'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryRepository } = require('../lib/repository.cjs');
const { queueNotifications, deliverOutbox, retryOutbox, createSmtpTransport } = require('../lib/notifications.cjs');
const now = 1789362000000;
const owner = { uid: 'owner', role: 'master', active: true };
function fixture(extra = {}) {
  return new MemoryRepository({
    users: [
      { id: 'owner', uid: 'owner', email: 'owner@example.test', role: 'master', active: true, storeIds: [] },
      { id: 'customer', uid: 'customer', email: 'customer@example.test', role: 'customer', active: true, storeIds: ['one'] },
      { id: 'other', uid: 'other', email: 'other@example.test', role: 'customer', active: true, storeIds: ['two'] },
      { id: 'inactive', uid: 'inactive', email: 'inactive@example.test', role: 'master', active: false }
    ],
    preferences: [
      { id: 'owner', notificationPreferences: { email: false } },
      { id: 'customer', notificationPreferences: { email: true, emailEnabledAt: now - 1000 } },
      { id: 'other', notificationPreferences: { email: true, emailEnabledAt: now - 1000 } },
      { id: 'inactive', notificationPreferences: { email: true, emailEnabledAt: now - 1000 } }
    ],
    notifications: [{ id: 'notice', storeId: 'one', userId: null, type: 'order.submitted', message: 'Order AW-1 was submitted for Shop One.', recordId: 'order-one', createdAt: now }],
    ...extra
  });
}
const ids = () => { let n = 0; return () => `generated-${++n}`; };
const transport = calls => ({ async sendMail(message) { calls.push(message); return { accepted: [message.to], rejected: [], messageId: message.messageId }; } });

 test('queue is durable, idempotent and restricted to active opted-in authorized recipients', async () => {
  const repo = fixture();
  const first = await queueNotifications(repo, { now, id: ids() });
  assert.equal(first.created, 1);
  const rows = await repo.list('outbox');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userId, 'customer');
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].to, 'customer@example.test');
  const again = await queueNotifications(repo, { now: now + 5 });
  assert.equal(again.created, 0);
  assert.equal(again.existing, 1);
  assert.equal((await repo.list('outbox'))[0].id, rows[0].id);
});

test('private notifications go only to target user and old notices are not backfilled on opt-in', async () => {
  const repo = fixture({ notifications: [
    { id: 'old', storeId: 'one', type: 'order.submitted', message: 'Old message', createdAt: now - 2000 },
    { id: 'private', storeId: 'one', userId: 'owner', type: 'account.changed', message: 'Private message', createdAt: now }
  ] });
  assert.equal((await queueNotifications(repo, { now })).created, 0);
});

test('missing sender configuration preserves queued work and performs no send', async () => {
  const repo = fixture(); await queueNotifications(repo, { now });
  const result = await deliverOutbox(repo, { now });
  assert.equal(result.configured, false);
  assert.equal((await repo.list('outbox'))[0].status, 'pending');
});

test('delivery marks provider acceptance as sent with a stable Message-ID', async () => {
  const repo = fixture(); await queueNotifications(repo, { now });
  const calls = [];
  const result = await deliverOutbox(repo, { transport: transport(calls), from: 'Alabama Wholesale <orders@example.test>', now, id: ids() });
  assert.equal(result.sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, 'customer@example.test');
  assert.equal(calls[0].text, 'Order AW-1 was submitted for Shop One.');
  assert.match(calls[0].messageId, /^<aw-[a-f0-9]+@example\.test>$/);
  const row = (await repo.list('outbox'))[0];
  assert.equal(row.status, 'sent');
  assert.equal(row.deliveryStatus, 'accepted-by-provider');
  assert.equal(row.attempts, 1);
  assert.equal((await deliverOutbox(repo, { transport: transport(calls), from: 'orders@example.test', now })).sent, 0);
  assert.equal(calls.length, 1);
});

test('atomic claims stop concurrent workers from sending the same message twice', async () => {
  const repo = fixture(); await queueNotifications(repo, { now });
  let release; const gate = new Promise(resolve => { release = resolve; });
  let started; const startedGate = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const slow = { async sendMail(message) { calls++; started(); await gate; return { accepted: [message.to] }; } };
  const one = deliverOutbox(repo, { transport: slow, from: 'orders@example.test', now, id: () => 'worker-one' });
  await startedGate;
  const two = await deliverOutbox(repo, { transport: slow, from: 'orders@example.test', now, id: () => 'worker-two' });
  assert.equal(two.sent, 0);
  release(); await one;
  assert.equal(calls, 1);
});

test('delivery rechecks opt-out, store access, current email and active status', async () => {
  for (const change of ['optout', 'store', 'email', 'inactive']) {
    const repo = fixture(); await queueNotifications(repo, { now });
    if (change === 'optout') await repo.put('preferences', 'customer', { id: 'customer', notificationPreferences: { email: false } });
    else await repo.put('users', 'customer', { ...(await repo.get('users', 'customer')), ...(change === 'store' ? { storeIds: ['two'] } : change === 'email' ? { email: 'changed@example.test' } : { active: false }) });
    const calls = [];
    const result = await deliverOutbox(repo, { transport: transport(calls), from: 'orders@example.test', now });
    assert.equal(calls.length, 0, change);
    assert.equal(result.skipped, 1, change);
    assert.equal((await repo.list('outbox'))[0].status, 'failed', change);
    assert.equal((await repo.list('outbox'))[0].retryable, false, change);
  }
});

