import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import * as filesystem from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';

// Fixed SDK region keys; requests cannot select an upstream host.
const regions = new Map(Object.entries({
  us_east_1: 'mypurecloud.com', eu_west_1: 'mypurecloud.ie',
  ap_southeast_2: 'mypurecloud.com.au', ap_northeast_1: 'mypurecloud.jp',
  eu_central_1: 'mypurecloud.de', us_west_2: 'usw2.pure.cloud',
  ca_central_1: 'cac1.pure.cloud', ap_northeast_2: 'apne2.pure.cloud',
  eu_west_2: 'euw2.pure.cloud', ap_south_1: 'aps1.pure.cloud',
  us_east_2: 'use2.us-gov-pure.cloud', sa_east_1: 'sae1.pure.cloud',
  me_central_1: 'mec1.pure.cloud', ap_northeast_3: 'apne3.pure.cloud',
  eu_central_2: 'euc2.pure.cloud', mx_central_1: 'mxc1.pure.cloud',
  ap_southeast_1: 'apse1.pure.cloud', eusc_de_east_1: 'edee1.eusc-pure.cloud'
}));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fingerprint = /^[0-9a-f]{64}$/;
const validFingerprint = value => typeof value === 'string' && fingerprint.test(value);
const unsafeNames = new Set(['__proto__', 'prototype', 'constructor']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validColumns = value => Array.isArray(value) && value.every(name => typeof name === 'string' && name.length > 0 && name !== 'key' && !unsafeNames.has(name)) && new Set(value).size === value.length;

class ServiceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const unavailable = () => new ServiceError(503, 'Policy service unavailable');

export function schemaFingerprint(schema) {
  if (!object(schema) || !object(schema.properties) || (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every(name => typeof name === 'string')))) throw unavailable();
  const properties = Object.keys(schema.properties).sort().map(name => {
    const definition = schema.properties[name];
    if (unsafeNames.has(name) || !object(definition) || typeof definition.type !== 'string') throw unavailable();
    return [name, definition.type];
  });
  return createHash('sha256').update(JSON.stringify({ properties, required: [...new Set(schema.required || [])].sort() })).digest('hex');
}

function decodeStorage(text) {
  const document = JSON.parse(text);
  if (!exactKeys(document, ['version', 'tables']) || document.version !== 1 || !object(document.tables)) throw new Error('Invalid policy storage');
  const policies = new Map();
  for (const [tableId, entry] of Object.entries(document.tables)) {
    if (!uuid.test(tableId) || tableId !== tableId.toLowerCase() || !exactKeys(entry, ['revision', 'editableColumns', 'schemaFingerprint']) || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || !validColumns(entry.editableColumns) || !validFingerprint(entry.schemaFingerprint)) throw new Error('Invalid policy storage');
    policies.set(tableId, entry);
  }
  return policies;
}

async function readBody(request, timeoutMs) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) throw new ServiceError(400, 'Content-Type must be application/json');
  const limit = 16 * 1024;
  if (Number(request.headers['content-length']) > limit) throw new ServiceError(400, 'Request body too large');
  let timer;
  const body = new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const finish = error => {
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('error', onError);
      request.removeListener('aborted', onAbort);
      if (error) { request.resume(); reject(error); }
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > limit) finish(new ServiceError(400, 'Request body too large'));
      else chunks.push(chunk);
    };
    const onEnd = () => {
      finish();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new ServiceError(400, 'Invalid JSON body')); }
    };
    const onError = () => finish(new ServiceError(400, 'Invalid request body'));
    const onAbort = () => finish(new ServiceError(400, 'Request aborted'));
    request.on('data', onData).on('end', onEnd).on('error', onError).on('aborted', onAbort);
    timer = setTimeout(() => finish(new ServiceError(400, 'Request body timeout')), timeoutMs);
  });
  try { return await body; } finally { clearTimeout(timer); }
}

