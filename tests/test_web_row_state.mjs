import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, A, B, rowA, rowB, schema, actions, input, tick, submit, deferred, html } from './helpers/controller.mjs';

test('switching A to B clears old DOM/schema and gates writes and export until B succeeds', async () => {
  const f = fixture();
  await f.selectTable(A);
  const [oldEdit, oldDelete] = actions(f);
  const details = deferred(), rows = deferred();
  f.state.architect.getFlowsDatatable = () => details.promise;
  f.state.architect.getFlowsDatatableRows = () => rows.promise;
  const loading = f.selectTable(B);
  assert.equal(f.state.schema, null);
  assert.equal(actions(f).length, 0);
  assert.equal(f.elements.get('rowCount').textContent, '0 rows');
  assert.equal(f.elements.get('addRowButton').disabled, true);
  assert.equal(f.elements.get('exportButton').disabled, true);
  await oldEdit.click();
  await oldDelete.click();
  await f.elements.get('addRowButton').click();
  await f.saveRow(submit);
  f.exportRows();
  assert.equal(f.state.dialog, null);
  assert.equal(f.writes.length, 0);
  assert.equal(f.exports(), 0);
  details.resolve({ schema });
  rows.resolve({ entities: [rowB] });
  await loading;
  await oldEdit.click();
  await oldDelete.click();
  assert.equal(f.state.dialog, null);
  assert.equal(f.writes.length, 0);
  await actions(f)[0].click();
  assert.equal(f.state.dialog.table.id, 'B');
  assert.equal(input(f, 'value').value, 'B value');
  f.exportRows();
  assert.equal(f.exports(), 1);
});

test('failed B load keeps schema, row actions and export unavailable', async () => {
  const f = fixture();
  await f.selectTable(A);
  f.openRowDialog(f.state.rows[0]);
  f.state.architect.getFlowsDatatable = async () => { throw new Error('B load failed'); };
  await f.selectTable(B);
  assert.equal(f.elements.get('rowDialog').open, false);
  assert.equal(f.state.schema, null);
  assert.equal(actions(f).length, 0);
  assert.equal(f.elements.get('addRowButton').disabled, true);
  assert.match(f.elements.get('notice').textContent, /B load failed/);
  f.openRowDialog();
  await f.saveRow(submit);
  f.exportRows();
  assert.equal(f.writes.length, 0);
  assert.equal(f.exports(), 0);
});

test('removing selected table invalidates its pending load', async () => {
  const f = fixture();
  const pending = deferred();
  f.state.architect.getFlowsDatatable = () => pending.promise;
  const loading = f.selectTable(A);
  f.clearSelectedTable();
  pending.resolve({ schema });
  await loading;
  assert.equal(f.state.table, null);
  assert.equal(f.state.schema, null);
  assert.equal(f.state.rows.length, 0);
  assert.equal(actions(f).length, 0);
  assert.equal(f.elements.get('tableView').hidden, true);
});

test('slow A load cannot replace already loaded B rows', async () => {
  const f = fixture();
  const pending = deferred();
  f.state.architect.getFlowsDatatable = id => id === 'A' ? pending.promise : Promise.resolve({ schema });
  const loadingA = f.selectTable(A);
  await f.selectTable(B);
  pending.resolve({ schema });
  await loadingA;
  assert.equal(f.state.table.id, 'B');
  assert.equal(f.state.rows[0].value, 'B value');
});

test('canceling a pending save and opening another dialog isolates save completion', async () => {
  const f = fixture();
  await f.selectTable(A);
  f.openRowDialog(f.state.rows[0]);
  input(f, 'value').value = 'A draft';
  const pending = deferred();
  f.state.architect.putFlowsDatatableRow = (...args) => { f.writes.push(['put', ...args]); return pending.promise; };
  const saving = f.saveRow(submit);
  await tick();
  assert.equal(f.writes[0][1], 'A');
  assert.equal(f.writes[0][2], 'same-key');
  await f.elements.get('cancelDialogButton').click();
  f.openRowDialog();
  input(f, 'key').value = 'new-row';
  const newer = f.state.dialog;
  pending.resolve();
  await saving;
  assert.equal(f.state.dialog, newer);
  assert.equal(f.elements.get('rowDialog').open, true);
  assert.equal(f.elements.get('saveRowButton').textContent, 'Create row');
  assert.equal(f.elements.get('saveRowButton').disabled, false);
  assert.equal(input(f, 'key').value, 'new-row');
  assert.equal(f.reads.length, 1);
});

test('old save failure cannot overwrite a newer dialog error or button state', async () => {
  const f = fixture();
  await f.selectTable(A);
  f.openRowDialog(f.state.rows[0]);
  const pending = deferred();
  f.state.architect.putFlowsDatatableRow = () => pending.promise;
  const saving = f.saveRow(submit);
  await tick();
  await f.elements.get('closeDialogButton').click();
  f.openRowDialog();
  f.elements.get('formError').textContent = 'New draft error';
  pending.reject(new Error('Old save error'));
  await saving;
  assert.equal(f.elements.get('formError').textContent, 'New draft error');
  assert.equal(f.elements.get('saveRowButton').textContent, 'Create row');
});

