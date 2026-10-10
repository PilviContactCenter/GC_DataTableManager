import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createColumnPolicyServer, schemaFingerprint } from '../server/column-policy.mjs';

const tableId = '00000000-0000-0000-0000-000000000003';
const adminGroupId = '00000000-0000-0000-0000-000000000001';
const userGroupId = '00000000-0000-0000-0000-000000000002';
const schema = { properties: { key: { type: 'string' }, status: { type: 'string' }, enabled: { type: 'boolean' }, count: { type: 'integer' } }, required: ['key', 'status'] };
const validBody = (revision = 0, editableColumns = ['status'], currentSchema = schema) => ({ revision, editableColumns, schemaFingerprint: schemaFingerprint(currentSchema) });
const reply = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'column-policy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const state = { schema, calls: [], tableStatus: 200, userStatus: 200, override: null };
  const configuration = {
    region: 'eu_central_1', adminGroupId, userGroupId, policyPath: join(directory, 'column-access.json'),
    requestTimeoutMs: 100,
    fetchImpl: async (url, init) => {
      state.calls.push({ url, init });
      assert.ok(url.startsWith('https://api.mypurecloud.de/api/v2/'));
      assert.equal(init.redirect, 'error');
      if (state.override) return state.override(url, init);
      const token = init.headers.Authorization.slice(7);
      if (url.endsWith('/users/me?expand=groups')) {
        if (token === 'expired') return reply(401, {});
        if (state.userStatus !== 200) return reply(state.userStatus, {});
        const groups = { admin: [adminGroupId], user: [userGroupId], both: [userGroupId, adminGroupId], none: [] }[token] || [];
        return reply(200, { id: 'actor', groups: groups.map(id => ({ id: id.toUpperCase() })) });
      }
      assert.equal(url, `https://api.mypurecloud.de/api/v2/flows/datatables/${tableId}?expand=schema`);
      return reply(state.tableStatus, { schema: state.schema });
    }, ...options
  };
  let server;
  let base;
  const stop = async () => {
    if (!server?.listening) return;
    const stopped = once(server, 'close');
    server.close(); server.closeAllConnections();
    await stopped;
  };
  const start = async () => {
    server = await createColumnPolicyServer(configuration);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  };
  await start();
  t.after(stop);
  const request = async ({ token = 'admin', method = 'GET', body, path = `/api/column-access/${tableId}`, contentType = 'application/json', headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(token === null ? {} : { Authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { 'Content-Type': contentType }), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    return { status: response.status, body: await response.json() };
  };
  return { state, configuration, request, stop, start, directory, base: () => base };
}

test('health is local; missing policy returns a live fingerprint to both groups', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.request({ path: '/health', token: null }), { status: 200, body: { status: 'ok' } });
  assert.equal(f.state.calls.length, 0);
  for (const token of ['user', 'admin', 'both']) {
    assert.deepEqual(await f.request({ token }), { status: 200, body: { tableId, revision: 0, configured: false, editableColumns: [], schemaFingerprint: schemaFingerprint(schema), schemaChanged: false } });
    assert.equal(f.state.calls.at(-1).init.headers.Authorization, `Bearer ${token}`);
  }
  assert.equal(f.state.calls.length, 6, 'membership and division/schema checked freshly each time');
});

test('missing/expired tokens and denied groups stop before table access or body parsing', async t => {
  const f = await fixture(t);
  for (const token of [null, 'expired', 'none', 'user']) {
    const previous = f.state.calls.length;
    const result = await f.request({ token, method: 'PUT', body: '{bad json' });
    assert.equal(result.status, token === null || token === 'expired' ? 401 : 403);
    assert.equal(f.state.calls.length - previous, token === null ? 0 : 1);
  }
  assert.equal((await f.request({ token: 'both', method: 'PUT', body: validBody() })).status, 200, 'Admin takes precedence');
});

test('table permissions use the supplied token and deny concealed/missing tables', async t => {
  const f = await fixture(t);
  for (const status of [403, 404]) {
    f.state.tableStatus = status;
    assert.equal((await f.request()).status, 403);
    assert.equal((await f.request({ method: 'PUT', body: validBody() })).status, 403);
  }
  f.state.tableStatus = 401;
  assert.equal((await f.request()).status, 401);
  f.state.userStatus = 403;
  assert.equal((await f.request()).status, 403);
});