/** Injectable fetch/filesystem let HTTP tests verify auth and durable writes without Genesys. */
export async function createColumnPolicyServer({
  region = process.env.GENESYS_REGION,
  adminGroupId = process.env.GENESYS_ADMIN_GROUP_ID,
  userGroupId = process.env.GENESYS_USER_GROUP_ID,
  policyPath = process.env.POLICY_PATH || '/data/column-access.json',
  fetchImpl = globalThis.fetch, fsImpl = filesystem,
  requestTimeoutMs = 10000, bodyTimeoutMs = 10000
} = {}) {
  if (!regions.has(region) || !uuid.test(adminGroupId || '') || !uuid.test(userGroupId || '') || adminGroupId.toLowerCase() === userGroupId.toLowerCase()) throw new Error('Invalid Genesys region or app group configuration');
  const baseUrl = `https://api.${regions.get(region)}`;
  const directory = dirname(policyPath);
  let policies;
  try { policies = decodeStorage(await fsImpl.readFile(policyPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Policy storage cannot be loaded');
    policies = new Map();
  }
  const checkStorage = async () => {
    await fsImpl.access(directory, constants.R_OK | constants.W_OK);
    try { await fsImpl.access(policyPath, constants.R_OK); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  await checkStorage();
  let queue = Promise.resolve();

  async function genesys(path, token, table = false) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: controller.signal, redirect: 'error' });
          if (response.status === 401) throw new ServiceError(401, 'Invalid or expired access token');
          if (response.status === 403 || (table && response.status === 404)) throw new ServiceError(403, 'Access denied');
          if (!response.ok) throw unavailable();
          return await response.json();
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, requestTimeoutMs); })
      ]);
    } catch (error) { throw error instanceof ServiceError ? error : unavailable(); }
    finally { clearTimeout(timer); }
  }

  const view = (tableId, hash) => {
    const entry = policies.get(tableId);
    return { tableId, revision: entry?.revision || 0, configured: Boolean(entry), editableColumns: entry ? [...entry.editableColumns] : [], schemaFingerprint: hash, schemaChanged: Boolean(entry && entry.schemaFingerprint !== hash) };
  };
  async function update(tableId, body, hash) {
    const operation = queue.then(async () => {
      if ((policies.get(tableId)?.revision || 0) !== body.revision || body.schemaFingerprint !== hash) throw new ServiceError(409, 'Column policy or table schema changed; reload and review');
      const entry = { revision: body.revision + 1, editableColumns: [...body.editableColumns].sort(), schemaFingerprint: hash };
      const next = new Map(policies).set(tableId, entry);
      const tables = Object.create(null);
      for (const [id, value] of next) tables[id] = value;
      const temporary = `${policyPath}.${randomUUID()}.tmp`;
      try {
        await checkStorage();
        const handle = await fsImpl.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(`${JSON.stringify({ version: 1, tables }, null, 2)}\n`, 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        await fsImpl.rename(temporary, policyPath);
      } catch { throw unavailable(); }
      finally { await fsImpl.unlink(temporary).catch(() => {}); }
      // Only the successful atomic replacement activates this revision.
      policies = next;
      return view(tableId, hash);
    });
    queue = operation.catch(() => {});
    return operation;
  }

  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, body) => { response.writeHead(status); response.end(JSON.stringify(body)); };
    try {
      if (request.url === '/health' && request.method === 'GET') { await checkStorage(); send(200, { status: 'ok' }); return; }
      const match = /^\/api\/column-access\/([^/?]+)$/.exec(request.url || '');
      if (!match) throw new ServiceError(404, 'Not found');
      if (!uuid.test(match[1])) throw new ServiceError(400, 'Invalid table ID');
      if (request.method !== 'GET' && request.method !== 'PUT') throw new ServiceError(405, 'Method not allowed');
      const authorization = /^Bearer ([^\s,]+)$/i.exec(request.headers.authorization || '');
      if (!authorization) throw new ServiceError(401, 'Bearer access token required');
      const token = authorization[1];
      const user = await genesys('/api/v2/users/me?expand=groups', token);
      if (!object(user) || typeof user.id !== 'string' || !user.id || (user.groups !== undefined && !Array.isArray(user.groups))) throw unavailable();
      const groups = new Set((user.groups || []).map(group => String(group?.id || '').toLowerCase()));
      const admin = groups.has(adminGroupId.toLowerCase());
      if (!admin && (!groups.has(userGroupId.toLowerCase()) || request.method === 'PUT')) throw new ServiceError(403, 'Access denied');
      const tableId = match[1].toLowerCase();
      const details = await genesys(`/api/v2/flows/datatables/${tableId}?expand=schema`, token, true);
      const hash = schemaFingerprint(details?.schema);
      if (request.method === 'GET') { await checkStorage(); send(200, view(tableId, hash)); return; }
      const body = await readBody(request, bodyTimeoutMs);
      if (!exactKeys(body, ['revision', 'editableColumns', 'schemaFingerprint']) || !Number.isSafeInteger(body.revision) || body.revision < 0 || body.revision >= Number.MAX_SAFE_INTEGER || !validColumns(body.editableColumns) || !validFingerprint(body.schemaFingerprint) || body.editableColumns.some(name => !Object.hasOwn(details.schema.properties, name))) throw new ServiceError(400, 'Invalid column policy');
      send(200, await update(tableId, body, hash));
    } catch (error) { send(error instanceof ServiceError ? error.status : 503, { error: error instanceof ServiceError ? error.message : 'Policy service unavailable' }); }
    finally { request.resume(); }
  });
  server.requestTimeout = bodyTimeoutMs + 2 * requestTimeoutMs;
  server.headersTimeout = Math.min(server.requestTimeout, 15000);
  return server;
}
