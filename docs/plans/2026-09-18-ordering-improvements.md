# Ordering improvements

Implement the five requested changes in the current Alabama Wholesale app.

- Search: reproduce stale search commits and bind all supported input/commit events without replacing the focused search field.
- Flavors: add a version-checked catalog flavor from the existing item selection and edit dialogs, retaining unfinished order entries and catalog permissions.
- Categories: store optional parentId, reject missing parents and cycles, expose horizontally scrolling category and child rows, include descendants when filtering, and allow parent assignment in management and product categorization.
- Order labels: use the store name plus a stable unique order/invoice identifier throughout lists, detail views and downloaded copies without renumbering historical invoices.
- Builder: default to smaller cards and offer Small/Medium/Large in builder settings and Workspace. Persist the choice per authenticated account.

Independent search, flavor and order naming work is delegated. Category hierarchy and builder settings stay together locally. Verify domain rules, account isolation, existing tests/build, and synthetic browser interactions at phone and desktop sizes. No production business data is used for tests.