test('strict input rejects malformed IDs, payloads, key, duplicates and prototype names', async t => {
  const f = await fixture(t);
  assert.equal((await f.request({ path: '/api/column-access/__proto__' })).status, 400);
  assert.equal((await f.request({ method: 'OPTIONS' })).status, 405);
  const invalid = [null, [], {}, { ...validBody(), extra: 1 }, { ...validBody(), revision: '0' }, { ...validBody(), revision: -1 }, { ...validBody(), revision: 1.5 }, { ...validBody(), schemaFingerprint: [schemaFingerprint(schema)] }, { ...validBody(), schemaFingerprint: 'old' }, { ...validBody(), editableColumns: 'status' }, ...[['key'], ['missing'], ['status', 'status'], ['__proto__'], ['constructor'], ['prototype'], [1], ['']].map(editableColumns => validBody(0, editableColumns)), '{bad json', '{"__proto__":{},"revision":0,"editableColumns":[],"schemaFingerprint":"' + schemaFingerprint(schema) + '"}'];
  for (const body of invalid) assert.equal((await f.request({ method: 'PUT', body })).status, 400, JSON.stringify(body));
  assert.equal((await f.request({ method: 'PUT', body: validBody(), contentType: 'text/plain' })).status, 400);
  assert.equal((await f.request({ method: 'PUT', body: ' '.repeat(16385) })).status, 400);
  assert.equal((await f.request()).body.revision, 0);
});

test('chunked bodies respect size limits and incomplete bodies time out', async t => {
  const f = await fixture(t, { bodyTimeoutMs: 40 });
  const raw = write => new Promise((resolve, reject) => {
    const request = httpRequest(`${f.base()}/api/column-access/${tableId}`, { method: 'PUT', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { request.destroy(); resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); });
    });
    request.on('error', reject);
    write(request);
  });
  assert.equal((await raw(request => { request.write(' '.repeat(8192)); request.write(' '.repeat(8193)); request.end(); })).status, 400);
  const result = await raw(request => request.write('{'));
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'Request body timeout');
});

test('writes persist metadata only; policy revisions prevent stale and concurrent updates', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.request({ method: 'PUT', body: validBody(0, ['enabled', 'status']) }), f.request({ method: 'PUT', body: validBody(0, ['count']) })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const saved = results.find(result => result.status === 200).body;
  assert.equal(saved.revision, 1);
  assert.equal(saved.configured, true);
  assert.equal(saved.schemaChanged, false);
  assert.equal((await f.request({ method: 'PUT', body: validBody() })).status, 409);
  const next = await f.request({ method: 'PUT', body: validBody(1, []) });
  assert.equal(next.status, 200);
  assert.equal(next.body.revision, 2);
  assert.deepEqual(next.body.editableColumns, []);
  const text = await fs.readFile(f.configuration.policyPath, 'utf8');
  assert.deepEqual(JSON.parse(text), { version: 1, tables: { [tableId]: { revision: 2, editableColumns: [], schemaFingerprint: schemaFingerprint(schema) } } });
  assert.ok(!text.includes('Bearer') && !text.includes('actor'));
  await f.stop(); await f.start();
  assert.deepEqual((await f.request({ token: 'user' })).body, next.body);
});

test('fingerprints ignore order and titles but detect names, types and required fields', () => {
  const reordered = { properties: { count: { type: 'integer', title: 'New label' }, enabled: { type: 'boolean' }, status: { type: 'string' }, key: { type: 'string' } }, required: ['status', 'key'] };
  assert.equal(schemaFingerprint(reordered), schemaFingerprint(schema));
  for (const changed of [{ ...schema, required: ['key'] }, { ...schema, properties: { ...schema.properties, added: { type: 'string' } } }, { ...schema, properties: { ...schema.properties, count: { type: 'number' } } }]) assert.notEqual(schemaFingerprint(changed), schemaFingerprint(schema));
});

test('schema drift is visible and requires Admin resaving against the current schema', async t => {
  const f = await fixture(t);
  await f.request({ method: 'PUT', body: validBody() });
  f.state.schema = { ...schema, properties: { ...schema.properties, added: { type: 'string' } } };
  const changed = await f.request({ token: 'user' });
  assert.equal(changed.body.schemaChanged, true);
  assert.equal(changed.body.schemaFingerprint, schemaFingerprint(f.state.schema));
  assert.equal((await f.request({ method: 'PUT', body: validBody(1) })).status, 409);
  const resaved = await f.request({ method: 'PUT', body: validBody(1, ['status'], f.state.schema) });
  assert.equal(resaved.status, 200);
  assert.equal(resaved.body.schemaChanged, false);
  assert.equal(resaved.body.revision, 2);
});

