# Formatted and collapsible orders

**Goal:** Match the supplied email example with a store heading and product bullets, preserve every quantity, and reduce scrolling with collapse controls.

**Design:** One shared formatter provides text, escaped email HTML, and structured groups for a safe DOM preview. Groups follow Tobacco, novelties, merchandise, candy, groceries, motor oil, drinks; unknown categories follow. Subcategories inherit their parent group. Product order remains stable within each group. Named flavors sort alphabetically; duplicate lines and instructions are retained. Submitted orders freeze category names on the server, just as product names and prices are frozen. Existing orders use current categories only when snapshots are absent.

**Interaction:** Every saved order with items offers Formatted order. Its preview includes copy, native share where supported, and the existing email action for eligible invoices. Existing email delivery uses the same formatted body and keeps the PDF attachment. Formatting never sends an order automatically or enables automatic email. Whole item lists and builder flavor groups have independent accessible collapse buttons; collapse never modifies drafts or loses notes.

**Implementation / verification:**
- [x] Shared formatter and regression tests for seven categories, subcategories, unknowns, snapshots, escaping, duplicate flavors and large orders.
- [x] Trusted submission category snapshots and formatted mail bodies, retaining authorization and delivery guards.
- [x] Alphabetical flavor controls and safe quantity mapping after inline creation.
- [x] Preview/share/copy UI, collapse controls, responsive styles, offline shell update.
- [x] Unit suite, build, targeted browser behavior on Chromium/WebKit and mobile/desktop, independent code review.
- [ ] Commit and PR with CI, deployment, and live release asset/health verification.
