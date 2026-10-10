import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRow } from '../web/domain.js';
import { fingerprint, fixture, A, B, actions, input, tick, submit, deferred, html } from './helpers/controller.mjs';

const schema = { properties: {
  key: { type: 'string', title: 'Row key' }, value: { type: 'string', title: 'Visible label' },
  locked: { type: 'string' }, flag: { type: 'boolean' }, optional: { type: 'boolean' }
}, required: ['key'] };
const row = { key: 'same-key', value: 'Original', locked: 'Keep me', flag: true, unknown: { nested: 2 } };
const user = () => fixture({ role: 'user', schema, row });
const choices = f => f.elements.get('columnAccessFields').querySelectorAll('input');
const success = body => ({ ok: true, json: async () => body });
const policy = (tableId = 'A', changes = {}) => ({ tableId, revision: 1, configured: true,
  editableColumns: ['value'], schemaFingerprint: fingerprint(schema), schemaChanged: false, ...changes });

test('User sees allowed fields plus locked text, checkbox and immutable key', async () => {
  const f = user();
  await f.selectTable(A);
  await actions(f)[0].click();
  assert.equal(input(f, 'value').readOnly, false);
  assert.equal(input(f, 'locked').readOnly, true);
  assert.equal(input(f, 'key').readOnly, true);
  assert.equal(input(f, 'flag').disabled, true);
  assert.equal(input(f, 'optional').disabled, true);
  const labels = f.elements.get('rowFields').querySelectorAll('label');
  assert.match(labels.find(label => label.htmlFor === 'field-locked').textContent, /locked by column access/);
});

test('User update ignores programmatic changes to locked controls and preserves absent booleans and extra properties', async () => {
  const f = user();
  await f.selectTable(A);
  f.openRowDialog(f.state.rows[0]);
  input(f, 'value').value = 'Allowed draft';
  input(f, 'locked').value = 'Forbidden';
  input(f, 'key').value = 'Changed key';
  input(f, 'flag').checked = false;
  input(f, 'optional').checked = true;
  await f.saveRow(submit);
  assert.deepEqual(JSON.parse(JSON.stringify(f.writes[0][3].body)), { ...row, value: 'Allowed draft' });
  assert.equal(Object.hasOwn(f.writes[0][3].body, 'optional'), false);
  assert.equal(f.policyCalls[0][1].headers.Authorization, 'Bearer current-sdk-token');
  assert.equal(f.policyCalls[0][0], '/api/column-access/A');
});

test('parseRow preserves omitted existing and absent optional booleans', () => {
  const parsed = parseRow(schema, { value: 'Edited' }, row);
  assert.deepEqual(parsed.row, { ...row, value: 'Edited' });
  assert.equal(Object.hasOwn(parsed.row, 'optional'), false);
});

for (const [label, changes] of [
  ['unconfigured', { configured: false, revision: 0, editableColumns: [] }],
  ['empty', { editableColumns: [] }],
  ['schema changed', { schemaChanged: true }],
  ['unknown field only', { editableColumns: ['new-field'] }]
]) test(`User stays read-only when policy is ${label}`, async () => {
  const f = user();
  f.setPolicy(changes);
  await f.selectTable(A);
  assert.equal(actions(f)[0].disabled, true);
  f.openRowDialog(f.state.rows[0]);
  assert.equal(f.state.dialog, null);
  await f.saveRow(submit);
  assert.equal(f.writes.length, 0);
});

test('policy failure leaves User read-only while Admin can still edit rows and retry policy', async () => {
  for (const role of ['user', 'admin']) {
    const f = fixture({ role, schema, row });
    f.setFetch(async () => { throw new Error('Policy service offline'); });
    await f.selectTable(A);
    assert.equal(actions(f)[0].disabled, role === 'user');
    assert.match(f.elements.get('columnAccessStatus').textContent, /offline/);
    if (role === 'admin') {
      f.openRowDialog(f.state.rows[0]);
      input(f, 'locked').value = 'Admin edit';
      await f.saveRow(submit);
      assert.equal(f.writes[0][3].body.locked, 'Admin edit');
    }
    f.setFetch(async () => success(policy()));
    await f.refreshColumnAccess();
    assert.equal(actions(f)[0].disabled, false);
  }
});

test('late A policy result cannot unlock B', async () => {
  const f = user(), pending = deferred();
  f.setFetch(async url => url.endsWith('/A') ? pending.promise : success(policy('B', { editableColumns: [] })));
  const loadingA = f.selectTable(A);
  await tick();
  assert.equal(actions(f)[0].disabled, true);
  await f.selectTable(B);
  pending.resolve(success(policy()));
  await loadingA;
  assert.equal(f.state.columnAccess.tableId, 'B');
  assert.equal(actions(f)[0].disabled, true);
});

