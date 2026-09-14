'use strict';

const { createHash } = require('node:crypto');
const VERSION = 'legacy-v1';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value : '';
const strings = value => Array.isArray(value) ? [...new Set(value.filter(v => typeof v === 'string' && v))] : [];

// Canonical JSON gives the archive and every derived record a reproducible fingerprint.
function canonical(value) {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value.toMillis === 'function') return { __timestampMillis: value.toMillis() };
  if (typeof value === 'number' && !Number.isFinite(value)) return { __nonFiniteNumber: String(value) };
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  if (typeof value === 'bigint') return { __bigint: String(value) };
  if (typeof value === 'function' || typeof value === 'symbol') throw new TypeError('Legacy snapshot must contain serializable data');
  return value;
}
function checksumSnapshot(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
const clone = value => canonical(value);
function dateMillis(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime())) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value))) return Date.parse(value);
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  if (value && typeof value.toMillis === 'function') return dateMillis(value.toMillis());
  return null;
}
function cents(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const result = Math.sign(value) * Math.round((Math.abs(value) + Number.EPSILON) * 100);
  return Number.isSafeInteger(result) ? result : null;
}
function safeId(value, fallback) {
  if (typeof value !== 'string' || !value) return fallback;
  if (value.length <= 400 && !value.includes('/') && value !== '.' && value !== '..' && !/^__.*__$/.test(value)) return value;
  return `legacy-id-${checksumSnapshot(value).slice(0, 32)}`;
}
function docEnvelope(value) {
  if (object(value) && object(value.data) && !own(value, 'value')) return { ...value.data, id: value.id || value.data.id };
  return value;
}
function docValue(value) {
  value = docEnvelope(value);
  return object(value) && own(value, 'value') ? value.value : value;
}
function sourceEntries(value) {
  if (Array.isArray(value)) return value.map((record, index) => ({ raw: docEnvelope(record), index, key: null }));
  if (object(value)) return Object.entries(value).map(([key, record], index) => ({ raw: object(record) ? { ...docEnvelope(record), id: record.id || key } : record, index, key }));
  return [];
}

/**
 * Build a create-only import plan. Root must persist the complete, unmodified snapshot
 * in a private archive before applying it. Neither this plan nor migrated profiles
 * carries legacy authentication credentials; sourcePath/checksum link back to that archive.
 *
 * snapshot: {state:{data,users,drafts:[{id,value,...}]}, history:[{id,value,...}]}
 * Top-level data/users/drafts and keyed document maps are also accepted.
 */
