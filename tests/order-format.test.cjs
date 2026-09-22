const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const file = path.join(__dirname, '../public/order-format.mjs');
async function formatter() {
  assert.ok(fs.existsSync(file), 'Shared order formatter is available');
  const module = await import(pathToFileURL(file).href);
  assert.equal(typeof module.formatOrder, 'function');
  return module.formatOrder;
}
const preferred = ['Tobacco', 'Novelties', 'Merchandise', 'Candy', 'Groceries', 'Motor oil', 'Drinks'];
const line = (productId, overrides = {}) => ({ productId, name: productId, variant: '', quantity: 2, unit: 'each', note: '', ...overrides });
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}

test('all seven categories follow the requested order without prices or category headings in the body', async () => {
  const formatOrder = await formatter();
  const order = {
    id: 'o1', storeName: 'Downtown Store', invoiceNumber: 'AW-2026-000001', totalCents: 987654,
    lines: preferred.map((category, index) => line('Product ' + index, { categoryNames: ['  ' + category.toUpperCase() + '  '], unitPriceCents: 12345, lineTotalCents: 24690 })).reverse(),
  };
  const result = formatOrder(order);
  assert.deepEqual(result.groups.map(group => group.category), preferred);
  assert.equal(result.storeName, 'Downtown Store');
  assert.equal(result.reference, 'AW-2026-000001');
  assert.equal(result.subject, 'Downtown Store — AW-2026-000001');
  assert.equal(result.text, 'Downtown Store\nAW-2026-000001\n\n' + preferred.map((_category, index) => '• Product ' + index + ' (2)').join('\n\n'));
  assert.equal((result.html.match(/<ul>/g) || []).length, 7);
  assert.match(result.html, /^<h1>Downtown Store<\/h1>\n<p>AW-2026-000001<\/p>/);
  for (const category of preferred) assert.ok(!result.html.includes(category), 'Category names do not become body headings');
  assert.doesNotMatch(result.text + result.html, /\$|12345|24690|987654/);
});

test('older lines inherit preferred ancestor categories while traversal handles missing parents and cycles', async () => {
  const formatOrder = await formatter();
  const categories = [
    { id: 't', name: 'Tobacco' }, { id: 'cigars', name: 'Cigars', parentId: 't' },
    { id: 'candies', name: 'Candy' }, { id: 'gum', name: 'Gum', parentId: 'candies' },
    { id: 'a', name: 'Accessories', parentId: 'b' }, { id: 'b', name: 'Bags', parentId: 'a' },
    { id: 'orphan', name: 'Other', parentId: 'absent' },
  ];
  const products = [
    { id: 'p1', name: 'Cigar', categoryIds: ['cigars'] },
    { id: 'p2', name: 'Gum', categoryIds: ['gum'] },
    { id: 'p3', name: 'Bag', categoryIds: ['b'] },
    { id: 'p4', name: 'Other', categoryIds: ['orphan'] },
    { id: 'p5', name: 'Unknown', categoryIds: ['missing'] },
  ];
  const result = formatOrder({ id: 'old', lines: products.map(product => line(product.id, { name: undefined })) }, { products, categories });
  assert.deepEqual(result.groups.map(group => group.category), ['Tobacco', 'Candy', 'Accessories', 'Other', '']);
  assert.equal(result.groups[0].items[0].text, 'Cigar (2)');
  assert.equal(result.groups[1].items[0].text, 'Gum (2)');
});

test('a product assigned to several categories uses the first preferred category, independent of input order', async () => {
  const formatOrder = await formatter();
  const products = [{ id: 'live', name: 'Live', categoryIds: ['drinks', 'candy', 'tobacco'] }];
  const categories = preferred.map((name, index) => ({ id: ['tobacco', 'n', 'm', 'candy', 'g', 'oil', 'drinks'][index], name }));
  const result = formatOrder({ lines: [
    line('snapshot', { categoryNames: ['Other', 'Drinks', 'Candy', 'Tobacco'] }),
    line('live'),
  ] }, { products, categories });
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].category, 'Tobacco');
  assert.deepEqual(result.groups[0].items.map(item => item.productId), ['snapshot', 'live']);
});

