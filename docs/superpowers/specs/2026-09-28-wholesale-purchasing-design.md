# Separate wholesale inventory and purchasing app

Date: September 28, 2026
Status: Approved by the user on September 28, 2026. Request 7; implement after requests 1–6 pass acceptance in the [expansion design](2026-09-28-wholesale-expansion-design.md).

## App and architecture

Create **Alabama Wholesale Operations**, a separately installable staff PWA under `/warehouse/`, with its own manifest identity/start URL, worker scope, icon/title and per-account local-storage namespace. Reuse the authenticated backend and authoritative wholesale inventory; do not copy stock into a disconnected database.

The initial app manages the existing warehouse as one stock location. Its screens are **Overview**, **Stock**, **Purchasing**, **Receive** and **Suppliers**. A link can open an authorized customer order/pick list for fulfillment context.

Customers cannot access warehouse APIs. Existing staff may view stock and perform physical count/receipt tasks permitted by their role. Supplier costs, supplier maintenance and purchase-order approval are owner-only initially. Enforcement belongs in server projections and commands, not only navigation.

## Inventory operations

- Show on-hand, reserved, available, reorder point, target, confirmed inbound and stock status by product/flavor.
- Search by name, SKU or barcode. Unknown counted inventory stays unknown and prompts a physical count.
- Record count adjustments with a reason and optimistic version. Preserve reservation constraints.
- Maintain an immutable movement log covering receipts, order delivery, confirmed resalable returns and adjustments.
- Show low-stock candidates with the quantities and inputs that caused the recommendation.
- Add optional warehouse bin/location fields for picker ordering. Location metadata is operational and does not change product identity.

## Suppliers and purchase orders

| Collection | Responsibility |
| --- | --- |
| `suppliers` | Name, contact details, notes, ordering terms, active state and version |
| `supplierProducts` | Catalog product/variant mapping, supplier SKU, ordering pack/multiple, last confirmed cost and lead time |
| `purchaseOrders` | Supplier snapshot, numbered lines, expected quantities, unit/pack and cost snapshots, status and expected delivery |
| `purchaseReceipts` | Immutable accepted/damaged/rejected quantities against PO lines, receipt time, actor and idempotency identity |
| `warehouseMovements` | Source-linked stock changes; one entry for each physical adjustment/receipt/delivery |

Keep supplier costs and purchase terms in private collections. The existing catalog serializer exposes ordinary product fields; adding private cost there would leak it.

Purchase-order lifecycle: `draft → ordered → partially received → received`, with `cancelled` for a fully cancelled order and `closed` when the remaining supplier obligation is explicitly closed without full acceptance. Draft POs do not count as confirmed inbound. Only the owner can mark a PO ordered or change committed purchase quantities.

Creating a PO does not place an external supplier order or increase warehouse stock. Provide printable/downloadable PO output and a prefilled email draft if desired; label the external order as placed only after explicit confirmation. No automatic supplier purchases or payments are part of this release.

## Receiving

Open a PO, enter delivered quantities and split them into accepted, damaged/rejected and outstanding. Show the original expected quantities and prior receipts.

Only accepted goods increase resalable on-hand. Partial receipt retains the remaining open quantity. For every rejected/damaged quantity record **Replacement expected** or **Close this quantity**; closing requires owner authorization. Rejected goods awaiting replacement remain an outstanding supplier obligation and are not accepted inventory.

Derive outstanding quantity as `ordered - accepted - explicitly closed/cancelled`. Validate each new delivery attempt against that outstanding quantity unless the owner first approves an amendment. A replacement for a previous rejection is therefore receivable without pretending the rejection was accepted stock. Preserve original, rejection, disposition, receipt and amendment history. Status is `received` only when all ordered goods are accepted; zero outstanding with closed quantities yields `closed`. Confirmed inbound uses only outstanding obligations on placed POs, including explicitly expected replacements.

Use saved pack conversions, not later catalog pack changes. A receiving command transaction writes the receipt, stock increments, movement records, PO status/version, audit and idempotency receipt together. Duplicate requests cannot increment stock twice. Concurrent receivers must resolve version/remaining-quantity conflicts.

All stock and purchase state changes require online confirmation. Offline count/PO/receipt drafts may be saved locally, clearly labeled unconfirmed; they cannot be represented as shared stock or submitted purchases.

## Purchase suggestions

Base the first release on configured reorder points, target quantities, reservations, supplier pack multiples and confirmed open PO quantities:

`available = onHand - reserved`

`suggested purchase = round up to supplier multiple(max(0, target - available - confirmed inbound))`

Do not suggest a definite amount when on-hand, target or ordering multiple is unknown. Show the missing input. Avoid recommending duplicate purchases already covered by confirmed inbound; show expected dates and overdue PO warnings.

If lead time or future demand is not configured, label this a stock-target suggestion rather than promising stockout prevention. Later validated delivery history from the ordering features can improve demand estimates without replacing explicit staff review.

## App isolation and integration

- Narrow the current ordering worker’s cleanup: it presently deletes caches beginning `aw-` or `alabama-`. Each app must delete only its own versioned caches.
- Exclude `/warehouse/` shell navigation from the ordering worker’s fallback; register the operations worker with `/warehouse/` scope. Verify deep links and both install identities.
- Keep per-app local databases/drafts/downloads separate while reusing server authentication where supported. Sign-out and account changes remove access to previous-account local views in both apps.
- API responses containing supplier data and business state remain private/no-store. Do not cache them as public PWA assets.
- Include every new collection in backup export, isolated restore verification and access tests.
- Share domain stock operations with the existing ordering app so one delivery or receipt cannot create divergent counts.

## Implementation boundaries

- App files: `public/warehouse/index.html`, `app.js`, `styles.css`, `manifest.webmanifest`, `sw.js` and focused screen modules.
- Server modules: `lib/purchasing.cjs`, `lib/warehouse-movements.cjs`, `lib/warehouse-routes.cjs` and purchase-order document rendering.
- Extend server routing, build checks and asset handling for the second app while retaining current ordering URLs.
- Add supplier/PO/receipt indexes and collection backup entries.
- Use synthetic suppliers, costs and purchase orders for previews and tests; never seed fake operational records into production.

## Acceptance examples

- A customer URL/API request cannot reveal supplier prices, POs or exact staff-only stock records.
- Ordering app and operations app show the same confirmed stock after a receipt or delivery.
- Receiving 4 of 10 cases leaves 6 outstanding and adds exactly the saved pack conversion × 4 to stock.
- Retrying that receipt adds no additional stock.
- Damaged/rejected goods do not appear as resalable on-hand.
- A later case-size change does not rewrite old receipt quantities.
- Opening or installing one PWA does not erase the other app’s caches/drafts.
- Purchase suggestions subtract existing confirmed inbound and never execute a purchase by themselves.
- Export/restore verification includes suppliers, POs, receipts, movements and their idempotency receipts.
