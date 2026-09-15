# Add products and variants from a photo

Owners can open **Add from photo** in Catalog or **Add product from photo** in Gemini chat. They take/upload one product photo and optionally add context. Gemini proposes the visible product name, flavor/variant, barcode and explicit units per case, and suggests a matching existing product when supported by catalog evidence. Unreadable details stay blank. Prices, inventory and financial fields are never inferred from packaging.

The photo dialog shows the image and editable proposed details. The owner chooses a new product or a variant of an existing product, then continues to the normal product editor. Nothing enters the catalog until **Save product**. New products can use the original photo; existing product photos remain selected unless the owner explicitly chooses the new picture. Variant additions preserve the parent's name, prices, categories, pack size, barcodes, photo and optimistic version. Case-insensitive duplicate variants and already-used barcodes are stopped before editing. Previously standard-only products must keep existing standard order lines valid when their first named variant is added.

Implementation responsibilities:

1. Add a master-only `/api/assistant/catalog-photo` proposal endpoint and bounded image/response validation. Use existing Firebase Auth, App Check and per-user AI quotas; send only minimal catalog context. Validate model IDs and evidence, and never execute model instructions or write catalog records during analysis.
2. Add an isolated, accessible photo dialog with file preview, optional prompt, cancellation, retry, stale-response protection, searchable existing products and editable review. Preserve the source File only for the active review and revoke preview URLs when finished.
3. Add a pure product-prefill helper with preservation/duplicate tests. Integrate with Catalog and Gemini, then the existing product editor and versioned product.save command. Keep a stable product ID across save retries and recheck identity/permissions after image upload.
4. Verify new-product and variant flows with synthetic records in Chromium/WebKit, including no writes on analyze/cancel, photo upload only on Save, preservation, duplicates, stale identity, model/upload failure and mobile layout. Run unit/API tests, build, production audit and CI; verify the deployed assets and access enforcement.

Primary reference: [Firebase structured multimodal output](https://firebase.google.com/docs/ai-logic/generate-structured-output).
