# Coverage gaps: the allow-list

This file lists the items of `docs/predbat-predheat-requirements.md` that `docs/coverage-matrix.json` marks `gap` **and** that cannot be stored by design (for example, an item that would need a vendor's own entity name, which the catalogue does not record). `test/coverage-matrix.test.js` reads the table below:

- every `gap` in the matrix must be listed here, with a reason;
- every row here must still be a `gap` in the matrix (no stale rows);
- the kind must be `not_storable_by_design`. A gap that is a missing column, table or registry key is never allowed here: the test fails until the schema element is added (a registry row in `src/db/seed/*.js` or `src/db/registry.js`, or a new delta), and the matrix is rebuilt.

Items that are not data at all (Home Assistant wiring, presentation, fixed code rules, archived keys) are not gaps: the matrix marks them `excluded_not_data` with their reason, and `docs/predbat-predheat-coverage.md` lists them.

**Current state (26 Oct 2026): no gaps.** Every missing schema element the matrix found was added (registry rows and delta 060; see `docs/predbat-predheat-coverage.md`), and no item needed an allow-list entry: where an item names a vendor entity (a commit button, a Home Assistant service), its data is covered and the entity name is noted as wiring.

| ID | Kind | Reason |
| --- | --- | --- |
