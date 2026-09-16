# Combined store order history verification

Verified on 2026-09-15. **Orders → All stores** combines order history for the signed-in account's accessible stores. **Selected store** restores the existing view. Both retain status filters, store labels, invoice opening and older-order pagination without changing the ordering store or working draft.

- 421 Node22 unit/API tests passed, including four new access and pagination regressions. Tests cover master global history, assigned-only stores, revoked access, unauthorized cursor rejection, status filtering, archived records and 65-store pagination across query chunks. A reproduced in-memory cursor bug was fixed to match Firestore's ordering-value cursor behavior.
- 152 Chromium/WebKit browser assertions passed at phone and desktop widths. They cover automatic first-page reads, status/cursor reset, combined/selected query parameters, cross-store invoice details, unchanged header/draft/preferences, delayed-response rejection, restricted accounts, inline retry and identity changes. No runtime errors or horizontal overflow were observed; mobile and desktop screenshots were inspected.
- A reproduced cross-store draft price bug was fixed by passing the order’s store into draft line estimates. Fourteen targeted Chromium/WebKit assertions confirm each/case overrides use the draft’s store, missing stores fall back to catalog prices, submitted snapshot prices stay fixed, and the active ordering store/draft remain unchanged.
- Build and whitespace checks passed. The production dependency audit reported zero vulnerabilities.

Browser tests used isolated synthetic orders and accounts; no production orders, catalog records or emails were created. Local reports, runners and screenshots are under the ignored `.firebase/upgrade/all-store-orders/` directory. GitHub CI also runs the Firestore rule emulator before merge. Release validation checks the App Hosting commit and traffic, live asset hashes and unauthenticated API rejection.
