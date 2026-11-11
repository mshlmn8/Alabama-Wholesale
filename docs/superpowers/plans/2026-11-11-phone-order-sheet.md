# Phone Order-Sheet Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On phone-sized screens, let a store owner set quantities directly in the catalog, with a new look, tabs, order screen and home, while desktop stays unchanged.

**Architecture:** Phone-only DOM branches in the existing render functions of `public/app.js`, chosen by one media query helper and re-rendered when the breakpoint is crossed. New behaviour lives in small modules that receive the app's DOM helpers by injection, the way `createAssortmentPanel` does. All new styles sit in one stylesheet inside `@media screen and (max-width: 800px)`.

**Tech Stack:** Browser ES modules, plain CSS, Node 22 `node:test`, Playwright Chromium against `scripts/demo.cjs`.

**Spec:** `docs/superpowers/specs/2026-11-11-phone-order-sheet-design.md`

## Global Constraints

- Phone means `screen and (max-width: 800px)`. Above 800px the DOM, styles and behaviour are unchanged.
- No server, storage, sync, pricing, permission or data-model change. Draft lines keep their shape: `{id, productId, variant, quantity, unit, note}` plus the Mix / Each fields.
- Every existing tool stays reachable on phone.
- Quantities are whole numbers from 0 to 1,000,000.
- Colours: ink `#17152B`, muted `#5B5A6B`, navy `#241A6B`, action orange `#C94712`. Controls at least 44px tall. Inputs keep 16px text.
- New public files must be added to `SHELL` in `public/sw.js` (with a new `VERSION`) and to `scripts/build.cjs`.
- Run tests with `npm test`; build check with `npm run build`.

## Review Focus

- First quantity change with no draft: a draft is created and the catalog stays on screen (today `editDraft` jumps to Build). Pinned in Task 2 and Task 7.
- A flavor whose quantity sits in a line with a note, a case unit or a Mix / Each line: `−` and typed values never delete a note or touch a Mix / Each line. Pinned in Task 1.
- The catalog changed while a panel is open (flavor removed, product deactivated): the change is refused with a message and the draft is untouched. Pinned in Task 4.
- A product without a usable price: the order bar reads "Check items", never a wrong total. Pinned in Task 4.
- Crossing 800px by rotating or resizing: the page re-renders in the other layout with the same draft and no error. Pinned in Task 7.

---

### Task 1: Quantity rules

**Files:**
- Create: `public/catalog-quantities.js`
- Test: `tests/catalog-quantities.test.cjs`

**Interfaces:**
- Produces:
  - `variantQuantity(lines, productId, variant) -> number` (manual lines only)
  - `productQuantity(lines, productId) -> number` (every line, Mix / Each included)
  - `draftUnits(lines) -> number`
  - `stepVariantQuantity(lines, productId, variant, delta, makeId) -> lines` (`delta` is `1` or `-1`; returns the same array when nothing changes)
  - `setVariantQuantity(lines, productId, variant, quantity, makeId) -> lines` (throws `Error` outside 0 to 1,000,000 or non-integer)

