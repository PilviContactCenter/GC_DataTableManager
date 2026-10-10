// Policies apply to the controls and writes in this app.
export async function columnSchemaFingerprint(schema) {
  const canonical = JSON.stringify({
    properties: Object.keys(schema.properties || {}).sort().map(name => [name, schema.properties[name].type]),
    required: [...new Set(schema.required || [])].sort()
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function validateColumnAccess(policy, tableId) {
  if (!policy || policy.tableId !== tableId || !Number.isSafeInteger(policy.revision) || policy.revision < 0 ||
    typeof policy.configured !== 'boolean' || typeof policy.schemaChanged !== 'boolean' ||
    typeof policy.schemaFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(policy.schemaFingerprint) ||
    !Array.isArray(policy.editableColumns) || policy.editableColumns.some(name => typeof name !== 'string' || name === 'key') ||
    new Set(policy.editableColumns).size !== policy.editableColumns.length) {
    throw new Error('Invalid column access response. Refresh to try again.');
  }
  return policy;
}

export function userEditableColumns(policy, schema) {
  if (!policy?.configured || policy.schemaChanged) return [];
  return policy.editableColumns.filter(name => name !== 'key' && Object.hasOwn(schema?.properties || {}, name));
}

export function sameColumnAccess(left, right) {
  return Boolean(left && right && left.tableId === right.tableId && left.revision === right.revision &&
    left.schemaFingerprint === right.schemaFingerprint && left.configured === right.configured &&
    !right.schemaChanged && left.editableColumns.length === right.editableColumns.length &&
    left.editableColumns.every(name => right.editableColumns.includes(name)));
}
