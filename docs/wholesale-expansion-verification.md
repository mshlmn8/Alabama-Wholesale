# Wholesale expansion verification

Implementation date: September 28, 2026. Worktree: `alabama-wholesale-features`. Branch: `codex/store-inventory-ordering`, based on `d2c5604`. The original ordering checkout and production Firebase data were not modified.

## Delivered scope

| Request | Implementation and evidence |
| --- | --- |
| Separate store inventory tab | Store-scoped counts, corrections, movements, targets, search and local count drafts; API ownership and pagination tests; phone/desktop walkthrough. |
| Missing items and weekly learning | Latest eligible reference strictly older than 96 hours; review choices and evidence; purchase-cycle and count-based depletion thresholds; deterministic and Gemini schema/fallback tests. Seeded browser evidence: 4 purchased/week, 6 estimated depleted/week and an 11-each planning suggestion. |
| Mix / Each and exceptions | Builder preview, excluded flavors, distinct selection identity, common-price checks, stock reservation and actual-pick confirmation. Browser walkthrough and domain rollback/return tests. |
| Additions | Empty linked draft, original immutable placement, distinct invoice/charge and NEW ITEMS ONLY documents. Browser Mail handoff/placement/addition walkthrough. |
| Credits and returns | Builder attachment, original-invoice credit caps, adjustments/unverified reconciliation, separate physical pickup/inspection and once-only restocking. Browser $1.08 adjustment approval and 1-item/$2.70 return approval→pickup→resalable receipt completed. |
| Picker format | Large quantities, checkboxes, picked/short columns, Mix exceptions/actual picks, addition reference and separate remaining pickups. Visual PDF review and long 1,201-line document regression. |
| Wholesale app | `/warehouse/` PWA with stock, suppliers, supplier product mappings, POs, amendments, closures and partial receiving against shared stock. Owner/staff/customer API tests and browser supplier→PO→receipt walkthrough. |

## Behavioral and security checks

Domain/API tests cover cross-store access, role changes on command replay, immutable physical case conversions, reservation and credit-cap conflicts, transaction rollback, duplicate receipts, rejection/replacement handling and unknown stock baselines. The Firestore suite exercises actual emulator transactions and denies direct client access even with forged administrator claims.

Warehouse supplier costs, terms and financial PO documents are owner-only. Staff command responses, including replays, use explicit safe projections. Customer requests are denied before warehouse business collections are read. API responses use private/no-store caching; the two service workers use separate cache namespaces and do not cache authenticated API records.

Review caught and corrected: physical-count movement identity collisions across staff; changed case conversions after Mail confirmation; mismatching actual flavors after a receipt; stale permissions on cached commands; pick lists replacing actual picks with provisional allocations; partially collected return case totals; configured warehouse bin propagation into pick lists; history pagination omissions; and missing browser form controls caused by arrays passed to native DOM methods.

## Verification results

**758 Node 22 tests passed** (baseline: 581). `npm run build` and `git diff --check` passed. A changed-file secret/risky-file scan found no credential matches or files over 50 MB. Production dependency audit reports zero vulnerabilities, with no new dependency or lockfile changes.

Firestore emulator: **7 tests passed**, including concurrent order submission, over-allocation protection and duplicate/concurrent purchase receiving. Expected PERMISSION_DENIED logs are part of the client-access denial tests. One intervening run exhausted a transaction lock timeout in the unchanged ten-way order-number concurrency test; a fresh run with no code change passed all seven tests. The failed run and successful rerun were retained during verification; no assertion or concurrency was removed.

The wholesale browser flow created a supplier and mapping, placed a ten-case PO, and received four accepted cases plus two rejected cases awaiting replacement. Shared stock moved from 12 to 60 each; six cases remained outstanding. All five warehouse views fit a 390px viewport, the receiving dialog had no horizontal overflow, customer login returned 403 with no private records shown, and an offline save sent zero commands. PO PDF download succeeded. The live warehouse cache contained no API responses.

Browser checks use synthetic local data on `http://localhost:8780/` and Chromium at desktop and phone sizes. They do not send email or contact suppliers. The Mail flow opens the existing prefilled draft and records a placement only on an explicit confirmation. No live Gemini request was made; configured transport/schema validation is covered by tests and the preview presents its unavailable state honestly.

## Preview and usage

See [the usage guide](wholesale-expansion-guide.md) for all seven workflows and reproducible local preview instructions. The preview seeds five weekly orders plus counts and resets business data when its process restarts. Demo credentials are synthetic and limited to the local Auth emulator.

## Release boundary

This is a reviewed local feature-branch implementation. No production deployment, database migration, external order email or supplier purchase was performed. A production release must deploy the checked-in Firestore indexes and updated server/public assets together. Existing records are retained; new observations, placements, return events, suppliers, purchase orders and receipts are included in the owner backup/restore allowlist.

No retail POS integration exists: weekly depletion is an estimate, not a claim of actual retail sales. Historical or Mail-only unverified sales still require reconciliation before a financial credit can be issued. Very large/incomplete histories are labeled and cannot produce falsely complete stock recommendations.

## Review artifacts

- [Store inventory with weekly evidence](verification/wholesale-expansion/store-inventory.png)
- [Wholesale overview](verification/wholesale-expansion/warehouse-overview.png)
- [Mobile partial purchase receipt](verification/wholesale-expansion/mobile-purchase.png)
- [Sample picker PDF](verification/wholesale-expansion/sample-pick-list.pdf)

All artifact data is synthetic. The sample PDF includes an excluded flavor, confirmed Mix quantities, an addition reference and a partially collected return.
