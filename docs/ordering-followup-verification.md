# Ordering follow-up, September 21, 2026

The user approved the compact Build/Orders layout and zero-dollar submission for
unpriced items on September 22. The combined implementation is verified below;
production rollout is checked separately against the merged commit.

## Implemented

- Category management opens a dedicated subcategory form with its parent already
  selected. Enter submits once; Cancel writes nothing. A confirmed save remains
  visible even when the following workspace refresh fails.
- Removed fixed order-line counts from selection, draft save, backup restore,
  submission, returns, PDFs, device copies and AI proposals. Actual database and
  request byte capacities remain; see [order-capacity.md](order-capacity.md).
- The catalog displays all matching products. Repeating a search event with an
  unchanged value no longer redraws the results and cancels the first Add click.
- New orders use quantity without an order-unit selector. Existing case-based
  lines retain their original quantity and price interpretation, with a short
  label to prevent accidentally treating cases as individual items.
- Updated the service-worker cache version for the changed client files.
- Build uses a compact continuous sheet, inline quantities and row options for
  flavor changes, notes and removal. Order notes and secondary draft tools are
  collapsed. A sticky total/Review bar remains accessible above mobile navigation.
- Orders uses compact store/invoice rows with search over loaded orders, retained
  paging, store/status filters and existing detail actions.
- Effective null/absent prices become $0 after store/variant overrides. Invalid
  values and unrelated legacy review gates remain blocked. Invoice snapshots
  freeze the submitted amount; subsequent catalog prices cannot alter it.
- Notes save while typing. After persistence failure, new-draft/layout actions
  protect the visible text and recovery/copy/export retain the unsaved note.

## Verification

- Node 22: all 525 tests passed, no failures or skips.
- Build verification and `git diff --check` passed.
- Firestore demo emulator: five tests passed, including one atomic submission
  with 601 distinct tracked products and rollback of an oversized frozen invoice.
- Chromium and WebKit: all 628 synthetic catalog products and broad search
  matches remain available; the last result opens on the first click, including
  after clearing filters and in the five-column grid. Clearing filters and
  entering the same query again correctly reapplies the search.
- Chromium and WebKit: subcategory creation/cancellation, Enter submission and
  confirmed-save refresh recovery passed at phone and desktop widths.
- Chromium and WebKit: quantity-only additions and legacy case edits passed;
  three builder sizes at widths 320, 390 and 1440 had no page or row overflow.
- Final compact layout: Chromium and WebKit passed all three sizes at 320, 390
  and 1440px, plus 800/801/900/901px breakpoint checks. Row heights were 51, 59 and
  69px. Buttons retain 44px targets; the review action is visible and hittable at
  the top, middle and bottom of long orders. Screenshots were inspected.
- Both browsers passed quantity autosave/rollback, flavor editing/creation,
  removal, notes, persisted settings, mixed and entirely zero-dollar submission,
  frozen prices after a catalog change, order search/pagination/filters, and
  cancelled or retried detail loading. No runtime errors occurred.
- Backend/API/PDF regressions cover zero-price totals and tax, override precedence,
  inventory reservation/returns, idempotent retries, authorization and immutable
  invoice snapshots. Six builder-recovery tests protect failed note saves.

Browser checks used synthetic local records. No production order, invoice,
inventory or financial records were changed during this work.
