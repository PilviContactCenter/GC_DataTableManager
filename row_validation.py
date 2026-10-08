"""Validate Data Table form values before sending them to Genesys Cloud."""

import math
import re


def parse_row_form(properties, form, *, existing=None, writable_columns=None, required=()):
    """Return (row data, errors) for a create or update form.

    On update, fields that were not submitted keep their existing values. An
    unchecked writable checkbox is the one exception: it becomes False.
    """
    row = existing.copy() if existing is not None else {}
    errors = []
    required = set(required or ())

    for name, definition in properties.items():
        if name == 'key' or (writable_columns is not None and name not in writable_columns):
            continue

        field_type = definition.get('type')
        if field_type == 'boolean':
            row[name] = name in form
            continue

        if name not in form:
            if existing is None and name in required:
                errors.append(f'{name} is required.')
            continue

        raw_value = form.get(name, '')
        if raw_value is None:
            raw_value = ''
        value = raw_value.strip()

        if not value:
            if name in required:
                errors.append(f'{name} is required.')
            elif field_type in ('integer', 'number'):
                if existing is None:
                    row.pop(name, None)
                # An empty optional numeric field on edit keeps its old value.
            else:
                row[name] = ''
            continue

        if field_type == 'integer':
            if not re.fullmatch(r'[+-]?\d+', value):
                errors.append(f'{name} must be a whole number.')
                continue
            row[name] = int(value)
        elif field_type == 'number':
            try:
                number = float(value)
            except ValueError:
                errors.append(f'{name} must be a number.')
                continue
            if not math.isfinite(number):
                errors.append(f'{name} must be a finite number.')
                continue
            row[name] = number
        else:
            row[name] = raw_value

    return row, errors
