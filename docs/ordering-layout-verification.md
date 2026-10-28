# Ordering layout verification

The approved layout refinement is implemented on `codex/ordering-layout`, based on `d2c5604`, in the isolated `alabama-wholesale-layout` checkout. It has not been merged, pushed, or deployed.

## Automated checks

Node 22.23.3, with the primary checkout's existing dependencies temporarily linked into this worktree:

- Baseline: 581 tests passed; build passed with a 1,973-byte HTML shell.
- Final: **586 tests passed**, zero failed, skipped, or cancelled. Build passed with a **2,068-byte HTML shell**.
- Five added tests cover measured chrome heights, resize fallback, disposed observer callbacks, complete role-specific tool menus, and session changes.
- Existing tests cover draft recovery, undo/redo, pricing, store ownership, per-account preferences, group collapse, worker caching, safe formatting, and retention of 1,201 formatted order lines.
- The new stylesheet and observer module are included in the offline shell and explicit build validation. No backend, authentication, dependency, or lockfile changes were made.

## Browser checks of the actual app source

CUA browser interactions used loopback-only synthetic fixtures: 628 catalog products, 75 owner stores, a 12-line draft, a separate 72-line draft, and a customer with two assigned stores. Firebase identity and requests were replaced in the fixture only; commands used the existing domain implementation against an in-memory repository. No production data, submissions, or emails were sent.

The first matrix completed **48 screen/width/theme checks**: Catalog, Current order, Orders, Customer stores, Workspace, and Overview at 320, 390, 768, and 1,147 pixels, in light and dark appearances. The checks measured document width, heading count, navigation, and dock/padding geometry. All screens fit their viewport. Mobile navigation has five destinations; desktop retains all six. Overview and other operations remain available through More.

| Measurement | Baseline | Implemented result |
| --- | --- | --- |
| Header at 390 px | 110 px | 70 px |
| Store picker at 390 px | 190 px | 230 px |
| Bottom navigation at 390 px | Six items | Five items, 63 px high |
| Builder review strip at 390 px | Floating in document | Fixed directly above navigation, about 78 px high |
| Mobile content bottom reserve | Fixed legacy spacing | 165 px from measured navigation and dock heights plus 24 px |
| Desktop builder at 1,147 px | Summary below the sheet | 609 px sheet beside a 250 px summary |

Additional interaction checks passed:

- Quantity keyboard edit: 4/$48.04 → 5/$50.20 → Undo 4/$48.04 → Redo 5/$50.20. Quantity, notes, and total survived reload in the fixture.
- Review retained all 12 lines, the total, and delivery notes. Literal `<script>` text remained text; no script element was rendered.
- The 72-line draft fit at 320 and 390 px. At 320 px, the final row ended at 502.94 px and the notes field at 542.33 px, above the review strip beginning at 599.22 px. At 390 px, the last row ended at 452.75 px, above the strip beginning at 703.22 px. Group collapse/expand retained quantity 2 and total $289.38.
- A customer switched to the long store name “Corner Market on University Boulevard & North Parkway” and opened an empty draft at 320 px. The header wrapped to 100.42 px without horizontal overflow; the measured bottom reserve remained correct and zero-line review was disabled.
- Customer Workspace retained ten tools, staff eleven, and owner nineteen under existing role conditions. Customer Catalog tools exposed Draft with AI while product creation remained owner-only. Detached tool actions reject a later session in the added tests.
- Catalog search and nested Category → Juice → Apple navigation worked. Grid and compact choices survived reload; a saved five-column choice adapted to two visible columns on a phone. Full names, prices, packing details, and Add actions were visible. List and grid remained accessible.
- Personal item size changed from Small to Large (row padding 3 → 12 px), retained total $50.20, and was restored to Small.
- Workspace tools closed with Escape and returned focus to `workspace-tools`. No open dialog remained. The final in-app preview reported no warning/error logs.
- Orders → Open 101 → Formatted order → Email order produced the existing `mailto:` draft with the store as subject, a bullet containing the product/flavor/quantity/line note, CRLF spacing, and delivery notes. The fixture intercepted the mail launch into a hidden output; native Mail was not launched. The production email action and formatter were unchanged.

## Evidence and preview

The implementation preview is `http://127.0.0.1:8892/#/build`. Its prices, products, accounts, and save status are synthetic examples. The ignored fixture server is `.firebase/ordering-layout/server.cjs`; it is not application or deployment code.

Saved artifacts in the parent workspace's `output` directory:

- `ordering-implementation-desktop.jpg`: actual dark desktop builder.
- `ordering-implementation-light.jpg`: actual light desktop builder.
- `ordering-implementation-mobile.jpg`: actual dark phone builder at 390×844.
- `ordering-implementation-catalog-mobile.jpg`: actual phone catalog.
- `ordering-implementation-mobile.json`, `ordering-implementation-large-order.json`, and `ordering-implementation-email-check.json`: measured geometry and intercepted synthetic email content.

The older `ordering-layout-*` artifacts show the approved proposal and are not evidence of the implementation. The 48-case matrix was observed before a browser interruption; its unsaved in-memory rows were lost. This document records the observed aggregate and representative measurements, not a reconstructed set of individual rows.

## Failure provenance and limits

The first baseline test attempt had 51 sandbox `listen EPERM` failures. Allowing localhost binding yielded 581 passing baseline tests; the final run also permitted binding and passed all 586.

A narrow account panel initially expanded the document to 359 px at a 320 px viewport. Correcting its inherited flex wrapping returned it to 320 px; the full matrix subsequently passed. During diff cleanup, a required Workspace grouping helper was accidentally omitted. It was restored, and two tests now cover tool completeness and stale-session behavior; the final full suite passed.

An immediate read after bulk quantity fill did not demonstrate undo/redo. A fresh keyboard edit and independent reads then verified each transition. No ordering-domain logic was changed.

The Chrome connection later timed out and disappeared. Resetting CUA restored access through the Codex in-app browser. Large-order, keyboard, personal-size, email, and screenshot checks were completed there. No alternate browser automation was used.

These checks do not prove live Firebase sync, production authorization configuration, an installed PWA refresh, camera scanning, downloads, physical iPhone safe areas/keyboards, spoken screen-reader behavior, native Mail formatting/delivery, or deployment. Those integrations remain the existing implementation and require their appropriate environment. The change is ready for local review; production acceptance is not claimed.
