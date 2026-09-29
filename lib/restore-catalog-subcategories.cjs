'use strict';

const { createHash } = require('node:crypto');
const { getLegacySubcategories, getLegacySubcategory } = require('./legacy-subcategories.cjs');

const RESTORATION_ID = 'legacyCatalogHierarchyV1';
const SYSTEM_ACTOR = 'catalog-subcategory-restoration';
const MAX_RECORDS = 50000;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const reject = (message, code = 'INVALID_RESTORATION_INPUT', status = 400) => {
  throw Object.assign(new Error(message), { code, status });
};
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    if (value instanceof Date) return { timestamp: value.toISOString() };
    if (typeof value.toMillis === 'function') return { timestampMillis: value.toMillis() };
    return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  }
  return value;
}
const stable = value => JSON.stringify(canonical(value));
const checksum = value => createHash('sha256').update(stable(value)).digest('hex');
const normalized = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
function validateId(value) {
  if (typeof value !== 'string' || !value || value.length > 700 || /[\/\u0000-\u001F]/u.test(value) || ['.', '..', '__proto__', 'constructor', 'prototype'].includes(value)) reject('Catalog identifiers are invalid.');
}
function validateLabel(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 150 || /[\u0000-\u001F]/u.test(value)) reject('A legacy subcategory label is invalid.');
  return value.trim();
}
function validateStrings(value, label, { names = false } = {}) {
  if (!Array.isArray(value) || value.length > 100) reject(`${label} must contain at most 100 values.`);
  for (const entry of value) names ? validateLabel(entry) : validateId(entry);
}
function validateRows(rows, label, { source = false, products = false } = {}) {
  if (!Array.isArray(rows) || rows.length > MAX_RECORDS) reject(`${label} must be a bounded list of records.`);
  const ids = new Set();
  for (const row of rows) {
    if (!plain(row)) reject(`${label} contains an invalid record.`);
    validateId(row.id);
    if (ids.has(row.id)) reject(`${label} contains duplicate identifiers.`);
    ids.add(row.id);
    if (source && (!plain(row.migration) || !/^[a-f0-9]{64}$/u.test(row.migration.sourceHash || ''))) reject('Legacy source records require a valid migration fingerprint.');
    if (source && products) {
      if (typeof row.name !== 'string' || row.name.length > 1000) reject('A legacy product name is invalid.');
      validateStrings(row.categoryIds, 'Legacy product categories');
      if (new Set(row.categoryIds).size !== row.categoryIds.length) reject('Legacy product categories contain duplicates.');
      if (row.subcategory != null && typeof row.subcategory !== 'string') reject('A legacy product subcategory is invalid.');
      if (row.subcategory) validateLabel(row.subcategory);
    }
    if (source && !products) {
      if (typeof row.name !== 'string' || row.name.length > 1000) reject('A legacy category name is invalid.');
      if (row.subcategories !== undefined) validateStrings(row.subcategories, 'Legacy subcategories', { names: true });
    }
  }
}
function validateTime(now) {
  if (!Number.isSafeInteger(now) || now < 0) reject('Restoration time must be epoch milliseconds.');
}
function childId(parentId, label) {
  return `legacy-sub-${checksum([parentId, normalized(label)]).slice(0, 40)}`;
}

/** Plan only. The source must be sanitized category/product records from the
 * original create-only migration, never client-supplied catalog assertions. */
