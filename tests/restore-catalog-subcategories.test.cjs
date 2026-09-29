'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { MemoryRepository } = require('../lib/repository.cjs');
const modulePath = require('node:path').join(__dirname, '../lib/restore-catalog-subcategories.cjs');
const implementation = fs.existsSync(modulePath) ? require(modulePath) : {};
const { buildSubcategoryRestoration: build, restoreCatalogSubcategories: restore } = implementation;
const now = 1790640000000;
const provenance = n => ({ sourceHash: n.repeat(64), migrationId: 'legacy-v1-synthetic' });
function fixture() {
  const sourceCategories = [{ id: 'drinks', name: 'Drinks', subcategories: ['Water', 'Soda'], migration: provenance('a') }];
  const sourceProducts = [{ id: 'p1', name: 'Water bottle', categoryIds: ['drinks'], subcategory: 'Water', migration: provenance('b') }];
  return { sourceCategories, sourceProducts, categories: structuredClone(sourceCategories), products: [{ ...structuredClone(sourceProducts[0]), version: 3, priceCents: 157, variants: ['Still'], image: '/image.png', imageSource: { provider: 'original' }, custom: { retained: true }, createdAt: 100, updatedAt: 200 }], now };
}
const run = input => { assert.equal(typeof build, 'function', 'restoration planner must exist'); return build(input); };
const planFor = async (repo, input) => run({ ...input, categories: await repo.list('categories'), products: await repo.list('products') });
const seeded = input => new MemoryRepository({ categories: input.categories, products: input.products, orders: [{ id: 'saved', lines: [{ productId: 'p1', categoryNames: ['Original'] }], totalCents: 157 }] });

test('restores real child categories and adds product membership without changing other fields', () => {
  const input = fixture(), original = structuredClone(input), result = run(input);
  assert.deepEqual(input, original);
  assert.equal(result.categoryCreates.length, 2);
  const water = result.categoryCreates.find(c => c.name === 'Water');
  assert.equal(water.parentId, 'drinks');
  assert.equal(water.active, true);
  assert.equal(water.version, 1);
  assert.equal(result.productUpdates.length, 1);
  const updated = result.productUpdates[0];
  assert.deepEqual(updated.categoryIds, ['drinks', water.id]);
  assert.equal(updated.version, 4);
  assert.equal(updated.updatedAt, now);
  for (const key of ['priceCents', 'variants', 'image', 'imageSource', 'custom', 'createdAt', 'migration']) assert.deepEqual(updated[key], input.products[0][key]);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
});

test('deterministic child IDs are scoped by parent and deduplicate normalized legacy names', () => {
  const input = fixture();
  input.sourceCategories[0].subcategories = input.categories[0].subcategories = ['Water', ' water ', 'Soda'];
  input.sourceCategories.push({ id: 'other', name: 'Other', subcategories: ['Water'], migration: provenance('c') });
  input.categories = structuredClone(input.sourceCategories);
  const a = run(input), b = run({ ...input, categories: [...input.categories].reverse(), sourceCategories: [...input.sourceCategories].reverse(), now: now + 1000 });
  assert.equal(a.categoryCreates.length, 3);
  assert.equal(new Set(a.categoryCreates.map(c => c.id)).size, 3);
  assert.deepEqual(a.categoryCreates.map(c => c.id), b.categoryCreates.map(c => c.id));
  assert.equal(a.fingerprint, b.fingerprint);
});

test('reuses the unique active child and preserves all of its current fields', () => {
  const input = fixture(), child = { id: 'custom-water', parentId: 'drinks', name: ' WATER ', active: true, sortOrder: 91, version: 8 };
  input.categories.push(child);
  const result = run(input);
  assert.deepEqual(result.categoryCreates.map(c => c.name), ['Soda']);
  assert.deepEqual(result.productUpdates[0].categoryIds, ['drinks', child.id]);
  assert.deepEqual(input.categories.at(-1), child);
});

