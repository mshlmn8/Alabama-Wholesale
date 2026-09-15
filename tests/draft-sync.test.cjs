const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { MemoryRepository } = require("../lib/repository.cjs");
const { executeCommand } = require("../lib/domain.cjs");
const modules = new Map();
function load(name) {
  if (!modules.has(name))
    modules.set(
      name,
      import(
        "data:text/javascript;base64," +
          Buffer.from(
            fs.readFileSync(path.join(__dirname, "../public/", name), "utf8"),
          ).toString("base64")
      ),
    );
  return modules.get(name);
}
const copy = (value) => JSON.parse(JSON.stringify(value));
const tick = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
function clock() {
  let now = 0,
    next = 0;
  const tasks = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      tasks.set(++next, { fn, at: now + ms });
      return next;
    },
    clearTimeout(id) {
      tasks.delete(id);
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await tick();
        const due = [...tasks]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        tasks.delete(due[0]);
        due[1].fn();
      }
      now = end;
      await tick();
    },
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
async function fixture(options = {}) {
  const [{ Workspace }, { createDraftSync }] = await Promise.all([
    load("storage.js"),
    load("draft-sync.js"),
  ]);
  const data = new Map();
  const storage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      if (storage.full) throw new Error("quota");
      data.set(k, v);
    },
  };
  const ws = new Workspace(storage, "owner");
  const repo = new MemoryRepository({
    stores: [{ id: "s1", name: "Shop", active: true, version: 1 }],
    products: [
      {
        id: "p1",
        name: "Drink",
        variants: ["Lime"],
        priceCents: 200,
        version: 1,
      },
    ],
    ...options.seed,
  });
  const timers = clock(),
    calls = [];
  let current = true,
    connected = true,
    seq = 0;
  const actual = (command) =>
    repo.transaction((tx) =>
      executeCommand(
        tx,
        { uid: "owner", role: "master", storeIds: [] },
        command,
        { now: timers.now(), id: () => `record-${++seq}` },
      ),
    );
  const setup = () =>
    createDraftSync({
      workspace: ws,
      send: async (command) => {
        calls.push(copy(command));
        return {
          result: await (options.send
            ? options.send(command, actual)
            : actual(command)),
        };
      },
      isCurrent: () => current,
      online: () => connected,
      onChange: () => {},
      timers,
      uuid: () => `command-${++seq}`,
    });
  let sync = setup();
  return {
    ws,
    repo,
    storage,
    timers,
    calls,
    actual,
    setup,
    get sync() {
      return sync;
    },
    set sync(value) {
      sync = value;
    },
    account(value) {
      current = value;
    },
    connected(value) {
      connected = value;
    },
    edit(changes = {}, id = "d1") {
      const prior = sync.get(id) ||
        ws.getDraft(id) || {
          id,
          storeId: "s1",
          version: 0,
          lines: [
            {
              id: "l1",
              productId: "p1",
              variant: "Lime",
              quantity: 1,
              unit: "each",
              note: "",
            },
          ],
          notes: "",
        };
      const result = ws.saveDraftForCloud({ ...prior, ...changes });
      sync.stage(result.draft);
      return result.draft;
    },
  };
}
test("typing is debounced and continuous edits save within two seconds", async () => {
  const f = await fixture();
  f.edit({ notes: "a" });
  await f.timers.advance(300);
  f.edit({ notes: "ab" });
  await f.timers.advance(599);
  assert.equal(f.calls.length, 0);
  await f.timers.advance(1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].payload.notes, "ab");
  assert.equal(f.sync.status("d1").cloudConfirmed, true);
  for (let i = 0; i < 5; i++) {
    f.edit({ notes: `continuous ${i}` });
    await f.timers.advance(400);
  }
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].payload.notes, "continuous 4");
  assert.equal((await f.repo.list("ledger")).length, 0);
  assert.equal((await f.repo.list("inventory")).length, 0);
});
test("edits during an in-flight save are serialized with the returned server version", async () => {
  const gate = deferred(),
    second = deferred();
  let first = true;
  const f = await fixture({
    send: async (c, actual) => {
      const result = await actual(c);
      if (first) {
        first = false;
        await gate.promise;
      } else await second.promise;
      return result;
    },
  });
  f.edit({ notes: "first" });
  const flush = f.sync.flush("d1");
  await tick();
  f.edit({ notes: "newer" });
  await f.timers.advance(1000);
  assert.equal(f.calls.length, 1);
  gate.resolve();
  await tick();
  const confirmed = await flush;
  assert.equal(confirmed.notes, "first");
  assert.equal(f.sync.get("d1").notes, "newer");
  assert.equal(f.sync.status("d1").cloudConfirmed, false);
  await f.timers.advance(600);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].payload.expectedVersion, 1);
  assert.equal((await f.repo.get("orders", "d1")).notes, "newer");
  second.resolve();
  await tick();
  assert.equal(f.sync.status("d1").cloudConfirmed, true);
});
test("an uncertain committed save retries its exact ID and body before newer edits", async () => {
  let first = true;
  const f = await fixture({
    send: async (c, actual) => {
      const result = await actual(c);
      if (first) {
        first = false;
        throw new Error("Connection lost");
      }
      return result;
    },
  });
  f.edit({ notes: "committed" });
  await f.timers.advance(600);
  f.edit({ notes: "new edit" });
  await f.timers.advance(1000);
  assert.deepEqual(f.calls[1], f.calls[0]);
  await f.timers.advance(600);
  assert.equal(f.calls.length, 3);
  assert.notEqual(f.calls[2].id, f.calls[0].id);
  assert.equal((await f.repo.get("orders", "d1")).version, 2);
});
test("quota failure can save in the cloud without claiming device persistence", async () => {
  const f = await fixture();
  f.ws.saveDraft({ id: "existing", lines: [], notes: "keep" });
  f.ws.enqueue({
    id: "financial",
    type: "payment.report",
    payload: { storeId: "s1", amountCents: 100 },
  });
  const raw = f.storage.getItem(f.ws.key);
  f.storage.full = true;
  f.edit({ notes: "cloud only" });
  await f.sync.flush("d1");
  assert.equal((await f.repo.get("orders", "d1")).notes, "cloud only");
  assert.equal(f.sync.status("d1").cloudConfirmed, true);
  assert.equal(f.sync.status("d1").localPersisted, false);
  assert.equal(f.storage.getItem(f.ws.key), raw);
});
test("offline edits resume automatically without replaying unrelated financial commands", async () => {
  const f = await fixture();
  f.ws.enqueue({
    id: "financial",
    type: "payment.report",
    payload: { storeId: "s1", amountCents: 100 },
  });
  f.connected(false);
  f.edit({ notes: "offline" });
  await f.timers.advance(10000);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sync.status("d1").phase, "offline");
  f.connected(true);
  f.sync.resume();
  await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.sync.status("d1").cloudConfirmed, true);
  assert.equal(f.ws.pending().length, 1);
});
test("newer different cloud content blocks stale local drafts until explicit resolution", async () => {
  const f = await fixture();
  f.edit({ notes: "stale" });
  const remote = await f.actual({
    id: "elsewhere",
    type: "order.save",
    payload: {
      id: "d1",
      storeId: "s1",
      lines: [],
      notes: "other device",
      expectedVersion: 0,
    },
  });
  f.sync.seed([remote]);
  await f.timers.advance(5000);
  assert.equal(f.sync.status("d1").phase, "conflict");
  assert.equal(f.calls.length, 0);
  f.edit({ notes: "still stale" });
  await f.timers.advance(5000);
  assert.equal(f.calls.length, 0);
});
test("malicious financial recovery records are never sent", async () => {
  const f = await fixture();
  f.edit();
  const data = f.ws.read();
  data.draftAutosave = {
    d1: {
      command: {
        id: "attack",
        type: "payment.verify",
        payload: { id: "d1", paymentId: "p" },
      },
      sentDraft: f.ws.getDraft("d1"),
    },
  };
  f.storage.setItem(f.ws.key, JSON.stringify(data));
  f.sync.dispose();
  f.sync = f.setup();
  f.sync.seed([]);
  await f.timers.advance(1000);
  assert.equal(
    f.calls.some((c) => c.type !== "order.save"),
    false,
  );
  assert.equal(f.sync.status("d1").phase, "blocked");
  assert.equal(f.calls.length, 0);
});
test("reloading an uncertain save preserves the old command before sending newer content", async () => {
  let fail = true;
  const f = await fixture({
    send: async (c, actual) => {
      const result = await actual(c);
      if (fail) throw new Error("response lost");
      return result;
    },
  });
  f.edit({ notes: "old request" });
  await f.timers.advance(600);
  f.edit({ notes: "new local content" });
  const old = copy(f.calls[0]);
  assert.deepEqual(f.ws.autosaveRecovery().d1.command, old);
  f.sync.dispose();
  f.sync = f.setup();
  fail = false;
  f.sync.seed([]);
  await f.timers.advance(600);
  assert.deepEqual(f.calls[1], old);
  await f.timers.advance(600);
  assert.equal(f.calls[2].payload.notes, "new local content");
  assert.equal(f.calls[2].payload.expectedVersion, 1);
  assert.equal(f.sync.status("d1").cloudConfirmed, true);
});
test("a matching remote draft repairs a lost local ack without another server write", async () => {
  const f = await fixture();
  f.edit({ notes: "matches cloud" });
  const remote = await f.actual({
    id: "other-request",
    type: "order.save",
    payload: {
      id: "d1",
      storeId: "s1",
      lines: f.ws.getDraft("d1").lines,
      notes: "matches cloud",
      expectedVersion: 0,
    },
  });
  f.sync.dispose();
  f.sync = f.setup();
  f.sync.seed([remote]);
  await f.timers.advance(2000);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sync.status("d1").cloudConfirmed, true);
  assert.equal(f.sync.get("d1").version, 1);
});
test("an account switch ignores a late response and leaves recovery scoped to the old account", async () => {
  const gate = deferred();
  const f = await fixture({
    send: async (c, actual) => {
      const result = await actual(c);
      await gate.promise;
      return result;
    },
  });
  f.edit({ notes: "old account" });
  const waiting = assert.rejects(
    f.sync.flush("d1"),
    (e) => e.code === "SESSION_CHANGED",
  );
  await tick();
  const raw = f.storage.getItem(f.ws.key);
  f.account(false);
  f.sync.dispose();
  gate.resolve();
  await tick();
  await waiting;
  assert.equal(f.storage.getItem(f.ws.key), raw);
  assert.equal(f.ws.getDraft("d1").syncState, "local");
  assert.equal(f.sync.hasUnsaved(), false);
  assert.ok(f.ws.autosaveRecovery().d1);
});
test("a validation rejection waits for a corrected edit and then uses a new command ID", async () => {
  const f = await fixture();
  f.edit({
    lines: [
      { id: "l1", productId: "p1", variant: "bad", quantity: 1, unit: "each" },
    ],
  });
  await f.timers.advance(600);
  assert.equal(f.sync.status("d1").phase, "error");
  await f.timers.advance(100000);
  assert.equal(f.calls.length, 1);
  f.edit({
    lines: [
      { id: "l1", productId: "p1", variant: "Lime", quantity: 2, unit: "each" },
    ],
  });
  await f.timers.advance(600);
  assert.equal(f.calls.length, 2);
  assert.notEqual(f.calls[0].id, f.calls[1].id);
  assert.equal(f.sync.status("d1").cloudConfirmed, true);
});
test("automatic transient retries stop after five attempts and retain the exact recovery command", async () => {
  let fail = true;
  const f = await fixture({
    send: async (c, actual) => {
      if (fail) throw Object.assign(new Error("unavailable"), { status: 503 });
      return actual(c);
    },
  });
  f.edit();
  await f.timers.advance(120000);
  assert.equal(f.calls.length, 5);
  assert.ok(
    f.calls.every((c) => JSON.stringify(c) === JSON.stringify(f.calls[0])),
  );
  assert.equal(f.sync.status("d1").phase, "error");
  f.sync.dispose();
  f.sync = f.setup();
  f.sync.seed([]);
  await f.timers.advance(120000);
  assert.equal(f.calls.length, 5);
  fail = false;
  await f.sync.retry("d1");
  assert.equal(f.calls.length, 6);
  assert.equal(f.sync.status("d1").cloudConfirmed, true);
});
test("same-draft manual save or submit blocks autosave until the queued action is resolved", async () => {
  const f = await fixture();
  f.ws.enqueue({
    id: "manual",
    type: "order.save",
    payload: { id: "d1", storeId: "s1", lines: [] },
  });
  f.edit();
  await f.timers.advance(2000);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sync.status("d1").phase, "blocked");
  f.ws.acknowledge("manual");
  f.sync.resume();
  await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.sync.status("d1").cloudConfirmed, true);
});
test("new legacy drafts require explicit review and existing legacy saves preserve the flag", async () => {
  const f = await fixture();
  f.edit({ legacy: { requiresReview: true } });
  await f.timers.advance(2000);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sync.status("d1").phase, "blocked");
  f.edit({ acknowledgeLegacyReview: true });
  await f.sync.flush("d1");
  assert.equal(f.calls[0].payload.acknowledgeLegacyReview, true);
  const remote = {
    id: "legacy",
    storeId: "s1",
    status: "draft",
    version: 2,
    lines: [],
    notes: "",
    createdBy: "owner",
    legacy: { requiresReview: true },
  };
  await f.repo.transaction((tx) => tx.set("orders", "legacy", remote));
  f.ws.mergeRemoteDrafts([remote]);
  f.sync.seed([remote]);
  f.edit({ notes: "legacy edit" }, "legacy");
  await f.sync.flush("legacy");
  assert.equal(f.calls[1].payload.acknowledgeLegacyReview, undefined);
  assert.equal(
    (await f.repo.get("orders", "legacy")).legacy.requiresReview,
    true,
  );
});
test("an incomplete success response never marks the draft as cloud saved", async () => {
  let malformed = true;
  const f = await fixture({
    send: async (c, actual) => {
      const result = await actual(c);
      return malformed ? { id: result.id, version: result.version } : result;
    },
  });
  f.edit();
  await f.timers.advance(600);
  assert.equal(f.sync.status("d1").cloudConfirmed, false);
  malformed = false;
  await f.timers.advance(1000);
  assert.deepEqual(f.calls[0], f.calls[1]);
  assert.equal(f.sync.status("d1").cloudConfirmed, true);
  assert.equal((await f.repo.get("orders", "d1")).version, 1);
});
test("cloud confirmation survives a browser read failure during local acknowledgment", async () => {
  const gate = deferred();
  const f = await fixture({
    send: async (c, actual) => {
      const result = await actual(c);
      await gate.promise;
      return result;
    },
  });
  f.edit({ notes: "confirmed" });
  const saving = f.sync.flush("d1");
  await tick();
  f.storage.getItem = () => {
    throw new Error("read unavailable");
  };
  gate.resolve();
  const remote = await saving;
  await tick();
  assert.equal(remote.version, 1);
  assert.equal(f.sync.status("d1").cloudConfirmed, true);
  assert.equal(f.sync.status("d1").localPersisted, false);
  assert.equal(f.sync.get("d1").version, 1);
});
test("global autosave concurrency is bounded while separate drafts make progress", async () => {
  const gates = [];
  let active = 0,
    max = 0;
  const f = await fixture({
    send: async (c, actual) => {
      active++;
      max = Math.max(max, active);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      active--;
      return actual(c);
    },
  });
  for (let i = 0; i < 8; i++) f.edit({ notes: "parallel" }, `d${i}`);
  await f.timers.advance(600);
  assert.equal(f.calls.length, 2);
  for (let i = 0; i < 8; i++) {
    gates[i].resolve();
    await tick();
  }
  assert.equal(max, 2);
  assert.equal(f.calls.length, 8);
  assert.equal(f.sync.hasUnsaved(), false);
});
test("a durable edit in another tab wins over an older debounced snapshot", async () => {
  const f = await fixture();
  f.edit({ notes: "tab A" });
  const { Workspace } = await load("storage.js");
  const other = new Workspace(f.storage, "owner");
  other.saveDraftForCloud({ ...other.getDraft("d1"), notes: "tab B" });
  await f.timers.advance(600);
  assert.equal(f.calls[0].payload.notes, "tab B");
  assert.equal((await f.repo.get("orders", "d1")).notes, "tab B");
});
test("paused drafts stay paused across reconnect but an explicit flush can complete", async () => {
  const f = await fixture();
  f.edit();
  f.sync.pause("d1");
  f.sync.resume();
  await f.timers.advance(3000);
  assert.equal(f.calls.length, 0);
  await f.sync.flush("d1");
  assert.equal(f.sync.status("d1").cloudConfirmed, true);
  f.sync.forget("d1");
  assert.equal(f.sync.hasUnsaved(), false);
});
test("a changed durable base prevents a quota-memory draft from overwriting another tab", async () => {
  const f = await fixture();
  f.edit({ notes: "base" });
  f.sync.pause("d1");
  f.storage.full = true;
  f.edit({ notes: "volatile edit" });
  const { Workspace } = await load("storage.js");
  f.storage.full = false;
  const other = new Workspace(f.storage, "owner");
  other.saveDraftForCloud({ ...other.getDraft("d1"), notes: "other tab" });
  f.sync.unpause("d1");
  await f.timers.advance(2000);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sync.status("d1").phase, "conflict");
  assert.equal(other.getDraft("d1").notes, "other tab");
});
test("status and flush cannot mistake another tab’s new content for the old cloud confirmation", async () => {
  const f = await fixture();
  f.edit({ notes: "saved A" });
  await f.sync.flush("d1");
  const { Workspace } = await load("storage.js");
  const other = new Workspace(f.storage, "owner");
  other.saveDraftForCloud({ ...other.getDraft("d1"), notes: "new B" });
  assert.equal(f.sync.status("d1").cloudConfirmed, false);
  assert.equal(f.sync.hasUnsaved(), true);
  const result = await f.sync.flush("d1");
  assert.equal(result.notes, "new B");
  assert.equal((await f.repo.get("orders", "d1")).notes, "new B");
});
test("a pending save is retried before a newer local tab edit is sent", async () => {
  let fail = true;
  const f = await fixture({
    send: async (c, actual) => {
      const result = await actual(c);
      if (fail) {
        fail = false;
        throw new Error("lost response");
      }
      return result;
    },
  });
  f.edit({ notes: "A" });
  await f.timers.advance(600);
  const { Workspace } = await load("storage.js");
  const other = new Workspace(f.storage, "owner");
  other.saveDraftForCloud({ ...other.getDraft("d1"), notes: "B" });
  await f.timers.advance(1000);
  await f.timers.advance(600);
  assert.deepEqual(f.calls[0], f.calls[1]);
  assert.equal(f.calls[2].payload.notes, "B");
  assert.equal(f.calls[2].payload.expectedVersion, 1);
});
test("cross-draft recovery IDs and mismatched recovery bodies cannot be replayed", async () => {
  for (const malformed of [
    {
      command: {
        id: "wrong-id",
        type: "order.save",
        payload: {
          id: "someone-else",
          storeId: "s1",
          lines: [],
          notes: "",
          expectedVersion: 0,
        },
      },
      sentDraft: { id: "d1", storeId: "s1", lines: [], version: 0 },
    },
    {
      command: {
        id: "different-body",
        type: "order.save",
        payload: {
          id: "d1",
          storeId: "s1",
          lines: [],
          notes: "changed by record",
          expectedVersion: 0,
        },
      },
      sentDraft: {
        id: "d1",
        storeId: "s1",
        lines: [],
        notes: "original",
        version: 0,
      },
    },
    {
      command: {
        id: "",
        type: "order.save",
        payload: {
          id: "d1",
          storeId: "s1",
          lines: [],
          notes: "",
          expectedVersion: 0,
        },
      },
      sentDraft: { id: "d1", storeId: "s1", lines: [], version: 0 },
    },
  ]) {
    const f = await fixture();
    f.edit();
    const data = f.ws.read();
    data.draftAutosave = { d1: malformed };
    f.storage.setItem(f.ws.key, JSON.stringify(data));
    f.sync.dispose();
    f.sync = f.setup();
    f.sync.seed([]);
    await f.timers.advance(10000);
    assert.equal(f.calls.length, 0);
    assert.equal(f.sync.status("d1").phase, "blocked");
  }
});
test("a stale recovery receipt cannot overwrite a cloud draft modified afterwards", async () => {
  let fail = true;
  const f = await fixture({
    send: async (c, actual) => {
      const result = await actual(c);
      if (fail) throw new Error("lost response");
      return result;
    },
  });
  f.edit({ notes: "original request" });
  await f.timers.advance(600);
  const remote = await f.actual({
    id: "newer-device",
    type: "order.save",
    payload: {
      ...f.calls[0].payload,
      notes: "newer cloud",
      expectedVersion: 1,
    },
  });
  f.edit({ notes: "newer local" });
  f.sync.dispose();
  f.sync = f.setup();
  fail = false;
  f.sync.seed([remote]);
  await f.timers.advance(5000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.sync.status("d1").phase, "conflict");
  assert.equal((await f.repo.get("orders", "d1")).notes, "newer cloud");
});
test("forgetting or disposing a draft cancels queued timers and late account responses", async () => {
  const f = await fixture();
  f.edit();
  f.sync.forget("d1");
  await f.timers.advance(5000);
  assert.equal(f.calls.length, 0);
  const gate = deferred();
  const g = await fixture({
    send: async (c, actual) => {
      const result = await actual(c);
      await gate.promise;
      return result;
    },
  });
  g.edit();
  const wait = assert.rejects(
    g.sync.flush("d1"),
    (e) => e.code === "SESSION_CHANGED",
  );
  await tick();
  g.account(false);
  gate.resolve();
  await wait;
  assert.equal(g.ws.getDraft("d1").syncState, "local");
});
test("a queued flush resolves when the user returns to content already confirmed online", async () => {
  const gates = [];
  const f = await fixture({
    send: async (c, actual) => {
      if (c.payload.id !== "d1") {
        const gate = deferred();
        gates.push(gate);
        await gate.promise;
      }
      return actual(c);
    },
  });
  f.edit({ notes: "confirmed" });
  await f.sync.flush("d1");
  f.edit({}, "d2");
  f.edit({}, "d3");
  await f.timers.advance(600);
  f.edit({ notes: "temporary edit" });
  const waiting = f.sync.flush("d1");
  f.edit({ notes: "confirmed" });
  assert.equal((await waiting).notes, "confirmed");
  assert.equal(f.calls.filter((c) => c.payload.id === "d1").length, 1);
  gates.forEach((gate) => gate.resolve());
  await tick();
});
test("observer failures cannot turn cloud success into a failed or repeated save", async () => {
  const f = await fixture();
  f.sync.dispose();
  const { createDraftSync } = await load("draft-sync.js");
  f.sync = createDraftSync({
    workspace: f.ws,
    send: async (command) => {
      f.calls.push(copy(command));
      return { result: await f.actual(command) };
    },
    online: () => true,
    isCurrent: () => true,
    onChange: () => {
      throw new Error("UI storage read failed");
    },
    timers: f.timers,
    uuid: () => "observer-command",
  });
  f.edit({ notes: "confirmed despite view error" });
  const remote = await f.sync.flush("d1");
  assert.equal(remote.version, 1);
  assert.equal(f.sync.status("d1").cloudConfirmed, true);
  await f.timers.advance(100000);
  assert.equal(f.calls.length, 1);
});
test("response content, store, status and version must all confirm the sent draft", async () => {
  for (const corrupt of [
    (remote) => ({ ...remote, storeId: "other-store" }),
    (remote) => ({ ...remote, status: "submitted" }),
    (remote) => ({ ...remote, version: remote.version + 1 }),
    (remote) => ({ ...remote, notes: "different draft" }),
    (remote) => ({ ...remote, lines: [] }),
  ]) {
    const f = await fixture({
      send: async (c, actual) => corrupt(await actual(c)),
    });
    f.edit({ notes: "requested" });
    await f.timers.advance(600);
    assert.equal(f.sync.status("d1").cloudConfirmed, false);
    assert.equal(f.ws.getDraft("d1").syncState, "local");
    assert.equal(f.ws.autosaveRecovery().d1.command.id, f.calls[0].id);
    f.sync.dispose();
  }
});

