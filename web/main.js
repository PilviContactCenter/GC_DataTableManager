import { roleFromGroups, columnsFor, parseRow } from './domain.js';
import { validateColumnAccess, userEditableColumns, sameColumnAccess, columnSchemaFingerprint } from './column-access.js';
import { AUDIT_PAGE_SIZE, createAuditSession, auditSessionQuery, mergeAuditEntries, auditRowKey, auditChanges } from './audit.js';

const $ = id => document.getElementById(id);
const config = window.APP_CONFIG || {};
const state = {
  sdk: null, client: null, architect: null, audits: null, users: null, role: null,
  tables: [], table: null, schema: null, rows: [], dialog: null, shown: 100, loadId: 0,
  columnAccess: null, columnAccessError: '', columnAccessPending: null, columnDialog: null,
  auditEntries: [], auditPage: 0, auditPageCount: 0, auditTotal: 0, auditLoadId: 0,
  auditSession: null, auditPending: null,
  actorNames: new Map(), actorLookupDenied: false
};

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
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return [config.clientId, config.adminGroupId, config.userGroupId].every(value => typeof value === 'string' && uuid.test(value))
    && config.adminGroupId.toLowerCase() !== config.userGroupId.toLowerCase()
    && typeof config.region === 'string' && /^[a-z0-9_]+$/.test(config.region);
}

async function signIn() {
  clearNotice();
  const button = $('signInButton');
  setBusy(button, true, 'Opening sign-in…');
  try {
    if (!hasConfig()) throw new Error('Set a valid Genesys OAuth client ID, region, and two different group IDs in Docker configuration.');
    if (!state.sdk && !window.require) throw new Error('Genesys SDK is still loading. Try again in a moment.');
    const sdk = state.sdk || window.require('platformClient');
    const region = Object.hasOwn(sdk.PureCloudRegionHosts, config.region) && sdk.PureCloudRegionHosts[config.region];
    if (!region) throw new Error(`Unknown Genesys region: ${config.region}`);
    const client = state.client || sdk.ApiClient.instance;
    client.setEnvironment(region);
    state.sdk = sdk;
    state.client = client;
    const redirectUri = new URL('/auth-popup.html', location.href).href;
    const codeVerifier = client.generatePKCECodeVerifier(128);
    await state.client.loginPKCEGrant(config.clientId, redirectUri, {
      state: crypto.randomUUID(),
      authPopupConfiguration: { usePopup: true, popupTimeout: 120000 }
    }, codeVerifier);
    state.users = new state.sdk.UsersApi();
    const user = await state.users.getUsersMe({ expand: ['groups'] });
    state.role = roleFromGroups(user.groups, config.adminGroupId, config.userGroupId);
    if (!state.role) {
      notice('Your Genesys account needs the Data Table Admin or Data Table User group.');
      return;
    }
    state.architect = new state.sdk.ArchitectApi();
    if (state.role === 'admin') state.audits = new state.sdk.AuditApi();
    $('userName').textContent = user.name || user.email || '';
    $('roleBadge').textContent = state.role === 'admin' ? 'Admin' : 'User';
    $('roleBadge').hidden = false;
    $('signOutButton').hidden = false;
    $('welcome').hidden = true;
    $('workspace').hidden = false;
    $('addRowButton').hidden = state.role !== 'admin';
    $('exportButton').hidden = state.role !== 'admin';
    $('historyButton').hidden = state.role !== 'admin';
    $('columnAccessButton').hidden = state.role !== 'admin';
    await loadTables();
  } catch (error) {
    notice(`Sign-in failed: ${errorMessage(error)}`);
  } finally {
    setBusy(button, false);
  }
}

async function allPages(loadPage, pageSize = 100) {
  const entries = [];
  const maxPages = 1000;
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    const result = await loadPage(pageNumber, pageSize);
    const batch = result?.entities || [];
    entries.push(...batch);
    const hasMore = result.nextUri || (result.pageCount ? pageNumber < result.pageCount : batch.length >= pageSize);
    if (!hasMore) return entries;
  }
  throw new Error(`The table exceeds the ${maxPages}-page loading limit. No partial results were loaded.`);
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
  state.loadId++;
  closeAuditHistory();
  state.table = null;
  clearTableRows();
  $('noTable').hidden = false;
  $('tableView').hidden = true;
  renderTables();
}

