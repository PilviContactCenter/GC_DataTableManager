import assert from 'node:assert/strict';
import { test } from 'node:test';
import { roleFromGroups, columnsFor, parseRow } from '../web/domain.js';

const schema = { properties: { key: { type: 'string' }, count: { type: 'integer' }, rate: { type: 'number' }, enabled: { type: 'boolean' } }, required: ['key', 'count'] };

test('admin group wins and users without app groups get no access', () => {
  const groups = [{ id: 'USER' }, { id: 'ADMIN' }];
  assert.equal(roleFromGroups(groups, 'admin', 'user'), 'admin');
  assert.equal(roleFromGroups([], 'admin', 'user'), null);
});

test('columns include key and schema columns', () => {
  assert.deepEqual(columnsFor(schema), ['key', 'count', 'rate', 'enabled']);
});

test('valid row values are typed', () => {
  const result = parseRow(schema, { key: ' a ', count: '12', rate: '1.5', enabled: true });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.row, { key: 'a', count: 12, rate: 1.5, enabled: true });
});

test('invalid numbers are rejected', () => {
  const result = parseRow(schema, { key: 'a', count: '1.5', rate: 'Infinity' });
  assert.ok(result.errors.some(error => error.includes('whole number')));
  assert.ok(result.errors.some(error => error.includes('finite number')));
});

test('edit keeps immutable key and unchanged fields', () => {
  const result = parseRow(schema, { count: '8', enabled: false }, { key: 'original', count: 3, rate: 2, enabled: true });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.row, { key: 'original', count: 8, rate: 2, enabled: false });
});

test('clearing an optional numeric field removes its old value', () => {
  const result = parseRow(schema, { count: '8', rate: '', enabled: false }, { key: 'original', count: 3, rate: 2, enabled: false });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.row, { key: 'original', count: 8, enabled: false });
});
