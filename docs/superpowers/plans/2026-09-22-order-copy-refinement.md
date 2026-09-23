# Consistent editable order copies and simple numbering

The user confirmed that the store heading remains and the order/invoice number is removed from the formatted copy. Category boundaries use a literal `...` line with two empty lines above and below. Keep the existing seven-category sequence, alphabetical flavors, all quantities and instructions, and immutable issued snapshots.

The Share action currently uses the Web Share API's plain text field, while rich copying uses text/html. Native sharing has no rich email-body field. The user chose editable email text over PDF attachments. Provide an Email formatted text action that copies the styled HTML and opens the user's mail composer, with explicit paste instructions. Keep generic text sharing clearly identified as plain text; direct in-app email uses the identical styled HTML body. Failed rich clipboard access offers a selectable formatted preview rather than silently treating plain text as preserved formatting. No messages are sent by this development task.

New orders get an independent numeric display orderNumber at their first trusted server save, starting at 1. Transactional allocation and command receipts prevent duplicate numbering; store ownership and validation precede allocation. Existing records and issued invoice identifiers remain intact. Propagate the assigned number into working drafts, including drafts edited while a save was in flight. Display a temporary New order label until online allocation, never a client-invented number.

Implementation:
- Shared formatter: explicit separators, no body reference, common inline styles for rich HTML and preview; escaping and large-order regressions.
- Trusted numbering: allocation, idempotency, unchanged legacy/invoice data, summaries and naming tests.
- Draft synchronization: metadata acknowledgement without overwriting later local edits; no counterfeit persisted number inheritance.
- UI: identical styled preview; rich copy/email workflow and honest text-sharing option; update a draft's visible number without losing typed input.
- Verify full tests/build/audit, responsive Chromium/WebKit behavior, review and secret scan, PR checks, production rollout and live asset/browser checks.
