'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMigration, migrate, checksumSnapshot } = require('../lib/migration.cjs');

const now = 1789362000000;
function fixture() {
  return {
    state: {
      data: { value: {
        categories: [{ id: 'cat', name: 'Drinks', subcategories: ['Water'], order: 2 }],
        items: [{ id: 'water', name: 'Water', categoryId: 'cat', variants: ['Still'], price: 1.25, variantPrices: { Still: 1.5 }, image: 'data:image/png;base64,YWJj', taxable: false }, { id: 'unknown', name: 'Unpriced', variants: [] }],
        stores: [{ id: 'shop', name: 'Shop', creditLimit: 0, taxRate: 0, phone: '205-000-0000', templateLines: [{ literalText: 'Handle gently' }], ledger: [
          { id: 'charge', type: 'charge', amount: 100, date: 1700000000000 },
          { id: 'positive', type: 'payment', amount: 20, date: 1700000000001 },
          { id: 'pay-1700000000002', type: 'payment', amount: -10, method: 'Cash', date: '2023-11-14' }
        ] }],
        currentStoreId: 'shop', settings: { taxRate: 8.5, favoritesByStore: { shop: ['water'] }, uiTheme: 'dark', defaultEmail: 'orders@example.test' }
      }, updatedAt: 1700000000010 },
      users: { value: [{ id: 'staff', username: 'Alice', passwordHash: 'PRIVATE_HASH', salt: 'PRIVATE_SALT', password: 'PRIVATE_PASSWORD', role: 'employee', storeIds: ['shop'], salesmanInfo: { displayName: 'Alice', phone: '555', email: 'alice@example.test', hours: 'Weekdays', secret: 'PRIVATE_SECRET' } }] },
      drafts: [{ id: 'order-device-a', value: { storeId: 'shop', lines: [{ id: 'line', itemId: 'water', entries: [{ variant: 'Still', qty: '2' }], note: 'Cold' }], creditsReturns: 'Ask about last delivery' }, updatedAt: 1700000000000 }]
    },
    history: [{ id: 'old-order', value: { id: 'old-order', storeId: 'shop', date: 1600000000000, lines: [{ itemId: 'water', entries: [{ variant: 'Still', qty: '2' }] }], total: 20, subtotal: 18, tax: 2, orderText: 'Original text', billText: 'Original $20 invoice', edited: true }, updatedAt: 1700000000000 }]
  };
}
function record(plan, collection, id) {
  const result = plan.records.find(r => r.collection === collection && (!id || r.id === id));
  assert.ok(result, `missing ${collection}/${id || ''}`);
  return result.data;
}
function memoryRepository() {
  const values = new Map();
  return { values, async transaction(fn) {
    const writes = [];
    const tx = {
      get: async (c, id) => structuredClone(values.get(`${c}/${id}`) || null),
      set: (c, id, value) => writes.push([`${c}/${id}`, structuredClone(value)]),
      delete: () => { throw new Error('Migration must never delete'); }
    };
    const result = await fn(tx);
    for (const [key, value] of writes) values.set(key, value);
    return result;
  } };
}

test('keeps recognized mixed-sign opening balance and flags negative V7 payment', () => {
  const plan = buildMigration(fixture(), { now });
  const opening = record(plan, 'ledger');
  assert.equal(opening.type, 'opening');
  assert.equal(opening.deltaCents, 9000);
  assert.equal(opening.amountCents, 9000);
  assert.equal(record(plan, 'stores', 'shop').openingBalanceCents, 9000);
  assert.ok(plan.report.exceptions.some(e => e.code === 'negative_legacy_payment'));
  assert.equal(plan.report.balances[0].legacyEntryCount, 3);
  assert.equal(record(plan, 'stores', 'shop').legacy.ledger[2].amount, -10);
});

test('preserves historical date and saved totals independently of current prices', () => {
  const source = fixture();
  source.state.data.value.items[0].price = 999;
  const plan = buildMigration(source, { now });
  const order = record(plan, 'orders', 'old-order');
  assert.equal(order.createdAt, 1600000000000);
  assert.equal(order.totalCents, 2000);
  assert.equal(order.subtotalCents, 1800);
  assert.equal(order.taxCents, 200);
  assert.equal(order.status, 'legacy');
  assert.equal(order.orderText, 'Original text');
  assert.equal(order.legacy.needsPriceReview, true);
  assert.equal(order.lines[0].unitPriceCents, null);
  assert.ok(plan.report.exceptions.some(e => e.code === 'legacy_order_missing_snapshot'));
});

test('does not invent stock, pack sizes, missing prices, terms or credit limits', () => {
  const plan = buildMigration(fixture(), { now });
  const product = record(plan, 'products', 'unknown');
  const store = record(plan, 'stores', 'shop');
  assert.equal(product.priceCents, null);
  assert.equal(product.packSize, null);
  assert.equal(store.creditLimitCents, 0);
  assert.equal(store.terms, null);
  assert.equal(store.taxRateBps, 0);
  assert.ok(plan.records.filter(r => r.collection === 'inventory').every(r => r.data.onHand === null && r.data.reserved === 0));
  assert.equal(record(plan, 'products', 'water').image, 'data:image/png;base64,YWJj');
  assert.deepEqual(store.favoriteProductIds, ['water']);
  assert.equal(store.templateLines[0].literalText, 'Handle gently');
});

