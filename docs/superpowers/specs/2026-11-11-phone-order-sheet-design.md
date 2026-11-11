# Phone order-sheet redesign

Status: direction approved by the user on 2026-11-11 from before-and-after
pictures ("yes go ahead and build it"). Scope confirmed the same day: **phones
only**. Anything beyond this document needs the user's approval first.

Mockup canvas: https://claude.ai/artifact/RfYR1SFwQZoXN2v2c4rubU

## Why

A store owner places a weekly order of many lines, mostly from a phone. Today:

- Every product is added through a pop-up sheet that must be confirmed and
  closed, and the first add jumps away from the catalog to Build.
- The catalog never shows what is already in the order.
- Header, page title, search card, categories and view toggles take about 40%
  of a phone screen before the first product.
- Overview leads with a slogan instead of the next action.
- Orange marks everything; the logo's navy is unused.

## Scope

Phone-sized screens only: `@media screen and (max-width: 800px)`, the breakpoint
`public/mobile-layout.css` already uses. Above 800px the DOM, styles and
behaviour stay exactly as they are. Crossing the breakpoint re-renders.

No server, storage, sync, pricing, permission or data-model change. Draft lines
keep their current shape. Every existing tool stays reachable.

## Design

### Look (phone)

- White surfaces on a light warm-grey ground; ink `#17152B`; muted `#5B5A6B`.
- Logo navy `#241A6B` for structure: active tab, selected chip, quantity `+`,
  the order bar, "in order" counts.
- Orange `#C94712` only for the one primary action on a screen.
- Manrope stays. Controls are at least 44px tall. Dark appearance keeps working
  with a matching dark palette.

### Navigation (phone)

- Bottom tabs: **Home, Catalog, Order, History, More**. Order shows the number
  of units in the current draft. History is the existing Orders page; Order is
  the existing Build page.
- Stores moves into More (first group) and stays in the store switcher.
- Top bar: store switcher with save status, notifications, workspace tools.
  The logo shows on Home only.

### Catalog (phone)

- One compact header: search with the barcode scanner inside it, a List/Photos
  switch, then one scrolling row of chips: All, Favorites, categories.
  Subcategory rows appear under it as today.
- **List view.** Each product is one row: photo, name, option count and price.
  Tapping a row opens its flavors in place. Each flavor has `−`, a typed
  quantity and `+`. A product with no flavors has the stepper on its own row.
- **Photos view.** Two columns of large photo cards (the existing column and
  compact settings still apply). Tapping a card opens the same flavor panel
  across the full width directly below it.
- Every quantity change saves to the draft immediately, through the same
  `editDraft` path and automatic saving as today, without leaving the catalog
  and without a full page re-render. Undo works per change.
- A product shows "N in order" when the draft holds it.
- The open panel also carries Favorite, Edit product (owner) and **More
  options**, which opens today's add dialog for Mix / Each, special notes and
  adding a new flavor. Catalog tools (add product, add from photo, draft with
  AI) move behind one button at the end of the chip row.
- An order bar above the tabs shows units and estimated total with **Review
  order**. It says "Check items" instead of a total when a price is missing,
  as today.

Quantity rules (pure, unit-tested in `public/catalog-quantities.js`):

- A flavor's quantity is the sum of its manual draft lines.
- `+` raises the plain line (unit `each`, no note); it creates one if needed.
- `−` lowers the plain line first and removes it at zero; otherwise it lowers
  the last manual line for that flavor but never removes a line that carries a
  note or a case unit. The catalog then says to change it on the Order screen.
- A typed quantity sets the plain line so the flavor total matches; lines with
  notes or case units are left alone. A blank field restores the saved
  quantity. Limits stay 0 to 1,000,000.
- A change is refused, and the catalog redrawn, when the working draft was
  replaced since the page was drawn (for example from another device).
- Mix / Each lines count toward "N in order" but are edited in Order.
- Changes are refused while order notes are unsaved, as today.

### Order (phone)

Same page and logic as Build. Each product group gains its photo; each line
gains `−`/`+` around the existing quantity field (`−` at 1 does nothing; remove
stays in the line's options). The summary keeps subtotal, tax and total, and
the primary button reads **Submit order** with the total beside it and opens
the existing review-and-submit step.

### Home (phone)

- **Order in progress**: estimated total, units and products, Review and
  submit, Keep adding. With no draft: Start an order, Browse catalog.
- **Same as last time?**: the latest submitted order with Reorder (existing
  reorder behaviour).
- **Account**: balance, credit limit, terms, Report a payment, plus the
  existing metrics that are not zero.
- **Recent orders** and **Draft an order from a note or photo**.
- Existing notices (migration review, storage, offline) are kept.

## Files

- New: `public/catalog-quantities.js`, `public/phone-layout.js` (breakpoint and
  tab mapping), `public/phone-catalog.js`, `public/phone-redesign.css`.
- Changed: `public/app.js` (phone branches in `render`, `renderCatalog`,
  `renderHome`, `renderBuilder`, `renderMore`; draft creation without
  navigation), `public/index.html`, `public/sw.js` (shell list and version),
  `scripts/build.cjs`.

## Testing

- Node tests for the quantity rules, tab mapping, and the offline shell list.
- Existing suite stays green.
- Chromium at 320, 390 and 800px in light and dark: add, change and remove
  quantities in both views, totals, undo, submit path, no horizontal overflow.
  At 801px and 1440px: screenshots identical to `main`.
- Preview data only. No production data, email or deployment.

## Out of scope

Desktop layout, the desktop order panel, new features, and production
deployment.
