# Mobile order-review correction

The iPhone review of the approved layout found that long product names pushed quantities and prices outside the review dialog. At a 320 px browser viewport, the table had 818 px of content inside a 246 px container.

Order-line tables now display each product above three labeled quantity, price, and line-total fields below 900 px. Desktop retains the table layout. Explicit table, row, and cell roles preserve the table structure when CSS changes its display. The offline shell version is incremented for the correction.

## Verification

- Node 22.23.3: 763 tests passed, with no failures, skips, or cancellations. Build passed with the 2,186-byte HTML shell. Production dependency audit reports zero vulnerabilities.
- An initial sandbox test attempt had 74 localhost `listen EPERM` failures; rerunning with localhost binding permitted passed all 763 tests.
- Ten browser measurements cover 320×740, 390×844, 412×915, 844×390, and 1147×850 in both themes. Every order cell fits within its table; all 12 lines and the $43.72 total remain present. At 320 px, table content and container both measure 246 px. Desktop rows retain `display: table-row`.
- The release's broader 60-case matrix covers Catalog, Build, Orders, Stores, More, and Store inventory at the same five sizes and both themes. It found no document-wide horizontal overflow and retained five mobile navigation destinations.
- Personally operated iPhone 17 / iOS 26.5 Safari in Simulator and Pixel 3a / Android API 34 Chrome in the Android emulator. Both render the corrected product, quantity, price, and total fields. Numeric keyboards keep the active quantity visible. Android editing changed quantity 2 → 3 and total $43.72 → $45.88; Undo restored 2 and $43.72.

## Evidence and limits

Screenshots and geometry JSON are saved in the parent workspace's `output` directory, including `ordering-release-iphone-review-after.jpg`, `ordering-release-android-review-after.jpg`, and the `ordering-release-review-dark.json` / `ordering-release-review-light.json` measurements.

Authenticated interaction checks use the actual application source with isolated synthetic accounts, products, stores, and orders. No production orders, payments, or emails were sent. The Android fixture uses an ADB loopback connection because the emulator host alias is not a secure browser context. This is test infrastructure only.

These results establish simulator and browser behavior, not physical-device acceptance, spoken screen-reader behavior, live authenticated sync, or an already-open installed PWA refresh. The earlier `ordering-layout-verification.md` records the original local implementation; its pre-deployment status and test counts are historical.
