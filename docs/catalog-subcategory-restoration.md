# Legacy catalog subcategory restoration

The v9 catalog displayed subcategories from saved labels or its built-in fallback lists, and grouped products using an explicit subcategory or ordered name rules. The original import preserved those strings but did not create the `parentId` records used by the current catalog navigation.

The shared legacy classifier preserves those original lists and rules, including custom saved groups. New imports create child category records and add their IDs to product memberships. The original parent memberships and product version, prices, variants, stock, and migration provenance are retained. Invalid or mismatched classifications stay under their original parents for review.

Catalog rows use the saved `sortOrder` or legacy `order`, so restored subcategories appear in their original sequence. Parent selection includes every descendant; a child selection filters to its own products.

## Existing catalog repair

`lib/restore-catalog-subcategories.cjs` provides a trusted operator utility, with no public HTTP route and no automatic writes during startup or catalog reads.

1. Extract only category and product classification fields from the original private migration plan. Retain each record's ID and `migration.sourceHash`; exclude accounts, customer records, credentials, and historical orders.
2. Read and privately back up the current categories and products. Pass them with the sanitized source to `buildSubcategoryRestoration` and review its creates, updates, conflicts, and fingerprint.
3. Call `restoreCatalogSubcategories` through the authorized administrator repository with the reviewed fingerprint. It recalculates the plan inside the transaction and rejects a changed catalog.
4. Verify all child records, all planned memberships, unchanged original category records, and every unrelated product field. Check the completion marker and audit record.

The transaction adds or reuses unique active children under the same parent. It preserves changed category definitions, reclassified products, inactive records, and ambiguous matches for review. Products keep their original parent memberships. A durable completion marker prevents retries from restoring children that an administrator later moves or removes.

The archived catalog preview yields 49 child categories and 619 eligible product memberships across eight original categories; nine mismatched explicit assignments remain at the parent level. The actual live plan must be generated again before application because later edits take precedence.

## Verification

- 799 Node 22 tests pass, including 30 restoration tests and nine legacy classification tests.
- Eight Firestore emulator checks pass. The new check restores 619 products under concurrent retries, with one completion audit and unchanged saved orders.
- Build and diff checks pass.
- The shared classifier matches all eight archived category lists and all 628 archived product classifications.
- Synthetic browser checks confirm nested drink tabs, Waters-only filtering, custom Apparels filtering, and scrollable rows at 390px without page overflow.

Live application requires authenticated Firebase access and is separate from deploying the code. Never claim the data restoration is complete based on the archived preview alone.
