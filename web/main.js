import { roleFromGroups, columnsFor, parseRow } from './domain.js';

const $ = id => document.getElementById(id);
const config = window.APP_CONFIG || {};
const state = { sdk: null, client: null, architect: null, role: null, tables: [], table: null, schema: null, rows: [], editRow: null, shown: 100, loadId: 0 };

function notice(message, success = false) {
  const element = $('notice');
  element.textContent = message;
  element.classList.toggle('success', success);
  element.hidden = false;
}

function clearNotice() { $('notice').hidden = true; }

function errorMessage(error) {
  if (error?.status === 403 || error?.statusCode === 403) return 'Your Genesys Cloud role does not allow this action.';
  const body = error?.response?.body || error?.body;
  return body?.message || error?.message || 'The request failed. Please try again.';
}

function setBusy(element, busy, busyText = 'Working…') {
  if (busy) {
    element.dataset.originalText = element.textContent;
    element.textContent = busyText;
    element.disabled = true;
  } else {
    element.textContent = element.dataset.originalText || element.textContent;
    element.disabled = false;
  }
}

function hasConfig() {
  return Boolean(config.clientId && config.adminGroupId && config.userGroupId && config.region);
}

async function signIn() {
  clearNotice();
  const button = $('signInButton');
  setBusy(button, true, 'Opening sign-in…');
  try {
    if (!state.client) {
      if (!window.require) throw new Error('Genesys SDK is still loading. Try again in a moment.');
      state.sdk = window.require('platformClient');
      state.client = state.sdk.ApiClient.instance;
      const region = state.sdk.PureCloudRegionHosts[config.region];
      if (!region) throw new Error(`Unknown Genesys region: ${config.region}`);
      state.client.setEnvironment(region);
    }
    const redirectUri = new URL('/auth-popup.html', location.href).href;
    await state.client.loginPKCEGrant(config.clientId, redirectUri, {
      state: crypto.randomUUID(),
      authPopupConfiguration: { usePopup: true, popupTimeout: 120000 }
    });
    const user = await new state.sdk.UsersApi().getUsersMe({ expand: ['groups'] });
    state.role = roleFromGroups(user.groups, config.adminGroupId, config.userGroupId);
    if (!state.role) {
      notice('Your Genesys account needs the Data Table Admin or Data Table User group.');
      return;
    }
    state.architect = new state.sdk.ArchitectApi();
    $('userName').textContent = user.name || user.email || '';
    $('roleBadge').textContent = state.role === 'admin' ? 'Admin' : 'User';
    $('roleBadge').hidden = false;
    $('signOutButton').hidden = false;
    $('welcome').hidden = true;
    $('workspace').hidden = false;
    $('addRowButton').hidden = state.role !== 'admin';
    $('exportButton').hidden = state.role !== 'admin';
    await loadTables();
  } catch (error) {
    notice(`Sign-in failed: ${errorMessage(error)}`);
  } finally {
    setBusy(button, false);
  }
}

async function allPages(loadPage, pageSize = 100) {
  const entries = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber++) {
    const result = await loadPage(pageNumber, pageSize);
    const batch = result?.entities || [];
    entries.push(...batch);
    if (batch.length < pageSize || (result.pageCount && pageNumber >= result.pageCount)) break;
  }
  return entries;
}

async function loadTables() {
  clearNotice();
  const button = $('refreshTablesButton');
  setBusy(button, true);
  try {
    state.tables = await allPages((pageNumber, pageSize) => state.architect.getFlowsDatatables({ pageNumber, pageSize, sortBy: 'name' }));
    state.tables.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    renderTables();
    if (state.table) {
      const current = state.tables.find(table => table.id === state.table.id);
      if (current) await selectTable(current);
      else clearSelectedTable();
    }
  } catch (error) {
    notice(`Could not load data tables: ${errorMessage(error)}`);
  } finally {
    setBusy(button, false);
  }
}

