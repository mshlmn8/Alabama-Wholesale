# Complete Alabama Wholesale upgrade

The user approved all fixes and additions in the September 14 audit. Implement that scope in the isolated `codex/complete-app-upgrade` worktree, retaining Firebase and the indigo/orange wholesale identity. The original production data and historical balances must be preserved with a migration report. No default password may authorize migration or owner enrollment.

## Architecture

Use an explicit Express server with Firebase Admin for authenticated API operations, and a modular, accessible browser app in `public/`. Firebase Auth identifies people; an active server-owned profile grants role and store permissions. Direct browser Firestore access is denied after cutover. Bootstrap the owner only from a verified Google identity matching the configured owner email. Invite enrollment links existing staff/customer profiles to real identities. Never return legacy password hashes.

Store individual records in `apps/alabama-wholesale/v2*` subcollections. The repository abstraction exposes `get(collection,id)`, `list(collection)`, and `transaction(callback)`; transaction callbacks receive `get`, `list`, `set`, `delete`. Transaction implementations ensure reads occur before writes. Every mutation uses a stable command ID and a durable receipt, authorization, validation, version checks, and audit events. Financial amounts use integer cents.

Domain exports: `executeCommand(tx, actor, command, {now, id})`, `authorizeStore(actor,storeId)`, `calculateOrder(lines,products,store)`. Actor has uid, role (`master`, `salesman`, `customer`), storeIds. `now` is epoch milliseconds and `id()` generates unique IDs. Transaction receipt handling can be implemented in the domain. Records have id and version; updates expect the current version.

## API and browser contract

- `GET /api/config`: `{firebaseConfig,recaptchaSiteKey}`. Only public Firebase configuration.
- `POST /api/session/bootstrap`: Firebase token required; activates verified configured owner or returns enrollment requirement.
- `GET /api/state`: `{me,categories,products,stores,orders,inventory,ledger,payments,returns,notifications,users,migration}` filtered by actor. Orders newest first; history endpoint paginates.
- `GET /api/orders?storeId=&status=&cursor=`: `{orders,nextCursor}` with store authorization.
- `POST /api/commands`: `{id,type,payload}`. Response `{result}`; UI refreshes state. Every request sends Firebase ID token in Authorization, and App Check token in `X-Firebase-AppCheck` when configured. Errors `{error:{code,message}}`.
- `POST /api/invites`: master creates email/role/storeIds/legacyProfileId invitation; returns enrollment link. `POST /api/invites/accept` consumes invitation with matching verified Firebase email. No automatic email send before sender configuration.
- `POST /api/admin/migrate`: configured owner only; snapshots legacy source into private archive and idempotently migrates; records exceptions.
- `GET /api/documents/:orderId/:kind` for `invoice`, `pick-list`, `delivery-note` returns PDF after store access checks.
- `POST /api/assistant/propose`: authenticated input `{text?,image?:{mimeType,data}}`; returns a proposed cart and ambiguities. No writes. User reviews quantities/products before saving a draft.

## Data contracts

Product: `{id,name,categoryIds,variants,priceCents,variantPricesCents,packSize,barcode,variantBarcodes,taxable,stockStatus,image,version}`. Null price/stock means unknown. Store: `{id,name,address,county,contact,phone,email,taxRateBps,creditLimitCents,terms,salesmanId,priceOverrides,version}`. Inventory record uses encoded product/variant key with `{id,productId,variant,onHand,reserved,reorderPoint,version}`.

Order draft: `{id,storeId,lines:[{id,productId,variant,quantity,unit,note}],notes,status,version,createdAt,updatedAt,createdBy}`; unit is `each` or `case`, quantity positive integer. Submitted orders snapshot name, SKU, unit/pack size, quantity, unitPriceCents, lineTotalCents, subtotalCents, taxCents, totalCents, invoiceNumber. Legacy orders retain original saved totals/date/text and flagged missing snapshots.

Commands: `product.save`, `category.save`, `store.save`, `order.save`, `order.submit`, `order.transition`, `payment.report`, `payment.verify`, `inventory.adjust`, `return.create`, `return.approve`, `notification.read`, `preferences.save`. Command payload uses record fields and expectedVersion for updates. Transition payload `{id,status,expectedVersion}`. Payment payload `{storeId,amountCents,method,reference,note}`; verify `{paymentId}`. Inventory adjustment `{productId,variant,onHand,reorderPoint,reason,expectedVersion}`. Return create `{orderId,lines:[{lineId,quantity}],reason}`; approve `{returnId,restock}`.

Statuses: draft → submitted → approved → picking → delivered, with controlled cancellation. Submitting reserves known inventory atomically, freezes prices, assigns invoice number, posts charge once, and creates audit/notification records. Cancellation releases reservation and reverses a posted charge once. Delivery consumes reservations. Unknown stock is flagged rather than fabricated. Payments reported by customers stay pending until verified by staff. Returns credit no more than delivered quantities not previously returned; restock is explicit. Inventory adjustments require staff and a reason.

## Migration and safety

Preserve legacy source in protected archive, legacy profile IDs, historical order dates/totals, deleted flags, templates, notes, addresses, catalog variants/images, and existing drafts. Unknown prices/stock remain unknown. Preserve the legacy recognized opening balance, and flag negative V7 payments for staff reconciliation rather than silently rewriting financial history. Duplicate-looking entries remain untouched. Import reruns must not create duplicate records or overwrite post-migration edits. Freeze old writes at cutover and verify migration counts/checksums before enabling normal operations.

## UI requirements

Maintain fast mobile ordering, searchable products/flavors, per-store favorites, draft autosave with explicit local/pending/synced/failed status, undo/redo, resume versus new order, saved-order reload, editable catalog/categories/stores, staff/customer permissions, theme preference, and safe backup export/import. Add workflow/status history, invoice/PDF/pick-list/delivery notes, pending payment approval, inventory quantities/thresholds/barcode entry (keyboard plus camera where supported), returns, customer pricing/terms, notifications, and Gemini text/photo proposals requiring review. Fix labels, keyboard controls, modal focus and zoom. Use separate image assets and honest placeholders.

## Verification

Regression tests first for each audit failure. Domain/API tests cover role and store isolation, prices/quantities, duplicate submission, concurrent inventory, optimistic conflicts, payment signs, return limits, failed saves, invitation security, and idempotent migration. Run Firebase emulator/rules tests, responsive browser walkthrough with synthetic data, PDF validation, offline recovery, dependency audit, and production health/auth smoke checks. Deployment and data cutover follow passing checks; document real external blockers precisely without presenting stubbed integrations as complete.