test('profile migration allows only safe fields and grants no Firebase identity', () => {
  const plan = buildMigration(fixture(), { now });
  const profile = record(plan, 'legacyProfiles', 'staff');
  assert.equal(profile.role, 'salesman');
  assert.equal(profile.status, 'pending-enrollment');
  assert.equal(profile.uid, null);
  assert.equal(profile.salesmanInfo.displayName, 'Alice');
  assert.deepEqual(profile.storeIds, ['shop']);
  const exported = JSON.stringify(plan);
  for (const secret of ['PRIVATE_HASH', 'PRIVATE_SALT', 'PRIVATE_PASSWORD', 'PRIVATE_SECRET']) assert.ok(!exported.includes(secret));
});

test('preserves source and converted draft, flags malformed quantities without partial parsing', () => {
  const source = fixture();
  source.state.drafts[0].value.lines.push({ itemId: 'water', entries: [{ variant: 'Still', qty: '2abc' }, { variant: 'Still', qty: '-3' }], literalText: 'Special instructions' });
  const plan = buildMigration(source, { now });
  const rawDraft = record(plan, 'legacyDrafts');
  const draft = plan.records.find(r => r.collection === 'orders' && r.data.status === 'draft').data;
  assert.equal(rawDraft.value.lines.length, 2);
  assert.equal(draft.lines.length, 3);
  assert.equal(draft.lines[0].quantity, 2);
  assert.equal(draft.lines[1].quantity, null);
  assert.equal(draft.lines[2].quantity, null);
  assert.equal(draft.migrationBlocked, true);
  assert.match(draft.notes, /Ask about last delivery/);
  assert.ok(plan.report.exceptions.some(e => e.code === 'invalid_legacy_quantity'));
});

test('retains deleted history tombstones without treating them as active orders', () => {
  const source = fixture();
  source.history.push({ id: 'deleted-order', deleted: true, updatedAt: 1700000000001 });
  const plan = buildMigration(source, { now });
  const deleted = record(plan, 'orders', 'deleted-order');
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.status, 'legacy');
  assert.equal(deleted.totalCents, null);
  assert.equal(plan.report.counts.source.history, 2);
});

test('unknown dates remain unknown and invalid ledger blocks financial migration', () => {
  const source = fixture();
  delete source.history[0].value.date;
  source.state.data.value.stores[0].ledger.push({ type: 'charge', amount: '100oops' });
  const plan = buildMigration(source, { now });
  const store = record(plan, 'stores', 'shop');
  assert.equal(store.openingBalanceCents, null);
  assert.equal(store.migrationBlocked, true);
  assert.equal(plan.records.filter(r => r.collection === 'ledger').length, 0);
  assert.equal(record(plan, 'orders', 'old-order').createdAt, null);
  assert.ok(plan.report.exceptions.some(e => e.code === 'opening_balance_unresolved'));
});

test('duplicate-looking orders are retained and require reconciliation', () => {
  const source = fixture();
  const duplicate = structuredClone(source.history[0]);
  duplicate.id = duplicate.value.id = 'duplicate-order';
  duplicate.value.date += 1000;
  source.history.push(duplicate);
  const plan = buildMigration(source, { now });
  assert.ok(record(plan, 'orders', 'old-order'));
  assert.ok(record(plan, 'orders', 'duplicate-order'));
  assert.ok(plan.report.exceptions.some(e => e.code === 'possible_duplicate_orders'));
});

