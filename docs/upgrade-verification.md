# Alabama Wholesale upgrade verification

The September 14 upgrade replaces browser-owned permissions and shared-document writes with verified Firebase Auth, server-owned access profiles, and transactional records. The prior application remains in repository history for reference and is excluded from the deployed public directory.

## Implemented behavior

- Verified Google owner enrollment and email-bound, expiring invitations. New invitations and access changes invalidate older links. Disabling an account takes effect on its next API request.
- Every business mutation has a stable command receipt, validation, version checks and an audit event. Customer access is checked against assigned stores by the server.
- Integer-cent billing, immutable invoice prices, atomic stock reservations, invoice numbers, fulfillment transitions, cancellation credits, pending payment verification, explicit invoice allocations, and bounded return credits/restocking.
- Individual catalog, store, order, ledger, inventory, payment and return records. Queries scope financial history to the relevant account or invoice. History paginates with deterministic ordering.
- Reviewed Gemini text/photo proposals through the existing Firebase AI Logic setup. Proposals cannot directly change orders, finances or inventory. Input/output validation and per-user request limits apply.
- Real invoice, pick-list, delivery-note, historical-copy and credit-memo PDFs. Historical prices are never reconstructed using the current catalog.
- Durable local draft/command recovery with visible failures, immutable in-flight submissions, stale-tab detection and account-switch isolation. Accessible dialogs, keyboard controls and a verified mobile layout.
- Product uploads, accurate catalog image paths, barcode/variant matching, per-store favorites, templates, team access management, stock alerts and customer-specific terms/prices.
- Consistent business backup snapshots and checksum-verified restore into an isolated recovery namespace. Direct browser Firestore access is denied at cutover.
- In-app notifications and an opt-in SMTP outbox with delivery claims, status tracking and explicit retry of uncertain results. Actual email remains unconfigured until the owner supplies a sender/service.

## Verification performed before release

- Full Node 22.23.2 test suite: **147 tests passed** at the latest checkpoint. Includes money, permission isolation, concurrency, migration, PDFs, AI validation, email outbox, upload validation, persistence and delayed-response regressions.
- Firebase Firestore emulator: browser/anonymous/forged-admin reads and writes denied; simultaneous orders cannot oversell stock; duplicate submissions create one charge; large private archives preserve all bytes.
- A private copy of the real legacy database migrated successfully in the emulator: 628 products, 75 stores, 85 history documents (84 active plus one tombstone), four saved drafts, 2,556 unknown-stock variant records, 11 pending enrollment profiles. All **3,582 planned records** verified; repeated migration created zero duplicates.
- The source preview produced 134 review notices, primarily missing historical price snapshots. These preserve source evidence and do not invent prices, stock quantities or fulfillment state.
- Browser walkthrough with synthetic records: two cases at $30 plus tax produce a $64.80 invoice; workflow reaches delivered; a $20 report leaves the balance unchanged until verification; a one-case return credits $32.40 and restocks 12 units. PDF downloads, Gemini review gating, reload recovery, store isolation and a 390×844 mobile viewport were exercised.
- PDF text and rendered pages inspected for one-page and multipage invoices, pagination, complete SKU retention and historical dates.
- All 345 referenced catalog image paths resolve. The HTML shell is approximately 1.5 KB rather than the previous 7.16 MB embedded-image page; product images load as separate files.
- Production dependencies have no known findings in `npm audit --omit=dev` at the pre-release checkpoint.
- Independent reviews found and verified fixes for stale invitations, inconsistent backup reads, tied-date pagination, account-switch races, late draft acknowledgments and confirmed-save/failed-refresh ambiguity.

## Release gates

Production cutover is complete. All 3,582 imported records matched their planned canonical values, all 75 opening balances matched the source, and repeated migration created zero duplicates or conflicts. All nine indexes were READY before the migration gate opened. The private source archive passed byte-for-byte verification; the final source checksum is `f70d68d9654fb2176bf4c7659945843930b9137ca72a073ca7714dad2b11fa05`.

Authenticated production follow-up confirmed the configured Google owner has active master access and can reload the workspace. The live Gemini assistant returned an exact product/variant/quantity proposal, which was closed without adding or submitting an order. A live business backup downloaded successfully and its SHA-256 matched. Its catalog, store, history and ledger counts matched the migration.

The historical PDF walkthrough found and corrected two display issues: imported records now request Historical copy rather than an unsupported final invoice, and legacy horizontal divider glyphs render as printable hyphens. Regression tests exercise the UI-selected document kinds through the real renderer. The live historical download retains its original date, saved total and missing-price warnings. No new live orders, payments, credits, invitations or emails were created during verification.

Live `/health` returns HTTP 200 with version 2, unauthenticated `/api/state` returns 401, and private source paths return 404. `/health` avoids Cloud Run's reserved paths ending in `z`; `/healthz` remains a local compatibility alias. Email sending remains the only unconfigured integration, pending the owner's sender/service details.

## Email configuration

Set `EMAIL_FROM` to the verified business sender and provide `SMTP_URL` through Secret Manager. Never put SMTP credentials in browser configuration or Git. The outbox sends only to active authorized users who explicitly opted in, and excludes notifications created before that opt-in. A `sent` status means the provider accepted the email; it does not claim the recipient read it. Uncertain outcomes require a deliberate retry after checking the provider.
