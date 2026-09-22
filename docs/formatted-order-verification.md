# Formatted order release verification

## Behavior

Open any saved order with items and choose **Formatted order**. The preview uses the saved store name and order/invoice reference, then product bullets with flavor quantities in parentheses. **Copy formatted order** copies both rich HTML and plain text where supported; browsers without rich copying use plain text or a selectable-text fallback. **Share order** opens the device share sheet where supported. Closing that share sheet does not send or copy anything.

The category sequence is Tobacco, Novelties, Merchandise, Candy, Groceries, Motor oil, Drinks. Unknown categories follow and uncategorized products are last. Blank space separates groups, matching the supplied example. Subcategories inherit the matching ancestor. Flavors sort alphabetically, with numeric names in natural order. Every original quantity and instruction remains, including duplicate lines and historical case quantities. Prices are omitted from this view; the invoice remains available separately.

New submissions freeze category names from the server catalog alongside product and price snapshots. Older orders use current category assignments when a snapshot is absent, while retaining saved product/store names. Formatting never edits an issued order.

Builder products each have a collapse control; complete item lists can be collapsed in the builder, review dialog, and saved order. Controls toggle existing DOM visibility, so quantities and unsaved notes survive. Display state is remembered for the current browser session, independently by user and order. Totals and review actions stay accessible. Narrow screens use a 44-pixel arrow control with an accessible label.

Existing direct/scheduled email delivery now uses the same formatted HTML and text with the invoice PDF attached. Its fixed recipient, authentication, ownership checks, scheduling, retry protection, and sender-configuration requirements are unchanged. This release does not enable automatic sending, configure a sender, or send any existing orders.

## Verification

- 555 Node 22 tests pass, including snapshot integrity, category ancestry/cycles, duplicate quantities, legacy naming, HTML escaping, stale identity controls, share cancellation, rich/plain copy fallbacks, and retained notes.
- Build and diff checks pass. Production dependency audit: zero vulnerabilities.
- Chromium and WebKit synthetic authenticated workflows cover alphabetical inline flavor creation, preserved typed quantities, collapse/expand and rerender, unpriced submission at $0, seven category groups, safe preview rendering, rich/plain clipboard/native share, and all 1,201 lines of a large order.
- Layout checks at 320, 390, and 1,440 pixels; mobile touch controls remain at least 44 pixels.
- Test deliveries use mocked SMTP only. Browser tests use an in-memory repository; no customer orders or email recipients are changed.
- Deployment is verified separately against the merged commit, Firebase traffic state, public asset hashes and unauthenticated endpoint protections. Authenticated production actions are not exercised by the anonymous live smoke.