test('a definite SMTP rejection is failed and is retried only by explicit administrator action', async () => {
  const repo = fixture(); await queueNotifications(repo, { now });
  let calls = 0;
  const rejected = { async sendMail() { calls++; throw Object.assign(new Error('SECRET credentials/server detail'), { responseCode: 550, code: 'EENVELOPE', command: 'RCPT TO' }); } };
  assert.equal((await deliverOutbox(repo, { transport: rejected, from: 'orders@example.test', now })).failed, 1);
  const row = (await repo.list('outbox'))[0];
  assert.equal(row.status, 'failed');
  assert.ok(!JSON.stringify(row).includes('SECRET'));
  await deliverOutbox(repo, { transport: rejected, from: 'orders@example.test', now });
  assert.equal(calls, 1);
  await assert.rejects(() => retryOutbox(repo, row.id, { actor: { uid: 'customer', role: 'customer' }, reason: 'Try again', now }), e => e.status === 403);
  await retryOutbox(repo, row.id, { actor: owner, reason: 'Recipient server fixed', now });
  const sent = [];
  assert.equal((await deliverOutbox(repo, { transport: transport(sent), from: 'orders@example.test', now })).sent, 1);
  assert.equal((await repo.list('outbox'))[0].attempts, 2);
});

test('ambiguous failures and expired send leases are uncertain and never retried automatically', async () => {
  const repo = fixture(); await queueNotifications(repo, { now });
  let calls = 0;
  const ambiguous = { async sendMail() { calls++; throw Object.assign(new Error('Socket lost'), { code: 'ESOCKET', command: 'DATA' }); } };
  assert.equal((await deliverOutbox(repo, { transport: ambiguous, from: 'orders@example.test', now })).uncertain, 1);
  const row = (await repo.list('outbox'))[0];
  assert.equal(row.status, 'uncertain');
  await deliverOutbox(repo, { transport: ambiguous, from: 'orders@example.test', now: now + 999999 });
  assert.equal(calls, 1);
  await assert.rejects(() => retryOutbox(repo, row.id, { actor: owner, reason: 'Try again', now }), e => e.code === 'duplicate_risk_acknowledgement_required');
  await retryOutbox(repo, row.id, { actor: owner, reason: 'Confirmed no receipt; retry requested', acknowledgeDuplicateRisk: true, now });
  await repo.put('outbox', row.id, { ...(await repo.get('outbox', row.id)), status: 'sending', claimToken: 'crashed-worker', leaseExpiresAt: now - 1 });
  const result = await deliverOutbox(repo, { transport: ambiguous, from: 'orders@example.test', now });
  assert.equal(result.uncertain, 1);
  assert.equal(calls, 1);
});

test('hung delivery times out as uncertain and a late callback cannot create a blind retry', async () => {
  const repo = fixture(); await queueNotifications(repo, { now });
  const result = await deliverOutbox(repo, { transport: { sendMail: () => new Promise(() => {}) }, from: 'orders@example.test', now, sendTimeoutMs: 10 });
  assert.equal(result.uncertain, 1);
  assert.equal((await repo.list('outbox'))[0].status, 'uncertain');
});

test('SMTP transport configuration enforces TLS without exposing credentials or opening a connection', () => {
  let captured;
  const fake = {};
  assert.equal(createSmtpTransport({ smtpUrl: 'smtp://user:secret@smtp.example.test:587', createTransport: options => { captured = options; return fake; } }), fake);
  assert.equal(captured.requireTLS, true);
  assert.equal(captured.tls.rejectUnauthorized, true);
  assert.deepEqual(captured.auth, { user: 'user', pass: 'secret' });
  assert.equal(createSmtpTransport({}), null);
  assert.throws(() => createSmtpTransport({ smtpUrl: 'https://example.test/SECRET' }), e => e.code === 'invalid_smtp_configuration' && !e.message.includes('SECRET'));
});

test('completed queue scans do not repeat recipient transactions, and interrupted scans resume', async () => {
  const repo = fixture();
  await repo.put('preferences', 'owner', { id: 'owner', notificationPreferences: { email: true, emailEnabledAt: now - 1 } });
  const original = repo.transaction.bind(repo);
  let calls = 0;
  repo.transaction = fn => { if (++calls === 2) throw new Error('simulated storage outage'); return original(fn); };
  await assert.rejects(() => queueNotifications(repo, { now }), /simulated storage outage/);
  assert.equal((await repo.list('outbox')).length, 1);
  repo.transaction = original;
  const resumed = await queueNotifications(repo, { now });
  assert.equal(resumed.created, 1);
  assert.equal((await repo.list('outbox')).length, 2);
  assert.ok((await repo.get('notifications', 'notice')).emailQueue.completedAt);
  repo.transaction = () => { throw new Error('completed scan must not open another transaction'); };
  assert.equal((await queueNotifications(repo, { now })).existing, 2);
});

test('a storage failure after SMTP acceptance leaves an uncertain lease rather than requeueing', async () => {
  const repo = fixture(); await queueNotifications(repo, { now });
  const original = repo.transaction.bind(repo);
  repo.transaction = callback => original(tx => callback({ ...tx, set: async (collection, id, value) => { if (collection === 'outbox' && value.status === 'sent') throw new Error('storage unavailable after provider accepted'); return tx.set(collection, id, value); } }));
  const calls = [];
  const result = await deliverOutbox(repo, { transport: transport(calls), from: 'orders@example.test', now });
  assert.equal(result.uncertain, 1);
  assert.equal(calls.length, 1);
  assert.equal((await repo.list('outbox'))[0].status, 'sending');
  repo.transaction = original;
  await deliverOutbox(repo, { transport: transport(calls), from: 'orders@example.test', now: now + 60001 });
  assert.equal(calls.length, 1);
  assert.equal((await repo.list('outbox'))[0].status, 'uncertain');
});