test('invalid records and duplicate IDs are retained as exceptions with unique output IDs', () => {
  const source = fixture();
  source.state.data.value.items.push({ id: 'water', name: 'Other water', price: 5 }, null);
  source.state.data.value.stores.push({ id: 'has/slash', name: 'Another shop' });
  const plan = buildMigration(source, { now });
  const keys = plan.records.map(r => `${r.collection}/${r.id}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(plan.records.filter(r => r.collection === 'products').length >= 3);
  assert.ok(plan.report.exceptions.some(e => e.code === 'duplicate_source_id'));
  assert.ok(plan.report.exceptions.some(e => e.code === 'invalid_source_record'));
  assert.ok(plan.records.every(r => !r.id.includes('/')));
});

test('migration is deterministic, does not mutate input, and supports direct snapshot values', () => {
  const source = fixture();
  const before = structuredClone(source);
  const one = buildMigration(source, { now });
  const two = buildMigration(source, { now: now + 100 });
  assert.equal(one.sourceChecksum, two.sourceChecksum);
  assert.deepEqual(one.records.map(r => [r.collection, r.id]), two.records.map(r => [r.collection, r.id]));
  assert.deepEqual(source, before);
  assert.equal(checksumSnapshot({ z: 1, a: { b: 2, a: 1 } }), checksumSnapshot({ a: { a: 1, b: 2 }, z: 1 }));
  const direct = buildMigration({ data: source.state.data.value, users: source.state.users.value, drafts: source.state.drafts, history: source.history }, { now });
  assert.equal(record(direct, 'products', 'water').priceCents, 125);
});

test('migration creates once, survives partial batches, and does not overwrite later edits', async () => {
  const source = fixture();
  const repo = memoryRepository();
  const first = await migrate(repo, source, { now, batchSize: 2 });
  assert.equal(first.execution.created, first.records.length);
  const product = repo.values.get('products/water');
  product.priceCents = 300;
  product.version = 2;
  const again = await migrate(repo, source, { now: now + 1, batchSize: 3 });
  assert.equal(again.execution.created, 0);
  assert.equal(again.execution.skipped, first.records.length);
  assert.equal(repo.values.get('products/water').priceCents, 300);
  assert.equal(repo.values.get('products/water').version, 2);
  source.state.data.value.items[0].price = 10;
  const changed = await migrate(repo, source, { now: now + 2 });
  assert.ok(changed.execution.conflicts.some(c => c.collection === 'products' && c.id === 'water'));
  assert.equal(repo.values.get('products/water').priceCents, 300);
});

test('failed migration batch can be resumed without duplicates', async () => {
  const source = fixture();
  const repo = memoryRepository();
  const original = repo.transaction;
  let batches = 0;
  repo.transaction = async fn => { if (++batches === 2) throw new Error('simulated outage'); return original(fn); };
  await assert.rejects(migrate(repo, source, { now, batchSize: 3 }), /simulated outage/);
  const preserved = repo.values.size;
  assert.equal(preserved, 3);
  repo.transaction = original;
  const resumed = await migrate(repo, source, { now, batchSize: 3 });
  assert.equal(resumed.execution.skipped, preserved);
  assert.equal(repo.values.size, resumed.records.length);
});

test('rounds the recognized aggregate once and blocks string amounts instead of coercing them', () => {
  const source = fixture();
  source.state.data.value.stores[0].ledger = [
    { type: 'charge', amount: 0.004 }, { type: 'charge', amount: 0.004 }, { type: 'charge', amount: 0.004 }
  ];
  assert.equal(record(buildMigration(source, { now }), 'ledger').deltaCents, 1);
  source.state.data.value.stores[0].ledger = [{ type: 'charge', amount: '100' }, { type: 'charge', amount: 20 }];
  const blocked = buildMigration(source, { now });
  assert.equal(record(blocked, 'stores', 'shop').openingBalanceCents, null);
  assert.equal(record(blocked, 'stores', 'shop').migrationBlocked, true);
  assert.equal(record(blocked, 'stores', 'shop').legacy.ledger[0].amount, '100');
});

test('large migration batches use all reads before writes and match domain inventory keys', async () => {
  const source = fixture();
  source.state.data.value.items = Array.from({ length: 251 }, (_, n) => ({ id: `product-${n}`, name: `Product ${n}`, variants: ['Blue / White', ''], price: n / 100 }));
  const repo = memoryRepository();
  const original = repo.transaction;
  let batches = 0;
  repo.transaction = fn => original(tx => {
    let hasWritten = false;
    batches++;
    return fn({
      get: async (collection, id) => { assert.equal(hasWritten, false, 'Firestore cannot read after transaction writes'); return tx.get(collection, id); },
      set: async (collection, id, value) => { hasWritten = true; return tx.set(collection, id, value); }
    });
  });
  const result = await migrate(repo, source, { now, batchSize: 25 });
  assert.ok(batches > 20);
  assert.equal(result.execution.created, result.records.length);
  assert.ok(repo.values.has('inventory/product-0~Blue%20%2F%20White'));
  assert.equal(repo.values.get('inventory/product-0~Blue%20%2F%20White').onHand, null);
});

test('migrated opening balance integrates with repository and verified-payment workflow', async () => {
  const { MemoryRepository } = require('../lib/repository.cjs');
  const { executeCommand, storeBalance } = require('../lib/domain.cjs');
  const repo = new MemoryRepository();
  await migrate(repo, fixture(), { now });
  const actor = { uid: 'owner', role: 'master', active: true, storeIds: [] };
  let sequence = 0;
  const context = { now, id: () => `new-${++sequence}` };
  const payment = await repo.transaction(tx => executeCommand(tx, actor, { id: 'report-payment', type: 'payment.report', payload: { storeId: 'shop', amountCents: 2000, method: 'cash' } }, context));
  assert.equal(storeBalance(await repo.list('ledger'), 'shop'), 9000);
  await repo.transaction(tx => executeCommand(tx, actor, { id: 'verify-payment', type: 'payment.verify', payload: { paymentId: payment.id } }, context));
  assert.equal(storeBalance(await repo.list('ledger'), 'shop'), 7000);
  await migrate(repo, fixture(), { now });
  assert.equal(storeBalance(await repo.list('ledger'), 'shop'), 7000);
});
