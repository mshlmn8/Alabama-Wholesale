# Dispatch layout with Foundry colors

The approved design combines Dispatch's compact ordering interface with warm ivory, orange and ink. The existing Alabama Wholesale landscape logo is used at its original aspect ratio in the sidebar, mobile header, authentication and loading screens. A versioned installation icon embeds the unchanged logo, avoiding the previous immutable asset URL.

## Changes

- Catalog defaults to List; Grid retains 1–5 columns and compact sizing. Each choice is stored with the user's device preferences. Legacy column preferences are retained when moving to the new view selector.
- The catalog review bar uses the actual current draft and existing price calculation. It labels the amount as an estimate and displays “Prices needed” when any line lacks pricing.
- Page headings, navigation, product controls, forms, tables and dialogs use a consistent compact scale. The mobile header shows the logo and live protection status above store selection and actions.
- Light is the default. Explicit dark and system preferences are retained, and the theme toggle uses the actual rendered theme.
- Manrope is hosted locally as a 24 KB variable font with its license. The font and versioned icon join the existing public offline shell. Authenticated API responses remain outside that cache.

## Verification

- Node 22: 286 tests passed, including catalog preferences, search, storage recovery, draft synchronization, permissions, financial records and scheduled mail.
- Build syntax and app-shell checks passed. The HTML shell remains under 2 KB.
- Chromium and WebKit functional checks passed for the default theme, first toggle, catalog view/density persistence after reload, exact SS search, AI proposal review and automatic quantity/note saves.
- The main browser matrix passed 352 cases across 320, 390, 768 and 1440 pixel widths, both themes and both engines. It checks catalog list/grid modes, all 1–5 column settings, field sizing, header overlap, original logo proportions and each workspace page.
- Another 80 dialog cases passed, covering very long product names, invoice review, email scheduling/settings and the barcode scanner. A separate contrast audit found no text contrast warnings in either theme, and confirmed the local font loaded.
- Independent review checked reduced motion, hidden grid controls, access to product editing, dense tile actions and dialog printing. Follow-up layout fixes prevent summary overlap at intermediate widths, align overview action buttons and retain 16px input text on touch devices in either orientation.

Testing uses isolated synthetic records. No production order, inventory record or email was created by these checks. This release changes the presentation and catalog view preferences; Gmail sender setup remains separately pending verification.