function buildMigration(snapshot, { now = Date.now() } = {}) {
  if (!object(snapshot)) throw new TypeError('A legacy snapshot object is required');
  if (!Number.isSafeInteger(now)) throw new TypeError('Migration time must be epoch milliseconds');
  const sourceChecksum = checksumSnapshot(snapshot);
  const migrationId = `${VERSION}-${sourceChecksum.slice(0, 24)}`;
  const state = object(snapshot.state) ? snapshot.state : {};
  const rawData = state.data ?? snapshot.data;
  const data = docValue(rawData);
  if (!object(data)) throw new TypeError('Legacy state/data must be an object; refusing an empty migration');
  const settings = object(data.settings) ? data.settings : {};
  const records = [];
  const exceptions = [];
  const usedKeys = new Set();
  const report = { schemaVersion: 1, migrationId, sourceChecksum, createdAt: now, requiresArchive: true, counts: { source: {}, output: {} }, balances: [], exceptions };
  const exception = (code, path, message, details = {}) => {
    const id = `issue-${checksumSnapshot({ code, path, details }).slice(0, 28)}`;
    if (!exceptions.some(e => e.id === id)) exceptions.push({ id, code, severity: code === 'opening_balance_unresolved' ? 'blocking' : 'review', sourcePath: path, message, ...details, status: 'open' });
  };
  const add = (collection, id, value, sourcePath, raw) => {
    const key = `${collection}/${id}`;
    if (usedKeys.has(key)) throw new Error(`Migration generated duplicate destination ${key}`);
    usedKeys.add(key);
    records.push({ collection, id, data: { ...value, id, version: value.version || 1, migration: { migrationId, sourceChecksum, sourcePath, sourceHash: checksumSnapshot(raw) } } });
  };
  const entries = (value, kind, path) => {
    if (value != null && !Array.isArray(value) && !object(value)) exception('invalid_source_collection', path, 'Collection is not an array or keyed object; original remains in the archive.');
    const rows = sourceEntries(value);
    const seen = new Set();
    return rows.map(row => {
      const raw = row.raw;
      const sourcePath = `${path}/${row.key ?? row.index}`;
      if (!object(raw)) {
        exception('invalid_source_record', sourcePath, 'Record is not an object; original remains in the archive.', { recordKind: kind });
        return null;
      }
      const value = docValue(raw);
      const originalId = text(raw.id) || text(value?.id) || row.key;
      let id = safeId(originalId, `legacy-${kind}-${checksumSnapshot(sourcePath).slice(0, 24)}`);
      if (!originalId) exception('missing_source_id', sourcePath, 'Assigned a deterministic ID to a record that had no ID.', { recordKind: kind, recordId: id });
      if (seen.has(id)) {
        exception('duplicate_source_id', sourcePath, 'Duplicate ID retained as a separate record; references continue to resolve to the first record.', { recordKind: kind, legacyId: originalId });
        id = `legacy-duplicate-${checksumSnapshot({ sourcePath, id }).slice(0, 28)}`;
      }
      seen.add(id);
      return { raw, value, sourcePath, id, originalId };
    }).filter(Boolean);
  };
  const categoryRows = entries(data.categories, 'category', 'state/data/categories');
  const productRows = entries(data.items ?? data.products, 'product', 'state/data/items');
  const storeRows = entries(data.stores, 'store', 'state/data/stores');
  const userSource = docValue(state.users ?? snapshot.users) ?? [];
  const userRows = entries(userSource, 'profile', 'state/users');
  const historySource = snapshot.history ?? [];
  const historyRows = entries(historySource, 'order', 'history');
  const draftSource = state.drafts ?? snapshot.drafts ?? [];
  const draftRows = entries(draftSource, 'draft', 'state/drafts');
  const mapRows = rows => {
    const result = new Map();
    for (const row of rows) if (row.originalId && !result.has(row.originalId)) result.set(row.originalId, row.id);
    return result;
  };
  const categoryIds = mapRows(categoryRows), productIds = mapRows(productRows), storeIds = mapRows(storeRows), profileIds = mapRows(userRows);
  const ref = (map, value) => typeof value === 'string' && value ? map.get(value) || safeId(value, null) : null;
  const price = (value, path) => {
    if (value == null || value === '') return null;
    const result = cents(value);
    if (result === null || result < 0) {
      exception('invalid_legacy_price', path, 'Price is invalid and remains unconfigured; original remains in the archive.');
      return null;
    }
    if (Math.abs(value * 100 - result) > 1e-7) exception('fractional_cent_rounded', path, 'Money was rounded to the nearest cent; original value remains in the archive.');
    return result;
  };
  const rateBps = (value, path) => {
    if (value == null || value === '') return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      exception('invalid_tax_rate', path, 'Tax rate remains unconfigured because the source is invalid.'); return null;
    }
    return Math.round(value * 100);
  };
  report.counts.source = {
    categories: sourceEntries(data.categories).length, products: sourceEntries(data.items ?? data.products).length,
    stores: sourceEntries(data.stores).length, users: sourceEntries(userSource).length,
    history: sourceEntries(historySource).length, drafts: sourceEntries(draftSource).length,
    ledgerEntries: storeRows.reduce((sum, row) => sum + (Array.isArray(row.value?.ledger) ? row.value.ledger.length : 0), 0)
  };
  for (const row of categoryRows) {
    const value = row.value;
    if (!object(value)) { exception('invalid_source_record', row.sourcePath, 'Category value is invalid.'); continue; }
    add('categories', row.id, { name: text(value.name), order: Number.isFinite(value.order) ? value.order : row.index ?? 0, subcategories: strings(value.subcategories), color: text(value.color), icon: text(value.icon), legacyId: row.originalId }, row.sourcePath, row.raw);
  }
  for (const row of productRows) {
    const value = row.value;
    if (!object(value)) { exception('invalid_source_record', row.sourcePath, 'Product value is invalid.'); continue; }
    const variants = strings(value.variants);
    if (Array.isArray(value.variants) && variants.length !== value.variants.length) exception('invalid_or_duplicate_variants', `${row.sourcePath}/variants`, 'Invalid or duplicate variants need review; originals remain in the archive.', { productId: row.id });
    const categories = strings(value.categoryIds?.length ? value.categoryIds : value.categoryId ? [value.categoryId] : []).map(id => ref(categoryIds, id));
    for (const id of categories) if (!categoryRows.some(c => c.id === id)) exception('missing_category_reference', row.sourcePath, 'Product references a missing category.', { productId: row.id, categoryId: id });
    const variantPricesCents = Object.fromEntries(Object.entries(object(value.variantPrices) ? value.variantPrices : {}).map(([variant, amount]) => [variant, price(amount, `${row.sourcePath}/variantPrices/${variant}`)]));
    const packSize = Number.isSafeInteger(value.packSize) && value.packSize > 0 ? value.packSize : null;
    const product = {
      name: text(value.name), categoryIds: categories, variants, priceCents: price(value.price, `${row.sourcePath}/price`), variantPricesCents,
      packSize, barcode: text(value.barcode), sku: text(value.sku), variantBarcodes: Object.fromEntries(Object.entries(object(value.variantBarcodes) ? value.variantBarcodes : {}).filter(([, code]) => typeof code === 'string')),
      taxable: typeof value.taxable === 'boolean' ? value.taxable : true, stockStatus: text(value.stockStatus) || 'unknown',
      image: text(value.image), subcategory: text(value.subcategory), tags: strings(value.tags), hasColon: value.hasColon === true,
      order: Number.isFinite(value.order) ? value.order : 0, legacyId: row.originalId,
      legacy: { variantStock: object(value.variantStock) ? clone(value.variantStock) : null, taxableDefaulted: typeof value.taxable !== 'boolean', packSizeNeedsReview: packSize === null }
    };
    add('products', row.id, product, row.sourcePath, row.raw);
    // Legacy stock labels never establish physical quantities.
    for (const variant of variants.length ? variants : ['']) {
      const inventoryId = `${encodeURIComponent(row.id)}~${encodeURIComponent(variant)}`;
      add('inventory', inventoryId, { productId: row.id, variant, onHand: null, reserved: 0, reorderPoint: null, updatedAt: now, needsCount: true }, row.sourcePath, { productId: row.originalId, variant });
    }
  }
  for (const row of userRows) {
    const value = row.value;
    if (!object(value)) { exception('invalid_source_record', row.sourcePath, 'Profile value is invalid.'); continue; }
    const role = value.role === 'employee' ? 'salesman' : ['master', 'salesman', 'customer'].includes(value.role) ? value.role : null;
    if (!role) exception('unknown_legacy_role', row.sourcePath, 'Owner must select a valid role before enrollment.', { legacyProfileId: row.id });
    const info = object(value.salesmanInfo) ? value.salesmanInfo : {};
    const assignedStoreIds = strings(value.storeIds?.length ? value.storeIds : value.storeId ? [value.storeId] : []).map(id => ref(storeIds, id));
    for (const id of assignedStoreIds) if (!storeRows.some(s => s.id === id)) exception('missing_store_reference', row.sourcePath, 'Profile references a missing store.', { legacyProfileId: row.id, storeId: id });
    add('legacyProfiles', row.id, {
      legacyId: row.originalId, username: text(value.username), displayName: text(value.displayName) || text(info.displayName) || text(value.username),
      email: text(value.email) || text(info.email), phone: text(value.phone) || text(info.phone), role, storeIds: assignedStoreIds,
      salesmanId: ref(profileIds, value.salesmanId), salesmanInfo: { displayName: text(info.displayName), phone: text(info.phone), email: text(info.email), hours: text(info.hours) },
      createdAt: dateMillis(value.createdAt), status: 'pending-enrollment', uid: null
    }, row.sourcePath, { id: row.originalId, username: value.username, role: value.role, storeIds: assignedStoreIds });
  }
  for (const row of storeRows) {
    const value = row.value;
    if (!object(value)) { exception('invalid_source_record', row.sourcePath, 'Store value is invalid.'); continue; }
    const ledger = Array.isArray(value.ledger) ? value.ledger : [];
    let total = 0;
    let unresolved = value.ledger != null && !Array.isArray(value.ledger);
    const ledgerIds = new Set();
    for (let index = 0; index < ledger.length; index++) {
      const entry = ledger[index];
      const path = `${row.sourcePath}/ledger/${index}`;
      if (!object(entry) || typeof entry.amount !== 'number' || !Number.isFinite(entry.amount) || cents(entry.amount) === null) {
        unresolved = true;
        exception('invalid_legacy_ledger_entry', path, 'Invalid ledger amount requires owner reconciliation before financial operations.', { storeId: row.id });
        continue;
      }
      // Match the old application's recognized balance, including its mixed-sign defect.
      total += entry.type === 'charge' ? entry.amount : -entry.amount;
      if (entry.type === 'payment' && entry.amount < 0) exception('negative_legacy_payment', path, 'Negative legacy payment increased the old balance. Preserve that balance until staff verifies and reconciles this entry.', { storeId: row.id, legacyEntryId: text(entry.id), amountCents: cents(entry.amount), likelyV7: /^pay-\d+$/.test(text(entry.id)) && typeof entry.method === 'string' });
      else if (entry.type !== 'charge') exception('legacy_credit_purpose_unverified', path, 'Legacy credit may be a payment or adjustment; its balance effect is preserved without asserting payment verification.', { storeId: row.id, legacyEntryId: text(entry.id) });
      if (entry.id && ledgerIds.has(entry.id)) exception('duplicate_ledger_id', path, 'Duplicate ledger ID is retained without deduplication.', { storeId: row.id, legacyEntryId: text(entry.id) });
      ledgerIds.add(entry.id);
    }
    const openingBalanceCents = unresolved ? null : cents(total);
    unresolved ||= openingBalanceCents === null;
    if (unresolved) exception('opening_balance_unresolved', row.sourcePath, 'Opening balance cannot be calculated safely from the source ledger; financial changes are blocked pending reconciliation.', { storeId: row.id });
    const favoriteIds = strings(settings.favoritesByStore?.[row.originalId]);
    if (data.currentStoreId === row.originalId) favoriteIds.push(...strings(settings.favorites));
    const priceOverrides = Object.fromEntries(Object.entries(object(value.priceOverrides) ? value.priceOverrides : {}).map(([key, amount]) => [ref(productIds, key), price(amount, `${row.sourcePath}/priceOverrides/${key}`)]));
    const store = {
      name: text(value.name), address: text(value.address), county: text(value.county), contact: text(value.contact), phone: text(value.phone), email: text(value.email),
      taxRateBps: rateBps(value.taxRate == null ? settings.taxRate : value.taxRate, `${row.sourcePath}/taxRate`),
      creditLimitCents: price(value.creditLimit, `${row.sourcePath}/creditLimit`), terms: typeof value.terms === 'string' && value.terms.trim() ? value.terms : null,
      salesmanId: ref(profileIds, value.salesmanId), priceOverrides, templateLines: Array.isArray(value.templateLines) ? clone(value.templateLines) : [],
      favoriteProductIds: [...new Set(favoriteIds.map(id => ref(productIds, id)))], openingBalanceCents, migrationBlocked: unresolved, legacyId: row.originalId,
      legacy: { ledger: clone(ledger), taxRateInherited: value.taxRate == null, sourceTaxRate: value.taxRate ?? null }
    };
    // Old customer profiles, not the current signed-in user, identify assigned salespeople.
    if (!store.salesmanId) {
      const assignments = [...new Set(userRows.filter(u => object(u.value) && (strings(u.value.storeIds).includes(row.originalId) || u.value.storeId === row.originalId)).map(u => ref(profileIds, u.value.salesmanId)).filter(Boolean))];
      if (assignments.length === 1) store.salesmanId = assignments[0];
      if (assignments.length > 1) exception('conflicting_salesman_assignment', row.sourcePath, 'Several customer profiles assign different salespeople to this store; owner must select the assignment.', { storeId: row.id, salesmanIds: assignments });
    }
    add('stores', row.id, store, row.sourcePath, row.raw);
    report.balances.push({ storeId: row.id, openingBalanceCents, legacyEntryCount: ledger.length, status: unresolved ? 'blocked' : 'preserved' });
    if (!unresolved) add('ledger', `legacy-opening-${checksumSnapshot(row.id).slice(0, 28)}`, {
      storeId: row.id, type: 'opening', deltaCents: openingBalanceCents, amountCents: Math.abs(openingBalanceCents), createdAt: now,
      createdBy: 'migration', note: 'Legacy recognized opening balance — see migration reconciliation report', status: 'posted',
      legacyEntryCount: ledger.length, reconciliationRequired: exceptions.some(e => e.storeId === row.id)
    }, `${row.sourcePath}/ledger`, ledger);
  }
  function convertLines(rawLines, path, orderId) {
    if (!Array.isArray(rawLines)) return [];
    const converted = [];
    rawLines.forEach((line, lineIndex) => {
      const linePath = `${path}/${lineIndex}`;
      if (!object(line)) { exception('invalid_source_record', linePath, 'Invalid order line remains in the archive.', { orderId }); return; }
      const productId = ref(productIds, line.itemId || line.productId);
      const product = productRows.find(p => p.id === productId)?.value;
      if (!product) exception('missing_product_reference', linePath, 'Order line references a missing product and requires review.', { orderId, productId });
      const entries = Array.isArray(line.entries) && line.entries.length ? line.entries : [{ variant: line.variant || '', qty: line.quantity ?? line.qty }];
      entries.forEach((entry, entryIndex) => {
        const quantitySource = object(entry) ? entry.qty ?? entry.quantity : null;
        const quantity = typeof quantitySource === 'number' && Number.isSafeInteger(quantitySource) && quantitySource > 0 ? quantitySource : typeof quantitySource === 'string' && /^\s*[1-9]\d*\s*$/.test(quantitySource) && Number.isSafeInteger(Number(quantitySource)) ? Number(quantitySource) : null;
        if (quantity === null) exception('invalid_legacy_quantity', `${linePath}/entries/${entryIndex}`, 'Quantity cannot be converted to a positive integer without guessing; review the original order line.', { orderId });
        converted.push({
          id: `legacy-line-${checksumSnapshot({ orderId, lineIndex, entryIndex }).slice(0, 24)}`, productId, variant: text(entry?.variant), quantity,
          unit: line.unit === 'case' ? 'case' : 'each', name: text(product?.name) || text(line.name) || text(line.literalText), sku: text(product?.sku),
          note: text(line.note), unitPriceCents: null, lineTotalCents: null, packSize: null,
          legacy: { rawQuantity: clone(quantitySource), unitInferred: !['each', 'case'].includes(line.unit), categoryId: text(line.categoryId), except: text(line.except), suffix: text(line.suffix), literalText: text(line.literalText), needsPriceReview: true }
        });
      });
    });
    return converted;
  }
  const duplicateGroups = new Map();
  for (const row of historyRows) {
    const deleted = row.raw.deleted === true;
    const value = object(row.value) ? row.value : {};
    if (!object(row.value) && !deleted) exception('invalid_source_record', row.sourcePath, 'Order value is invalid and requires review.', { orderId: row.id });
    const storeId = ref(storeIds, value.storeId);
    if (!deleted && !storeRows.some(s => s.id === storeId)) exception('missing_store_reference', row.sourcePath, 'History references a missing store.', { orderId: row.id, storeId });
    const createdAt = dateMillis(value.date);
    if (createdAt === null && !deleted) exception('missing_legacy_date', row.sourcePath, 'Original order date is unknown; migration did not substitute today.', { orderId: row.id });
    const lines = convertLines(value.lines, `${row.sourcePath}/lines`, row.id);
    if (!deleted) exception('legacy_order_missing_snapshot', row.sourcePath, 'Saved totals and text are preserved, but original unit prices, units, and fulfillment status cannot be verified. Do not issue this as a newly finalized invoice.', { orderId: row.id, storeId });
    const order = {
      storeId, storeName: text(value.storeName), createdAt, updatedAt: dateMillis(row.raw.updatedAt) ?? createdAt, createdBy: 'legacy', status: 'legacy', paymentStatus: 'legacy-unverified', deleted,
      lines, notes: text(value.notes) || text(value.creditsReturns), orderText: text(value.orderText), billText: text(value.billText),
      totalCents: price(value.total, `${row.sourcePath}/total`), subtotalCents: price(value.subtotal, `${row.sourcePath}/subtotal`), taxCents: price(value.tax, `${row.sourcePath}/tax`), invoiceNumber: null,
      legacy: { id: row.originalId, date: clone(value.date), edited: value.edited === true, needsPriceReview: true, fulfillmentUnknown: true, rawLines: clone(value.lines || []), sourceTotal: value.total ?? null, sourceSubtotal: value.subtotal ?? null, sourceTax: value.tax ?? null }
    };
    add('orders', row.id, order, row.sourcePath, row.raw);
    if (!deleted) {
      const signature = checksumSnapshot({ storeId, lines: value.lines, total: value.total, orderText: value.orderText });
      const group = duplicateGroups.get(signature) || [];
      group.push({ orderId: row.id, createdAt, sourcePath: row.sourcePath }); duplicateGroups.set(signature, group);
    }
  }
  for (const group of duplicateGroups.values()) {
    const sorted = group.filter(o => o.createdAt !== null).sort((a, b) => a.createdAt - b.createdAt);
    const candidates = new Set();
    for (let i = 1; i < sorted.length; i++) if (sorted[i].createdAt - sorted[i - 1].createdAt <= 5 * 60 * 1000) { candidates.add(sorted[i - 1].orderId); candidates.add(sorted[i].orderId); }
    if (candidates.size > 1) exception('possible_duplicate_orders', 'history', 'Matching orders saved within five minutes are retained; staff should reconcile them against ledger and delivery evidence.', { orderIds: [...candidates].sort() });
  }
  for (const row of draftRows) {
    const value = row.value;
    add('legacyDrafts', row.id, { value: clone(value), createdAt: null, updatedAt: dateMillis(row.raw.updatedAt), archived: true, deviceId: row.originalId, ownerUid: null }, row.sourcePath, row.raw);
    if (!object(value)) { exception('invalid_source_record', row.sourcePath, 'Draft remains archived because its value is invalid.'); continue; }
    if (row.raw.deleted === true) continue;
    const id = `legacy-draft-${checksumSnapshot(row.originalId || row.sourcePath).slice(0, 28)}`;
    const lines = convertLines(value.lines, `${row.sourcePath}/lines`, id);
    const storeId = ref(storeIds, value.storeId);
    const migrationBlocked = lines.some(line => line.quantity === null || !productRows.some(p => p.id === line.productId)) || !storeRows.some(s => s.id === storeId);
    add('orders', id, {
      storeId, status: 'draft', lines, notes: [text(value.notes), text(value.creditsReturns)].filter(Boolean).join('\n'),
      createdAt: dateMillis(value.createdAt), updatedAt: dateMillis(row.raw.updatedAt), createdBy: 'legacy', migrationBlocked,
      legacy: { deviceId: row.originalId, rawLines: clone(value.lines || []), requiresReview: true, archiveDraftId: row.id }
    }, row.sourcePath, row.raw);
  }
  add('legacySettings', 'settings', {
    currentStoreId: ref(storeIds, data.currentStoreId), taxRateBps: rateBps(settings.taxRate, 'state/data/settings/taxRate'),
    uiTheme: ['light', 'dark'].includes(settings.uiTheme) ? settings.uiTheme : 'light', defaultEmail: text(settings.defaultEmail), currency: text(settings.currency),
    blankAfterStore: Number.isFinite(settings.blankAfterStore) ? settings.blankAfterStore : null,
    blankBetweenCats: Number.isFinite(settings.blankBetweenCats) ? settings.blankBetweenCats : null,
    favoritesByStore: Object.fromEntries(storeRows.map(row => [row.id, records.find(r => r.collection === 'stores' && r.id === row.id)?.data.favoriteProductIds || []]))
  }, 'state/data/settings', settings);
  for (const issue of exceptions) add('migrationExceptions', issue.id, { ...issue, createdAt: now }, issue.sourcePath, issue);
  for (const record of records) report.counts.output[record.collection] = (report.counts.output[record.collection] || 0) + 1;
  report.counts.output.migrations = 1;
  report.status = exceptions.some(e => e.severity === 'blocking') ? 'needs-reconciliation' : 'ready-with-review';
  add('migrations', migrationId, { ...clone(report), archiveRequired: true }, 'snapshot', { sourceChecksum });
  return { migrationId, sourceChecksum, records, report };
}