- [ ] **Step 1: Write failing tests** covering: sum across manual lines; `+` raises the plain line and creates `{id: makeId(), productId, variant, quantity: 1, unit: "each", note: ""}` when none exists; `+` at 1,000,000 returns the same array; `−` lowers the plain line first, then the last manual line, and removes a line at zero; `−` with no manual line returns the same array even when a Mix line exists; `set` leaves noted and case lines alone and adjusts or removes only the plain line; `set` below the quantity already held by other lines removes the plain line and keeps the others; input arrays are never mutated.
- [ ] **Step 2: Run** `node --test tests/catalog-quantities.test.cjs`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement.** A plain line is `!["mix","each"].includes(line.selectionMode) && (line.unit ?? "each") === "each" && !(line.note || "").trim()`. A manual line is the same test without the unit and note conditions.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(catalog): add inline quantity rules`.

### Task 2: Phone layout helpers and draft creation without navigation

**Files:**
- Create: `public/phone-layout.js`
- Modify: `public/app.js` (`beginDraft`, `editDraft`, `render`, module top level)
- Test: `tests/phone-layout.test.cjs`

**Interfaces:**
- Produces:
  - `PHONE_QUERY = "screen and (max-width: 800px)"`
  - `isPhone(environment = window) -> boolean`
  - `PHONE_TABS = [["home","Home","home"],["catalog","Catalog","catalog"],["build","Order","cart"],["orders","History","orders"],["more","More","more"]]`
  - `phoneDestination(view) -> "home"|"catalog"|"build"|"orders"|"more"` (anything else maps to `"more"`)
  - `watchPhoneLayout(onChange, environment = window) -> stop()`
  - In `app.js`: `startDraft()` creates and activates a draft without `setView`; `beginDraft()` becomes `startDraft(); setView("build")`; `editDraft` calls `startDraft()` when there is no draft.

- [ ] **Step 1: Write failing tests** for `phoneDestination` (`home`→`home`, `stores`→`more`, `documents`→`more`, `orders`→`orders`), `isPhone` with a fake `matchMedia`, and `watchPhoneLayout` calling back on change and not after `stop()`.
- [ ] **Step 2: Run** `node --test tests/phone-layout.test.cjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the module and the `app.js` draft change. Call `watchPhoneLayout(() => state && render())` once at module load.
- [ ] **Step 4: Run** `npm test`. Expected: all pass (existing callers of `beginDraft` still land on Build).
- [ ] **Step 5: Commit** `feat(phone): add layout helpers and in-place draft creation`.

### Task 3: Phone shell, tabs and look

**Files:**
- Create: `public/phone-redesign.css`
- Modify: `public/app.js` (`render`, `renderMore`), `public/index.html`, `public/sw.js`, `scripts/build.cjs`
- Test: `tests/phone-shell.test.cjs`

**Interfaces:**
- Consumes: Task 2 exports; `draftUnits` from Task 1.
- Produces: `#app[data-phone="true"]` and `#app[data-view="<view>"]` on phone renders; mobile nav built from `PHONE_TABS` with a `.badge-count` on Order; a Stores row first in More's "Quick access" on phone.

- [ ] **Step 1: Write failing tests**: `public/sw.js` `SHELL` contains `/phone-redesign.css`, `/phone-layout.js`, `/phone-catalog.js`, `/catalog-quantities.js` and `VERSION` differs from `aw-v2-20261105-more-1`; `public/index.html` links `/phone-redesign.css` after `/mobile-layout.css`; every rule in `phone-redesign.css` is inside `@media screen and (max-width: 800px)` (strip those blocks, assert only whitespace and comments remain).
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement.** In `render`, keep the desktop nav array; build the phone tab bar from `PHONE_TABS` when `isPhone()`. Stylesheet: phone tokens (light and dark), top bar, tab bar, chips, cards, buttons; logo hidden unless `data-view="home"`.
- [ ] **Step 4: Run** `npm test && npm run build`. Expected: pass.
- [ ] **Step 5: Commit** `feat(phone): new tabs, top bar and look`.

### Task 4: Catalog order sheet

**Files:**
- Create: `public/phone-catalog.js`
- Modify: `public/app.js` (`renderCatalog`), `public/phone-redesign.css`
- Test: `tests/phone-catalog.test.cjs`

**Interfaces:**
- Consumes: Task 1 functions; from `app.js` by injection: `el`, `icon`, `button`, `iconButton`, `input`, `act`, `cash`, `toast`.
- Produces: `createPhoneCatalog(deps) -> { card(product), panelFor(product), nodes(products), orderBar, refresh() }` where `deps` also carries `getLines()`, `changeLines(fn)`, `priceFor(productId, variant)`, `totals()`, `variantsOf(product)`, `currentProduct(id)`, `isFavorite(id)`, `onFavorite(id)`, `onEdit(product)|null`, `onMoreOptions(product)`, `onReview()`, `expanded` (a `Set` kept by `app.js` across renders).
  - `orderBarLabel(totals, units) -> { units: string, total: string }` exported for tests: total is `"Check items"` when `totals.missing.length`, else the cash string.
  - `assertOrderable(product, variant, variantsOf) -> void` exported for tests: throws `"This product's options changed. Reopen it and review the available flavors."` when the product is missing, inactive, deleted, or lacks the variant.

