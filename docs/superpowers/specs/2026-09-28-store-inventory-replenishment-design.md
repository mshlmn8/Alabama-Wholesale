# Store inventory and replenishment design

Date: September 28, 2026
Status: Approved by the user on September 28, 2026. Covers requests 1–2 in the [expansion design](2026-09-28-wholesale-expansion-design.md).

## Store inventory experience

Add **Store inventory** as a separate navigation tab, following the store selected in the header. Show product, flavor, last counted quantity, count date, target stock and weekly estimate when supported by data. Include search, category filters, barcode entry, low-stock filtering and count history.

Customers can count stock only for assigned stores. Salespeople can count their assigned stores; the owner can access all stores. This does not grant customers permission to edit the global catalog, warehouse stock, prices or account balances.

Count entry records the quantity physically observed, the measurement time and an optional note. Case entry converts using a known pack size and saves that conversion; an unknown pack size cannot be guessed. Display **Not counted** separately from a counted zero. Saving a later observation does not erase earlier observations.

Inventory counts support local drafts and explicit sync status. A concurrent update preserves the unsynced observation for review. Server confirmation is required before a count influences shared insights. Each item row carries its own measurement time so a long stock-taking session does not pretend every product was counted simultaneously.

## Collections and data boundaries

| Collection | Responsibility |
| --- | --- |
| `storeInventory` | Latest store/product/variant count pointer, target quantity, version and audit timestamps |
| `storeInventoryCounts` | Immutable observations: identity, `countEach`, `measuredAt`, server `recordedAt`, actor, unit/pack snapshot and note |
| `storeInventoryMovements` | Actual receipt, return-out, damage, transfer or correction; signed base quantity, effective date, source reference and idempotency identity |
| `orderPlacements` | Immutable placed-order snapshot for confirmed Mail orders, or a reference to a server-submitted order; store, time, lines, parent/addition link and provenance |

Keep store inventory separate from existing global `inventory`. Do not initialize every store from warehouse counts or treat unknown inventory as zero.

Server-derived deliveries create store receipt movements exactly once. Existing orders have confirmed delivered status; Mail-only orders require explicit receipt confirmation before affecting stock. Never count both a receipt confirmation and a later linked delivery for the same fulfillment. Match them using the placement/order fulfillment identity.

A physical count is an absolute observation, not an incremental stock receipt. Analysis uses movements in `(starting measuredAt, ending measuredAt]` and prevents overlap/double counting. Late-recorded movements trigger recomputation. Correcting a count creates a replacement reference and audit history rather than silently rewriting observations.

## Defining prior orders

Support the app’s two existing ways of working:

- **Submitted through the app:** confirmed submission establishes placement; it continues to use the existing charge and stock-reservation rules.
- **Sent through Mail:** keep the one-tap Mail action. A visible **Mark as placed** action saves an immutable snapshot after the user confirms placing it. It does not submit, charge, reserve stock or claim provider-confirmed delivery. Unconfirmed Mail handoffs remain unconfirmed.

The Mail action preserves the exact handoff snapshot and its content hash. **Mark as placed** confirms that snapshot, not a draft edited after opening Mail. Show any newer edits as a separate unplaced revision.

Submitting a draft already marked placed links to its existing placement only when the ordered contents match. Different contents require explicit replacement or addition resolution so an actual purchase is never silently overwritten or counted twice. A placement stores the relevant draft revision; addition placements link to the original placement.

Existing migrated history may support a comparison only when identifiable products, quantities and a reliable saved date exist; label it historical/unverified. It cannot become a confirmed delivery or count-based sales input without confirmation. Unfinished drafts and canceled/deleted orders are excluded.

## Missing-items behavior

Add **Check missing items** in Build and a compact review section before placing/submitting an order. Do not auto-add items or prevent deliberate omissions.

At a fixed server analysis time, select the most recent eligible store order strictly older than 96 hours. An order exactly 96 hours old is not eligible. Display the chosen reference/date so the comparison is understandable.

Load full order lines through a scoped server query; the compact recent-history response is insufficient. Fetch all relevant later placements and additions, with an explicit incomplete-history result if configured query limits are reached.

1. Compare product and variant identity in common units against the current draft.
2. Merge linked additions into their original order family without counting them as a new purchasing cycle.
3. Account for newer placed orders: a product purchased after the reference order appears as **Ordered recently**, with its date, rather than a plain forgotten-item warning.
4. Show each candidate’s prior quantity, latest count/date, later receipts and a suggested quantity only when evidence supports it.
5. Offer **Add**, **Adjust quantity**, **Skip this order** and **Already have enough**. Skip feedback belongs to this draft by default.
6. A present product with different flavors is **Check flavors**, not automatically missing. A Mix request covers the product-level omission only. Its permitted flavors display **Allowed in mix; not guaranteed** until an exact split is confirmed. A one-unit mix allowing ten flavors is never counted as buying ten flavors.
7. Inactive products or removed variants are shown as unavailable with a review action, never silently substituted.

