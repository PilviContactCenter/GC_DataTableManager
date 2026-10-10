export function roleFromGroups(groups, adminGroupId, userGroupId) {
  const assigned = new Set((groups || []).map(group => String(group.id || '').toLowerCase()));
  if (assigned.has(String(adminGroupId).toLowerCase())) return 'admin';
  if (assigned.has(String(userGroupId).toLowerCase())) return 'user';
  return null;
}

export function columnsFor(schema, rows = []) {
  const propertyNames = Object.keys(schema?.properties || {});
  const rowNames = rows.length ? Object.keys(rows[0]) : [];
  return ['key', ...new Set([...propertyNames, ...rowNames].filter(name => name !== 'key'))];
}

export function parseRow(schema, values, existing = null) {
  const properties = schema?.properties || {};
  const required = new Set(schema?.required || []);
  const row = existing ? { ...existing } : {};
  const errors = [];
  const names = new Set(['key', ...Object.keys(properties)]);

  for (const name of names) {
    if (name === 'key' && existing) continue;
    const type = name === 'key' ? 'string' : properties[name]?.type || 'string';
    const raw = values[name];
    if (raw === undefined) {
      if (!existing && (name === 'key' || required.has(name))) errors.push(`${name} is required.`);
      continue;
    }
    if (type === 'boolean') {
      row[name] = Boolean(raw);
      continue;
    }
    const value = String(raw);
    const trimmed = value.trim();
    if (!trimmed) {
      if (name === 'key' || required.has(name)) errors.push(`${name} is required.`);
      else if (type === 'integer' || type === 'number') {
        delete row[name];
      } else row[name] = '';
      continue;
    }
    if (type === 'integer') {
      if (!/^[+-]?\d+$/.test(trimmed)) {
        errors.push(`${name} must be a whole number.`);
        continue;
      }
      const number = Number(trimmed);
      if (!Number.isSafeInteger(number)) errors.push(`${name} must be a safe whole number.`);
      else row[name] = number;
    } else if (type === 'number') {
      const number = Number(trimmed);
      if (!Number.isFinite(number)) errors.push(`${name} must be a finite number.`);
      else row[name] = number;
    } else {
      row[name] = name === 'key' ? trimmed : value;
    }
  }
  return { row, errors };
}