- [ ] **Step 1: Write failing tests** for `orderBarLabel` (missing price → "Check items"; 1 unit → "1 item in this order"; 9 → "9 items in this order") and `assertOrderable` (inactive, deleted, removed flavor, valid).
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement the module.** Card: `article.phone-product[data-product-id]` with photo, name, meta (`N flavors`/`N options`/`Single product`, price), count pill, chevron or inline stepper. Panel: `section.phone-flavors` with one row per variant, then Favorite, Edit product, More options. Each change calls `changeLines`, then updates that product's pill, the row quantity and the order bar without a page render.
- [ ] **Step 4: Wire `renderCatalog`.** On phone: header with search, scan inside the field, List/Photos switch, chip row (All, Favorites, categories, tools), results from `nodes(products)`, order bar. `changeLines` checks scope, store, `hasUnsavedDraftNotes()` and calls `editDraft(..., { renderPage: false })` then `updateDraftProtection`. Desktop path untouched.
- [ ] **Step 5: Run** `npm test && npm run build`. Expected: pass.
- [ ] **Step 6: Commit** `feat(phone): order directly in the catalog`.

### Task 5: Order screen

**Files:**
- Modify: `public/app.js` (`renderBuilder`), `public/phone-redesign.css`

**Interfaces:**
- Consumes: `isPhone`.
- Produces: on phone, `img.builder-product-photo` in each group head; `button.builder-step` before and after each quantity field; review button text `Submit order` with `[data-builder-total]` beside it.

- [ ] **Step 1: Implement.** `−`/`+` set the field's value within 1 to 1,000,000 and dispatch `input`, reusing the existing handler.
- [ ] **Step 2: Run** `npm test`. Expected: pass.
- [ ] **Step 3: Commit** `feat(phone): steppers and photos on the order screen`.

### Task 6: Home

**Files:**
- Modify: `public/app.js` (`renderHome`), `public/phone-redesign.css`

**Interfaces:**
- Consumes: `isPhone`, `draftUnits`, `draftTotals`, `newDraftFromOrder`, `orderList`.
- Produces: `renderPhoneHome(store, orders, drafts, open, pendingPayments, low)` returning `div.phone-home`.

- [ ] **Step 1: Implement** the sections in the spec. Reorder uses the newest non-draft order for the store and `newDraftFromOrder`. Non-zero metrics appear as rows under Account.
- [ ] **Step 2: Run** `npm test`. Expected: pass.
- [ ] **Step 3: Commit** `feat(phone): action-first home`.

### Task 7: Browser verification and notes

**Files:**
- Create: `docs/phone-order-sheet-verification.md`

- [ ] **Step 1:** With `scripts/demo.cjs` and the auth emulator, in Chromium at 390px: from an empty draft press `+` on a flavor; assert the URL still ends `#/catalog`, the pill reads "1 in order" and the bar shows a total. Type a quantity, press `−` to zero, switch to Photos, repeat. Open Order, use `−`/`+`, open Submit. Open Home, press Reorder.
- [ ] **Step 2:** Resize 390 → 1200 → 390 with a draft open; assert no page error and the same draft total.
- [ ] **Step 3:** At 320, 390 and 800px, light and dark, for Home, Catalog (both views), Order, History, More: assert `document.documentElement.scrollWidth <= innerWidth`.
- [ ] **Step 4:** At 801px and 1440px, screenshot Home, Catalog, Build, Orders, More on this branch and on `main`; assert the images are byte-identical.
- [ ] **Step 5:** Record results, limits and anything unverified in the verification file. Commit `docs: record phone redesign verification`.