No eligible history yields “No prior order older than four days.” Unknown counts and missing quantity/pack information remain explicit. A changed draft/store invalidates the result and requires refreshed comparison before applying suggestions.

## Weekly estimates

Orders alone support **weekly purchases**, not verified retail sales. Use placed quantities for purchase cadence, confirmed receipts for delivered replenishment, and inventory observations for estimated depletion. Display which metric is shown.

Initial product defaults:

- A purchase-rate estimate requires at least four distinct confirmed placed order cycles spanning at least 28 days. Use the earliest qualifying placement as the opening boundary and the latest as the closing boundary; sum placed quantities with timestamps in `(opening, closing]`, then divide by elapsed days and multiply by seven. Exclude the opening order quantity from that interval so four orders do not inflate three replenishment intervals. Linked additions contribute their quantities at their actual placement times but do not count as separate cycles. Show the interval, last order date and number of cycles.
- A count-based weekly estimate requires at least three non-overlapping valid count intervals spanning at least 28 days. These are eligibility rules, not a statistical accuracy guarantee.

For each valid interval:

`estimated depletion = opening count + actual receipts + inbound transfers + signed documented non-sale corrections - closing count - returns out - damage - outbound transfers`

`weekly estimate = total estimated depletion / total observed days × 7`

Signed non-sale corrections represent documented physical gains/losses not already represented by another movement. Negative corrections reduce inferred depletion rather than masquerading as sales. An unexplained adjustment invalidates the affected interval until classified; corrections to a count observation replace that observation and are not additional movements.

Exclude intervals with ambiguous units, corrected-but-unresolved records, unexplained negative depletion or unresolved physical movements. Do not clamp invalid negative results into a plausible number. Flag missing external receipts and unrecorded losses as limits on accuracy. Without retail POS transactions this remains an estimate, never a claim of measured sales.

Store counts do not automatically decrease every day using a forecast. Show the last actual count separately from projected stock. A stale count cannot silently suppress missing-item warnings.

For a supported estimate, use an explicit seven-day planning horizon by default and display it. Proposed replenishment is the nonnegative gap between target demand and estimated available stock including confirmed pending receipts; round only to known order-unit multiples. Show the arithmetic and allow editing.

## AI contract

Implement audited calculations and candidate selection in a deterministic module. Add a scoped Gemini analysis endpoint using the existing verified identity, App Check and rate-limit conventions.

The AI receives only the selected store’s minimized evidence: candidate product IDs, verified quantities, dates, count freshness and computed rates. It can explain or prioritize validated candidates. Its output must reference known candidate IDs and cannot change quantities, prices, stock, credits, order status or permissions.

Treat catalog text, notes and historical order content as untrusted. Validate the response schema, cap input/output and escape displayed text. Failure or missing AI configuration leaves the deterministic comparison usable and clearly labels the explanation as unavailable. Never label a rules-only response as a completed AI analysis.

## Implementation boundaries

- New focused modules: `lib/store-inventory.cjs`, `lib/replenishment.cjs`, `lib/replenishment-ai.cjs`, `public/store-inventory.js`, `public/replenishment.js`.
- Extend authenticated command dispatch with count recording/correction, manual physical movements, receipt confirmation and placement confirmation.
- Add scoped inventory/history/insight API routes, required Firestore indexes and backup collection entries.
- Extend draft and device-backup schemas for placement links, skipped suggestions and unsynced count entries; preserve existing recovery behavior.
- Do not put all history into `/api/state`; paginate counts and movements and bound analysis with transparent completeness reporting.

## Acceptance examples

- Store A’s customer cannot read or alter Store B’s counts, placements or analysis, including replaying a formerly authorized command.
- Counts of 24 and then 10, with 12 received and 2 damaged between them, yield estimated depletion of 24 over the interval.
- A four-day-old order is excluded; one older by one millisecond qualifies.
- A product in an eligible old order and a newer order is labeled ordered recently.
- An order saved only as a draft is not a past purchase. Opening Mail does not change placement or stock.
- Confirming placement twice or submitting that same placed order does not duplicate purchase history.
- A delivery received twice through retries produces one store receipt.
- An add-on changes total purchased quantity without manufacturing another weekly cycle.
- Missing counts produce purchase-pattern information, not an invented sales rate.