test('cancel during row conflict read prevents PUT entirely', async () => {
  const f = fixture();
  await f.selectTable(A);
  f.openRowDialog(f.state.rows[0]);
  const pending = deferred();
  f.state.architect.getFlowsDatatableRow = () => pending.promise;
  const saving = f.saveRow(submit);
  await f.elements.get('rowDialog').dispatch('cancel');
  pending.resolve(rowA);
  await saving;
  assert.equal(f.writes.length, 0);
  assert.equal(f.state.dialog, null);
});

test('A save completing after B selection never refreshes B or closes its dialog', async () => {
  const f = fixture();
  await f.selectTable(A);
  f.openRowDialog(f.state.rows[0]);
  const pending = deferred();
  f.state.architect.putFlowsDatatableRow = (...args) => { f.writes.push(['put', ...args]); return pending.promise; };
  const saving = f.saveRow(submit);
  await tick();
  await f.selectTable(B);
  f.openRowDialog(f.state.rows[0]);
  const dialogB = f.state.dialog;
  pending.resolve();
  await saving;
  assert.equal(f.writes[0][1], 'A');
  assert.equal(f.state.dialog, dialogB);
  assert.deepEqual(f.reads, ['A', 'B']);
  assert.equal(f.state.rows[0].value, 'B value');
});

test('delete completion after changing table does not refresh the new selection', async () => {
  const f = fixture();
  await f.selectTable(A);
  const pending = deferred();
  f.state.architect.deleteFlowsDatatableRow = (...args) => { f.writes.push(['delete', ...args]); return pending.promise; };
  const deleting = f.deleteRow(f.state.rows[0]);
  await tick();
  await f.selectTable(B);
  pending.resolve();
  await deleting;
  assert.deepEqual(f.writes[0], ['delete', 'A', 'same-key']);
  assert.deepEqual(f.reads, ['A', 'B']);
});

test('another editor changing the row prevents PUT and retains the draft', async () => {
  const f = fixture();
  await f.selectTable(A);
  f.openRowDialog(f.state.rows[0]);
  input(f, 'value').value = 'My draft';
  f.state.architect.getFlowsDatatableRow = async () => ({ ...rowA, other: 'Concurrent change' });
  await f.saveRow(submit);
  assert.equal(f.writes.length, 0);
  assert.equal(f.elements.get('rowDialog').open, true);
  assert.equal(input(f, 'value').value, 'My draft');
  assert.match(f.elements.get('formError').textContent, /row changed/);
  assert.equal(f.elements.get('saveRowButton').disabled, false);
});

test('another editor changing a row prevents its deletion', async () => {
  const f = fixture();
  await f.selectTable(A);
  f.state.architect.getFlowsDatatableRow = async () => ({ ...rowA, value: 'Changed' });
  await f.deleteRow(f.state.rows[0]);
  assert.equal(f.writes.length, 0);
  assert.match(f.elements.get('notice').textContent, /row changed/);
});

test('successful edit refreshes its captured table and closes its own dialog', async () => {
  const f = fixture();
  await f.selectTable(A);
  f.openRowDialog(f.state.rows[0]);
  input(f, 'value').value = 'Edited';
  await f.saveRow(submit);
  assert.equal(f.writes[0][1], 'A');
  assert.equal(f.writes[0][3].body.value, 'Edited');
  assert.equal(f.elements.get('rowDialog').open, false);
  assert.deepEqual(f.reads, ['A', 'A']);
});

test('pagination loads 101 pages even when batches are shorter than pageSize', async () => {
  const f = fixture();
  const calls = [];
  const rows = await f.allPages(async page => { calls.push(page); return { pageCount: 101, entities: [{ key: `row-${page}` }] }; });
  assert.equal(rows.length, 101);
  assert.equal(calls.at(-1), 101);
});

test('pagination follows nextUri and fails explicitly at the safety bound', async () => {
  const f = fixture();
  const rows = await f.allPages(async page => ({ entities: [{ key: `${page}` }], nextUri: page < 3 ? `/rows?pageNumber=${page + 1}` : undefined }));
  assert.equal(rows.length, 3);
  await assert.rejects(f.allPages(async () => ({ entities: [], nextUri: '/rows' })), /1000-page loading limit.*No partial results/);
});

test('row dialog has an accessible name from its title', () => {
  assert.match(html, /<dialog\b[^>]*id="rowDialog"[^>]*aria-labelledby="dialogTitle"/);
  assert.match(html, /<h2\b[^>]*id="dialogTitle"/);
});
