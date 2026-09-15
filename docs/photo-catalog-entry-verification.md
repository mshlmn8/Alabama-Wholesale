# Photo catalog entry verification

Verified on 2026-09-15. Catalog administrators can start from **Catalog → Add from photo** or **Gemini → Add product from photo**. A JPEG, PNG or WebP photo produces an editable proposal for a new product or an existing product's new flavor. The normal product editor remains the final review and save step.

## Automated checks

- Node 22 unit/API suite: 417 tests passed. Coverage includes photo input bounds, authenticated administrator access, AI quotas, response validation, catalog matching, preservation of existing product metadata, duplicate variants/barcodes and Standard-option compatibility.
- Build passed; production dependency audit reported zero vulnerabilities; `git diff --check` passed.
- Chromium and WebKit: 102 isolated photo-dialog assertions and 28 integrated app assertions passed. These cover file validation, editable proposals, searchable parent selection, cancellation, retries, stale account/permission responses, safe warning rendering, preview cleanup, dark mode and layouts at 320, 390 and 1440 pixels, including a reduced keyboard viewport.
- Chromium and WebKit: 18 editor scenarios passed. Existing prices, barcodes, categories, availability, tax settings and pictures are preserved when adding a flavor. Analysis and cancellation do not save catalog records or upload images. Explicit Save uploads the selected picture, while upload errors, canceled saves and account changes prevent unintended product commands. Version conflicts remain enforced.
- The production state serializer preserves the server-managed `standardVariantEnabled` flag. Adding the first named flavor leaves the existing Standard option valid for drafts, orders, inventory and AI-assisted ordering.

Browser reports, screenshots and test runners are retained locally under the ignored `.firebase/upgrade/photo-catalog-entry/` directory. Browser scenarios use isolated synthetic data and mocked provider responses; they do not establish live Gemini recognition accuracy. No production products, orders or emails were created for these tests. Extracted labels still require the administrator's review, and prices are never inferred from a photo.

GitHub CI additionally checks Firestore rules using the emulator before merge. Release verification checks the App Hosting build's source commit and traffic allocation, deployed asset hashes and unauthenticated API rejection.