function clearTableRows() {
  closeRowDialog();
  closeColumnDialog();
  state.columnAccess = null;
  state.columnAccessError = '';
  state.columnAccessPending = null;
  $('columnAccessStatus').textContent = '';
  state.schema = null;
  state.rows = [];
  $('rowTable').querySelector('thead').replaceChildren();
  $('rowTable').querySelector('tbody').replaceChildren();
  $('rowCount').textContent = '0 rows';
  $('rowsEmpty').hidden = true;
  $('loadMoreButton').hidden = true;
  setRowControls(false);
}

function setRowControls(ready) {
  for (const id of ['addRowButton', 'exportButton', 'rowSearch', 'loadMoreButton']) $(id).disabled = !ready;
  $('columnAccessButton').disabled = !ready;
  $('refreshColumnAccessButton').disabled = !ready || Boolean(state.columnAccessPending);
}

async function requestColumnAccess(tableId, update) {
  const token = state.client?.authentications?.['PureCloud OAuth']?.accessToken;
  if (!token) throw new Error('Sign in again to load column access.');
  const response = await fetch(`/api/column-access/${encodeURIComponent(tableId)}`, {
    method: update ? 'PUT' : 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: { Authorization: `Bearer ${token}`, ...(update ? { 'Content-Type': 'application/json' } : {}) },
    ...(update ? { body: JSON.stringify(update) } : {})
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Could not load column access.');
  return validateColumnAccess(body, tableId);
}

function editableColumns() {
  return state.columnAccessPending || state.columnAccessError ? [] : userEditableColumns(state.columnAccess, state.schema);
}

function renderColumnAccess() {
  const policy = state.columnAccess;
  $('columnAccessStatus').textContent = state.columnAccessPending ? 'Loading column access…' : state.columnAccessError ?
    `Column access unavailable. ${state.columnAccessError}` : policy?.schemaChanged ?
    'Table columns changed. An Admin must review User editable columns.' : !policy?.configured ?
    'User edits are read-only until an Admin selects editable columns.' :
    `${editableColumns().length} columns editable by Users in this app.`;
  $('refreshColumnAccessButton').disabled = !state.schema || Boolean(state.columnAccessPending);
  $('columnAccessButton').disabled = !state.schema || Boolean(state.columnAccessPending);
  if (state.schema) renderRows();
}

async function refreshColumnAccess(context = tableContext()) {
  if (!isCurrentTable(context) || state.columnDialog) return;
  const request = { context };
  state.columnAccessPending = request;
  state.columnAccessError = '';
  renderColumnAccess();
  try {
    const policy = await requestColumnAccess(context.table.id);
    if (state.columnAccessPending !== request || !isCurrentTable(context)) return;
    const fingerprint = await columnSchemaFingerprint(context.schema);
    if (state.columnAccessPending !== request || !isCurrentTable(context)) return;
    if (fingerprint !== policy.schemaFingerprint) throw new Error('Table columns changed while loading. Refresh the table to review column access.');
    state.columnAccess = policy;
  } catch (error) {
    if (state.columnAccessPending !== request || !isCurrentTable(context)) return;
    state.columnAccess = null;
    state.columnAccessError = errorMessage(error);
  } finally {
    if (state.columnAccessPending === request && isCurrentTable(context)) {
      state.columnAccessPending = null;
      renderColumnAccess();
    }
  }
}

function tableContext() {
  return { table: state.table, schema: state.schema, loadId: state.loadId };
}

function isCurrentTable(context) {
  return Boolean(context?.schema && context.loadId === state.loadId && context.table?.id === state.table?.id && context.schema === state.schema);
}

async function selectTable(table) {
  const loadId = ++state.loadId;
  if (state.table?.id !== table.id) closeAuditHistory();
  state.table = table;
  clearTableRows();
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
    setRowControls(true);
    $('tableHint').textContent = '';
    renderRows();
    await refreshColumnAccess(tableContext());
    if (loadId !== state.loadId) return;
    if (!$('auditPanel').hidden && state.role === 'admin') await loadAuditHistory(1);
  } catch (error) {
    if (loadId !== state.loadId) return;
    $('tableHint').textContent = 'Could not load rows';
    notice(`Could not open this table: ${errorMessage(error)}`);
  }
}

function renderRows() {
  if (!state.schema) return;
  const context = tableContext();
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
    edit.disabled = state.role !== 'admin' && editableColumns().length === 0;
    if (edit.disabled) edit.title = 'No columns are currently editable by Users in this app.';
    edit.addEventListener('click', () => openRowDialog(row, context));
    actions.append(edit);
    if (state.role === 'admin') {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Delete';
      remove.className = 'delete';
      remove.addEventListener('click', () => deleteRow(row, context));
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

function closeAuditHistory() {
  state.auditLoadId++;
  state.auditSession = null;
  state.auditPending = null;
  state.auditEntries = [];
  state.auditPage = 0;
  state.auditPageCount = 0;
  state.auditTotal = 0;
  $('auditPanel').hidden = true;
  $('historyButton').setAttribute('aria-expanded', 'false');
  $('auditList').replaceChildren();
  $('auditStatus').textContent = '';
  $('loadMoreAuditButton').hidden = true;
  setAuditBusy(false);
}

function setAuditBusy(busy, pageNumber) {
  $('auditRange').disabled = busy;
  $('refreshAuditButton').disabled = busy;
  $('loadMoreAuditButton').disabled = busy;
  $('refreshAuditButton').textContent = busy && pageNumber === 1 ? 'Loading…' : 'Refresh history';
  $('loadMoreAuditButton').textContent = busy && pageNumber > 1 ? 'Loading…' : 'Show more changes';
}

function isCurrentAuditRequest(request) {
  return state.auditPending === request && state.auditSession === request.session &&
    request.loadId === state.auditLoadId && state.table?.id === request.session.tableId &&
    Number($('auditRange').value) === request.session.days && !$('auditPanel').hidden;
}

async function toggleAuditHistory() {
  if (state.role !== 'admin' || !state.table) return;
  if (!$('auditPanel').hidden) {
    closeAuditHistory();
    return;
  }
  $('auditPanel').hidden = false;
  $('historyButton').setAttribute('aria-expanded', 'true');
  await loadAuditHistory(1);
}

async function loadAuditHistory(pageNumber = 1) {
  if (state.role !== 'admin' || !state.table || $('auditPanel').hidden) return;
  const tableId = state.table.id;
  const days = Number($('auditRange').value);
  if (pageNumber === 1) {
    // Controls are disabled while loading. A range/table change still replaces
    // the session if triggered programmatically or by another table refresh.
    if (state.auditPending && state.auditSession?.tableId === tableId && state.auditSession.days === days) return;
    state.auditSession = createAuditSession(tableId, days, new Date());
    state.auditEntries = [];
    state.auditPage = 0;
    state.auditPageCount = 0;
    state.auditTotal = 0;
    $('auditList').replaceChildren();
    $('loadMoreAuditButton').hidden = true;
  } else if (state.auditPending || !state.auditSession || state.auditSession.tableId !== tableId ||
    state.auditSession.days !== days || pageNumber !== state.auditPage + 1 || pageNumber > state.auditPageCount) {
    return;
  }
  const request = { loadId: ++state.auditLoadId, session: state.auditSession };
  state.auditPending = request;
  setAuditBusy(true, pageNumber);
  $('auditStatus').textContent = 'Loading change history…';
  try {
    const query = auditSessionQuery(request.session, pageNumber);
    const result = await state.audits.postAuditsQueryRealtime(query);
    if (!isCurrentAuditRequest(request)) return;
    state.auditEntries = mergeAuditEntries(state.auditEntries, result.entities || []);
    state.auditPage = pageNumber;
    state.auditPageCount = result.pageCount ?? Math.ceil((result.total ?? state.auditEntries.length) / AUDIT_PAGE_SIZE);
    state.auditTotal = result.total ?? state.auditEntries.length;
    renderAuditHistory();
    void resolveAuditActors(request.loadId);
  } catch (error) {
    if (isCurrentAuditRequest(request)) $('auditStatus').textContent = `Could not load change history: ${errorMessage(error)}`;
  } finally {
    // An older request must not enable controls owned by a newer session.
    if (state.auditPending === request) {
      state.auditPending = null;
      setAuditBusy(false);
    }
  }
}

function auditActor(event) {
  if (event.user?.name) return event.user.name;
  if (event.user?.id) return state.actorNames.get(event.user.id) || `User ${event.user.id}`;
  if (event.application) return event.application;
  if (event.client?.id) return `OAuth client ${event.client.id}`;
  return 'Genesys Cloud';
}

function renderAuditHistory() {
  const list = $('auditList');
  list.replaceChildren();
  if (!state.auditEntries.length) {
    $('auditStatus').textContent = 'No changes found for this table in the selected period.';
  } else {
    $('auditStatus').textContent = `Showing ${state.auditEntries.length} of ${state.auditTotal} events.`;
  }
  for (const event of state.auditEntries) {
    const item = document.createElement('details');
    item.className = 'audit-event';
    const summary = document.createElement('summary');
    const time = document.createElement('time');
    time.className = 'audit-time';
    const date = new Date(event.eventDate);
    time.textContent = Number.isNaN(date.getTime()) ? (event.eventDate || 'Unknown time') : date.toLocaleString();
    const action = document.createElement('strong');
    action.textContent = `${event.action || 'Change'} ${event.entityType === 'Schema' ? 'table settings' : (event.entityType || 'item').toLowerCase()}`;
    const target = document.createElement('span');
    const rowKey = auditRowKey(event);
    target.textContent = rowKey ? `Row: ${rowKey}` : '';
    const actor = document.createElement('span');
    actor.className = 'audit-actor';
    if (event.user?.id) actor.dataset.userId = event.user.id;
    actor.textContent = auditActor(event);
    summary.append(time, action, target, actor);
    if (event.status && event.status !== 'SUCCESS') {
      const status = document.createElement('span');
      status.className = 'audit-result';
      status.textContent = event.status;
      summary.append(status);
    }
    item.append(summary);

    const changes = auditChanges(event);
    if (changes.length) {
      const wrap = document.createElement('div');
      wrap.className = 'audit-changes-wrap';
      const table = document.createElement('table');
      table.className = 'audit-changes';
      const head = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const label of ['Field', 'Before', 'After']) {
        const th = document.createElement('th');
        th.textContent = label;
        headRow.append(th);
      }
      head.append(headRow);
      const body = document.createElement('tbody');
      for (const change of changes) {
        const row = document.createElement('tr');
        for (const value of [change.field, change.before, change.after]) {
          const cell = document.createElement('td');
          cell.textContent = value;
          row.append(cell);
        }
        body.append(row);
      }
      table.append(head, body);
      wrap.append(table);
      item.append(wrap);
    } else {
      const empty = document.createElement('p');
      empty.className = 'audit-no-values';
      empty.textContent = 'Genesys Cloud did not include field values for this event.';
      item.append(empty);
    }
    list.append(item);
  }
  $('loadMoreAuditButton').hidden = state.auditPage >= state.auditPageCount;
}

async function resolveAuditActors(loadId) {
  if (state.actorLookupDenied) return;
  const ids = [...new Set(state.auditEntries.map(event => event.user?.id).filter(Boolean))];
  for (const id of ids) {
    if (state.actorNames.has(id)) continue;
    try {
      const user = await state.users.getUser(id);
      state.actorNames.set(id, user.name || user.email || `User ${id}`);
    } catch (error) {
      if (error?.status === 403 || error?.statusCode === 403) {
        state.actorLookupDenied = true;
        break;
      }
      state.actorNames.set(id, `User ${id}`);
    }
    if (loadId !== state.auditLoadId) return;
    for (const actor of $('auditList').querySelectorAll('.audit-actor[data-user-id]')) {
      if (actor.dataset.userId === id) actor.textContent = state.actorNames.get(id);
    }
  }
}

function closeRowDialog() {
  state.dialog = null;
  if ($('rowDialog').open) $('rowDialog').close();
}

function closeColumnDialog() {
  state.columnDialog = null;
  if ($('columnAccessDialog').open) $('columnAccessDialog').close();
}

function isCurrentColumnDialog(dialog) {
  return state.role === 'admin' && state.columnDialog === dialog && $('columnAccessDialog').open && isCurrentTable(dialog);
}

function renderColumnChoices(dialog) {
  const fields = $('columnAccessFields');
  fields.replaceChildren();
  for (const [name, definition] of Object.entries(dialog.schema.properties || {})) {
    if (name === 'key') continue;
    const label = document.createElement('label');
    label.className = 'column-choice';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.column = name;
    checkbox.id = `column-access-${name}`;
    checkbox.checked = dialog.policy.editableColumns.includes(name);
    const title = document.createElement('span');
    title.textContent = definition.title || name;
    const identifier = document.createElement('small');
    identifier.textContent = `Column ID: ${name}`;
    label.htmlFor = checkbox.id;
    label.append(checkbox, title, identifier);
    fields.append(label);
  }
}

async function loadColumnDialog(dialog) {
  if (!isCurrentColumnDialog(dialog) || dialog.loading || dialog.saving) return;
  dialog.loading = true;
  dialog.policy = null;
  $('saveColumnAccessButton').disabled = true;
  $('reloadColumnAccessButton').disabled = true;
  $('columnAccessFields').replaceChildren();
  $('columnAccessError').textContent = 'Loading column access…';
  try {
    const policy = await requestColumnAccess(dialog.table.id);
    if (!isCurrentColumnDialog(dialog)) return;
    const fingerprint = await columnSchemaFingerprint(dialog.schema);
    if (!isCurrentColumnDialog(dialog)) return;
    if (fingerprint !== policy.schemaFingerprint) throw new Error('Table columns changed. Cancel and refresh the table before selecting columns.');
    dialog.policy = policy;
    state.columnAccess = policy;
    state.columnAccessError = '';
    renderColumnChoices(dialog);
    renderColumnAccess();
    $('columnAccessError').textContent = policy.schemaChanged ? 'Table columns changed. Review the selection and save to confirm.' : '';
  } catch (error) {
    if (isCurrentColumnDialog(dialog)) $('columnAccessError').textContent = errorMessage(error);
  } finally {
    dialog.loading = false;
    if (isCurrentColumnDialog(dialog)) {
      $('saveColumnAccessButton').disabled = !dialog.policy;
      $('reloadColumnAccessButton').disabled = false;
    }
  }
}

async function openColumnDialog() {
  const context = tableContext();
  if (state.role !== 'admin' || !isCurrentTable(context) || state.columnAccessPending) return;
  closeColumnDialog();
  const dialog = { ...context, policy: null, loading: false, saving: false };
  state.columnDialog = dialog;
  $('columnAccessTitle').textContent = `User editable columns — ${context.table.name || context.table.id}`;
  $('saveColumnAccessButton').textContent = 'Save selection';
  $('columnAccessDialog').showModal();
  await loadColumnDialog(dialog);
}

async function saveColumnAccess(event) {
  event.preventDefault();
  const dialog = state.columnDialog;
  if (!isCurrentColumnDialog(dialog) || !dialog.policy || dialog.loading || dialog.saving) return;
  const editableColumns = Array.from($('columnAccessFields').querySelectorAll('input')).filter(input => input.checked).map(input => input.dataset.column);
  // DOM tampering cannot add a column outside this dialog's captured schema.
  if (editableColumns.some(name => name === 'key' || !Object.hasOwn(dialog.schema.properties || {}, name))) return;
  dialog.saving = true;
  const button = $('saveColumnAccessButton');
  setBusy(button, true, 'Saving…');
  $('reloadColumnAccessButton').disabled = true;
  for (const input of $('columnAccessFields').querySelectorAll('input')) input.disabled = true;
  $('columnAccessError').textContent = '';
  try {
    const policy = await requestColumnAccess(dialog.table.id, {
      revision: dialog.policy.revision, editableColumns, schemaFingerprint: dialog.policy.schemaFingerprint
    });
    if (!isCurrentColumnDialog(dialog)) return;
    state.columnAccess = policy;
    state.columnAccessError = '';
    renderColumnAccess();
    closeColumnDialog();
    notice('User editable columns saved for this app.', true);
  } catch (error) {
    if (isCurrentColumnDialog(dialog)) $('columnAccessError').textContent = `${errorMessage(error)} Your selection has been kept. Refresh policy to review the latest selection.`;
  } finally {
    dialog.saving = false;
    if (isCurrentColumnDialog(dialog)) {
      setBusy(button, false);
      $('reloadColumnAccessButton').disabled = false;
      for (const input of $('columnAccessFields').querySelectorAll('input')) input.disabled = false;
    }
  }
}

function sameRow(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameRow(left[key], right[key]));
}

function openRowDialog(row = null, context = tableContext()) {
  if (!isCurrentTable(context) || (row && !state.rows.includes(row))) return;
  if (!row && state.role !== 'admin') return;
  const allowed = state.role === 'admin' ? null : editableColumns();
  if (allowed && !allowed.length) return;
  closeRowDialog();
  state.dialog = { ...context, row: row ? structuredClone(row) : null, saving: false,
    role: state.role, allowed, policy: allowed ? structuredClone(state.columnAccess) : null };
  $('dialogTitle').textContent = row ? `Edit ${row.key || 'row'}` : 'Add row';
  $('saveRowButton').textContent = row ? 'Save changes' : 'Create row';
  $('saveRowButton').disabled = false;
  $('formError').hidden = true;
  const fields = $('rowFields');
  fields.replaceChildren();
  const names = columnsFor(state.schema);
  for (const name of names) {
    const definition = state.schema.properties?.[name] || {};
    const type = name === 'key' ? 'string' : definition.type || 'string';
    const value = row ? row[name] : definition.default;
    const wrapper = document.createElement('div');
    wrapper.className = `field${type === 'boolean' ? ' checkbox' : ''}`;
    const label = document.createElement('label');
    label.textContent = `${definition.title || name}${name === 'key' || state.schema.required?.includes(name) ? ' *' : ''}`;
    const input = document.createElement('input');
    input.id = `field-${name}`;
    input.dataset.field = name;
    input.name = name;
    label.htmlFor = input.id;
    const locked = name === 'key' && row || allowed && !allowed.includes(name);
    if (locked && allowed) label.textContent += ' (locked by column access)';
    if (type === 'boolean') {
      input.type = 'checkbox';
      input.checked = Boolean(value);
      input.disabled = Boolean(locked);
      wrapper.append(input, label);
    } else {
      input.type = type === 'integer' || type === 'number' ? 'number' : 'text';
      if (type === 'number') input.step = 'any';
      if (type === 'integer') input.step = '1';
      input.className = 'input';
      input.value = value ?? '';
      input.required = name === 'key' || Boolean(state.schema.required?.includes(name));
      input.readOnly = Boolean(locked);
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
  const dialog = state.dialog;
  if (!dialog || dialog.saving || !$('rowDialog').open || !isCurrentTable(dialog)) return;
  const form = $('rowForm');
  if (!form.reportValidity()) return;
  const values = {};
  for (const input of form.querySelectorAll('[data-field]')) {
    // Preserve all forbidden properties, including optional fields absent in
    // the original row, even if a caller changes locked controls in the DOM.
    if (dialog.allowed && !dialog.allowed.includes(input.dataset.field)) continue;
    values[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.value;
  }
  const { row, errors } = parseRow(dialog.schema, values, dialog.row);
  if (errors.length) {
    $('formError').textContent = errors.join(' ');
    $('formError').hidden = false;
    return;
  }
  const button = $('saveRowButton');
  dialog.saving = true;
  setBusy(button, true, 'Saving…');
  try {
    if (state.role !== dialog.role) throw new Error('Your app role changed. Cancel and reopen this row.');
    if (dialog.row) {
      if (dialog.allowed) {
        const policy = await requestColumnAccess(dialog.table.id);
        if (state.dialog !== dialog || !isCurrentTable(dialog)) return;
        if (state.role !== dialog.role || !sameColumnAccess(dialog.policy, policy) || !policy.configured || !userEditableColumns(policy, dialog.schema).length) {
          throw new Error('Column access changed since you opened this row. Your draft has been kept. Cancel and refresh column access before editing again.');
        }
      }
      // Keep the row freshness read adjacent to the SDK write. Policy checks
      // can take several requests; a row changed during them must be detected.
      const current = await state.architect.getFlowsDatatableRow(dialog.table.id, dialog.row.key, { showbrief: false });
      if (state.dialog !== dialog || !isCurrentTable(dialog)) return;
      if (!sameRow(current, dialog.row)) throw new Error('This row changed since you opened it. Your draft has been kept. Cancel and refresh the table before editing again.');
      if (state.role !== dialog.role) throw new Error('Your app role changed. Cancel and reopen this row.');
      await state.architect.putFlowsDatatableRow(dialog.table.id, dialog.row.key, { body: row });
    } else await state.architect.postFlowsDatatableRows(dialog.table.id, row);
    if (state.dialog !== dialog || !isCurrentTable(dialog)) return;
    closeRowDialog();
    notice(dialog.row ? 'Row updated.' : 'Row created.', true);
    await selectTable(dialog.table);
  } catch (error) {
    if (state.dialog !== dialog || !isCurrentTable(dialog)) return;
    $('formError').textContent = errorMessage(error);
    $('formError').hidden = false;
  } finally {
    dialog.saving = false;
    if (state.dialog === dialog) setBusy(button, false);
  }
}

async function deleteRow(row, context = tableContext()) {
  if (state.role !== 'admin' || !isCurrentTable(context) || !state.rows.includes(row)) return;
  const key = row.key;
  const original = structuredClone(row);
  if (!confirm(`Delete row "${key}"? This cannot be undone.`) || !isCurrentTable(context)) return;
  try {
    const current = await state.architect.getFlowsDatatableRow(context.table.id, key, { showbrief: false });
    if (!isCurrentTable(context)) return;
    if (!sameRow(current, original)) throw new Error('This row changed since it was loaded. Refresh the table before deleting it.');
    await state.architect.deleteFlowsDatatableRow(context.table.id, key);
    if (!isCurrentTable(context)) return;
    notice('Row deleted.', true);
    if (!state.dialog) await selectTable(context.table);
  } catch (error) {
    if (isCurrentTable(context)) notice(`Could not delete row: ${errorMessage(error)}`);
  }
}

function exportRows() {
  if (state.role !== 'admin' || !isCurrentTable(tableContext())) return;
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
  $('historyButton').addEventListener('click', toggleAuditHistory);
  $('columnAccessButton').addEventListener('click', openColumnDialog);
  $('refreshColumnAccessButton').addEventListener('click', () => refreshColumnAccess());
  $('columnAccessForm').addEventListener('submit', saveColumnAccess);
  $('reloadColumnAccessButton').addEventListener('click', () => state.columnDialog && loadColumnDialog(state.columnDialog));
  $('closeColumnAccessButton').addEventListener('click', closeColumnDialog);
  $('cancelColumnAccessButton').addEventListener('click', closeColumnDialog);
  $('columnAccessDialog').addEventListener('cancel', event => { event.preventDefault(); closeColumnDialog(); });
  $('columnAccessDialog').addEventListener('close', () => { if (!$('columnAccessDialog').open) state.columnDialog = null; });
  $('closeAuditButton').addEventListener('click', closeAuditHistory);
  $('refreshAuditButton').addEventListener('click', () => loadAuditHistory(1));
  $('auditRange').addEventListener('change', () => loadAuditHistory(1));
  $('loadMoreAuditButton').addEventListener('click', () => loadAuditHistory(state.auditPage + 1));
  $('addRowButton').addEventListener('click', () => openRowDialog());
  $('exportButton').addEventListener('click', exportRows);
  $('loadMoreButton').addEventListener('click', () => { state.shown += 100; renderRows(); });
  $('closeDialogButton').addEventListener('click', closeRowDialog);
  $('cancelDialogButton').addEventListener('click', closeRowDialog);
  $('rowDialog').addEventListener('cancel', event => { event.preventDefault(); closeRowDialog(); });
  $('rowDialog').addEventListener('close', () => { if (!$('rowDialog').open) state.dialog = null; });
  $('rowForm').addEventListener('submit', saveRow);

  if (!hasConfig()) {
    $('signInButton').disabled = true;
    $('welcomeHint').textContent = 'Set the Genesys OAuth client ID, region, and group IDs in Docker configuration.';
    return;
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
