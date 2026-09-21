# Ordering improvements — September 18, 2026

Implementation and synthetic verification for the five ordering improvements. Production release verification is performed separately after rollout.

- Catalog search responds to typing, Enter, browser search/clear, change and composition completion. Missing commit handlers were reproduced with synthetic browser events; the user's specific device event sequence was not observed.
- Administrators can save a new flavor with an optional price and barcode inside the item selector or Edit order item dialog. Existing quantities, units and notes are retained. Catalog permissions, product versions and account/store/draft guards remain enforced.
- Categories appear in a horizontally scrolling row. Selecting a category exposes its child row, and parent filtering includes descendant products. Category management supports adding children and changing parents; the server rejects missing parents and circular relationships.
- Order labels, draft exports, invoice downloads, PDF titles and email attachment filenames use the store name and stable order/invoice identifier. Issued invoice numbers and financial behavior remain unchanged.
- Build defaults to Small cards. Item size is configurable from Build or Workspace → Builder settings, with Small/Medium/Large persisted in the authenticated account's server preferences.

## Verification

- All 467 unit/API tests pass on Node 22.23.2; the production build and whitespace checks pass.
- Search: 16 Chromium/WebKit browser checks cover typing, browser commit paths, clearing and rerendering.
- Integrated categories/settings: 48 Chromium/WebKit checks cover category scrolling, nested filtering, category creation, size changes and persistence after reload, no page overflow and preserved touch targets at 320, 380, 390, 700 and 1440px.
- Independent layout review covers 48 additional scenarios in Chromium/WebKit, including category dialogs and all three builder sizes at 320, 380, 390, 700, 768 and 1440px. A mobile category-button overlap was found and fixed. No remaining overflow or undersized button targets were found.
- On the 390px fixture, the same product card measures approximately 241px in Small, 358px in Medium and 409px in Large. Screenshots were inspected.
- Inline flavors: Chromium and WebKit phone checks verify adding a seventh flavor enables search, existing case quantities and notes survive saving, and builder editing selects a newly saved flavor while retaining quantity and notes. No runtime errors occurred; the dialog screenshots were inspected.
- Independent reviews found no blocking issues in category validation, per-account settings or inline flavor version/session handling.

All browser data is synthetic. No production orders, catalog records or emails were changed. Reproducible browser fixtures, reports and screenshots are retained locally under `.firebase/ordering-improvements/` `.firebase/search-fix/` and `.firebase/inline-flavors/` (ignored by Git).
