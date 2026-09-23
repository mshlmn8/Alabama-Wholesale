# Formatted order verification

## Behavior

Open an order and choose **Formatted order**. The copy keeps the store heading and omits the order/invoice number. Product bullets contain alphabetical flavors with quantities in parentheses. Categories follow Tobacco, Novelties, Merchandise, Candy, Groceries, Motor oil, Drinks; unknown categories follow, then uncategorized products. A literal `...` separates category groups, with two empty lines above and below.

**Copy formatted order** writes both styled HTML and plain text to the clipboard. The preview and HTML share inline styles for fonts, bullets, and spacing. **Email formatted text** copies the rich version and explains the paste step before **Open email** opens the user's composer. The recipient and store-name subject are populated; the user pastes into the message body to keep it editable and retain rich formatting. A blocked rich clipboard offers a selectable formatted preview, with plain text available only as an explicit alternative.

**Share plain text** remains available for other apps and clearly identifies its format. The Web Share API accepts text, links, or files, not a rich email-body field; it cannot require receiving apps to preserve typography. The user chose editable text over a PDF attachment. The app's direct/scheduled email workflow sends the same styled HTML and keeps the existing invoice PDF attachment. Dedicated-sender configuration remains separate; this development task sends no real email.

New orders receive a unique numeric display name, starting at 1, at their first server save. Allocation uses a global transactional counter and command receipts. Retries and concurrent saves cannot duplicate a number. Unsaved/offline orders show New order until allocation. Existing orders retain their names and fiscal invoice identifiers remain unchanged. Assigned numbers propagate into edited local drafts without overwriting newer notes or quantities.

Submitted category/product/price snapshots remain authoritative. Older orders use current category assignments only when their snapshot is absent. Formatting preserves every original quantity and instruction, including duplicate rows and historical cases. No display formatting changes an issued order. Whole-order and product-flavor collapse controls remain available.

## Verification

- 580 Node 22 tests pass; build and diff checks pass; production dependency audit reports zero vulnerabilities.
- Six Firestore emulator integration tests pass, including eight concurrent new orders across stores with duplicate save retries yielding exactly 1–8.
- Clipboard/email tests verify rich HTML, store-only subject, absent plain-text mailto body, manual-copy recovery and stale-identity guards.
- Numbering tests cover failed-save rollback, forged metadata, corrupted/exhausted counters, retained fiscal references, equal-version refresh, quota overlays, backup handling and newer local edits.
- Synthetic Chromium/WebKit browser checks cover mobile/desktop preview, category spacing, copying, composer preparation (intercepted), large orders, collapse, and numbering. No customer data or real mail applications are used.
- Live deployment verification checks the merged commit, Firebase traffic, asset hashes, protected endpoints and anonymous browser rendering. It does not submit production orders or authenticate as a customer.
