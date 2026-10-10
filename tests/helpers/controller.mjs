import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import * as domain from '../../web/domain.js';
import * as audit from '../../web/audit.js';
import * as columnAccess from '../../web/column-access.js';

const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../../web/main.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
const schema = { properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key'] };
const A = { id: 'A', name: 'Table A' };
const B = { id: 'B', name: 'Table B' };
const rowA = { key: 'same-key', value: 'A value' };
const rowB = { key: 'same-key', value: 'B value' };
const submit = { preventDefault() {} };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// A small DOM fixture runs the actual controller and event listeners. Its
// purpose is async state regression coverage; native browser layout is not modeled.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.attributes = {};
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.classList = { toggle() {} };
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
  dispatch(name, event = submit) { return Promise.all((this.listeners[name] || []).map(listener => listener(event))); }
  click() { if (!this.disabled) return this.dispatch('click'); }
  querySelectorAll(selector) {
    const matches = element => selector === '[data-field]' ? element.dataset.field != null : element.tagName === selector;
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  showModal() { this.open = true; }
  close() { this.open = false; void this.dispatch('close'); }
  reportValidity() { return true; }
}

function fixture(options = {}) {
  const elements = new Map([...html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/g)].map(([markup, tag, id]) => {
    const element = new Element(tag);
    element.id = id;
    element.hidden = /\bhidden\b/.test(markup);
    return [id, element];
  }));
  elements.get('rowTable').append(new Element('thead'), new Element('tbody'));
  elements.get('rowForm').append(elements.get('rowFields'));
  const document = {
    readyState: 'complete', createElement: tag => new Element(tag),
    getElementById: id => elements.get(id) || [...elements.values()].flatMap(element => element.querySelectorAll('input')).find(input => input.id === id)
  };
  let exports = 0;
  let policy = { tableId: 'A', revision: 1, configured: true, editableColumns: ['value'], schemaFingerprint: fingerprint(options.schema || schema), schemaChanged: false };
  const policyCalls = [];
  let fetchPolicy = async (url, request) => {
    const tableId = decodeURIComponent(url.split('/').at(-1));
    policyCalls.push([url, request]);
    if (request.method === 'PUT') {
      const update = JSON.parse(request.body);
      policy = { ...policy, ...update, revision: update.revision + 1, configured: true };
    }
    return { ok: true, json: async () => ({ ...structuredClone(policy), tableId }) };
  };
  const sandbox = {
    ...domain, ...audit, ...columnAccess, crypto: webcrypto, TextEncoder, document, window: { APP_CONFIG: {} }, structuredClone,
    confirm: () => true, Blob,
    fetch: (...args) => fetchPolicy(...args),
    URL: { createObjectURL: () => { exports++; return 'blob:test'; }, revokeObjectURL() {} }
  };
  runInNewContext(`${source}\nglobalThis.app = { state, selectTable, clearSelectedTable, openRowDialog, saveRow, deleteRow, exportRows, allPages, refreshColumnAccess, openColumnDialog, closeColumnDialog, saveColumnAccess, requestColumnAccess };`, sandbox);
  const app = sandbox.app;
  app.state.role = options.role || 'admin';
  app.state.client = { authentications: { 'PureCloud OAuth': { accessToken: 'current-sdk-token' } } };
  app.state.tables = [A, B];
  const writes = [];
  const reads = [];
  app.state.architect = {
    async getFlowsDatatable(id) { reads.push(id); return { schema: options.schema || schema }; },
    async getFlowsDatatableRows(id) { return { entities: [structuredClone(options.row || (id === 'A' ? rowA : rowB))] }; },
    async getFlowsDatatableRow(id, key, requestOptions) {
      assert.equal(requestOptions.showbrief, false);
      return structuredClone(options.row || (id === 'A' ? rowA : rowB));
    },
    async putFlowsDatatableRow(...args) { writes.push(['put', ...args]); },
    async postFlowsDatatableRows(...args) { writes.push(['post', ...args]); },
    async deleteFlowsDatatableRow(...args) { writes.push(['delete', ...args]); }
  };
  return { ...app, elements, writes, reads, exports: () => exports, policyCalls,
    setPolicy: next => { policy = { ...policy, ...next }; },
    setFetch: fetch => { fetchPolicy = fetch; }
  };
}

const actions = f => f.elements.get('rowTable').querySelectorAll('button');
const input = (f, name) => f.elements.get('rowFields').querySelectorAll('[data-field]').find(field => field.dataset.field === name);
const tick = () => new Promise(resolve => setImmediate(resolve));


function fingerprint(schema) {
  return createHash('sha256').update(JSON.stringify({ properties: Object.keys(schema.properties || {}).sort().map(name => [name, schema.properties[name].type]), required: [...new Set(schema.required || [])].sort() })).digest('hex');
}
export { fingerprint, fixture, Element, A, B, rowA, rowB, schema, actions, input, tick, submit, deferred, html };
