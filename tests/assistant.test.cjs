'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProposer, validateProposal, LIMITS } = require('../lib/assistant.cjs');
const products = [
  { id: 'water', name: 'Water', variants: ['Still', 'Sparkling'], packSize: 12, stockStatus: 'in', priceCents: 150, privateCost: 'DO_NOT_SEND', image: 'data:image/png;base64,DO_NOT_SEND' },
  { id: 'gum', name: 'Gum', variants: [], packSize: null, stockStatus: 'unknown' },
  { id: 'out', name: 'Out item', variants: [], packSize: 6, stockStatus: 'out' }
];
const context = { products, identity: { uid: 'staff' }, headers: { authorization: 'Bearer verified-id-token', 'x-firebase-appcheck': 'verified-app-check', cookie: 'DO_NOT_SEND' }, config: { firebaseConfig: { projectId: 'test-project', apiKey: 'public-config-key', appId: '1:123:web:abc' } } };
const line = overrides => ({ productId: 'water', variant: 'Still', quantity: 2, unit: 'each', note: '', ...overrides });
const output = (lines = [line()], overrides = {}) => ({ lines, ambiguities: [], summary: 'Two waters', ...overrides });
const response = proposal => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(proposal) }] } }] }), { status: 200 });
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=';

test('matches Firebase GoogleAI SDK transport and sends only necessary catalog fields', async () => {
  let request;
  const propose = createProposer({ fetchImpl: async (url, options) => { request = { url, options }; return response(output()); } });
  const before = structuredClone(context);
  const result = await propose({ text: 'Two still waters' }, context);
  assert.equal(request.url, 'https://firebasevertexai.googleapis.com/v1beta/projects/test-project/models/gemini-3.8-flash:generateContent');
  assert.equal(request.options.headers.Authorization, 'Firebase verified-id-token');
  assert.equal(request.options.headers['X-Firebase-AppCheck'], 'verified-app-check');
  assert.equal(request.options.headers['X-Firebase-Appid'], '1:123:web:abc');
  assert.equal(request.options.headers['x-goog-api-key'], 'public-config-key');
  const body = JSON.parse(request.options.body);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.ok(body.generationConfig.responseSchema);
  assert.match(body.systemInstruction.parts[0].text, /untrusted/i);
  assert.ok(!request.options.body.includes('DO_NOT_SEND'));
  assert.deepEqual(result.lines, [line()]);
  assert.deepEqual(context, before);
  assert.match(result.summary, /review/i);
});

test('unknown products, wrong variants and invalid quantities never become proposed lines', () => {
  const result = validateProposal(output([
    line({ productId: 'invented' }), line({ variant: 'Invented' }), line({ quantity: -3 }), line({ quantity: 1.5 }), line({ quantity: '2' }), line({ quantity: Infinity })
  ]), products);
  assert.deepEqual(result.lines, []);
  assert.ok(result.ambiguities.length >= 6);
});

test('requires known case size and exact empty variant for products without variants', () => {
  const result = validateProposal(output([line({ productId: 'gum', variant: '', unit: 'case' }), line({ productId: 'gum', variant: 'mint' }), line({ unit: 'box' }), line({ unit: 'case' })]), products);
  assert.deepEqual(result.lines, [line({ unit: 'case' })]);
  assert.equal(result.ambiguities.length, 3);
});

test('ambiguous and duplicate lines are held for review instead of counted twice', () => {
  const result = validateProposal(output([line(), line(), line({ productId: 'out', variant: '' })], { ambiguities: ['Please clarify the gum quantity.'] }), products);
  assert.deepEqual(result.lines, []);
  assert.match(result.ambiguities.join(' '), /duplicate/i);
  assert.match(result.ambiguities.join(' '), /availability/i);
  assert.ok(result.ambiguities.includes('Please clarify the gum quantity.'));
});

test('rejects unexpected financial/action fields and does not repeat model claims of completed actions', () => {
  assert.throws(() => validateProposal(output([line({ totalCents: 500 })]), products), e => e.code === 'invalid_ai_response');
  assert.throws(() => validateProposal(output([], { action: 'charge-ledger' }), products), e => e.code === 'invalid_ai_response');
  const result = validateProposal(output([], { summary: 'I charged the ledger and emailed the customer.' }), products);
  assert.ok(!result.summary.includes('charged'));
  assert.match(result.summary, /review|clarify/i);
});

test('sends valid inline photos ahead of text and preserves raw base64', async () => {
  let body;
  const propose = createProposer({ fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return response(output()); } });
  await propose({ image: { mimeType: 'image/png', data: png }, text: 'Read this order' }, context);
  assert.deepEqual(body.contents[0].parts[0], { inlineData: { mimeType: 'image/png', data: png } });
  assert.ok(body.contents[0].parts[1].text.includes('Read this order'));
});