for (const [label, changes] of [
  ['revision revoked', { revision: 2, editableColumns: [] }],
  ['schema drift', { schemaChanged: true, schemaFingerprint: 'b'.repeat(64) }],
  ['grant changed without revision', { editableColumns: ['locked'] }]
]) test(`User save refuses ${label} and retains draft`, async () => {
  const f = user();
  await f.selectTable(A);
  f.openRowDialog(f.state.rows[0]);
  input(f, 'value').value = 'Keep this draft';
  f.setPolicy(changes);
  await f.saveRow(submit);
  assert.equal(f.writes.length, 0);
  assert.equal(f.elements.get('rowDialog').open, true);
  assert.equal(input(f, 'value').value, 'Keep this draft');
  assert.match(f.elements.get('formError').textContent, /Column access changed/);
  assert.equal(f.elements.get('saveRowButton').disabled, false);
});

test('cancel during User policy preflight prevents PUT and isolates a new dialog', async () => {
  const f = user();
  await f.selectTable(A);
  f.openRowDialog(f.state.rows[0]);
  const pending = deferred();
  f.setFetch(() => pending.promise);
  const saving = f.saveRow(submit);
  await tick();
  await f.elements.get('cancelDialogButton').click();
  f.openRowDialog(f.state.rows[0]);
  const newer = f.state.dialog;
  pending.resolve(success(policy()));
  await saving;
  assert.equal(f.writes.length, 0);
  assert.equal(f.state.dialog, newer);
  assert.equal(f.elements.get('saveRowButton').disabled, false);
});

test('duplicate User submit makes one policy preflight and one PUT', async () => {
  const f = user();
  await f.selectTable(A);
  f.openRowDialog(f.state.rows[0]);
  const pending = deferred();
  let calls = 0;
  f.setFetch(async () => { calls++; return pending.promise; });
  const first = f.saveRow(submit);
  await tick();
  await f.saveRow(submit);
  assert.equal(calls, 1);
  pending.resolve(success(policy()));
  await first;
  assert.equal(f.writes.length, 1);
});

test('Admin dialog shows schema titles and stable IDs excluding key and saves exact contract', async () => {
  const f = fixture({ schema, row });
  await f.selectTable(A);
  await f.openColumnDialog();
  assert.deepEqual(choices(f).map(choice => choice.dataset.column), ['value', 'locked', 'flag', 'optional']);
  assert.ok(f.elements.get('columnAccessFields').querySelectorAll('span').some(title => title.textContent === 'Visible label'));
  assert.ok(f.elements.get('columnAccessFields').querySelectorAll('small').some(id => id.textContent === 'Column ID: value'));
  choices(f).find(choice => choice.dataset.column === 'flag').checked = true;
  await f.saveColumnAccess(submit);
  const [, request] = f.policyCalls.find(([, request]) => request.method === 'PUT');
  assert.deepEqual(JSON.parse(request.body), { revision: 1, editableColumns: ['value', 'flag'], schemaFingerprint: fingerprint(schema) });
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.equal(f.state.columnAccess.revision, 2);
  assert.equal(f.elements.get('columnAccessDialog').open, false);
});

test('Admin conflict preserves selection and releases save controls for explicit refresh', async () => {
  const f = fixture({ schema, row });
  await f.selectTable(A);
  await f.openColumnDialog();
  choices(f).find(choice => choice.dataset.column === 'flag').checked = true;
  f.setFetch(async () => ({ ok: false, json: async () => ({ error: 'Column access changed. Refresh before saving.' }) }));
  await f.saveColumnAccess(submit);
  assert.equal(choices(f).find(choice => choice.dataset.column === 'flag').checked, true);
  assert.equal(f.elements.get('columnAccessDialog').open, true);
  assert.match(f.elements.get('columnAccessError').textContent, /selection has been kept/);
  assert.equal(f.elements.get('saveColumnAccessButton').disabled, false);
  assert.equal(f.elements.get('reloadColumnAccessButton').disabled, false);
});

test('Admin save gates duplicate submission and completion cannot modify the next table/dialog', async () => {
  const f = fixture({ schema, row });
  await f.selectTable(A);
  await f.openColumnDialog();
  const pending = deferred();
  let calls = 0;
  f.setFetch(async (url, request) => {
    if (request.method === 'PUT') { calls++; return pending.promise; }
    return success(policy(url.endsWith('/B') ? 'B' : 'A'));
  });
  const saving = f.saveColumnAccess(submit);
  await f.saveColumnAccess(submit);
  assert.equal(calls, 1);
  assert.equal(f.elements.get('saveColumnAccessButton').textContent, 'Saving…');
  await f.selectTable(B);
  await f.openColumnDialog();
  const newer = f.state.columnDialog;
  pending.resolve(success(policy('A', { revision: 2 })));
  await saving;
  assert.equal(f.state.columnDialog, newer);
  assert.equal(f.state.columnAccess.tableId, 'B');
  assert.equal(f.elements.get('saveColumnAccessButton').disabled, false);
});

