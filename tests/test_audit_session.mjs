import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import * as audit from '../web/audit.js';

// Exercise the actual browser handlers without signing in or calling Genesys.
const mainSource = readFileSync(new URL('../web/main.js', import.meta.url), 'utf8').replace(/^import .*;\r?$/gm, '');

class Element {
  hidden = false;
  disabled = false;
  textContent = '';
  value = '';
  dataset = {};
  children = [];
  attributes = {};
  classList = { toggle() {} };
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  querySelectorAll() {
    return this.children.flatMap(child => [
      ...(child.dataset.userId ? [child] : []), ...child.querySelectorAll()
    ]);
  }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(loadPage) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  get('auditPanel').hidden = true;
  get('auditRange').value = '14';
  let now = Date.parse('2026-10-10T12:00:00Z');
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
  }
  const queries = [];
  const context = vm.createContext({
    ...audit, Date: ClockDate, window: {},
    document: { readyState: 'loading', addEventListener() {}, getElementById: get, createElement: () => new Element() }
  });
  vm.runInContext(`${mainSource}\n globalThis.handlers = { state, loadAuditHistory, toggleAuditHistory, closeAuditHistory };`, context);
  const handlers = context.handlers;
  handlers.state.role = 'admin';
  handlers.state.table = { id: 'table-a' };
  handlers.state.users = { getUser: async id => ({ name: id }) };
  handlers.state.audits = { postAuditsQueryRealtime(query) {
    queries.push(query);
    return loadPage(query, queries.length);
  } };
  return { ...handlers, get, queries, advance: milliseconds => { now += milliseconds; } };
}

const event = (id, eventDate = '2026-10-10T11:00:00Z') => ({ id, eventDate, action: 'Update', entityType: 'Row' });
const ids = state => Array.from(state.auditEntries, entry => entry.id);
const busyControls = h => ['refreshAuditButton', 'auditRange', 'loadMoreAuditButton'].map(id => h.get(id).disabled);

test('audit session captures immutable table, range and interval', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const session = audit.createAuditSession('table-a', 7, now);
  now.setDate(11);
  assert.equal(Object.isFrozen(session), true);
  assert.equal(session.tableId, 'table-a');
  assert.equal(session.days, 7);
  assert.equal(session.endTime, '2026-10-10T12:00:00.000Z');
  assert.equal(audit.auditSessionQuery(session, 2).interval, audit.auditSessionQuery(session, 1).interval);
  assert.equal(audit.auditSessionQuery(session, 2).interval.split('/')[1], '2026-10-10T12:00:00.000Z');
});

test('new events between pages cannot shift the descending page boundary', async () => {
  const events = Array.from({ length: 51 }, (_, index) => event(`event-${index}`,
    new Date(Date.parse('2026-10-10T11:59:00Z') - index * 1000).toISOString()));
  const h = harness(async query => {
    const [start, end] = query.interval.split('/').map(Date.parse);
    const matching = events.filter(entry => Date.parse(entry.eventDate) >= start && Date.parse(entry.eventDate) <= end)
      .sort((a, b) => Date.parse(b.eventDate) - Date.parse(a.eventDate));
    const offset = (query.pageNumber - 1) * query.pageSize;
    return { entities: matching.slice(offset, offset + query.pageSize), total: matching.length, pageCount: 2 };
  });
  await h.toggleAuditHistory();
  h.advance(120000);
  events.unshift(event('new-event', '2026-10-10T12:01:00Z'));
  await h.loadAuditHistory(2);
  assert.equal(h.queries[0].interval, h.queries[1].interval);
  assert.deepEqual(ids(h.state), Array.from({ length: 51 }, (_, index) => `event-${index}`));
  assert.equal(h.state.auditTotal, 51);
  assert.equal(h.get('loadMoreAuditButton').hidden, true);
  await h.loadAuditHistory(1);
  assert.notEqual(h.queries[0].interval, h.queries[2].interval);
  assert.equal(h.state.auditTotal, 52);
  assert.equal(ids(h.state)[0], 'new-event');
});

test('pending fetch gates duplicate paging and same-range refresh', async () => {
  const pending = deferred();
  const pendingMore = deferred();
  const h = harness((query, call) => call === 1 ? pending.promise : pendingMore.promise);
  const opening = h.toggleAuditHistory();
  assert.deepEqual(busyControls(h), [true, true, true]);
  assert.equal(h.get('closeAuditButton').disabled, false);
  await h.loadAuditHistory(1);
  await h.loadAuditHistory(2);
  assert.equal(h.queries.length, 1);
  pending.resolve({ entities: [event('first')], pageCount: 2, total: 2 });
  await opening;
  assert.deepEqual(busyControls(h), [false, false, false]);
  const more = h.loadAuditHistory(2);
  await h.loadAuditHistory(2);
  await h.loadAuditHistory(1);
  assert.equal(h.queries.length, 2);
  assert.deepEqual(busyControls(h), [true, true, true]);
  pendingMore.resolve({ entities: [event('second')], pageCount: 2, total: 2 });
  await more;
  assert.deepEqual(ids(h.state), ['first', 'second']);
});

