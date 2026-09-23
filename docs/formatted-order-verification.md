# Formatted order verification

## Behavior

Open an order and choose **Formatted order**. The copy keeps the store heading and omits the order/invoice number. Product bullets contain alphabetical flavors with quantities in parentheses. Categories follow Tobacco, Novelties, Merchandise, Candy, Groceries, Motor oil, Drinks; unknown categories follow, then uncategorized products. A literal `...` separates category groups, with two empty lines above and below.

**Email order** immediately opens the user's mail app with the recipient, store-name subject, and full order body already filled in. This restores the original v9 `emailOutput()` flow (`9f0cb42`) using the current formatted text: literal bullets, alphabetical flavors, quantities, notes, and exact category separators. Newlines are encoded as CRLF, and all subject/body characters are URL-encoded. There is no clipboard dependency, second dialog, helper installation, or automatic sending.

The mail app controls text fonts, heading appearance and wrapping. A `mailto` body is plain text, so this restores the old filled-in flow without claiming the rich preview's exact typography transfers. The app passes the entire order without a length cap; extremely long email links remain subject to the receiving device/mail application's capabilities.

**Copy formatted order** remains an optional way to copy styled HTML and plain text into Notes or a rich editor. The preview and HTML share inline styles for fonts, bullets, and spacing. A blocked rich clipboard offers a selectable formatted preview, with plain text available as an explicit alternative. **Share plain text** remains available for other apps. The separate direct/scheduled email workflow sends styled HTML and the existing invoice PDF when its sender is configured. No real email is sent during development or verification.

New orders receive a unique numeric display name, starting at 1, at their first server save. Allocation uses a global transactional counter and command receipts. Retries and concurrent saves cannot duplicate a number. Unsaved/offline orders show New order until allocation. Existing orders retain their names and fiscal invoice identifiers remain unchanged. Assigned numbers propagate into edited local drafts without overwriting newer notes or quantities.

Submitted category/product/price snapshots remain authoritative. Older orders use current category assignments only when their snapshot is absent. Formatting preserves every original quantity and instruction, including duplicate rows and historical cases. No display formatting changes an issued order. Whole-order and product-flavor collapse controls remain available.

## Verification

- 581 Node 22 tests pass; build and diff checks pass; production dependency audit reports zero vulnerabilities.
- The prior numbering release also passed six Firestore emulator integration tests, including eight concurrent new orders across stores with duplicate save retries yielding exactly 1–8.
- Email tests verify immediate handoff with full CRLF body, store-only subject, safe Unicode/reserved-character encoding, 1,201-line preservation, no clipboard or paste step, and stale-identity guards. Rich-copy and manual recovery tests remain.
- Numbering tests cover failed-save rollback, forged metadata, corrupted/exhausted counters, retained fiscal references, equal-version refresh, quota overlays, backup handling and newer local edits.
- Synthetic Chromium/WebKit browser checks intercept the email handoff and cover mobile/desktop preview, exact prefilled text, category spacing, blocked clipboard access, optional rich/manual copying, and large orders. They do not claim to verify typography inside iPhone Mail itself. No customer data or real mail applications are used.
- Live deployment verification checks the merged commit, Firebase traffic, asset hashes, protected endpoints and anonymous browser rendering. It does not submit production orders or authenticate as a customer.
