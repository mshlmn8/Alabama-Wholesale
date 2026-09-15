# Multi-flavor ordering and store search verification

September 15, 2026.

The product chooser accepts independent flavor quantities, preserves selections while filtering, and adds the entire batch through one existing draft edit. Each line retains its flavor, quantity, unit and optional shared note. Multi-flavor products start unselected; scanned flavors and standard products start at one. The UI rejects invalid or excessive quantities and batches beyond the server's 150-line limit before changing the draft.

The header store picker filters only the user's available stores. Selection is explicit; typing, no results, Escape and Tab preserve the current store. Account changes and app renders dispose listeners. An open picker postpones passive refresh. A failed notes save blocks store switching before any state is changed, preserving the visible text for retry or export.

Validation:

- 391 Node 22 tests passed, including new batch validation cases. Build, production dependency audit and whitespace checks passed.
- 182 integrated Chromium/WebKit assertions passed: Apple ×2 and Cranberry ×2 in one action, independent line IDs, Undo/Redo, shared notes, cases, barcode defaults, standard products, filtering retention, automatic server saves, two-store isolation and restoration after reload.
- Responsive checks used 320px, 390px and 1440px widths, long names and 114 stores, plus a short viewport representing keyboard space. No horizontal overflow or runtime errors. Quantity inputs remain 16px, controls have 44px targets, and the action footer stays visible.
- A 149-line draft plus two selected flavors was rejected without changing the draft, undo history or selection. Reducing the batch to one line reached 150 and saved online.
- 10 additional Chromium/WebKit checks reproduced a rejected notes save and verified that switching stores preserves the visible unsaved text and original draft/store.
- Isolated picker checks covered selected-option scrolling, accent/case matching, explicit commit, no results, keyboard focus and disposed controls. Chromium's implicit scroll-container Tab stop was removed and retested in the integrated app.

Browser tests used isolated synthetic accounts, products and orders. No production orders or emails were created. Local evidence is in the ignored `.firebase/upgrade/multi-flavor-store-search/` directory. The service-worker shell includes the new modules/styles and advances to `aw-v2-20260915-10`.