test('range change during page two ignores its result and stale finally', async () => {
  const oldPage = deferred();
  const newRange = deferred();
  const h = harness((query, call) => call === 1
    ? Promise.resolve({ entities: [event('old-first')], pageCount: 2, total: 2 })
    : call === 2 ? oldPage.promise : newRange.promise);
  await h.toggleAuditHistory();
  const more = h.loadAuditHistory(2);
  h.get('auditRange').value = '1';
  const refresh = h.loadAuditHistory(1);
  assert.deepEqual(ids(h.state), []);
  assert.equal(h.get('auditList').children.length, 0);
  assert.notEqual(h.queries[1].interval, h.queries[2].interval);
  oldPage.resolve({ entities: [event('old-second')], pageCount: 2, total: 2 });
  await more;
  assert.deepEqual(ids(h.state), []);
  assert.deepEqual(busyControls(h), [true, true, true]);
  assert.equal(h.get('auditStatus').textContent, 'Loading change history…');
  assert.equal(h.get('refreshAuditButton').textContent, 'Loading…');
  newRange.resolve({ entities: [event('new-range')], pageCount: 1, total: 1 });
  await refresh;
  assert.deepEqual(ids(h.state), ['new-range']);
  assert.deepEqual(busyControls(h), [false, false, false]);
});

test('close and reopen starts a fresh session and stale finally keeps it busy', async () => {
  const oldRequest = deferred();
  const newRequest = deferred();
  const h = harness((query, call) => call === 1 ? oldRequest.promise : newRequest.promise);
  const opening = h.toggleAuditHistory();
  h.closeAuditHistory();
  assert.equal(h.state.auditSession, null);
  assert.deepEqual(busyControls(h), [false, false, false]);
  h.advance(120000);
  const reopening = h.toggleAuditHistory();
  assert.notEqual(h.queries[0].interval, h.queries[1].interval);
  oldRequest.resolve({ entities: [event('stale')], pageCount: 1, total: 1 });
  await opening;
  assert.deepEqual(ids(h.state), []);
  assert.deepEqual(busyControls(h), [true, true, true]);
  newRequest.resolve({ entities: [event('current')], pageCount: 1, total: 1 });
  await reopening;
  assert.deepEqual(ids(h.state), ['current']);
  assert.equal(h.get('auditStatus').textContent, 'Showing 1 of 1 events.');
});

test('table switch invalidates the old table result', async () => {
  const oldRequest = deferred();
  const newRequest = deferred();
  const h = harness((query, call) => call === 1 ? oldRequest.promise : newRequest.promise);
  const opening = h.toggleAuditHistory();
  h.closeAuditHistory();
  h.state.table = { id: 'table-b' };
  const reopening = h.toggleAuditHistory();
  assert.equal(h.queries[1].filters[0].value, 'table-b');
  newRequest.resolve({ entities: [event('table-b-event')], pageCount: 1, total: 1 });
  await reopening;
  oldRequest.resolve({ entities: [event('table-a-event')], pageCount: 1, total: 1 });
  await opening;
  assert.deepEqual(ids(h.state), ['table-b-event']);
});

test('closed panel ignores stale errors and completion', async () => {
  const pending = deferred();
  const h = harness(() => pending.promise);
  const opening = h.toggleAuditHistory();
  h.closeAuditHistory();
  pending.reject(new Error('old request failed'));
  await opening;
  assert.equal(h.get('auditPanel').hidden, true);
  assert.equal(h.get('auditStatus').textContent, '');
  assert.deepEqual(busyControls(h), [false, false, false]);
});

test('failed page two retries the same session and removes duplicate event IDs', async () => {
  const h = harness((query, call) => {
    if (call === 1) return Promise.resolve({ entities: [event('first')], pageCount: 2, total: 2 });
    if (call === 2) return Promise.reject(new Error('temporary failure'));
    return Promise.resolve({ entities: [event('first'), event('second')], pageCount: 2, total: 2 });
  });
  await h.toggleAuditHistory();
  await h.loadAuditHistory(2);
  assert.deepEqual(ids(h.state), ['first']);
  assert.equal(h.state.auditPage, 1);
  assert.deepEqual(busyControls(h), [false, false, false]);
  assert.match(h.get('auditStatus').textContent, /temporary failure/);
  h.advance(120000);
  await h.loadAuditHistory(2);
  assert.equal(h.queries[0].interval, h.queries[2].interval);
  assert.deepEqual(ids(h.state), ['first', 'second']);
});