test("known validation rejections and conflicts stay paused after reload", async () => {
  for (const failure of [
    { status: 400, code: "INVALID_VARIANT" },
    { status: 409, code: "VERSION_CONFLICT" },
  ]) {
    const f = await fixture({
      send: async () => {
        throw Object.assign(new Error("Needs review"), failure);
      },
    });
    f.edit();
    await f.timers.advance(600);
    assert.equal(f.calls.length, 1);
    f.sync.dispose();
    f.sync = f.setup();
    f.sync.seed([]);
    await f.timers.advance(10000);
    assert.equal(f.calls.length, 1);
    assert.equal(
      f.sync.status("d1").phase,
      failure.status === 409 ? "conflict" : "error",
    );
  }
});

test("an explicit flush can finish its stable retry while background saves are paused", async () => {
  let first = true;
  const f = await fixture({
    send: async (command, actual) => {
      const result = await actual(command);
      if (first) {
        first = false;
        throw new Error("uncertain response");
      }
      return result;
    },
  });
  f.edit();
  f.sync.pause("d1");
  const waiting = f.sync.flush("d1");
  await tick();
  await f.timers.advance(1000);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0], f.calls[1]);
  assert.equal((await waiting).version, 1);
});
test("forgetting an in-flight draft releases capacity for other drafts", async () => {
  const gates = [];
  const f = await fixture({
    send: async (command, actual) => {
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      return actual(command);
    },
  });
  f.edit({}, "d1");
  f.edit({}, "d2");
  f.edit({}, "d3");
  await f.timers.advance(600);
  assert.equal(f.calls.length, 2);
  f.sync.forget("d1");
  gates[0].resolve();
  await tick();
  assert.equal(f.calls.length, 3);
  gates[1].resolve();
  gates[2].resolve();
  await tick();
  assert.equal(f.sync.status("d3").cloudConfirmed, true);
});