function renderTables() {
  const query = $('tableSearch').value.trim().toLowerCase();
  const visible = state.tables.filter(table => `${table.name || ''} ${table.description || ''}`.toLowerCase().includes(query));
  const list = $('tableList');
  list.replaceChildren();
  for (const table of visible) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = table.name || table.id;
    button.title = table.description || '';
    button.classList.toggle('active', state.table?.id === table.id);
    button.addEventListener('click', () => selectTable(table));
    list.append(button);
  }
  $('tableCount').textContent = `${visible.length} of ${state.tables.length} tables`;
}

function clearSelectedTable() {
  state.table = null;
  state.schema = null;
  state.rows = [];
  $('noTable').hidden = false;
  $('tableView').hidden = true;
  renderTables();
}

async function selectTable(table) {
  const loadId = ++state.loadId;
  state.table = table;
  state.rows = [];
  state.shown = 100;
  $('rowSearch').value = '';
  $('noTable').hidden = true;
  $('tableView').hidden = false;
  $('tableTitle').textContent = table.name || table.id;
  $('tableDescription').textContent = table.description || '';
  $('tableHint').textContent = 'Loading rows…';
  renderTables();
  try {
    const [details, rows] = await Promise.all([
      state.architect.getFlowsDatatable(table.id, { expand: 'schema' }),
      allPages((pageNumber, pageSize) => state.architect.getFlowsDatatableRows(table.id, { pageNumber, pageSize, showbrief: false }))
    ]);
    if (loadId !== state.loadId) return;
    state.schema = details.schema || { properties: {} };
    state.rows = rows;
    $('tableHint').textContent = '';
    renderRows();
  } catch (error) {
    if (loadId !== state.loadId) return;
    $('tableHint').textContent = 'Could not load rows';
    notice(`Could not open this table: ${errorMessage(error)}`);
  }
}

function renderRows() {
  const query = $('rowSearch').value.trim().toLowerCase();
  const filtered = state.rows.filter(row => !query || Object.values(row).some(value => String(value ?? '').toLowerCase().includes(query)));
  const columns = columnsFor(state.schema, state.rows);
  const headRow = document.createElement('tr');
  for (const name of columns) {
    const th = document.createElement('th');
    th.textContent = state.schema?.properties?.[name]?.title || name;
    headRow.append(th);
  }
  const actionsHead = document.createElement('th');
  actionsHead.textContent = 'Actions';
  headRow.append(actionsHead);
  $('rowTable').querySelector('thead').replaceChildren(headRow);

  const tbody = $('rowTable').querySelector('tbody');
  tbody.replaceChildren();
  for (const row of filtered.slice(0, state.shown)) {
    const tr = document.createElement('tr');
    for (const name of columns) {
      const td = document.createElement('td');
      const value = row[name];
      td.textContent = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
      if (name === 'key') td.className = 'row-key';
      td.title = td.textContent;
      tr.append(td);
    }
    const actionCell = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => openRowDialog(row));
    actions.append(edit);
    if (state.role === 'admin') {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Delete';
      remove.className = 'delete';
      remove.addEventListener('click', () => deleteRow(row));
      actions.append(remove);
    }
    actionCell.append(actions);
    tr.append(actionCell);
    tbody.append(tr);
  }
  $('rowCount').textContent = `${state.rows.length} ${state.rows.length === 1 ? 'row' : 'rows'}`;
  $('rowsEmpty').hidden = filtered.length > 0;
  $('loadMoreButton').hidden = filtered.length <= state.shown;
  $('loadMoreButton').textContent = `Show more rows (${filtered.length - state.shown} remaining)`;
}

