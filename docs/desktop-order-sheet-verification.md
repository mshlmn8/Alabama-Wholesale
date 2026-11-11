# Desktop order sheet and catalog sort: verification

Checked on 2026-11-11 against
`docs/superpowers/specs/2026-11-11-desktop-order-sheet-and-sort-design.md`.

## What changed

- The order-sheet design that shipped for phones is now the only design at
  every width. The old desktop catalog cards, add-only flow and Overview body
  are removed.
- From 1100px wide, a "Your order" panel sits beside the catalog with each
  line, subtotal, tax and estimated total. Between 801px and 1099px the order
  bar is used instead.
- The sidebar reads Home, Catalog, Order, History, Store inventory, Stores,
  More. Order and the top-bar cart show the number of items and update with
  every change.
- The catalog has a Sort control: Catalog order, Newest first, Oldest first,
  A–Z, Last ordered. The choice is remembered on the device.
- Fix: **Reorder** on Home now loads the last order in full before starting
  the new order. Before this, it started an empty order, because the app keeps
  order history as summaries without line items. This affected the phone
  release that is already live.

## Results

- **Automated tests:** `npm test` on Node 22: 904 passed, 0 failed, including
  new tests for the sort rules, the order panel rows, the remembered sort in
  the catalog page, and the stylesheet's phone and desktop sections.
  `npm run build` passed.
- **Desktop flow, Chromium at 1440×900, 18 checks passed:** empty panel beside
  the catalog; first `+` stays on the catalog; the panel itemises lines and
  totals; sidebar Order and the top-bar cart both show the item count; adding
  through More options stays on the catalog; A–Z, Newest first, Oldest first
  and Last ordered each give the expected order; sorting applies to search
  results; the choice survives a reload; Catalog order restores the original;
  at 1024px the order bar replaces the panel and clears the sidebar; the order
  page's `+` updates the sidebar count; Submit order opens "Review your
  order"; Home is two columns; Reorder brings back the last order's 2 lines
  and $105.84 total; no page errors.
- **Sort and panel edge cases, 7 checks passed:** while order history loads the
  list is dimmed and cannot be tapped; it then shows Last ordered; coming back
  to the catalog re-sorts at once with no new requests; a failed read is
  reported once and the sort returns to Catalog order, with no repeat on later
  visits; with 58 rows in the order panel the lines scroll and Review and
  submit stays on screen.
- **Phone flow and edge cases, Chromium at 390×844:** the 25 flow checks and
  12 edge-case checks from the phone release pass unchanged, apart from the
  breakpoint check now expecting the sidebar and order panel above 800px.
- **Overflow:** 126 cases at 320, 390, 800, 801, 1024, 1100 and 1440px, light
  and dark, across catalog (list with a product open, photos), Home, Order,
  History, More, Stores, Account and Notifications. None scrolled sideways.

## How it was run

`scripts/demo.cjs` logic with the Firebase Auth emulator and in-memory data,
seeded with nine real catalog products and their photos. Creation dates,
prices, stock and order history are synthetic. No production data was read or
changed and no email was sent.

## Independent review

A separate reviewer found no critical defect and five important ones. Four
are fixed, each with a failing test first: Last ordered read only the newest
page of orders across all stores, so it did nothing for a store whose orders
were not on that page; the list reordered under the user when history arrived
and dropped a typed quantity; a failed read repeated its error on every
catalog visit; a long order pushed the total and button out of the desktop
panel. Also fixed from the same review: empty dates treated as the start of
time, order dates taken from draft creation instead of submission, one
unreadable order failing the whole read, and the panel not showing case units
or the Standard option.

The fifth is not fixed and is listed under Limits (Newest and oldest).

## Limits

- **Last ordered** reads the selected store's 12 most recent submitted orders
  the first time it is chosen. A product last ordered before those 12 sorts as
  not ordered.
- **Newest and oldest** use each product's creation date, and products brought
  in from the old system have none. They sort after dated products, in catalog
  order. The first time such a product is edited, the server stamps it with
  that day's date, so an old product whose price was just changed appears
  among the newest. Correcting this needs a change to how product edits are
  saved, or a one-time dating of imported products; neither is in this change.
- Using the keyboard arrow keys on the closed Sort box changes the sort at
  each step.

## Not verified

- A physical computer browser other than Chromium, a physical phone, the
  installed home-screen app, and screen reader speech.
- Live Firebase sign-in, cloud sync between devices and offline recovery.
- Catalogs of several hundred products for scroll speed.
- Production deployment.
