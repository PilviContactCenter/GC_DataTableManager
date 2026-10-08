import assert from 'node:assert/strict';
import { test } from 'node:test';
import { roleFromGroups, columnsFor, parseRow } from '../web/domain.js';
import { auditQuery, auditRowKey, auditChanges } from '../web/audit.js';

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

test('audit query targets one data table and stays within the real-time window', () => {
  const now = new Date('2026-10-08T12:00:00.000Z');
  const query = auditQuery('table-123', 14, 2, now);
  assert.equal(query.serviceName, 'Datatables');
  assert.deepEqual(query.filters, [{ property: 'EntityId', value: 'table-123' }]);
  assert.deepEqual(query.sort, [{ name: 'Timestamp', sortOrder: 'descending' }]);
  assert.equal(query.pageNumber, 2);
  assert.equal(query.pageSize, 50);
  const [start, end] = query.interval.split('/').map(value => new Date(value));
  assert.equal(end.toISOString(), now.toISOString());
  assert.ok(end - start < 14 * 24 * 60 * 60 * 1000);
  assert.throws(() => auditQuery('table-123', 15, 1, now));
});

test('audit events expose row key and before/after field values', () => {
  const event = {
    entityType: 'Row',
    context: { key: 'customer-1' },
    propertyChanges: [{ property: 'status', oldValues: ['Pending'], newValues: ['Ready'] }]
  };
  assert.equal(auditRowKey(event), 'customer-1');
  assert.deepEqual(auditChanges(event), [{ field: 'status', before: 'Pending', after: 'Ready' }]);
  assert.equal(auditRowKey({ entityType: 'Schema', context: { key: 'irrelevant' } }), null);
});
