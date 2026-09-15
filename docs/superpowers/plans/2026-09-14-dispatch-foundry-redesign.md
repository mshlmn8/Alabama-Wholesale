# Dispatch + Foundry redesign implementation plan

**Approved direction:** The user selected Dispatch's compact ordering layout with Foundry's orange, ivory and ink colors, using the original Alabama Wholesale logo.

**Architecture:** Restyle the existing browser app and add a persisted catalog presentation choice. Keep order, authentication, storage, mail and financial behavior on the existing backend. The original landscape logo remains unchanged; use its full aspect ratio across app surfaces.

**Stack:** Existing browser JavaScript and CSS, locally hosted Manrope variable font, Node 22 tests, isolated Chromium and WebKit fixtures.

## Implementation

- [x] Use an isolated branch from the current released main commit.
- [x] Update `public/app.js` brand and mobile header: actual landscape logo, visible save status, compact store and action row; remove repeated page brand text.
- [x] Make ivory the default theme while preserving explicitly chosen dark/system preferences. Toggle according to the rendered theme.
- [x] Update `public/index.html`, manifest and icon to show the original logo during loading and installation; preload the local 24 KB font.
- [x] Add List/Grid controls to `renderCatalog`, default to List, retain 1–5 grid columns and compact preferences in `public/view-helpers.js`.
- [x] Keep exact-name search ranking and bounded product rendering; show a current-order review dock using the actual working draft.
- [x] Replace old visual tokens and inconsistent component sizing in `public/styles.css`; align catalog rows, builder fields, tables, dialogs and navigation in both themes.
- [x] Verify catalog preference migration with meaningful helper tests and existing order/storage tests using `npx --yes --package=node@22 node --test --test-reporter=spec tests/*.test.cjs`.
- [x] Inspect authenticated synthetic app screenshots and interactions at 320, 390, 768 and 1440 pixels in Chromium and WebKit. Verify input sizes, draft editing/autosave, all grids, logo proportions, dialogs and overflow.
- [x] Run `npm run build` and `git diff --check`, then review the final diff.

**Release gate:** Publish through the repository's PR/checks/merge workflow, then verify App Hosting rollout and live asset hashes before reporting the working URL. Local and browser verification details are recorded in `docs/dispatch-foundry-verification.md`.

## Acceptance criteria

The app visibly follows the selected compact Dispatch design with orange/ivory coloring and the real logo. Product names, prices and actions align. Mobile input fonts remain at least 16px and pinch zoom remains available. The existing order integrity and autosave flows remain intact. Grid density is a deliberate user choice. Runtime assets and the new font work with the versioned offline shell. No email is sent or business record altered during testing.