function buildSubcategoryRestoration({ categories, products, sourceCategories, sourceProducts, now = Date.now() }) {
  validateTime(now);
  validateRows(categories, 'Current categories');
  validateRows(products, 'Current products');
  validateRows(sourceCategories, 'Source categories', { source: true });
  validateRows(sourceProducts, 'Source products', { source: true, products: true });
  const categoryById = new Map(categories.map(row => [row.id, row]));
  const productById = new Map(products.map(row => [row.id, row]));
  const sourceCategoryById = new Map(sourceCategories.map(row => [row.id, row]));
  const categoryCreates = [], productUpdates = [], conflicts = [];
  const resolvedByParent = new Map();
  let categoriesReused = 0;
  const conflict = (reason, recordId, details = {}) => conflicts.push({ reason, recordId, ...details });

  for (const source of [...sourceCategories].sort(byId)) {
    const current = categoryById.get(source.id);
    if (!current) { conflict('category_missing', source.id); continue; }
    if (current.migration?.sourceHash !== source.migration.sourceHash) { conflict('category_provenance_changed', source.id); continue; }
    if (current.deleted || current.active === false) { conflict('inactive_category', source.id); continue; }
    if (current.parentId) { conflict('category_reparented', source.id); continue; }
    if (stable(current.subcategories || []) !== stable(source.subcategories || [])) { conflict('category_subcategories_changed', source.id); continue; }
    const labels = getLegacySubcategories(source);
    validateStrings(labels, 'Resolved legacy subcategories', { names: true });
    const resolved = new Map(), handled = new Set();
    resolvedByParent.set(source.id, resolved);
    for (const [sortOrder, raw] of labels.entries()) {
      const label = validateLabel(raw), nameKey = normalized(label);
      if (handled.has(nameKey)) continue;
      handled.add(nameKey);
      const id = childId(source.id, label), occupied = categoryById.get(id);
      if (occupied && (occupied.parentId !== source.id || typeof occupied.name !== 'string' || normalized(occupied.name) !== nameKey)) {
        conflict('child_id_collision', source.id, { subcategory: label }); continue;
      }
      const matches = categories.filter(row => row.parentId === source.id && typeof row.name === 'string' && normalized(row.name) === nameKey);
      if (matches.length > 1) { conflict('ambiguous_child', source.id, { subcategory: label }); continue; }
      if (matches.length === 1) {
        if (matches[0].deleted || matches[0].active === false) { conflict('inactive_child', source.id, { subcategory: label }); continue; }
        resolved.set(nameKey, matches[0].id);
        categoriesReused++;
        continue;
      }
      const record = { id, name: label, parentId: source.id, sortOrder, active: true, version: 1, createdAt: now, updatedAt: now, createdBy: SYSTEM_ACTOR, updatedBy: SYSTEM_ACTOR, [RESTORATION_ID]: { parentId: source.id, sourceName: label, sourceHash: source.migration.sourceHash } };
      categoryCreates.push(record);
      categoryById.set(id, record);
      resolved.set(nameKey, id);
    }
  }

  for (const source of [...sourceProducts].sort(byId)) {
    const current = productById.get(source.id);
    if (!current) { conflict('product_missing', source.id); continue; }
    if (current.migration?.sourceHash !== source.migration.sourceHash) { conflict('product_provenance_changed', source.id); continue; }
    if (current.deleted || current.active === false) { conflict('inactive_product', source.id); continue; }
    if (own(current, RESTORATION_ID)) { conflict('product_already_restored', source.id); continue; }
    // Old subcategory selection belonged to the first category. Preserve the
    // complete, ordered category assignment; any modern edit needs review.
    if (stable(current.categoryIds) !== stable(source.categoryIds)) { conflict('product_reclassified', source.id); continue; }
    if ((current.subcategory || '') !== (source.subcategory || '')) { conflict('product_subcategory_changed', source.id); continue; }
    const parentId = source.categoryIds[0], primaryCategory = sourceCategoryById.get(parentId);
    if (!primaryCategory) { conflict('product_parent_missing', source.id); continue; }
    const resolved = resolvedByParent.get(parentId);
    if (!resolved) { conflict('product_parent_unavailable', source.id, { parentId }); continue; }
    const label = getLegacySubcategory(source, primaryCategory);
    if (typeof label !== 'string' || !label.trim()) { conflict('product_subcategory_unresolved', source.id, { parentId }); continue; }
    const id = resolved.get(normalized(label));
    if (!id) { conflict('product_subcategory_unresolved', source.id, { parentId, subcategory: label }); continue; }
    if (source.categoryIds.includes(id)) continue;
    const version = current.version ?? 1;
    if (!Number.isSafeInteger(version) || version < 1 || version >= Number.MAX_SAFE_INTEGER) { conflict('product_version_invalid', source.id); continue; }
    if (source.categoryIds.length >= 100) { conflict('product_category_capacity', source.id); continue; }
    productUpdates.push({ ...structuredClone(current), categoryIds: [...current.categoryIds, id], version: version + 1, updatedAt: now, updatedBy: SYSTEM_ACTOR, [RESTORATION_ID]: { parentId, categoryId: id, sourceHash: source.migration.sourceHash } });
  }
  categoryCreates.sort(byId);
  productUpdates.sort(byId);
  const summary = { sourceCategories: sourceCategories.length, sourceProducts: sourceProducts.length, categoriesCreated: categoryCreates.length, categoriesReused, productsUpdated: productUpdates.length, conflicts: conflicts.length };
  // Full current records protect unrelated fields from stale read-modify-write.
  // The invocation time is excluded so a reviewed plan remains applicable later.
  const fingerprint = checksum({
    restoration: RESTORATION_ID,
    categories: [...categories].sort(byId), products: [...products].sort(byId),
    sourceCategories: [...sourceCategories].sort(byId), sourceProducts: [...sourceProducts].sort(byId),
    categoryCreates: categoryCreates.map(({ createdAt, updatedAt, ...record }) => record),
    productMemberships: productUpdates.map(record => ({ id: record.id, categoryIds: record.categoryIds, version: record.version, restoration: record[RESTORATION_ID] })),
    conflicts,
  });
  return { categoryCreates, productUpdates, summary, conflicts, fingerprint };
}