function openRowDialog(row = null) {
  if (!state.table || !state.schema) return;
  if (!row && state.role !== 'admin') return;
  state.editRow = row;
  $('dialogTitle').textContent = row ? `Edit ${row.key || 'row'}` : 'Add row';
  $('saveRowButton').textContent = row ? 'Save changes' : 'Create row';
  $('formError').hidden = true;
  const fields = $('rowFields');
  fields.replaceChildren();
  const names = columnsFor(state.schema);
  for (const name of names) {
    const definition = state.schema.properties?.[name] || {};
    const type = name === 'key' ? 'string' : definition.type || 'string';
    const wrapper = document.createElement('div');
    wrapper.className = `field${type === 'boolean' ? ' checkbox' : ''}`;
    const label = document.createElement('label');
    label.textContent = `${definition.title || name}${name === 'key' || state.schema.required?.includes(name) ? ' *' : ''}`;
    const input = document.createElement('input');
    input.id = `field-${name}`;
    input.dataset.field = name;
    input.name = name;
    label.htmlFor = input.id;
    if (type === 'boolean') {
      input.type = 'checkbox';
      input.checked = Boolean(row?.[name]);
      wrapper.append(input, label);
    } else {
      input.type = type === 'integer' || type === 'number' ? 'number' : 'text';
      if (type === 'number') input.step = 'any';
      if (type === 'integer') input.step = '1';
      input.className = 'input';
      input.value = row?.[name] ?? '';
      input.required = name === 'key' || Boolean(state.schema.required?.includes(name));
      if (name === 'key' && row) input.readOnly = true;
      wrapper.append(label, input);
    }
    if (definition.description) {
      const help = document.createElement('small');
      help.textContent = definition.description;
      wrapper.append(help);
    }
    fields.append(wrapper);
  }
  $('rowDialog').showModal();
}

async function saveRow(event) {
  event.preventDefault();
  const form = $('rowForm');
  if (!form.reportValidity()) return;
  const values = {};
  for (const input of form.querySelectorAll('[data-field]')) {
    values[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.value;
  }
  const { row, errors } = parseRow(state.schema, values, state.editRow);
  if (errors.length) {
    $('formError').textContent = errors.join(' ');
    $('formError').hidden = false;
    return;
  }
  const button = $('saveRowButton');
  setBusy(button, true, 'Saving…');
  try {
    if (state.editRow) await state.architect.putFlowsDatatableRow(state.table.id, state.editRow.key, { body: row });
    else await state.architect.postFlowsDatatableRows(state.table.id, row);
    $('rowDialog').close();
    notice(state.editRow ? 'Row updated.' : 'Row created.', true);
    await selectTable(state.table);
  } catch (error) {
    $('formError').textContent = errorMessage(error);
    $('formError').hidden = false;
  } finally {
    setBusy(button, false);
  }
}

async function deleteRow(row) {
  if (state.role !== 'admin' || !confirm(`Delete row "${row.key}"? This cannot be undone.`)) return;
  try {
    await state.architect.deleteFlowsDatatableRow(state.table.id, row.key);
    notice('Row deleted.', true);
    await selectTable(state.table);
  } catch (error) {
    notice(`Could not delete row: ${errorMessage(error)}`);
  }
}

function exportRows() {
  if (state.role !== 'admin' || !state.table) return;
  const blob = new Blob([JSON.stringify(state.rows, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${state.table.name || state.table.id}-rows.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function init() {
  $('regionLabel').textContent = config.region || '';
  $('signInButton').addEventListener('click', signIn);
  $('signOutButton').addEventListener('click', () => location.reload());
  $('refreshTablesButton').addEventListener('click', loadTables);
  $('tableSearch').addEventListener('input', renderTables);
  $('rowSearch').addEventListener('input', () => { state.shown = 100; renderRows(); });
  $('refreshRowsButton').addEventListener('click', () => state.table && selectTable(state.table));
  $('addRowButton').addEventListener('click', () => openRowDialog());
  $('exportButton').addEventListener('click', exportRows);
  $('loadMoreButton').addEventListener('click', () => { state.shown += 100; renderRows(); });
  $('closeDialogButton').addEventListener('click', () => $('rowDialog').close());
  $('cancelDialogButton').addEventListener('click', () => $('rowDialog').close());
  $('rowForm').addEventListener('submit', saveRow);

  if (!hasConfig()) {
    $('signInButton').disabled = true;
    $('welcomeHint').textContent = 'Set the Genesys OAuth client ID, region, and group IDs in Docker configuration.';
    return;
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