test("unchanged cloud refreshes do not downgrade an existing durable empty draft under quota", async () => {
  const f = await fixture();
  const remote = await f.actual({
    id: "seed-empty",
    type: "order.save",
    payload: {
      id: "d1",
      storeId: "s1",
      lines: [],
      notes: "",
      expectedVersion: 0,
    },
  });
  f.ws.mergeRemoteDrafts([remote]);
  const before = f.storage.getItem(f.ws.key);
  f.storage.full = true;
  f.sync.seed([remote]);
  f.sync.seed([remote]);
  await f.timers.advance(2000);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sync.status("d1").cloudConfirmed, true);
  assert.equal(f.sync.status("d1").localPersisted, true);
  assert.equal(f.ws.storageStatus().warning, null);
  assert.equal(f.storage.getItem(f.ws.key), before);
});

test("autosave recovery stays small without deleting original draft metadata or changing an uncertain request", async () => {
  let first = true;
  const f = await fixture({
    send: async (command, actual) => {
      const result = await actual(command);
      if (first) {
        first = false;
        throw new Error("response lost");
      }
      return result;
    },
  });
  const originalText = "archived-original-".repeat(20000);
  f.edit({
    lines: [],
    notes: "small visible draft",
    legacy: { requiresReview: false, rawLines: [originalText] },
  });
  await f.timers.advance(600);
  const recovery = f.ws.autosaveRecovery().d1;
  assert.ok(
    JSON.stringify(recovery).length < 3000,
    "The recovery record must not duplicate large retained metadata.",
  );
  assert.deepEqual(recovery.command, f.calls[0]);
  assert.equal(f.ws.exportBackup().drafts[0].legacy.rawLines[0], originalText);
  f.edit({ notes: "newer edit" });
  f.sync.dispose();
  f.sync = f.setup();
  f.sync.seed([]);
  await f.timers.advance(1200);
  assert.deepEqual(f.calls[0], f.calls[1]);
  assert.equal(f.calls[2].payload.expectedVersion, 1);
  assert.equal((await f.repo.get("orders", "d1")).notes, "newer edit");
  assert.equal(f.ws.exportBackup().drafts[0].legacy.rawLines[0], originalText);
});
test("empty and unfinished drafts save automatically and restore in a fresh device workspace", async () => {
  const f = await fixture();
  f.edit({ lines: [], notes: "" }, "empty");
  f.edit({ lines: [], notes: "Finish this order later" }, "unfinished");
  await f.timers.advance(600);
  const remote = await f.repo.list("orders");
  assert.equal(remote.length, 2);
  assert.ok(remote.every((draft) => draft.status === "draft"));
  assert.equal((await f.repo.list("ledger")).length, 0);
  const { Workspace } = await load("storage.js"),
    { createDraftSync } = await load("draft-sync.js");
  const data = new Map();
  const second = new Workspace(
    {
      getItem: (key) => data.get(key) || null,
      setItem: (key, value) => data.set(key, value),
    },
    "owner",
  );
  second.mergeRemoteDrafts(remote);
  let writes = 0;
  const sync = createDraftSync({
    workspace: second,
    send: async () => {
      writes++;
    },
    online: () => true,
    onChange: () => {},
  });
  sync.seed(remote);
  assert.equal(second.listDrafts().length, 2);
  assert.equal(second.getDraft("empty").lines.length, 0);
  assert.equal(second.getDraft("unfinished").notes, "Finish this order later");
  assert.equal(sync.status("empty").cloudConfirmed, true);
  assert.equal(sync.status("unfinished").cloudConfirmed, true);
  assert.equal(writes, 0);
  sync.dispose();
});
