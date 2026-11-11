# Phone order-sheet redesign: verification

Checked on 2026-11-11 against the spec in
`docs/superpowers/specs/2026-11-11-phone-order-sheet-design.md`.

## What changed

On screens up to 800px wide:

- Quantities are set in the catalog itself. Tapping a product opens its
  flavors in place with `−`, a typed quantity and `+`. A product with one
  option has the stepper on its row. Every change saves to the draft through
  the existing draft path and the catalog stays on screen.
- The catalog has a List view and a Photos view. Favorites, catalog tools and
  the column settings sit in the category chip row.
- An order bar above the tabs shows units and the estimated total.
- Tabs are Home, Catalog, Order, History and More. Stores is under More.
- The order screen shows product photos and `−`/`+` on each line. Its main
  button reads Submit order and opens the existing review step.
- Home leads with the order in progress, then reorder, account and recent
  orders.

Above 800px nothing changes.

## Results

- **Automated tests:** `npm test` on Node 22: 889 passed, 0 failed. This
  includes 25 new tests for the quantity rules, the phone tab mapping, the
  catalog helpers and the offline shell list. `npm run build` passed.
- **Phone flow, Chromium at 390×844, 25 checks passed:** first `+` from an
  empty order stays on the catalog and creates the draft; the count, order bar
  and Order tab badge update; a typed quantity saves and an invalid one is
  refused; `−` to zero empties the order; a single product steps on its own
  row; Photos view opens flavors full width below the card; nine items total
  $176.58 with 8% tax; More options still opens Mix / Each, notes and new
  flavor; the order screen's `−`/`+` change the line and total; Submit order
  opens "Review your order"; Home shows the order in progress; Reorder asks
  before replacing it; Stores opens from More; no page errors.
- **Edge cases, 12 checks passed:** `−` keeps a line that has a note and says
  to change it on the Order screen; a blank typed quantity restores the saved
  one; typing 0 keeps the noted line; a typed value followed by `+` without
  leaving the field saves both; the Order tab count follows edits made on the
  order screen; the main button is readable in dark appearance (dark text on
  light orange) and has no navy outline in light; in a four-column photo grid
  a single product's stepper moves into its panel.
- **Breakpoint:** resizing 390 → 1200 → 390 re-rendered each layout with the
  same draft total and no error.
- **Overflow:** 54 cases at 320, 390 and 800px, light and dark, across catalog
  (list with a product open, photos), Home, Order, History, More, Stores,
  Account and Notifications. None scrolled sideways.
- **Desktop unchanged:** full-page screenshots of Overview, Catalog, Build,
  Orders, Stores and More at 801px and 1440px were pixel-identical between this
  branch and `main` (12 of 12).

## How it was run

`scripts/demo.cjs` logic with the Firebase Auth emulator and in-memory data. A
scratch copy of the demo was seeded with nine real catalog products and their
photos so flavors and images were realistic. Prices, stock and order history
are synthetic. No production data was read or changed and no email was sent.

## Independent review

A separate reviewer read the branch and found no critical defect and four
important ones, all fixed with a failing test first: `−` could delete a line
with a note; dark-appearance buttons lost contrast; a draft replaced in the
background left stale counts; unreadable typed input saved as zero. Smaller
fixes from the same review: the Order tab count on the order screen, Reorder
skipping cancelled orders, no layout switch while a field or dialog is in use,
screen-reader text on product rows, and dense photo grids.

Known and left as is: a line ordered by the case counts as its number in "N in
order" and the item count.

## Not verified

- A physical iPhone or Android phone, an installed home-screen app, and screen
  reader speech. Only Chromium emulation was used; WebKit was not run.
- Live Firebase sign-in, cloud sync between devices and offline recovery with
  the new catalog. The draft save path itself is unchanged.
- Catalogs of several hundred products for scroll speed. Cards are built once
  per page render and flavor panels only when opened.
- Production deployment. The service worker version changed, so installed
  apps pick up the new files on their next update.
