export const AUDIT_PAGE_SIZE = 50;

export function auditQuery(tableId, days = 14, pageNumber = 1, now = new Date()) {
  if (!tableId || ![1, 7, 14].includes(days) || !Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new Error('Invalid audit query.');
  }
  const end = new Date(now);
  if (Number.isNaN(end.getTime())) throw new Error('Invalid audit query time.');
  // Keep the interval just inside the real-time API's 14-day maximum.
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000 + 1000);
  return {
    interval: `${start.toISOString()}/${end.toISOString()}`,
    serviceName: 'Datatables',
    filters: [{ property: 'EntityId', value: tableId }],
    sort: [{ name: 'Timestamp', sortOrder: 'descending' }],
    pageNumber,
    pageSize: AUDIT_PAGE_SIZE
  };
}

export function auditRowKey(event) {
  if (event?.entityType !== 'Row') return null;
  if (event.context?.key) return String(event.context.key);
  const keyChange = (event.propertyChanges || []).find(change => change.property === 'key');
  return keyChange?.newValues?.[0] || keyChange?.oldValues?.[0] || null;
}

export function auditChanges(event) {
  return (event?.propertyChanges || []).map(change => ({
    field: change.property || 'Field',
    before: (change.oldValues || []).join(', ') || '—',
    after: (change.newValues || []).join(', ') || '—'
  }));
}