for (const [reason, children] of [
  ['ambiguous_child', [{ id: 'w1', name: 'Water' }, { id: 'w2', name: ' WATER ' }]],
  ['inactive_child', [{ id: 'w1', name: 'Water', active: false }]],
  ['inactive_child', [{ id: 'w1', name: 'Water', deleted: true }]],
]) test(`does not duplicate or assign a ${reason}`, () => {
  const input = fixture();
  input.categories.push(...children.map(c => ({ parentId: 'drinks', ...c })));
  const result = run(input);
  assert.ok(result.conflicts.some(c => c.reason === reason));
  assert.equal(result.categoryCreates.some(c => c.name === 'Water'), false);
  assert.equal(result.productUpdates.length, 0);
});

test('fails closed if the deterministic child ID was renamed or moved', () => {
  const input = fixture(), water = run(input).categoryCreates.find(c => c.name === 'Water');
  input.categories.push({ ...water, name: 'Mineral water', parentId: 'other' });
  const result = run(input);
  assert.ok(result.conflicts.some(c => c.reason === 'child_id_collision'));
  assert.equal(result.categoryCreates.some(c => c.name === 'Water'), false);
  assert.equal(result.productUpdates.length, 0);
});

for (const [reason, edit] of [
  ['product_missing', input => { input.products = []; }],
  ['product_provenance_changed', input => { input.products[0].migration.sourceHash = 'c'.repeat(64); }],
  ['product_provenance_changed', input => { delete input.products[0].migration; }],
  ['product_reclassified', input => { input.products[0].categoryIds = ['other']; }],
  ['product_reclassified', input => { input.products[0].categoryIds = ['drinks', 'manual-child']; }],
  ['product_subcategory_changed', input => { input.products[0].subcategory = 'Soda'; }],
  ['inactive_product', input => { input.products[0].active = false; }],
  ['inactive_product', input => { input.products[0].deleted = true; }],
]) test(`preserves products with ${reason}`, () => {
  const input = fixture(); edit(input);
  const result = run(input);
  assert.ok(result.conflicts.some(c => c.reason === reason));
  assert.equal(result.productUpdates.length, 0);
});

for (const [reason, edit] of [
  ['category_missing', input => { input.categories = []; }],
  ['category_provenance_changed', input => { delete input.categories[0].migration; }],
  ['category_provenance_changed', input => { input.categories[0].migration.sourceHash = 'c'.repeat(64); }],
  ['category_reparented', input => { input.categories[0].parentId = 'other'; }],
  ['category_subcategories_changed', input => { input.categories[0].subcategories = ['Custom']; }],
  ['inactive_category', input => { input.categories[0].active = false; }],
]) test(`preserves category edits for ${reason}`, () => {
  const input = fixture(); edit(input);
  const result = run(input);
  assert.ok(result.conflicts.some(c => c.reason === reason));
  assert.equal(result.categoryCreates.length, 0);
  assert.equal(result.productUpdates.length, 0);
});

test('fingerprint changes after catalog edits even when classification is unchanged', () => {
  const input = fixture(), before = run(input).fingerprint;
  input.products[0].priceCents++;
  assert.notEqual(run(input).fingerprint, before);
  const second = run(input).fingerprint;
  input.categories[0].name = 'Beverages';
  assert.notEqual(run(input).fingerprint, second);
});

test('invalid schema, duplicate identifiers, unsafe names, and invalid provenance fail closed', () => {
  for (const mutate of [
    input => { input.products = {}; },
    input => { input.sourceProducts.push(structuredClone(input.sourceProducts[0])); },
    input => { input.sourceCategories[0].id = '../unsafe'; },
    input => { input.sourceProducts[0].migration.sourceHash = ''; },
    input => { input.sourceProducts[0].categoryIds = 'drinks'; },
    input => { input.sourceCategories[0].subcategories = ['x'.repeat(151)]; },
    input => { input.now = NaN; },
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => run(input), { code: 'INVALID_RESTORATION_INPUT' });
  }
});

test('transaction repair is atomic, audited, and leaves orders unchanged', async () => {
  const input = fixture(), repo = seeded(input), beforeOrders = await repo.list('orders');
  const preview = await planFor(repo, input);
  assert.equal(typeof restore, 'function', 'transaction runner must exist');
  const result = await restore(repo, { ...input, expectedFingerprint: preview.fingerprint });
  assert.equal(result.applied, true);
  assert.equal((await repo.list('categories')).length, 3);
  assert.equal((await repo.get('products', 'p1')).version, 4);
  assert.deepEqual(await repo.list('orders'), beforeOrders);
  assert.equal((await repo.get('settings', 'legacyCatalogHierarchyV1')).complete, true);
  assert.equal((await repo.list('audit')).length, 1);
});