test('Admin dialog load cancelled during await cannot repaint a newer dialog', async () => {
  const f = fixture({ schema, row });
  await f.selectTable(A);
  const pending = deferred();
  f.setFetch(() => pending.promise);
  const opening = f.openColumnDialog();
  f.closeColumnDialog();
  f.setFetch(async () => success(policy('B', { editableColumns: ['flag'] })));
  await f.selectTable(B);
  await f.openColumnDialog();
  const newer = f.state.columnDialog;
  pending.resolve(success(policy()));
  await opening;
  assert.equal(f.state.columnDialog, newer);
  assert.equal(choices(f).find(choice => choice.dataset.column === 'flag').checked, true);
  assert.equal(choices(f).find(choice => choice.dataset.column === 'value').checked, false);
});

test('User cannot open or save Admin selection and dialog has an accessible name', async () => {
  const f = user();
  await f.selectTable(A);
  await f.openColumnDialog();
  await f.saveColumnAccess(submit);
  assert.equal(f.state.columnDialog, null);
  assert.equal(f.policyCalls.filter(([, request]) => request.method === 'PUT').length, 0);
  assert.match(html, /<dialog\b[^>]*id="columnAccessDialog"[^>]*aria-labelledby="columnAccessTitle"/);
});

test('initial policy refresh gates Admin settings so its late result cannot overwrite a saved revision', async () => {
  const f = fixture({ schema, row });
  const pending = deferred();
  f.setFetch(() => pending.promise);
  const loading = f.selectTable(A);
  await tick();
  assert.equal(f.elements.get('columnAccessButton').disabled, true);
  await f.openColumnDialog();
  await f.saveColumnAccess(submit);
  assert.equal(f.state.columnDialog, null);
  pending.resolve(success(policy()));
  await loading;
  assert.equal(f.elements.get('columnAccessButton').disabled, false);
  f.setFetch(async (url, request) => success(policy('A', { revision: request.method === 'PUT' ? 2 : 1 })));
  await f.openColumnDialog();
  await f.saveColumnAccess(submit);
  assert.equal(f.state.columnAccess.revision, 2);
});

test('browser/live schema mismatch leaves User locked and prevents Admin confirming stale columns', async () => {
  for (const role of ['user', 'admin']) {
    const f = fixture({ role, schema, row });
    f.setPolicy({ schemaFingerprint: 'b'.repeat(64) });
    await f.selectTable(A);
    assert.match(f.elements.get('columnAccessStatus').textContent, /columns changed/);
    assert.equal(actions(f)[0].disabled, role === 'user');
    if (role === 'admin') {
      await f.openColumnDialog();
      assert.equal(f.elements.get('saveColumnAccessButton').disabled, true);
      assert.match(f.elements.get('columnAccessError').textContent, /Cancel and refresh the table/);
    }
  }
});

test('revocation while optimistic row read is pending is caught by the final policy read', async () => {
  const f = user();
  await f.selectTable(A);
  f.openRowDialog(f.state.rows[0]);
  const pending = deferred();
  f.state.architect.getFlowsDatatableRow = () => pending.promise;
  const saving = f.saveRow(submit);
  f.setPolicy({ revision: 2, editableColumns: [] });
  pending.resolve(row);
  await saving;
  assert.equal(f.writes.length, 0);
  assert.match(f.elements.get('formError').textContent, /Column access changed/);
});

test('failed User policy preflight keeps the draft and blocks SDK PUT', async () => {
  const f = user();
  await f.selectTable(A);
  f.openRowDialog(f.state.rows[0]);
  input(f, 'value').value = 'Draft';
  f.setFetch(async () => { throw new Error('Policy offline'); });
  await f.saveRow(submit);
  assert.equal(f.writes.length, 0);
  assert.equal(input(f, 'value').value, 'Draft');
  assert.match(f.elements.get('formError').textContent, /Policy offline/);
});

test('Admin failed dialog load can refresh and save after the service recovers', async () => {
  const f = fixture({ schema, row });
  await f.selectTable(A);
  f.setFetch(async () => { throw new Error('Policy offline'); });
  await f.openColumnDialog();
  assert.equal(f.elements.get('saveColumnAccessButton').disabled, true);
  assert.equal(f.elements.get('reloadColumnAccessButton').disabled, false);
  f.setFetch(async () => success(policy()));
  await f.elements.get('reloadColumnAccessButton').click();
  assert.equal(f.elements.get('saveColumnAccessButton').disabled, false);
  assert.equal(choices(f).length, 4);
});
