# Store inventory and ordering expansion implementation plan

> **For agentic workers:** Use subagent-driven-development with disjoint file ownership and review. User approved the complete design and implementation on September 28, 2026.

**Goal:** Deliver requested features 1–6 in the existing ordering app, preserving orders, stock, ledger, drafts and Mail behavior.

**Architecture:** Existing Express/Firebase command transactions remain authoritative. Focused extension modules receive the existing domain helpers and return scoped, versioned records; every command uses existing durable receipts and audit records. Browser components use the existing command queue and draft autosave.

**Tech Stack:** Node 22, CommonJS domain, browser ES modules, Firebase Admin, PDFKit, node:test.

## Ownership and contracts

Root owns `lib/domain.cjs`, `server.js`, `public/app.js`, `public/draft-sync.js`, `public/order-format.mjs`, stock-assortment integration and PDF integration. Delegates own their new modules/tests only; no concurrent edits to shared files.

Extension modules export `commands`, `authorize(actor,type,payload,helpers)` and `execute(tx,actor,command,context,helpers)`. Root dispatches before existing command branches, after idempotency and authorization. Helpers passed are the existing validators, authorization, version helpers, pricing, required-record lookup, inventory helpers, ledger and notifications; extensions cannot bypass them.

```js
const result = await extension.execute(tx, actor, command, {now,id,actor}, helpers);
// All extension results must include storeId when scoped to a store.
// Receipt replay rechecks role and current store authorization.
```

## Task 1: Inventory observations, placements and analysis

Files: new `lib/store-operations.cjs`, `lib/replenishment.cjs`, `lib/replenishment-ai.cjs`, `lib/store-operation-routes.cjs`; focused tests under `tests/`.

- [x] Add failing domain tests for store count isolation/versioning/history, immutable Mail handoff/confirmation, linked additions, receipt deduplication and revoked-access replay.
- [x] Implement commands `storeInventory.count`, `storeInventory.movement`, `order.handoff`, `order.place`, `order.addition`, `placement.receive` with explicit schemas and safe integer quantities.
- [x] Implement analysis using scoped full order/placement history, strict `placedAt < now - 96*60*60*1000`, stable family identities and newer-order notices.
- [x] Prove estimate arithmetic with actual counts/movements and opening-boundary purchase exclusions; unknown data stays unknown.
- [x] Implement minimized Gemini explanations using existing transport/rate limits and schema-validated candidate IDs; deterministic fallback is explicitly labeled.
- [x] Run `node --test tests/store-operations.test.cjs tests/replenishment.test.cjs` and inspect all failures.

```js
assert.equal(eligible({placedAt: now - 96*60*60*1000}, now), false);
assert.equal(eligible({placedAt: now - 96*60*60*1000 - 1}, now), true);
// 24 opening + 12 received - 10 closing - 2 damaged = 24 depletion.
```

## Task 2: Assortment persistence, pricing, reservations and picking

Files: new `lib/order-assortments.cjs`; modify domain, draft sync, formatting and builder integration. New behavioral tests `tests/order-assortments.test.cjs`.

- [x] Write failing tests for logical Mix lines and Each expansion, excluded flavors, heterogeneous effective prices, all-excluded validation and case conversions.
- [x] Extend draft line schema with `selectionMode`, `allowedVariants`, `excludedVariants`; snapshot exact allocation records separately.
- [x] Implement deterministic fair allocation within available whole units, common-price validation and atomic reservation/reallocation.
- [x] Add `order.pick` with version/role/store validation; delivery requires confirmed mixed allocations. Use expanded actual allocations for delivery, cancellation, receipts and returns.
- [x] Preserve metadata through draft sync, local history, undo/redo and text/PDF output. Ensure flavor merger distinguishes Mix from ordinary lines.
- [x] Run focused assortment, draft-sync, selection, domain and formatting tests.

## Task 3: Credits/returns and physical movement

Files: new `lib/order-credits.cjs`; tests `tests/order-credits.test.cjs`; root integrates hooks into existing returns/projections.

- [x] Write failing tests for pending/approved joint credit caps, owner-only adjustment approval, replay, unverified requests and delayed physical returns.
- [x] Add credit request/approval and return pickup/receive commands. Physical return events do not issue another credit.
- [x] Reuse existing returns collection for invoice-linked financial credits so invoice projections have one source; discriminate adjustment records and validate subtotal/tax caps jointly.
- [x] Attach builder credit/return references without negative order lines; show pending requests separately.
- [x] Run focused domain/credit/document tests, including tax-rounding and mixed-flavor return limits.

## Task 4: User flows and picker format

Files: new `public/store-operations.js`, `public/store-operations.css`; root wiring in app/nav/format; new `lib/pick-list.cjs` and document tests.

- [x] Add selected-store inventory with search, counts, timestamps, target, history and offline count drafts.
- [x] Add missing-item review with Add/Skip, explanations, last order/count evidence and explicit insufficient-data states.
- [x] Add Mix/Each tab, searchable flavor exceptions, unit/quantity preview and actual picking editor.
- [x] Add immutable Mail handoff confirmation, linked additions and builder credits/returns.
- [x] Upgrade pick list with repeated headers, large quantities, picked/short columns, exclusions, addition labeling and separate return pickups.
- [x] Run phone/desktop browser walkthrough and inspect generated multi-page PDFs; preserve one-tap Mail.

## Task 5: Integration gates

- [x] Add all new collections to backups and scoped response handling. Never expose supplier costs or other stores’ counts.
- [x] Add required Firestore indexes, build module checks and PWA assets.
- [x] Run full Node 22 test suite, build, rules/concurrency tests and changed-file secret/diff checks.
- [x] Review requirements against actual app flows. Only then begin request 7 under the separate purchasing plan.

No production deployment, external email sending or supplier purchasing occurs during implementation/preview verification.