test('products keep first appearance within a category while unknown categories sort last with uncategorized final', async () => {
  const formatOrder = await formatter();
  const result = formatOrder({ lines: [
    line('z-first', { name: 'Zulu', categoryNames: ['Candy'] }),
    line('empty', { categoryNames: [] }),
    line('unknown-z', { categoryNames: ['Zebra'] }),
    line('a-second', { name: 'Alpha', categoryNames: ['Candy'] }),
    line('unknown-a', { categoryNames: ['Accessories'] }),
    line('drinks', { categoryNames: ['Drinks'] }),
  ] });
  assert.deepEqual(result.groups.map(group => group.category), ['Candy', 'Drinks', 'Accessories', 'Zebra', '']);
  assert.deepEqual(result.groups[0].items.map(item => item.text), ['Zulu (2)', 'Alpha (2)']);
});

test('saved store, product names and category snapshots remain unchanged after catalog edits, including an empty snapshot', async () => {
  const formatOrder = await formatter();
  const order = {
    id: 'saved', storeSnapshot: { name: 'Original Store' }, storeName: 'Later Store', invoiceNumber: 'INV/42',
    lines: [line('p', { name: 'Original Product', categoryNames: ['Tobacco', 'Cigars'] }), line('u', { name: 'No category at submission', categoryNames: [] })],
  };
  const products = [{ id: 'p', name: 'New Product', categoryIds: ['drinks'] }, { id: 'u', name: 'New U', categoryIds: ['candy'] }];
  const categories = [{ id: 'drinks', name: 'Drinks' }, { id: 'candy', name: 'Candy' }];
  const before = formatOrder(order, { store: { name: 'Current Store' }, products, categories });
  products[0].name = 'Renamed Again'; products[0].categoryIds = ['candy']; categories[1].name = 'Groceries';
  assert.deepEqual(formatOrder(order, { store: { name: 'Other Current Store' }, products, categories }), before);
  assert.equal(before.storeName, 'Original Store');
  assert.deepEqual(before.groups.map(group => group.category), ['Tobacco', '']);
  assert.equal(before.groups[0].items[0].text, 'Original Product (2)');
});

test('renamed saved products with the same product ID remain distinct bullets', async () => {
  const formatOrder = await formatter();
  const result = formatOrder({ lines: [
    line('p', { name: 'Original Name', variant: 'Grape', categoryNames: ['Drinks'] }),
    line('p', { name: 'Revised Name', variant: 'Apple', categoryNames: ['Drinks'] }),
    line('p', { name: 'Original Name', variant: 'Apple', categoryNames: ['Drinks'] }),
  ] });
  assert.deepEqual(result.groups[0].items, [
    { productId: 'p', text: 'Original Name: Apple (2), Grape (2)' },
    { productId: 'p', text: 'Revised Name: Apple (2)' },
  ]);
});

test('legacy productName and itemId retain saved naming and resolve current category fallback', async () => {
  const formatOrder = await formatter();
  const result = formatOrder({ lines: [
    { itemId: 'legacy-id', productName: 'Original legacy name', variant: 'Grape', quantity: 4 },
    { productId: 'canonical-id', itemId: 'wrong-id', name: 'Canonical snapshot', productName: 'Older alias', quantity: 2 },
    { itemId: 'unknown-id', quantity: 3 },
  ] }, { products: [
    { id: 'legacy-id', name: 'Renamed catalog product', categoryIds: ['c'] },
    { id: 'canonical-id', name: 'Current catalog name', categoryIds: ['c'] },
  ], categories: [{ id: 'c', name: 'Candy' }] });
  assert.deepEqual(result.groups, [
    { category: 'Candy', items: [
      { productId: 'legacy-id', text: 'Original legacy name: Grape (4)' },
      { productId: 'canonical-id', text: 'Canonical snapshot (2)' },
    ] },
    { category: '', items: [{ productId: 'unknown-id', text: 'unknown-id (3)' }] },
  ]);
});

test('flavors sort alphabetically with numeric/base English comparison and stable equal-name ties', async () => {
  const formatOrder = await formatter();
  const result = formatOrder({ lines: [
    line('Drink', { variant: 'Flavor 10', quantity: 10 }),
    line('Drink', { variant: 'apple', quantity: 1 }),
    line('Drink', { variant: 'Flavor 2', quantity: 2 }),
    line('Drink', { variant: 'Apple', quantity: 3 }),
    line('Drink', { variant: 'Ápple', quantity: 4 }),
  ] });
  assert.equal(result.groups[0].items[0].text, 'Drink: apple (1), Apple (3), Ápple (4), Flavor 2 (2), Flavor 10 (10)');
});

