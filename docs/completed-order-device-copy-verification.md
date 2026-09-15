# Completed-order device copies — 2026-09-14

Successful order submissions now request an invoice PDF download by default. The account/device setting appears in order review and Workspace backup; users can turn it off or choose PDF, a JSON archive, or both. The setting is captured with the queued submission so confirmation through Sync center uses the original choice.

Document preparation runs separately from financial confirmation. A failed file request leaves the order saved online and offers a file-only retry. The order details show “Saved online” alongside a separate preparing, requested, partial or error state for its device copy. A download request does not prove the browser wrote a file to disk.

The implementation reuses the existing authenticated invoice route and PDF renderer. JSON uses the separate `aw-order-copy` version 1 envelope with a snapshot of the confirmed order; it contains no executable command queue and is not imported as a new financial transaction. Account changes and controller disposal prevent late download requests.

## Validation

- 228 Node 22 tests pass, including 18 new download regressions. The production build and whitespace checks pass.
- The isolated browser harness uses synthetic orders and the existing PDF generator. It observes actual download events, saves the received files, checks PDF/JSON contents, and records submission requests and committed orders. No production business data is mutated.
- The representative invoice was rendered and visually inspected. It contains the correct invoice ID, customer, product, quantity, frozen price, $0.32 tax, $4.32 total and order notes.
- All 13 scenarios pass in Chromium and all 13 pass in WebKit. They exercise default PDF, disabled copies, account/device preference persistence, JSON/both, document errors and manual retry, delayed documents, account changes, recovered submission, failed submission, draft saving, cancelled downloads and a blocked-download fallback. A 6.5-second PDF delay leaves the confirmed order visible within 113–123 ms in the local fixture; document preparation does not block order navigation.
- WebKit initially replaced the first of two immediate Blob download requests. A bounded 100 ms gap between formats produced both actual files in the browser check; identity is checked again after that gap. PDF-only requests have no added delay.

Browser artifacts and the reproducible fixture are retained locally in `.firebase/upgrade/completed-order-copy/`. Browser download permission, cancellation and final file placement remain outside the app's control. The UI keeps a manual download action available and never labels a file “Saved on device.”