test('rejects unsupported, disguised, malformed or oversized images before transport', async () => {
  let calls = 0;
  const propose = createProposer({ fetchImpl: async () => { calls++; return response(output()); } });
  const inputs = [
    { mimeType: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') },
    { mimeType: 'image/jpeg', data: png },
    { mimeType: 'image/png', data: 'this is not base64' },
    { mimeType: 'image/png', data: `data:image/png;base64,${png}` },
    { mimeType: 'image/png', data: Buffer.alloc(LIMITS.imageBytes + 1).toString('base64') }
  ];
  for (const image of inputs) await assert.rejects(() => propose({ image }, context), e => [400, 413, 415].includes(e.status));
  assert.equal(calls, 0);
});

test('requires authenticated context and bounded text and ignores no client catalog overrides', async () => {
  let calls = 0;
  const propose = createProposer({ fetchImpl: async () => { calls++; return response(output()); } });
  for (const input of [{}, { text: ' ' }, { text: 'a'.repeat(LIMITS.textChars + 1) }, { text: 'hello', products: [] }]) await assert.rejects(() => propose(input, context), e => e.status === 400 || e.status === 413);
  await assert.rejects(() => propose({ text: 'hello' }, { ...context, identity: null }), e => e.status === 401);
  await assert.rejects(() => propose({ text: 'hello' }, { ...context, headers: {} }), e => e.status === 401);
  assert.equal(calls, 0);
});

test('handles provider rate limits, unavailable models and auth failures without exposing provider bodies', async () => {
  for (const [status, expected] of [[429, 'assistant_rate_limit'], [404, 'assistant_model_unavailable'], [403, 'assistant_configuration'], [500, 'assistant_unavailable']]) {
    const propose = createProposer({ fetchImpl: async () => new Response('PRIVATE_UPSTREAM_DIAGNOSTIC', { status }) });
    await assert.rejects(() => propose({ text: 'hello' }, context), e => e.code === expected && !e.message.includes('PRIVATE'));
  }
});

test('rejects safety-blocked, truncated, malformed and oversized provider responses', async () => {
  const variants = [
    { promptFeedback: { blockReason: 'SAFETY' } },
    { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: JSON.stringify(output()) }] } }] },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'not JSON' }] } }] }
  ];
  for (const raw of variants) {
    const propose = createProposer({ fetchImpl: async () => new Response(JSON.stringify(raw)) });
    await assert.rejects(() => propose({ text: 'hello' }, context), e => ['assistant_blocked', 'invalid_ai_response'].includes(e.code));
  }
  const propose = createProposer({ fetchImpl: async () => new Response('x'.repeat(LIMITS.responseBytes + 1)) });
  await assert.rejects(() => propose({ text: 'hello' }, context), e => e.code === 'invalid_ai_response');
});

test('deadline covers upstream headers and body even when transport ignores abort', async () => {
  const hangingHeaders = createProposer({ timeoutMs: 10, fetchImpl: async () => new Promise(() => {}) });
  await assert.rejects(() => hangingHeaders({ text: 'hello' }, context), e => e.code === 'assistant_timeout' && e.status === 504);
  const hangingBody = createProposer({ timeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream({ start() {} })) });
  await assert.rejects(() => hangingBody({ text: 'hello' }, context), e => e.code === 'assistant_timeout');
});

test('empty or excessively large catalog fails honestly without silent truncation', async () => {
  let calls = 0;
  const propose = createProposer({ fetchImpl: async () => { calls++; return response(output()); } });
  await assert.rejects(() => propose({ text: 'hello' }, { ...context, products: [] }), e => e.code === 'catalog_empty');
  await assert.rejects(() => propose({ text: 'hello' }, { ...context, products: Array.from({ length: LIMITS.products + 1 }, (_, n) => ({ id: `p${n}`, name: 'Product', variants: [] })) }), e => e.code === 'catalog_too_large');
  assert.equal(calls, 0);
});


test('order assistant preserves explicit Standard choices after a product gains flavors', async () => {
  const mixed = products.map(p=>p.id==='water'?{...p,standardVariantEnabled:true}:p);
  const requested=output([line({variant:''}),line({variant:'Still'})]);
  assert.deepEqual(validateProposal(requested,mixed).lines,requested.lines);
  assert.deepEqual(validateProposal(output([line({variant:''})]),products).lines,[]);
  let body;
  const propose=createProposer({fetchImpl:async(_url,options)=>{body=JSON.parse(options.body);return response(output([line({variant:''})]));}});
  const result=await propose({text:'Two Standard waters, each'},{...context,products:mixed});
  const catalog=JSON.parse(body.contents[0].parts.at(-1).text).catalog;
  assert.equal(catalog.find(p=>p.id==='water').standardVariantEnabled,true);
  assert.match(body.systemInstruction.parts[0].text,/standardVariantEnabled/);
  assert.deepEqual(result.lines,[line({variant:''})]);
});
