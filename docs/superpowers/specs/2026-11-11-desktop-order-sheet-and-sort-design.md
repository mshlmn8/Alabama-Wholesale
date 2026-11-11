# Desktop order sheet and catalog sort

Status: requested by the user on 2026-11-11 after the phone redesign went live:
"now do the same for desktop. and add an assorting tool for the catalog that
sorts the catalog based on from newest to oldest or vice versa, A-Z, last
ordered." The desktop direction was shown in the first mockup round. Anything
beyond this document needs the user's approval first.

Builds on `2026-11-11-phone-order-sheet-design.md`. Phone behaviour from that
spec stays as shipped.

## Desktop (wider than 800px)

The order-sheet design becomes the only design. The old desktop catalog cards,
add-only flow, Overview layout and their code paths are removed.

- **Look.** The phone palette applies at every width: white surfaces, navy
  `#241A6B` for structure, orange only for the main action, dark appearance
  kept.
- **Sidebar.** Home, Catalog, Order, History, Store inventory, Stores, More.
  Order shows the number of units in the draft. Top bar tools are unchanged.
- **Catalog.** Same search, List/Photos switch, chips and in-place flavor
  steppers as on the phone. Chips wrap instead of scrolling. An open product
  lays its flavors out in columns. Photos view uses the saved column count.
- **Order panel.** At 1100px and wider, a "Your order" panel sits beside the
  catalog and stays in view: lines grouped by product, subtotal, tax, estimated
  total ("Check items" when a price is missing) and **Review and submit**,
  which opens the Order page. It updates with every quantity change. Between
  801px and 1099px the order bar is used instead, as on the phone.
- **Adding through More options** stays on the catalog at every width.
- **Order page.** Product photos, `−`/`+` on each line and **Submit order**, as
  on the phone, inside the existing desktop layout.
- **Home.** The phone home sections in two columns: order in progress, reorder
  and recent orders on the left; account and the AI draft action on the right.

## Catalog sort (all widths)

A **Sort** control in the catalog with five choices:

| Choice | Order |
| --- | --- |
| Catalog order | Today's order, including best-match-first when searching. Default. |
| Newest first | Product `createdAt`, newest first |
| Oldest first | Product `createdAt`, oldest first |
| A–Z | Product name, ignoring case, numbers in numeric order |
| Last ordered | Most recently ordered first for the selected store |

- Sorting applies after search, category and Favorites filters.
- Ties, and products without the needed date, keep catalog order. For Last
  ordered, products never ordered by this store come after those that were.
- "Last ordered" uses the store's submitted orders already loaded in the app,
  not drafts or cancelled or deleted orders. Each order's date is its saved
  order date, else when it was created.
- The choice is remembered on the device with the other catalog display
  preferences. An unknown saved value falls back to Catalog order.
- On desktop the control is beside the view switch; on phones it is the first
  item in the chip row.

Pure logic lives in `public/catalog-sort.js` and is unit-tested.

## Files

- New: `public/catalog-sort.js`.
- Changed: `public/app.js`, `public/phone-catalog.js` (order panel),
  `public/phone-redesign.css` (shared components at every width, phone layout,
  desktop layout), `public/sw.js`, `scripts/build.cjs`, test harnesses, guide.
- File and class names keep their `phone-` prefix to limit churn; file headers
  say they now serve every width.

## Testing

- Node tests for the sort rules and last-ordered index; harness tests updated
  to the single design.
- Chromium at 1440, 1100, 1024 and 801px, light and dark: add, type and remove
  quantities, order panel totals, More options stays on catalog, Order page
  steppers, Home, each sort choice, no sideways overflow.
- The phone checks from the previous release are rerun unchanged.
- Preview data only.

## Out of scope

Renaming `phone-` files and classes, removing unused rules from the older
stylesheets, and production deployment.