test('corrupt and unknown-version files refuse startup without overwriting', async t => {
  const f = await fixture(t);
  await f.stop();
  for (const text of ['{broken', '{"version":2,"tables":{}}', '{"version":1,"tables":{"__proto__":{}}}', JSON.stringify({ version: 1, tables: { [tableId]: { revision: 1, editableColumns: ['key'], schemaFingerprint: schemaFingerprint(schema) } } })]) {
    await fs.writeFile(f.configuration.policyPath, text);
    await assert.rejects(createColumnPolicyServer(f.configuration), /storage cannot be loaded/);
    assert.equal(await fs.readFile(f.configuration.policyPath, 'utf8'), text);
  }
});

test('failed atomic rename preserves active and persisted revisions and permits retry', async t => {
  let failRename = false;
  const f = await fixture(t, { fsImpl: { ...fs, rename: async (...args) => { if (failRename) throw new Error('disk full'); return fs.rename(...args); } } });
  await f.request({ method: 'PUT', body: validBody() });
  const before = await fs.readFile(f.configuration.policyPath, 'utf8');
  failRename = true;
  assert.equal((await f.request({ method: 'PUT', body: validBody(1, ['enabled']) })).status, 503);
  assert.equal((await f.request()).body.revision, 1);
  assert.equal(await fs.readFile(f.configuration.policyPath, 'utf8'), before);
  assert.deepEqual(await fs.readdir(f.directory), ['column-access.json']);
  failRename = false;
  assert.equal((await f.request({ method: 'PUT', body: validBody(1, ['enabled']) })).status, 200);
});

test('failed file write does not configure a policy or leave partial temporary files', async t => {
  const f = await fixture(t, { fsImpl: { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return { writeFile: async () => { throw new Error('disk full'); }, sync: () => handle.sync(), close: () => handle.close() };
  } } });
  assert.equal((await f.request({ method: 'PUT', body: validBody() })).status, 503);
  assert.equal((await f.request()).body.configured, false);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('unwritable storage refuses startup; later storage failure makes health and API unavailable', async t => {
  let fail = false;
  const f = await fixture(t, { fsImpl: { ...fs, access: async (...args) => { if (fail) throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); return fs.access(...args); } } });
  fail = true;
  await assert.rejects(createColumnPolicyServer(f.configuration), /permission denied/);
  assert.equal((await f.request({ path: '/health' })).status, 503);
  assert.equal((await f.request()).status, 503);
  assert.equal((await f.request({ method: 'PUT', body: validBody() })).status, 503);
  fail = false;
  assert.equal((await f.request()).body.revision, 0);
});

test('upstream failure, invalid schema and timeouts return generic unavailable errors', async t => {
  const f = await fixture(t, { requestTimeoutMs: 20 });
  for (const status of [429, 500]) {
    f.state.userStatus = status;
    assert.deepEqual(await f.request(), { status: 503, body: { error: 'Policy service unavailable' } });
  }
  f.state.userStatus = 200;
  f.state.tableStatus = 500;
  assert.equal((await f.request()).status, 503);
  f.state.tableStatus = 200;
  f.state.schema = {};
  assert.equal((await f.request()).status, 503);
  f.state.override = async () => { throw new Error('contains upstream secret'); };
  assert.deepEqual(await f.request(), { status: 503, body: { error: 'Policy service unavailable' } });
  f.state.override = () => new Promise(() => {});
  const start = Date.now();
  assert.equal((await f.request()).status, 503);
  assert.ok(Date.now() - start < 1000, 'timeout works even if transport ignores abort');
});

test('server rejects arbitrary regions and equal app groups before making requests', async () => {
  await assert.rejects(createColumnPolicyServer({ region: 'https://attacker.example', adminGroupId, userGroupId }), /configuration/);
  await assert.rejects(createColumnPolicyServer({ region: 'eu_central_1', adminGroupId, userGroupId: adminGroupId }), /configuration/);
});
