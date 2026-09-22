# Compact ordering and zero-price submission

The user approved the compact-row proposal and confirmed that unpriced products
must submit at $0. This continues the September 21 ordering fixes.

## Design

Build uses one continuous order sheet, with a short heading for each product and
one row per flavor. Quantities stay directly editable; amounts update in place.
Flavor changes, line notes and removal are in the row's Options dialog. Product
actions and draft tools remain available without repeating them on every line.
Order notes are collapsed until opened. A compact sticky total and Review action
remain reachable while scrolling. Existing per-user item-size settings adjust
spacing while retaining accessible touch controls.

Orders uses compact searchable rows showing the store/invoice, date, status and
amount, with one action to open details. Existing filters, pagination and access
rules remain in force.

An absent or null effective product price resolves to zero, after applying the
existing store/variant override precedence. Invalid amounts and invalid case
sizes remain errors. Submitted invoices freeze the calculated zero, so later
catalog changes cannot alter historical invoices. No product price is silently
written back to the catalog.

## Implementation and checks

- [x] Add backend regressions for unpriced/zero-override lines, mixed taxable
  orders, frozen invoice totals, inventory and idempotent submission; update
  `lib/domain.cjs` after observing the missing-price failure.
- [x] Add frontend pricing regressions for null/absent prices, zero overrides,
  invalid data and case conversion; update `linePrice` and review messaging in
  `public/app.js` to match server calculations.
- [x] Replace the builder card layout with the approved compact sheet and
  scoped `public/builder-layout.css`. Keep draft save/session guards and recovery.
- [x] Replace order-history cards with compact rows and scoped Orders styles.
- [x] Include new styles in the app shell, offline cache and build checks.
- [x] Verify synthetic Chromium/WebKit flows on phone and desktop, quantity
  persistence, all size settings, notes/options, order search/details and zero
  price review/submission. Review screenshots and fix clipping or overlap.
- [x] Run the complete Node test suite, build, and diff checks. Record outcome
  and deployment status in the verification document.

No new dependencies or changes to authentication/tenant access are planned.
