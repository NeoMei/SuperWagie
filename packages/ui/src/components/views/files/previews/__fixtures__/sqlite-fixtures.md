# SQLite preview samples

These files were generated locally with Python's standard sqlite3 module. They
contain synthetic test data only, use DELETE journal mode, and need no sidecar.
Tests load the bytes through Node's filesystem API and decode them with the
approved bundled SQL.js WASM. No native SQLite binding is required by UI tests.

- `quoted.sqlite`: a Chinese table name and a 9007199254740993 integer.
- `unsafe.sqlite`: a physical table with a generated expression, a recursive
  view and an FTS5 virtual table with shadow tables. The preview selects only
  the safe physical column.
- `rows.sqlite`: 105 rows with 1,200-character text values for paging and display
  truncation.
- `wide.sqlite`: 65 columns, exceeding the preview's column budget.
- `plain.sqlite`: a small ordinary database used for malformed/WAL checks.
- `invoice.sqlite`: one Chinese value for actual-worker byte ownership checks.
- `picker.sqlite`: tables A and B, with 105 values in A for mounted picker and
  pager tests.
