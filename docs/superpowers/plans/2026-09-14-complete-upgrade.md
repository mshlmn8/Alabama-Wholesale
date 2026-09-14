# Complete App Upgrade Implementation Plan

**Goal:** Implement every approved audit fix and useful addition while preserving production data.
**Architecture:** Modular browser UI + verified Firebase Auth + transactional Express/Admin API + versioned Firestore migration.
**Tech Stack:** Node, Express, Firebase Admin/Auth/App Check, browser ES modules, Node tests, PDFKit.

## Work packages

- [x] Domain and money: `lib/domain.cjs`, `tests/domain.test.cjs`. First assert $100 debit + $20 verified payment = $80, duplicate command returns original order, customer cross-store access throws, and stale versions conflict. Implement bounded command operations from spec, then test transitions, inventory and returns.
- [x] Backend/auth: `server.js`, `lib/repository.cjs`, `lib/auth.cjs`, `tests/api.test.cjs`. First exercise unauthenticated/anonymous rejection, store filtering, private-file denial, valid healthz, owner-only bootstrap, expired/reused invite rejection. Implement Firebase Admin verification and explicit public serving.
- [x] Migration: `lib/migration.cjs`, `tests/migration.test.cjs`. Fixtures preserve saved totals/date, unknown stock, all source records, legacy opening balances, exceptions and drafts. Repeat import must be a no-op. Prepare an authenticated migration preview and reconciliation UI.
- [x] Browser: `public/index.html`, `public/styles.css`, `public/app.js`, `public/firebase.js`, `public/storage.js`, `public/sw.js`. Replace monolithic overrides with labeled responsive screens and command-driven flows. Test durable pending draft saves and quota errors before implementing. Reuse only reviewed pure parser ideas from separate staff preview; do not merge its deployment configuration.
- [x] Documents and AI: `lib/documents.cjs`, `lib/assistant.cjs`, `tests/documents.test.cjs`, `tests/assistant.test.cjs`. Fixtures must reject unsnapshotted invoices as finalized, unauthorized store access at route, unknown AI product IDs and unsupported images. Generate real PDFs; model output is only a draft proposal.
- [x] Assets and dependency maintenance: extract correct image files, remove duplicate image pools from deployed build, update compatible packages, verify no sensitive/private assets served. Preserve original source privately for migration reference.
- [x] Full verification: `npm test`, Firebase emulator access/concurrency tests, production build, browser workflows using isolated synthetic data, PDF inspection and `npm audit --omit=dev`. Fix failures and review independently before release.
- [x] Cutover: configure Auth provider/runtime service account/App Check, migrate verified snapshot, deploy explicit App Hosting configuration, deny old/direct Firestore access, verify owner sign-in, counts, financial history, authenticated APIs, and live Gemini. Connect authorized email sender when supplied; preserve outbox until then.

Use the full API/data contracts in the spec as the integration boundary. Keep this checklist current and record commands/results in `docs/upgrade-verification.md`. User approval is already provided for the scope and execution; no repeated approval gates are needed for routine implementation.

Production migration, owner sign-in, live Gemini preview, protected backup export and historical PDF download have been verified. The SMTP adapter/outbox is implemented; activation awaits the owner's sender/service details.
