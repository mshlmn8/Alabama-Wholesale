# Store ordering and wholesale operations guide

The ordering app now keeps store counts, order recommendations, additions and return requests together. The separate Wholesale Operations app shares warehouse stock with fulfillment and supplier receiving.

## 1. Count inventory for a store

Select the store, then open **Store inventory**. Search by product, flavor, SKU or barcode. Use **Count** to save an observation in each or case units, a measurement date and an optional target in individual units. A counted zero is different from an item that has never been counted.

**History** shows dated observations and physical movements. Correct a mistaken observation through its **Correct** action so its audit trail remains available. Use **Movement** for documented receipts from another source, losses, transfers or other physical changes. For orders placed through the app, confirm the actual receipt through **Placed orders & receipts** instead.

Offline count drafts stay on that account and device until they are confirmed online. Other stores' observations never contribute to the selected store's recommendations.

## 2. Check missing items and weekly patterns

In the order builder, choose **Check missing items**. The reference is the latest eligible order strictly older than 96 hours. Review the prior quantity, last count and any newer purchases before choosing **Add**, changing the suggested quantity, **Skip**, or **Enough stock**. A review never places an order automatically.

The comparison works when Gemini is unavailable. When configured, Gemini explains the verified candidates; it cannot invent products or alter the order without your selection.

Store inventory can show two different weekly figures:

- **Weekly purchases** requires at least four order cycles spanning 28 days. Additions belong to their original order cycle.
- **Estimated weekly depletion** requires at least three valid count intervals spanning 28 days, together with recorded receipts and losses. It estimates stock consumed between observations; it is not a retail POS sales report. Missing movements can distort it.

Unknown case conversions, stale counts and incomplete history are labeled. Record regular counts and all physical receipts/losses to improve the estimates.

## 3. Order a Mix or Each assortment

Open a catalog item's ordering dialog and select **Mix / Each**. Exclude any unwanted flavors using the searchable exceptions list.

- **Mix:** the quantity is the total across the allowed flavors. For example, 6 cases of Faygo cans, excluding a flavor, means 6 cases total.
- **Each:** the quantity applies separately to every allowed flavor. For example, 2 cases across 4 allowed flavors adds 8 cases total.

Review the preview before adding. Mix requires a common effective price across the allowed flavors. If prices differ, use exact flavor quantities so the price stays clear.

Staff must confirm the actual Mix quantities while picking before marking delivery. The confirmed flavors determine stock deductions, store receipts and return limits.

## 4. Add items after an order is placed

Use **Placed orders & additions** in the builder or **Add to order** from an order's details. Start an addition to create a new empty order linked to the original. Its documents identify the original and say **NEW ITEMS ONLY**. The original order remains unchanged.

**Email order** still opens a prefilled Mail draft in one tap. Opening Mail does not prove it was sent. After actually placing the order, use **I placed this order** to confirm that exact frozen handoff. Later edits cannot change that recorded placement. Use a linked addition for extra goods.

For Mail orders, confirm receipt only after goods arrive and enter the actual Mix flavors. A later matching app delivery cannot record the same store receipt twice.

## 5. Include credits and returns

Expand **Credits & returns** in the builder. Create an invoice-linked goods return, a documented credit adjustment, or an unverified request when the original invoice needs reconciliation. Attach the request to the current order so the outgoing order and documents carry its reference and instructions.

Requested credits are labeled separately from approved credits. They do not become negative order quantities or silently reduce a new order total. Approval checks the original invoice and other pending/approved requests to prevent excess credit. Staff may approve invoice-linked goods returns; the owner approves adjustments and reconciles unverified requests.

Financial approval and physical handling are separate. Staff record **Confirm pickup**, then **Receive and inspect returned goods**. Only accepted resalable goods return to warehouse inventory, once. Rejected goods do not increase resalable stock.

## 6. Give the picker a pick list

Open order details and choose **Pick list PDF**. The printable layout groups products by recorded warehouse location or category, uses large required quantities, and provides checkboxes plus **PICKED** and **SHORT** columns. It includes case conversions, Mix exceptions, confirmed flavor allocations, delivery instructions and an addition reference when applicable.

Return pickups appear in their own section, with only the remaining quantities to collect. Prices and financial credit amounts do not clutter the picker document. Headers and order references repeat on additional pages. Paper marks do not change inventory; confirm fulfillment in the app.

## 7. Run Wholesale Operations

Staff can open **Wholesale Operations** from the ordering workspace, or visit `/warehouse/`. It has its own name, manifest, service worker and device records and can be installed separately. Both apps use the existing sign-in service and authoritative warehouse stock.

1. **Stock:** count physical stock and configure bin, target and reorder point. Unknown stock requires an opening count before receiving a PO.
2. **Suppliers** (owner): save a supplier and map each catalog product/flavor to its supplier SKU, purchase unit, case size, order multiple, cost and lead time.
3. **Purchasing** (owner): create a draft PO, review its quantities/costs, and download the printable PO. After placing it with the supplier, choose **Mark ordered**. This action records your confirmation; it does not contact or purchase from the supplier.
4. **Receive:** choose an open PO, record accepted and rejected quantities and select whether rejected goods need replacement. Four accepted cases from a ten-case PO leave six outstanding. Rejected goods add no resalable stock. Retrying the same action cannot receive it twice.
5. **Amend quantities / Close outstanding** (owner): record an explicit reason. Original case size and cost remain frozen on an ordered PO; changes and receipts remain traceable.

Suggestions subtract reserved stock and confirmed inbound quantities from the target, then round up to the supplier's ordering multiple. Missing stock, target, supplier mapping or complete inbound history results in an unknown recommendation.

Staff can count and receive goods. Supplier costs, terms and financial PO documents are restricted to the owner. Customers cannot access the warehouse APIs. All changes require online confirmation; a pending action retains its exact retry identity.

## Local preview

Use Node 22 and Java 21. From the feature checkout, start the Firebase Auth emulator and then the synthetic app in separate terminals:

```sh
npx firebase-tools emulators:start --only auth --project demo-alabama-wholesale
node scripts/demo.cjs
```

Open `http://localhost:8780/` or `http://localhost:8780/warehouse/`. Demo owner: `demoowner@example.com`; demo customer: `democustomer@example.com`. Both use the synthetic password `DemoOnly!2026`.

The demo seeds five weekly orders, physical counts and a partially received supplier PO, uses an in-memory repository, and resets business data when restarted. It uses no production account or supplier transport. Gemini explanations are explicitly unavailable in this preview; the verified comparison and estimates still work.
