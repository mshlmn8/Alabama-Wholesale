# Ordering and fulfillment design

Date: September 28, 2026
Status: Approved by the user on September 28, 2026. Covers requests 3–6 in the [expansion design](2026-09-28-wholesale-expansion-design.md).

## Mix / Each inside the product dialog

Preserve the current manual multi-flavor picker. Add a second **Mix / Each** tab, with a segmented choice, quantity, the existing item/case unit, a searchable **Exclude flavors** field and a concrete preview.

- **Each:** entered quantity applies to every allowed flavor. For example, 2 cases × 5 flavors = 10 cases. Expand into ordinary lines, using existing prices, reservations and undo behavior.
- **Mix:** entered quantity is the total across allowed flavors. For example, 6 cases total; picker chooses allowed flavors, excluding Grape. Save the complete allowed/excluded flavor snapshot with the request.

The user approved this Mix/Each interpretation. Do not interpret six cases as six cans or assume assorted cans inside a sealed case.

Selecting all flavors as exceptions blocks Add with a clear explanation. Deactivated/removed flavors require review. Do not silently broaden an already placed assortment when the catalog later gains a new flavor.

### Pricing and inventory for Mix

The current app freezes invoice prices and reserves warehouse stock per flavor on submission. A free-text “mixed” note cannot safely replace those rules.

Use a distinct validated logical Mix line with selection metadata, alongside concrete stock allocations. This is not a fake flavor added to the catalog.

At submission:

1. Validate allowed variants, exceptions, chosen unit and pack size.
2. Compute the store’s effective price for each allowed flavor. Unresolved picker-choice Mix requires a common price across them.
3. If prices differ, require review of an exact flavor split and submit concrete priced lines. Never average prices or silently select the cheapest/highest flavor.
4. Compute a stable provisional allocation in whole selected units, spread across allowed flavors within known available stock. Existing unknown-stock warnings remain explicit. Recheck stock and reserve concrete allocations transactionally.
5. Snapshot the request and price. Keep provisional reservations distinct from actual picked flavors.

While picking, staff can rebalance within the frozen allowed flavors at the same frozen financial total. Revalidate authorization, order version, stock and total quantity; release/reassign reservations atomically. Changed prices or requested quantity require a separately reviewed order change, not a silent invoice rewrite.

Actual picked quantities must sum to the requested quantity before delivery. Excluded flavors are rejected on the server. Confirmed delivered allocations feed stock movements, per-flavor estimates and future return eligibility. A provisional split is never presented as actual sales or delivery.

Mail-only order copies display the Mix instruction, quantity, unit and exceptions even before there is any stock reservation. Per-flavor analysis waits for confirmed actual allocations.

## Addition orders

Put **Add items to this order** on a placed/submitted order. Create a new linked addition draft for the same store, with no copied original lines. Display the original order reference throughout editing and sending.

The original record and frozen totals remain unchanged. Each addition has its own immutable identity and readable suffix/reference. Chained additions point to the original root order, not arbitrarily nested parents.

- Before the original order is delivered: label **Addition to [reference] — new items only** and surface it in the fulfillment queue.
- After delivery: label as a linked follow-up delivery; do not imply it has been packed with a completed shipment.
- Canceled/deleted originals cannot receive new additions. The server rejects cross-store links and unknown parent IDs.
- An app-submitted addition charges and reserves only its own lines, using the existing idempotent submission path.
- A Mail-only addition creates a linked placement snapshot after explicit confirmation. It does not invent a charge or reserve stock.
- Original and additions each show their own placement/delivery status. A combined viewing/printing option identifies every included reference and is explicitly distinct from “new items only.”

Missing-items analysis treats the family as one purchasing cycle while retaining actual addition dates and quantities. Repeated network attempts never create multiple addition records for one action.

## Credits and returns in Build

Add an expandable **Credits & returns** section before Review/Send. Include existing return requests for this store and a **Request return/credit** action. This extends `return.create`/`return.approve` instead of creating a second accounting system.

For a return against a delivered invoice, select original line/flavor, quantity, reason and whether the driver should collect it. Enforce delivered-minus-pending/approved quantities on the server. Mix returns require the actually delivered flavor and use the original frozen unit/price/tax basis.

For legacy or Mail-only goods without verified financial snapshots, allow an **Unverified credit request** with product/quantity/reason and original-order reference. It remains a request; staff must reconcile a supported original sale or issue an authorized documented adjustment before it can affect the ledger. Never calculate an automatic refund from today’s catalog price.

