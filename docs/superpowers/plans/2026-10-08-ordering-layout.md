# Ordering Layout Implementation Plan

> **For agentic workers:** Use `executing-plans` to implement this plan inline, task by task. The user approved the design and implementation on 2026-10-08.

**Goal:** Apply the approved layout refinement without replacing ordering, saving, pricing, permissions, or email workflows.

**Architecture:** Keep the existing safe DOM renderer and domain functions. Add a presentation-only chrome observer and a dedicated stylesheet; move existing controls into accessible dialogs and grouped lists. Use the current store picker, session guards, category hierarchy, and account preferences.

**Tech Stack:** Browser JavaScript modules, CSS, native dialogs, Node 22.23.3, existing Node tests, CUA browser checks using synthetic records.

## Task 1: Establish baseline and approve boundaries

**Files:** `docs/superpowers/specs/2026-10-08-ordering-layout-design.md`, this plan.

- [x] Create branch `codex/ordering-layout` from `d2c5604` in `alabama-wholesale-layout`.
- [x] Copy the approved design into the repository; retain all listed features.
- [x] Run the existing tests with localhost binding permitted: `npm test` under Node 22.23.3. Baseline: 581 pass. The initial sandboxed attempt had 51 `listen EPERM` failures; that attempt is not a product regression.
- [x] Run `npm run build`. Baseline: pass, 1,973-byte HTML shell.
- [x] Inspect the real app at 390×844: header 110px, store picker 190px, six mobile navigation items, sticky review bar overlays order rows.

## Task 2: Reserve space from actual chrome dimensions

**Create:** `public/workspace-chrome.js`, `tests/workspace-chrome.test.cjs`.
**Modify:** `public/app.js` shell lifecycle.

- [x] Write tests for initially hidden chrome, wrapped review text, resizing, fallback without ResizeObserver, and late callbacks after disposal. Run the new test before creating the module; expect the missing-module failure.
- [x] Implement `observeWorkspaceChrome(root, { header, navigation, dock }, environment = window)` returning a cleanup callback. Each measurement writes actual heights to `--workspace-header-height`, `--mobile-nav-height`, and `--order-dock-height` on the app root.

```js
const measure = () => {
  if (!active) return;
  for (const [name, node] of elements) {
    const height = node ? Math.ceil(node.getBoundingClientRect().height) : 0;
    root.style.setProperty(name, `${height}px`);
  }
};
```

- [x] Disconnect the previous observer before each shell replacement and when authentication replaces the workspace. Observe the actual header, mobile navigation, and current builder/catalog review dock after attachment.
- [x] Run `node --test tests/workspace-chrome.test.cjs` and verify zero failures.

## Task 3: Refine shell, catalog controls, and workspace lists

**Modify:** `public/app.js` (`navLink`, `render`, `renderCatalog`, `renderHome`, `renderMore`).

- [x] Retain all six desktop destinations. Render five mobile destinations; group Overview and operational subpages under More.

```js
nav.filter(([key]) => key !== "home").map(([key, label, symbol]) =>
  navLink(key, key === "more" ? "More" : key === "build" ? "Build" : label, symbol)
);
```

- [x] Use a compact mobile brand mark, store context with existing save-status IDs, direct notifications, and a Workspace tools dialog containing refresh, Gemini, appearance, saving details, and current-order access. Guard delayed actions with the captured session scope.
- [x] Put scanning beside search. Move existing column and compact controls into a native display dialog; preserve their callbacks and saved values. Group catalog creation/AI actions in a Catalog tools dialog, preserving owner checks.
- [x] Add presentation classes to Overview, account metrics, and Stores. Preserve every metric, recent order, account action, and store action.
- [x] Render tool groups with descriptive button labels using safe DOM text. Ordering: Overview, Gemini, templates, builder settings. Account & operations: payments, returns, notifications, inventory for staff. Saving & device: notification preferences, sync, backup. Administration: all existing owner tools, photos, team access.
- [x] Verify all tools remain present under their existing role conditions and that detached dialogs cannot act on a later session.

## Task 4: Order sheet and responsive styling

**Modify:** `public/app.js` (`renderBuilder`, optional toolbar in `collapsibleOrderItems`).
**Create:** `public/workspace-layout.css`.

- [x] Put saving status, Undo/Redo, item count, and collapse in one wrapping order-sheet toolbar. Keep `draftStatus`, history selectors, note input, line IDs, quantity handlers, and summary references unchanged.
- [x] Wrap the order body and review summary in `builder-layout`. Add read-only subtotal/tax estimates that update with the existing total. Keep Review & submit and all recovery/options actions unchanged.

```css
.builder-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 250px;
  gap: 24px;
  align-items: start;
}
@media (max-width: 1100px) {
  .builder-layout { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 800px) {
  main.content {
    padding-bottom: calc(var(--mobile-nav-height, 0px) + var(--order-dock-height, 0px) + 24px);
  }
  .builder-review-bar, .catalog-order-dock {
    position: fixed;
    bottom: var(--mobile-nav-height, 0px);
  }
}
```

- [x] Style the sheet with aligned quantities/amounts, complete wrapping names, consistent image frames, comfortable targets, restrained orange accents, and both existing themes. Preserve small/medium/large row-spacing preferences.
- [x] Make the review summary sticky beside the sheet on desktop and a fixed strip above mobile navigation. Use measured padding and scroll margins; safe-area padding belongs to navigation and is included in its measured height.
- [x] Keep display preferences while adapting dense grid columns to the available width. Show complete product names, prices, packing details, and Add actions at phone widths.
- [x] Keep dialogs above chrome, constrain them to the viewport, and preserve focus, keyboard access, and reduced-motion behavior.

## Task 5: Bundle, verify, and hand back

**Modify:** `public/index.html`, `public/sw.js`, `scripts/build.cjs`, `tests/service-worker.test.cjs`.
**Create:** `docs/ordering-layout-verification.md` after verification.

- [x] Link the new stylesheet after existing layout sheets; add both new assets to the offline shell and build validation. Bump the worker version; make the existing cache-retention test derive the current version rather than hardcoding it.
- [x] Run `npm test` and `npm run build` under Node 22.23.3 with localhost binding permitted. Inspect every failure and fix before completion.
- [x] Reload the real-source fixture preview after edits. Check 320, 390, 768, and desktop widths in light/dark themes: build, catalog, Overview, Orders, Stores, Workspace.
- [x] Exercise quantity edits, Undo/Redo, notes, group collapse, nested categories, list/grid/display preferences, store switching, dialogs, and role-specific tools. Use separate synthetic large-order, empty-order, and customer fixtures where needed.
- [x] Verify final rows and notes can scroll above the dock; measure bounds after wrapping/resize. Inspect the full formatted email draft using a fixture-only intercepted mail launch, with no email sent.
- [x] Save representative screenshots and verification evidence. Review the diff for safe DOM output, session guards, asset caching, and unintended backend or dependency changes.
- [x] Hand back the actual local implementation and its preview. Distinguish fixture checks from live cloud sync, physical-device acceptance, and deployment.

Verification record: `docs/ordering-layout-verification.md` records the completed checks, browser interruption and recovery, fixture limits, and saved actual-source previews. The work is implemented locally; production acceptance is outside this change.

Self-review: all approved design sections map to Tasks 2–5. Domain/backend files and dependency versions are outside this layout change. Unrelated existing documentation is left in the primary checkout.
