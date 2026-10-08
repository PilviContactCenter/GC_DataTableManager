import unittest

from row_validation import parse_row_form


PROPERTIES = {
    'key': {'type': 'string'},
    'name': {'type': 'string'},
    'count': {'type': 'integer'},
    'rate': {'type': 'number'},
    'enabled': {'type': 'boolean'},
}


class ParseRowFormTests(unittest.TestCase):
    def test_create_converts_valid_values(self):
        row, errors = parse_row_form(
            PROPERTIES,
            {'name': '  Sales  ', 'count': '12', 'rate': '1.25', 'enabled': 'on'},
            required=['name'],
        )
        self.assertEqual(errors, [])
        self.assertEqual(row, {'name': '  Sales  ', 'count': 12, 'rate': 1.25, 'enabled': True})

    def test_invalid_numbers_are_rejected_instead_of_becoming_zero(self):
        row, errors = parse_row_form(
            PROPERTIES, {'count': '1.5', 'rate': 'NaN'},
            existing={'key': 'a', 'count': 7, 'rate': 2.5},
        )
        self.assertEqual(row['count'], 7)
        self.assertEqual(row['rate'], 2.5)
        self.assertEqual(errors, [
            'count must be a whole number.',
            'rate must be a finite number.',
        ])

    def test_required_field_and_blank_optional_number(self):
        row, errors = parse_row_form(
            PROPERTIES, {'name': '   ', 'count': ''}, required=['name'],
        )
        self.assertEqual(errors, ['name is required.'])
        self.assertNotIn('count', row)

    def test_update_preserves_read_only_columns(self):
        row, errors = parse_row_form(
            PROPERTIES,
            {'name': 'Changed', 'count': '99', 'enabled': 'on'},
            existing={'key': 'a', 'name': 'Original', 'count': 3, 'enabled': False},
            writable_columns={'name'},
        )
        self.assertEqual(errors, [])
        self.assertEqual(row, {'key': 'a', 'name': 'Changed', 'count': 3, 'enabled': False})

    def test_unchecked_writable_checkbox_becomes_false(self):
        row, errors = parse_row_form(
            PROPERTIES, {}, existing={'key': 'a', 'enabled': True},
            writable_columns={'enabled'},
        )
        self.assertEqual(errors, [])
        self.assertFalse(row['enabled'])


if __name__ == '__main__':
    unittest.main()