Include a separate owner-authorized credit-adjustment path for documented price/shortage corrections that do not represent a physical return. Store reason, original order/invoice reference, amount/tax components and an immutable credit-memo reference. Pending and approved returns and adjustments share one creditable amount budget per original invoice/line, with cumulative subtotal and tax caps; approving one must reduce the remaining budget available to the other. Serialize these decisions transactionally. Customers and salespeople may request an adjustment, but only authorized approval posts it. Requests without a verified invoice stay pending reconciliation.

Show **Requested credit**, **Approved account credit** and **New order total** separately. Pending credit cannot reduce the invoice or account balance. Applying an existing approved account credit must use an explicit allocation entry and cannot credit the same money twice. Preserve the original invoice subtotal/tax/total. Extend invoice financial projections, account balances, credit-memo rendering and allocation validation to include both return credits and approved adjustments exactly once.

All order output paths include a clearly labeled credits/returns section: Mail text, rich copy, share text, order view and appropriate PDF documents. Picker output contains pickup instructions and quantities; customer financial details belong in the invoice/credit memo.

Approval remains distinct from physical movement. Staff can approve credit without receiving goods; pickup confirmation records goods leaving the store, and warehouse receipt/inspection determines whether stock is resalable. Damaged or uncollected goods must not increase warehouse on-hand.

Add separately idempotent `return.pickup` and `return.receive` commands with partial quantity limits and physical statuses (`awaiting pickup`, `picked up`, `received`, `inspected`). Each received unit receives one disposition: resalable or nonresalable. Credit approval does not close these physical states. The existing `return.approve` cannot be replayed to change its restock decision; previously approved/restocked returns seed a completed disposition so the new receipt flow cannot restock them again. All pickup/receipt commands require role/store authorization and enforce remaining quantities across prior partial events.

## Picker-friendly pick list

The current app has a basic PDF pick list; improve it and make it prominent in the order-format menu and order-detail actions.

The first page has store name, order/addition reference, placed date, delivery instructions, status and blanks for picker/date. Repeat store/reference and column headings on continued pages. Print on US Letter with a high-contrast layout that remains clear in black and white.

| Check | Bin/category | Product / flavor | Need | Picked | Short |
| --- | --- | --- | --- | --- | --- |
| ☐ | Beverages | Faygo cans — Mix; NO Grape | 6 cases | ____ | ____ |
| ☐ | Candy | Example product — flavor | 2 boxes | ____ | ____ |

Use actual configured product units in generated output; this table is illustrative. Show case pack/conversion when known. Print the product once with subordinate flavor rows, keep short groups together, and repeat identity/continuation labels for groups that span pages. Long names/notes wrap rather than shrink to unreadable text.

Group by configured warehouse bin when available, otherwise frozen category/product. Retain distinct line notes; do not merge items whose units, instructions or assortment rules differ. Show Mix exceptions immediately below the item and leave space to record actual flavors.

Have a separate **Return pickups — do not pick from stock** section with item, quantity, reason and original reference. Clearly mark an addition-only list. End with total pick rows, totals by unit, shortage/substitution notes and picker/checker initials; do not sum cases and individual units into a misleading single quantity.

Paper checkmarks do not automatically change stock or order status. If actual quantities are entered in the app, confirmation uses the authenticated fulfillment command. A short quantity flags the order for resolution; it does not silently mark the full order delivered or charge a substitute.

Draft pick lists are labeled **DRAFT — not submitted**. Canceled orders cannot generate an active work ticket. Historical copies retain their unverified label.

## Implementation boundaries

- New modules: `lib/order-assortments.cjs`, `lib/order-additions.cjs`, `lib/order-placements.cjs`, `lib/order-credits.cjs`, `lib/pick-list.cjs`, `public/order-assortments.js`, `public/order-credits.js`.
- Extend line normalization, pricing snapshots, reservation/reallocation, delivery and return validation together; never change only the visible flavor text.
- Wire focused components into existing product dialog, builder, order detail and format selection.
- Update order summaries to include root/addition identity and placement provenance without loading every line.
- Extend text/PDF formatting, local persistence, online drafts, device copies and backups for selection metadata and linked requests.
- Keep supplier and wholesale costs out of customer documents and API projections.

## Acceptance examples

- Each 2 across five allowed flavors adds exactly 10 selected units; undo removes the entire batch once.
- Mix 6 never expands to 6 of every flavor; excluded flavors cannot be reserved or delivered.
- Different effective flavor prices require an exact priced split before submission.
- Two pickers changing one assortment cannot overwrite each other or oversell stock.
- Sending an addition prints only its new lines and identifies its original order.
- Approving the same return/credit twice issues one ledger credit; over-returns and over-credits fail.
- A damaged return never increases resalable warehouse stock.
- A 1,201-line order still has complete formatted Mail text and valid, unclipped pick-list pagination.
- Existing invoices retain their original frozen values after catalog, addition, count or credit changes.