test('stale or missing previews reject before any writes', async () => {
  const input = fixture(), repo = seeded(input), preview = await planFor(repo, input);
  await repo.put('products', 'p1', { ...input.products[0], priceCents: 199 });
  await assert.rejects(() => restore(repo, { ...input, expectedFingerprint: preview.fingerprint }), { code: 'RESTORATION_PREVIEW_CHANGED' });
  await assert.rejects(() => restore(repo, input), { code: 'INVALID_RESTORATION_INPUT' });
  assert.equal((await repo.list('categories')).length, 1);
  assert.equal(await repo.get('settings', 'legacyCatalogHierarchyV1'), null);
  assert.equal((await repo.list('audit')).length, 0);
});

test('concurrent and later retries apply once and never resurrect a deleted child', async () => {
  const input = fixture(), repo = seeded(input), preview = await planFor(repo, input);
  const options = { ...input, expectedFingerprint: preview.fingerprint };
  const results = await Promise.all([restore(repo, options), restore(repo, options)]);
  assert.equal(results.filter(r => r.applied).length, 1);
  assert.equal(results.filter(r => r.alreadyApplied).length, 1);
  const water = (await repo.list('categories')).find(c => c.name === 'Water');
  await repo.transaction(tx => tx.delete('categories', water.id));
  const replay = await restore(repo, options);
  assert.equal(replay.alreadyApplied, true);
  assert.equal(await repo.get('categories', water.id), null);
  assert.equal((await repo.list('audit')).length, 1);
});

test('failed transaction leaves no partial categories, products, marker, or audit', async () => {
  const input = fixture(), repo = seeded(input), preview = await planFor(repo, input);
  const failing = { transaction: fn => repo.transaction(tx => fn({ ...tx, set: async (collection, id, value) => { if (collection === 'settings') throw new Error('simulated failure'); return tx.set(collection, id, value); } })) };
  await assert.rejects(() => restore(failing, { ...input, expectedFingerprint: preview.fingerprint }), /simulated failure/);
  assert.deepEqual(await repo.list('categories'), input.categories);
  assert.deepEqual(await repo.list('products'), input.products);
  assert.equal(await repo.get('settings', 'legacyCatalogHierarchyV1'), null);
  assert.equal((await repo.list('audit')).length, 0);
});

test('a reviewed preview can apply later while retaining the actual application time', async () => {
  const input = fixture(), repo = seeded(input), preview = await planFor(repo, input);
  await restore(repo, { ...input, now: now + 60000, expectedFingerprint: preview.fingerprint });
  assert.equal((await repo.get('products', 'p1')).updatedAt, now + 60000);
  assert.equal((await repo.get('settings', 'legacyCatalogHierarchyV1')).appliedAt, now + 60000);
});

test('unexpected restoration audit or incomplete marker requires review instead of overwriting evidence', async () => {
  for (const collection of ['audit', 'settings']) {
    const input = fixture(), repo = seeded(input), preview = await planFor(repo, input);
    const previous = { id: 'legacyCatalogHierarchyV1', details: 'Retain this evidence', complete: false };
    await repo.put(collection, previous.id, previous);
    await assert.rejects(() => restore(repo, { ...input, expectedFingerprint: preview.fingerprint }), { code: 'RESTORATION_MARKER_INVALID' });
    assert.deepEqual(await repo.get(collection, previous.id), previous);
    assert.deepEqual(await repo.list('products'), input.products);
  }
});

test('an empty source cannot consume the global restoration marker', async () => {
  const input = fixture(), repo = seeded(input);
  await assert.rejects(() => restore(repo, { sourceCategories: [], sourceProducts: [], now, expectedFingerprint: 'a'.repeat(64) }), { code: 'INVALID_RESTORATION_INPUT' });
  assert.equal(await repo.get('settings', 'legacyCatalogHierarchyV1'), null);
});