test('Standard is shown only beside named flavors while duplicate plain quantities remain separate', async () => {
  const formatOrder = await formatter();
  const result = formatOrder({ lines: [
    line('Plain', { quantity: 2 }),
    line('Mixed', { variant: '', quantity: 3 }),
    line('Mixed', { variant: 'Grape', quantity: 4 }),
    line('Repeated plain', { quantity: 5 }),
    line('Repeated plain', { quantity: 6 }),
  ] });
  assert.deepEqual(result.groups[0].items.map(item => item.text), ['Plain (2)', 'Mixed: Grape (4), Standard (3)', 'Repeated plain (5), (6)']);
});

test('duplicate flavors keep each quantity, line note and original case interpretation', async () => {
  const formatOrder = await formatter();
  const result = formatOrder({ id: 'notes', notes: 'Leave at rear door\nCall upon arrival', lines: [
    line('Juice', { variant: 'Peach', quantity: 2, unit: 'case', note: 'Keep sealed' }),
    line('Juice', { variant: 'Peach', quantity: 3, unit: 'each', note: 'Top shelf\nKeep cool' }),
    line('Juice', { variant: 'Peach', quantity: 1, unit: 'case', note: 'Separate order' }),
  ] });
  assert.equal(result.groups[0].items[0].text, 'Juice: Peach (2 cases) — Keep sealed, Peach (3) — Top shelf\nKeep cool, Peach (1 case) — Separate order');
  assert.match(result.text, /Order notes: Leave at rear door\nCall upon arrival$/);
  assert.match(result.html, /Top shelf<br>Keep cool/);
  assert.match(result.html, /Leave at rear door<br>Call upon arrival/);
});

test('HTML escapes every saved and catalog string while the plain text keeps the original content', async () => {
  const formatOrder = await formatter();
  const order = { id: 'x', storeName: '<img src=x onerror="alert(1)"> & Shop', invoiceNumber: '<script>bad()</script>', notes: '<iframe src="bad">\n& notes', lines: [
    line('p', { name: '<svg onload="bad()">', variant: 'A & <b>B</b>', note: '"quote" & <script>note</script>', categoryNames: ['<img>'] }),
  ] };
  const result = formatOrder(order);
  assert.ok(result.text.includes(order.storeName));
  assert.ok(result.text.includes(order.lines[0].note));
  assert.doesNotMatch(result.html, /<(?:script|img|svg|iframe|b)(?:\s|>)/i);
  assert.match(result.html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; Shop/);
  assert.match(result.html, /&lt;script&gt;note&lt;\/script&gt;/);
  assert.match(result.html, /&lt;iframe src=&quot;bad&quot;&gt;<br>&amp; notes/);
});

test('formatting never mutates frozen inputs and retains every line of an order above 1100 lines', async () => {
  const formatOrder = await formatter();
  const order = freeze({ id: 'large-order-id', storeId: 's', lines: Array.from({ length: 1201 }, (_, index) => line('p' + index, { name: 'Product ' + index, categoryNames: ['Candy'], note: index === 1200 ? 'Final preserved note' : '' })) });
  const products = freeze([{ id: 'p0', name: 'Changed name', categoryIds: ['other'] }]);
  const categories = freeze([{ id: 'other', name: 'Other' }]);
  const result = formatOrder(order, { store: freeze({ name: 'Store' }), products, categories });
  assert.equal(result.reference, 'Order large-order-id');
  assert.equal(result.groups[0].items.length, 1201);
  assert.equal((result.text.match(/^• /gm) || []).length, 1201);
  assert.equal((result.html.match(/<li>/g) || []).length, 1201);
  assert.ok(result.text.includes('Product 1200 (2) — Final preserved note'));
  assert.equal(order.lines[0].name, 'Product 0');
});

test('an empty draft retains a stable store heading and full reference', async () => {
  const formatOrder = await formatter();
  assert.deepEqual(formatOrder({ id: 'draft-123', lines: [] }, { store: { name: 'New Store' } }), {
    storeName: 'New Store', reference: 'Order draft-123', subject: 'New Store — Order draft-123', groups: [],
    text: 'New Store\nOrder draft-123', html: '<h1>New Store</h1>\n<p>Order draft-123</p>',
  });
});
