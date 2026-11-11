# Desktop Order Sheet and Catalog Sort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the order-sheet design the only design at every width, add a desktop order panel, and add a remembered catalog sort.

**Architecture:** Remove the `isPhone()` gates around the catalog, home and order-page code so one DOM serves every width; `isPhone()` keeps deciding only tabs versus sidebar. The redesign stylesheet is reorganised into shared tokens and components, a phone layout block and a desktop layout block. Sorting is a pure module applied to the filtered product list.

**Tech Stack:** Browser ES modules, plain CSS, Node 22 `node:test`, Playwright Chromium against `scripts/demo.cjs`.

**Spec:** `docs/superpowers/specs/2026-11-11-desktop-order-sheet-and-sort-design.md`

## Global Constraints

- Phone layout stays as shipped: `screen and (max-width: 800px)`.
- Order panel shows at `min-width: 1100px`; the order bar is used below that.
- No server, storage, sync, pricing, permission or data-model change.
- Sort choices and their stored values: `catalog`, `newest`, `oldest`, `az`, `lastOrdered`. Default `catalog`.
- Colours and control sizes as in the phone spec.
- New public files go in `SHELL` in `public/sw.js` with a new `VERSION`, and in `scripts/build.cjs`.

## Review Focus

- Sorting a search result: best-match order must survive under Catalog order and be replaced, not mixed, under any other choice. Task 1.
- Products with no `createdAt`, and stores with no order history: the list still shows every product, in catalog order. Task 1.
- Order panel with a Mix / Each line or a missing price: the line is listed and the total reads "Check items". Task 3.
- Width between 801px and 1099px: no panel, the order bar shows, nothing overlaps the sidebar. Task 4.
- A draft replaced in the background while the desktop catalog is open: counts and panel redraw, and a stale change is refused. Task 3.

---

### Task 1: Sort rules

**Files:** Create `public/catalog-sort.js`; Test `tests/catalog-sort.test.cjs`

**Interfaces — Produces:**
- `CATALOG_SORTS = [["catalog","Catalog order"],["newest","Newest first"],["oldest","Oldest first"],["az","A–Z"],["lastOrdered","Last ordered"]]`
- `normalizeCatalogSort(value) -> string` (unknown → `"catalog"`)
- `lastOrderedIndex(orders, storeId) -> Map<productId, number>`
- `sortCatalogProducts(products, mode, lastOrdered = new Map()) -> products` (new array; input untouched)

- [ ] **Step 1: Failing tests:** each mode's order on a mixed list; ties and missing `createdAt` keep input order; `az` is case-insensitive and numeric-aware ("Item 2" before "Item 10"); `lastOrdered` puts never-ordered products last in input order; `lastOrderedIndex` ignores drafts, cancelled and deleted orders and other stores, reads `productId` or legacy `itemId`, and prefers `order.date` over `createdAt`; unknown mode behaves as `catalog`; input array is not mutated.
- [ ] **Step 2:** Run `node --test tests/catalog-sort.test.cjs`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(catalog): add sort rules`.

### Task 2: Shared stylesheet

**Files:** Modify `public/phone-redesign.css`, `tests/phone-shell.test.cjs`

- [ ] **Step 1: Failing tests** replacing the phone-only confinement test: tokens (`--accent-ink`, `--navy-fill`) are declared outside any media query for light and dark; no selector containing `.mobile-nav` or `.topbar` appears outside the `@media screen and (max-width: 800px)` block; a `@media (min-width: 1100px)` block exists and mentions `.catalog-order-panel`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Reorganise: tokens and component rules at top level with an `#app` prefix; phone shell and positioning in the phone block; desktop layout in `min-width: 801px` and `min-width: 1100px` blocks.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit with Task 3.

### Task 3: One design in the app

**Files:** Modify `public/app.js`, `public/phone-catalog.js`, `public/sw.js`, `scripts/build.cjs`, harness tests (`catalog-category-ui`, `builder-recovery`, `inline-flavors`, `workspace-tools`), `tests/phone-catalog.test.cjs`

**Interfaces — Produces:**
- `createPhoneCatalog` gains dep `orderGroups() -> [{ name, amount, lines: [{ label, quantity, amount }] }]` (amounts are display strings) and returns `orderPanel` (`aside.catalog-order-panel`).
- `orderPanelRows(groups) -> [{ kind: "group"|"line", text, amount }]` exported for tests.
- `renderCatalog` applies `sortCatalogProducts`; the sort `<select id="catalog-sort">` persists `catalogSort`.
- `updateOrderBadge()` replaces `updatePhoneOrderBadge()` and updates every `a[href="#/build"]` in the sidebar and tabs.

- [ ] **Step 1: Failing tests:** `orderPanelRows` flattens groups to "name / amount" then "N × label / amount"; harness expectations updated (sidebar and More row "Home").
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement: drop `isPhone()` gates in `renderCatalog`, `renderHome`, `renderBuilder`, `showAddProduct` and the two background-refresh conditions; delete `renderProductCard`, the old dock and the old Overview body; add the panel and sort control; rename sidebar labels.
- [ ] **Step 4:** Run `npm test && npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(desktop): order-sheet design at every width; catalog sort`.

### Task 4: Browser verification and notes

**Files:** Create `docs/desktop-order-sheet-verification.md`; modify `docs/mobile-ordering.md`

- [ ] **Step 1:** Desktop flow at 1440px: quantities, panel totals, More options stays on catalog, Order page, Home, every sort choice (assert first product names), sort persists after reload.
- [ ] **Step 2:** At 1024px: panel hidden, order bar visible. Overflow check at 801, 1024, 1100 and 1440px, light and dark.
- [ ] **Step 3:** Rerun the phone flow, edge-case and overflow checks from the previous release.
- [ ] **Step 4:** Record results and limits; update the guide. Commit.
