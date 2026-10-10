import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import vm from 'node:vm';
import * as domain from '../web/domain.js';
import * as audit from '../web/audit.js';

const mainSource = readFileSync(new URL('../web/main.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
const validConfig = {
  clientId: '11111111-1111-1111-1111-111111111111',
  adminGroupId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  userGroupId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  region: 'eu_central_1'
};

class Element {
  constructor() {
    this.dataset = {};
    this.children = [];
    this.textContent = '';
    this.classList = { toggle() {} };
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
  }
  set value(value) { this.inputValue = String(value); }
  get value() { return this.inputValue; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelectorAll() { return this.children.flatMap(child => child.dataset.field ? [child] : child.querySelectorAll()); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  reportValidity() { return true; }
  addEventListener() {}
}

function appHarness(configOverrides = {}, sdk) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  element('rowForm').querySelectorAll = () => element('rowFields').querySelectorAll();
  const window = { APP_CONFIG: { ...validConfig, ...configOverrides }, require: () => sdk };
  const context = vm.createContext({
    ...domain, ...audit, window, URL, crypto: { randomUUID },
    location: { href: 'https://app.example.com/' },
    document: { readyState: 'loading', addEventListener() {}, getElementById: element, createElement: () => new Element() }
  });
  for (const storage of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(context, storage, { get() { throw new Error('Storage access denied'); } });
    Object.defineProperty(window, storage, { get() { throw new Error('Storage access denied'); } });
  }
  vm.runInContext(`${mainSource}\nglobalThis.app = { state, config, hasConfig, signIn, openRowDialog, saveRow,
    stubLoads() { loadTables = async () => {}; selectTable = async () => {}; } };`, context);
  context.app.stubLoads();
  return { ...context.app, element };
}

function sdkHarness() {
  const calls = { logins: [], environments: [], verifierLengths: [] };
  const client = {
    hasLocalStorage: false,
    setEnvironment(region) { calls.environments.push(region); },
    generatePKCECodeVerifier(length) {
      calls.verifierLengths.push(length);
      return `${randomUUID()}${randomUUID()}${randomUUID()}${randomUUID()}`.slice(0, length);
    },
    async loginPKCEGrant(clientId, redirectUri, options, verifier) {
      // SDK 264 requires this fourth argument when storage is unavailable.
      if (!this.hasLocalStorage && !verifier) throw new Error('loginPKCEGrant requires Local Storage or codeVerifier as input parameter');
      calls.logins.push({ clientId, redirectUri, options, verifier });
    }
  };
  const sdk = {
    ApiClient: { instance: client },
    PureCloudRegionHosts: { eu_central_1: 'mypurecloud.de' },
    UsersApi: class { async getUsersMe() { return { name: 'Test user', groups: [{ id: validConfig.adminGroupId }] }; } },
    ArchitectApi: class {}, AuditApi: class {}
  };
  return { sdk, client, calls };
}

test('popup sign-in works without browser storage and uses a fresh verifier on each attempt', async () => {
  const { sdk, calls } = sdkHarness();
  const app = appHarness({}, sdk);
  await app.signIn();
  await app.signIn();
  assert.equal(app.state.role, 'admin');
  assert.equal(calls.logins.length, 2);
  assert.deepEqual(calls.verifierLengths, [128, 128]);
  assert.notEqual(calls.logins[0].verifier, calls.logins[1].verifier);
  for (const login of calls.logins) {
    assert.equal(login.verifier.length, 128);
    assert.equal(login.clientId, validConfig.clientId);
    assert.equal(login.redirectUri, 'https://app.example.com/auth-popup.html');
    assert.equal(login.options.authPopupConfiguration.usePopup, true);
  }
});

test('unknown and inherited region keys are rejected on every retry without publishing a client', async () => {
  for (const region of ['unknown_region', '__proto__']) {
    const { sdk, calls } = sdkHarness();
    const app = appHarness({ region }, sdk);
    await app.signIn();
    await app.signIn();
    assert.equal(app.state.client, null);
    assert.equal(app.state.sdk, null);
    assert.equal(calls.logins.length, 0);
    assert.equal(calls.environments.length, 0);
    assert.match(app.element('notice').textContent, /Unknown Genesys region/);
    assert.equal(app.element('signInButton').disabled, false);
    app.config.region = validConfig.region;
    await app.signIn();
    assert.equal(calls.logins.length, 1);
    assert.deepEqual(calls.environments, ['mypurecloud.de']);
  }
});

test('identical group UUIDs are rejected regardless of case, including after a valid attempt', async () => {
  const { sdk, calls } = sdkHarness();
  const app = appHarness({}, sdk);
  assert.equal(app.hasConfig(), true);
  await app.signIn();
  app.config.userGroupId = app.config.adminGroupId.toUpperCase();
  assert.equal(app.hasConfig(), false);
  await app.signIn();
  await app.signIn();
  assert.equal(calls.logins.length, 1);
  assert.match(app.element('notice').textContent, /two different group IDs/);
});

test('malformed IDs and region syntax cannot start sign-in', async () => {
  for (const override of [{ clientId: 'invalid' }, { adminGroupId: '' }, { region: 'https://mypurecloud.de' }]) {
    const { sdk, calls } = sdkHarness();
    const app = appHarness(override, sdk);
    assert.equal(app.hasConfig(), false);
    await app.signIn();
    assert.equal(app.state.client, null);
    assert.equal(calls.logins.length, 0);
  }
});

const defaultSchema = {
  properties: {
    key: { type: 'string' },
    title: { type: 'string', default: 'Default title' },
    empty: { type: 'string', default: '' },
    count: { type: 'integer', default: 0 },
    rate: { type: 'number', default: 0 },
    enabled: { type: 'boolean', default: true },
    disabled: { type: 'boolean', default: false }
  }, required: ['key', 'count', 'rate']
};

function rowHarness() {
  const app = appHarness();
  app.state.table = { id: 'table-id' };
  app.state.schema = defaultSchema;
  app.state.role = 'admin';
  const fields = () => Object.fromEntries(app.element('rowFields').querySelectorAll().map(input => [input.dataset.field, input]));
  return { ...app, fields };
}

test('new-row inputs show schema defaults and submission preserves true, false, zero and empty string', async () => {
  const app = rowHarness();
  let submitted;
  app.state.architect = { async postFlowsDatatableRows(tableId, body) { submitted = { tableId, body }; } };
  app.openRowDialog();
  const fields = app.fields();
  assert.equal(fields.title.value, 'Default title');
  assert.equal(fields.empty.value, '');
  assert.equal(fields.count.value, '0');
  assert.equal(fields.rate.value, '0');
  assert.equal(fields.enabled.checked, true);
  assert.equal(fields.disabled.checked, false);
  fields.key.value = 'new-key';
  await app.saveRow({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(submitted)), {
    tableId: 'table-id', body: { key: 'new-key', title: 'Default title', empty: '', count: 0, rate: 0, enabled: true, disabled: false }
  });
});

test('edit inputs retain explicit empty, zero and false values instead of schema defaults', async () => {
  const app = rowHarness();
  let submitted;
  app.state.architect = { async putFlowsDatatableRow(tableId, key, options) { submitted = { tableId, key, body: options.body }; } };
  const existing = { key: 'existing', title: '', empty: '', count: 0, rate: 0, enabled: false, disabled: false };
  app.openRowDialog(existing);
  const fields = app.fields();
  assert.equal(fields.title.value, '');
  assert.equal(fields.count.value, '0');
  assert.equal(fields.rate.value, '0');
  assert.equal(fields.enabled.checked, false);
  await app.saveRow({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(submitted)), { tableId: 'table-id', key: 'existing', body: existing });
});

test('Docker validator rejects case variants of the same group UUID and accepts distinct groups', t => {
  const gitSh = 'C:/Program Files/Git/bin/sh.exe';
  const shell = existsSync(gitSh) ? gitSh : 'sh';
  const source = readFileSync(new URL('../docker/validate-config.sh', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const run = userGroupId => spawnSync(shell, ['-s'], {
    input: source, encoding: 'utf8',
    env: { ...process.env, GENESYS_CLIENT_ID: validConfig.clientId, GENESYS_REGION: validConfig.region,
      GENESYS_ADMIN_GROUP_ID: validConfig.adminGroupId, GENESYS_USER_GROUP_ID: userGroupId }
  });
  const duplicate = run(validConfig.adminGroupId.toUpperCase());
  if (duplicate.error?.code === 'ENOENT') { t.skip('POSIX shell is required for Docker startup validation'); return; }
  assert.equal(duplicate.status, 1, duplicate.error?.message || duplicate.stderr);
  assert.match(duplicate.stderr, /Admin and user group IDs must be different/);
  const distinct = run(validConfig.userGroupId.toUpperCase());
  assert.equal(distinct.status, 0, distinct.error?.message || distinct.stderr);
});