/** Apply in small transactions; no update/delete of any existing business record. */
async function migrate(repository, snapshot, options = {}) {
  if (!repository || typeof repository.transaction !== 'function') throw new TypeError('Transactional repository is required');
  const plan = buildMigration(snapshot, options);
  const batchSize = options.batchSize ?? 40;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new TypeError('batchSize must be between 1 and 100');
  const execution = { created: 0, skipped: 0, conflicts: [] };
  for (let offset = 0; offset < plan.records.length; offset += batchSize) {
    const batch = plan.records.slice(offset, offset + batchSize);
    const result = await repository.transaction(async tx => {
      const existing = await Promise.all(batch.map(record => tx.get(record.collection, record.id)));
      const outcome = { created: 0, skipped: 0, conflicts: [] };
      for (let i = 0; i < batch.length; i++) {
        const record = batch[i];
        if (existing[i]) {
          outcome.skipped++;
          if (existing[i].migration?.sourceHash !== record.data.migration.sourceHash) outcome.conflicts.push({ collection: record.collection, id: record.id, reason: 'Existing record differs from migration source; preserved existing record.' });
        } else {
          await tx.set(record.collection, record.id, record.data);
          outcome.created++;
        }
      }
      return outcome;
    });
    execution.created += result.created;
    execution.skipped += result.skipped;
    execution.conflicts.push(...result.conflicts);
    if (options.onProgress) await options.onProgress({ completed: Math.min(offset + batchSize, plan.records.length), total: plan.records.length, ...execution });
  }
  return { ...plan, execution };
}

module.exports = { buildMigration, migrate, checksumSnapshot };
