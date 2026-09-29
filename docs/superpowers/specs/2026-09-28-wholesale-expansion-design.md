# Store ordering and wholesale inventory expansion

Date: September 28, 2026
Status: Approved by the user on September 28, 2026; implemented and verified on the feature branch.
Inspected baseline: `alabama-wholesale`, `main`, `d2c5604`.

This design covers all seven requested additions while preserving the existing ordering app. Build the separate wholesale app after the six ordering improvements are working and verified.

## Recommended approach

Extend the current ordering app and give wholesale staff a separate installable app backed by the same authenticated API and authoritative warehouse stock records.

| Approach | Benefit | Trade-off |
| --- | --- | --- |
| Extend ordering + separate wholesale app, shared backend — recommended | Preserves existing workflows, gives staff their own app, and keeps stock consistent | Requires explicit app scopes and permissions |
| Put everything in the current app | Less app-shell work | Does not provide the separate wholesale app requested |
| Separate apps and separate stock databases | Independent deployments/data ownership | Requires synchronization and conflict resolution; risks competing stock counts |

Use the current Express/Firebase architecture. New features belong in focused modules rather than expanding the large `public/app.js` and `lib/domain.cjs` with all their logic.

## What the user will get

| Request | Result |
| --- | --- |
| 1. Inventory for each store | A dedicated **Store inventory** tab that follows the selected store, with counts by item/flavor, count date, low-stock targets, search and history |
| 2. Missing items and weekly selling estimates | **Check missing items** in Build: compare the current order with the latest eligible order older than four days, explain omissions, and show stock/count evidence and qualified weekly estimates |
| 3. Mix/Each with exceptions | Keep manual flavor selection and add **Mix / Each**, with quantity, explicit units, searchable **Exclude flavors**, a result preview and saved exceptions |
| 4. Addition orders | **Add items to this order** creates a linked addition containing only new items, with its own reference and clearly marked email/pick list |
| 5. Credits/returns in the builder | An order-level **Credits & returns** section with requested versus approved credit, original-invoice references, return quantities and pickup instructions |
| 6. Picker-friendly format | A prominent **Pick list** option with category/bin grouping, large quantities, checkboxes, picked/short fields, notes and a separate return-pickup section |
| 7. Wholesale app | A separate staff PWA with warehouse stock, counts, suppliers, purchase orders, partial receiving and replenishment proposals |

## Approved design choices

1. **Mix/Each meaning:** Mix = one total quantity assorted across allowed flavors; Each = the entered quantity of every allowed flavor. Both retain the chosen ordering unit. This is distinct from breaking a sealed case into assorted individual cans.
2. **How an order becomes history:** the existing **Email order** opens Mail but cannot confirm sending. The design supports both app submission and an explicit **Mark as placed** confirmation for an order sent through Mail. Opening Mail alone must not mark an order sent, delivered or charged.

The UI should give a concrete example: “Mix 6 cases total, excluding Grape,” or “Each: 2 cases of each of 5 flavors = 10 cases.” Packaging choices must use catalog information; the app must not assume what one Faygo ordering unit represents.

## Delivery sequence and component designs

1. [Store inventory and replenishment](2026-09-28-store-inventory-replenishment-design.md): dated counts and movement records, then missing-items comparison and evidence-based AI explanations. Covers requests 1–2.
2. [Ordering and fulfillment](2026-09-28-ordering-fulfillment-design.md): Mix/Each, linked additions, builder returns/credits and the improved pick list. Covers requests 3–6. The explicit placement record needed by request 2 is shared groundwork.
3. [Wholesale purchasing app](2026-09-28-wholesale-purchasing-design.md): a distinct app using the tested warehouse movements and fulfillment contracts from stages 1–2. Covers request 7.

Each stage must produce a working, independently testable increment. Do not claim all seven complete after finishing only a subset.

## Preserve and improve matrix

| Existing capability | Treatment |
| --- | --- |
| Accounts, invitations, owner/staff/customer roles and store access | Preserve; enforce new permissions on the server |
| Store selection and combined order history | Preserve; new views follow the same selected-store context |
| Catalog products, photography, flavors, search and category hierarchy | Preserve; add ordering modes inside the existing product dialog |
| Customer pricing, quantities, frozen invoices, payments and ledger | Preserve; assortment and credits obey the existing accounting contracts |
| Automatic online draft saving, device copies, offline drafts, conflicts, undo/redo | Preserve; include new draft fields and references in all persistence paths |
| One-tap prefilled Mail with complete plain-text order | Preserve; include additions, exceptions and return instructions in its formatted content |
| Other order formats, PDFs, historical copies and downloads | Preserve; add a more useful pick-list choice |
| Warehouse inventory and return approval | Improve and reuse; store counts remain a separate concept |
| Gemini chat and reviewed order proposals | Preserve; add a separate scoped replenishment analysis |
| Backup/restore and migration protections | Extend to every new collection and record version |
| Existing ordering app, PWA identity and production data | Preserve; the new wholesale PWA has its own identity, scope and storage |

No existing feature is intentionally removed. The old rejected staff-preview checkout is not the implementation base.

## Verified code foundations

- `lib/domain.cjs`: command validation, per-store authorization, optimistic versions, idempotency receipts, inventory reservation/delivery and return approval.
- `server.js`: authenticated API, scoped history, PDF endpoints, rate-limited Gemini routes and explicit backup collections.
- `public/app.js`: grouped Build view, product/flavor dialog, Mail action, inventory view and returns view.
- `lib/documents.cjs`: invoice, existing basic pick list, delivery note, historical copy and credit memo generation.
- `public/order-format.mjs`, `public/order-selection.js`: formatted order text and grouped flavor additions.
- `public/storage.js`, `public/draft-sync.js`, `public/device-storage.js`: draft persistence and recovery.
- `public/sw.js`: existing PWA cache cleanup; must be narrowed to avoid deleting the new app’s caches.

The current API exposes warehouse count records to authenticated customers even though the inventory editor is staff-only. Add explicit projections for warehouse availability and keep exact staff inventory and supplier costs behind staff/owner access. Do not duplicate that behavior for store inventory.

## Acceptance and release evidence

- Verify all seven workflows with synthetic data, including phone and desktop layouts and print output.
- Prove cross-store denial, revoked-access replay denial, version-conflict handling and exactly-once stock/credit/receipt effects.
- Verify the strict four-day boundary, older-history pagination, canceled orders, additions, unit conversion, stock-count staleness and insufficient-data states.
- Preserve existing long-order formatting, flavor notes, one-tap Mail, draft recovery, pricing and order submission tests.
- Verify pick-list pagination, continued headers, large quantities, long names, assortment exceptions and distinct additions/returns sections without clipped text.
- Run required domain/API/document/storage tests, the full test suite and build; run Firestore rules/concurrency checks when server data contracts change.
- Preview and test the wholesale PWA independently, including customer denial, stock consistency, partial receiving, duplicate retries and service-worker isolation.
- Verify backup/restore coverage for the new data before any production cutover.

The exploratory baseline check passed 101 existing domain/API tests. That is evidence about the existing foundation, not validation of these new features. No production changes or live-data mutations were performed for this design.