/** Trusted operator entry point. Call only after owner authorization (or from
 * the private operator CLI); deliberately never called by a catalog read. */
async function restoreCatalogSubcategories(repo, { sourceCategories, sourceProducts, expectedFingerprint, now = Date.now() } = {}) {
  if (!repo || typeof repo.transaction !== 'function') reject('A transactional repository is required.');
  if (typeof expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedFingerprint)) reject('A reviewed restoration fingerprint is required.');
  validateTime(now);
  validateRows(sourceCategories, 'Source categories', { source: true });
  validateRows(sourceProducts, 'Source products', { source: true, products: true });
  if (!sourceCategories.length) reject('A nonempty legacy category source is required.');
  return repo.transaction(async tx => {
    const previous = await tx.get('settings', RESTORATION_ID);
    if (previous) {
      if (previous.complete !== true || !/^[a-f0-9]{64}$/u.test(previous.fingerprint || '')) reject('The restoration marker needs operator review.', 'RESTORATION_MARKER_INVALID', 409);
      return { applied: false, alreadyApplied: true, fingerprint: previous.fingerprint, summary: previous.summary };
    }
    if (await tx.get('audit', RESTORATION_ID)) reject('Existing restoration evidence needs operator review.', 'RESTORATION_MARKER_INVALID', 409);
    const categories = await tx.list('categories'), products = await tx.list('products');
    const plan = buildSubcategoryRestoration({ categories, products, sourceCategories, sourceProducts, now });
    if (plan.fingerprint !== expectedFingerprint) reject('The catalog changed after the restoration preview. Review a fresh preview.', 'RESTORATION_PREVIEW_CHANGED', 409);
    for (const record of plan.categoryCreates) await tx.set('categories', record.id, record);
    for (const record of plan.productUpdates) await tx.set('products', record.id, record);
    await tx.set('settings', RESTORATION_ID, { id: RESTORATION_ID, complete: true, fingerprint: plan.fingerprint, summary: plan.summary, appliedAt: now, appliedBy: SYSTEM_ACTOR });
    await tx.set('audit', RESTORATION_ID, { id: RESTORATION_ID, type: 'catalog.legacy_subcategories_restored', actorUid: SYSTEM_ACTOR, actorRole: 'system', createdAt: now, at: now, fingerprint: plan.fingerprint, summary: plan.summary });
    return { applied: true, alreadyApplied: false, fingerprint: plan.fingerprint, summary: plan.summary, conflicts: plan.conflicts };
  });
}

module.exports = { buildSubcategoryRestoration, restoreCatalogSubcategories, RESTORATION_ID };
