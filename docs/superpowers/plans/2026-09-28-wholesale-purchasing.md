# Wholesale purchasing implementation plan

> **For agentic workers:** Use subagent-driven-development after the ordering expansion gates pass.

**Goal:** Deliver request 7 as a distinct installable wholesale operations app with stock, suppliers, POs and receiving.

**Architecture:** A `/warehouse/` PWA consumes staff-authorized API projections and the same inventory ledger as ordering. Supplier costs remain owner-only. Stock changes occur through transactional idempotent commands.

**Tech Stack:** Existing Node 22/Firebase API, browser ES modules, PDFKit and node:test.

## Task 1: Purchasing domain

Files: `lib/purchasing.cjs`, `tests/purchasing.test.cjs`, domain dispatcher integration.

- [x] Write failing tests for supplier/PO permissions, whole-unit snapshots, immutable ordered POs, partial receipts, replacements and duplicate retries.
- [x] Implement supplier/product mapping save, draft/order/amend/close PO commands and receipt commands.
- [x] Receiving atomically updates accepted stock, immutable receipt/movement, PO version/status and command receipt. Rejected replacement quantities remain outstanding.
- [x] Verify: receiving four of ten cases leaves six outstanding; retry adds zero stock; damaged goods add zero resalable stock.
- [x] Implement suggestions `ceil(max(0,target-(onHand-reserved)-confirmedInbound)/multiple)*multiple` with explicit unknown-input states.

## Task 2: Separate PWA and routes

Files: `public/warehouse/` shell/screens/styles/worker/manifest, `lib/warehouse-routes.cjs`, existing server/worker/build integration.

- [x] Build Overview, Stock, Purchasing, Receive and Suppliers using the existing Firebase sign-in/session conventions and authenticated API.
- [x] Add printable/downloadable POs; marking ordered is an explicit user confirmation, never an external purchase.
- [x] Use distinct app/cache/database identities; exclude warehouse navigation/assets from ordering fallback/cache cleanup.
- [x] Verify owner/staff/customer projections and both install identities; test independent account/draft handling.

## Task 3: Completion evidence

- [x] Extend backup/restore and index/build checks.
- [x] Run domain/API/PWA tests, all regression tests, Node 22 build, dependency audit and browser phone/desktop receiving walkthrough.
- [x] Record actual limitations and a reproducible preview command in `docs/wholesale-expansion-verification.md`.
- [x] Commit reviewed changes to the feature branch; report exact branch/SHA, tests and preview state. Production release remains separate from local implementation.
