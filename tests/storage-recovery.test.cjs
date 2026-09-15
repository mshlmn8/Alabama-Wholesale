const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const modules = new Map();
function load(name) {
  if (!modules.has(name))
    modules.set(
      name,
      import(
        "data:text/javascript;base64," +
          Buffer.from(
            fs.readFileSync(path.join(__dirname, "../public", name), "utf8"),
          ).toString("base64")
      ),
    );
  return modules.get(name);
}
async function fixture() {
  const [{ Workspace }, { createStorageRecovery }] = await Promise.all([
    load("storage.js"),
    load("storage-recovery.js"),
  ]);
  const records = new Map();
  let full = false,
    clock = 0,
    recovered = 0,
    reclaimed = 0,
    current = true;
  const workspace = new Workspace(
    {
      getItem: (key) => records.get(key) ?? null,
      setItem(key, raw) {
        if (full) throw new Error("quota");
        records.set(key, raw);
      },
    },
    "owner",
  );
  workspace.saveDraft({ id: "draft", lines: [], notes: "original" });
  workspace.enqueue({
    id: "preserve-command",
    type: "order.submit",
    payload: { id: "other" },
  });
  full = true;
  workspace.saveDraftForCloud({
    ...workspace.getDraft("draft"),
    notes: "latest unsynced note",
  });
  const options = {
    workspace,
    now: () => clock,
    isCurrent: () => current,
    reclaim: async () => {
      reclaimed++;
      full = false;
    },
    onRecovered: () => {
      recovered++;
    },
  };
  return {
    workspace,
    records,
    options,
    createStorageRecovery,
    setFull: (value) => {
      full = value;
    },
    setCurrent: (value) => {
      current = value;
    },
    advance: (value) => {
      clock += value;
    },
    counts: () => ({ recovered, reclaimed }),
  };
}
test("automatic recovery durably saves session edits without changing queued command identities", async () => {
  const f = await fixture(),
    controller = f.createStorageRecovery(f.options);
  assert.equal(await controller.attempt(), true);
  const saved = JSON.parse(f.records.get(f.workspace.key));
  assert.equal(saved.drafts.draft.notes, "latest unsynced note");
  assert.equal(saved.drafts.draft.syncState, "local");
  assert.equal(saved.queue[0].command.id, "preserve-command");
  assert.equal(f.workspace.storageStatus().warning, null);
  assert.deepEqual(f.counts(), { recovered: 1, reclaimed: 1 });
});
test("transient failures are retried without opening the database when storage already works", async () => {
  const f = await fixture();
  f.setFull(false);
  assert.equal(await f.createStorageRecovery(f.options).attempt(), true);
  assert.deepEqual(f.counts(), { recovered: 1, reclaimed: 0 });
});
test("a failed database preserves the warning and automatic retries are bounded", async () => {
  const f = await fixture();
  let attempts = 0;
  const controller = f.createStorageRecovery({
    ...f.options,
    reclaim: async () => {
      attempts++;
      throw Error("database blocked");
    },
  });
  const original = f.records.get(f.workspace.key);
  await assert.rejects(controller.attempt(), /database blocked/);
  assert(f.workspace.storageStatus().warning);
  assert.equal(f.records.get(f.workspace.key), original);
  assert.equal(await controller.attempt(), false);
  assert.equal(attempts, 1);
  f.advance(30000);
  await assert.rejects(controller.attempt(), /database blocked/);
  assert.equal(attempts, 2);
  assert.equal(f.counts().recovered, 0);
});
test("successful opening the database alone never claims device persistence succeeded", async () => {
  const f = await fixture();
  const controller = f.createStorageRecovery({
    ...f.options,
    reclaim: async () => {},
  });
  await assert.rejects(controller.attempt(), { name: "StorageFailure" });
  assert(f.workspace.storageStatus().warning);
  assert.equal(f.counts().recovered, 0);
});
test("overlapping retries share one recovery and include edits made while opening the database", async () => {
  const f = await fixture();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const controller = f.createStorageRecovery({
    ...f.options,
    reclaim: async () => {
      await gate;
      f.setFull(false);
    },
  });
  const first = controller.attempt(),
    second = controller.attempt({ force: true });
  assert.equal(first, second);
  await Promise.resolve();
  f.workspace.saveDraftForCloud({
    ...f.workspace.getDraft("draft"),
    notes: "typed during recovery",
  });
  release();
  assert.equal(await first, true);
  assert.equal(
    JSON.parse(f.records.get(f.workspace.key)).drafts.draft.notes,
    "typed during recovery",
  );
  assert.equal(f.counts().recovered, 1);
});
test("a delayed database cannot mutate a workspace after account change or disposal", async () => {
  for (const dispose of [false, true]) {
    const f = await fixture();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const controller = f.createStorageRecovery({
      ...f.options,
      reclaim: async () => {
        await gate;
        f.setFull(false);
      },
    });
    const before = f.records.get(f.workspace.key),
      attempt = controller.attempt();
    await Promise.resolve();
    if (dispose) controller.dispose();
    else f.setCurrent(false);
    release();
    assert.equal(await attempt, false);
    assert.equal(f.records.get(f.workspace.key), before);
    assert.equal(f.counts().recovered, 0);
  }
});
test("draft conflicts are never repaired by replacing a newer tab's saved draft", async () => {
  const f = await fixture();
  const data = JSON.parse(f.records.get(f.workspace.key));
  data.drafts.draft.notes = "newer other tab";
  data.drafts.draft.localRevision++;
  const raw = JSON.stringify(data);
  f.records.set(f.workspace.key, raw);
  await assert.rejects(f.createStorageRecovery(f.options).attempt(), {
    name: "DraftConflict",
  });
  assert.equal(f.records.get(f.workspace.key), raw);
  assert.deepEqual(f.counts(), { recovered: 0, reclaimed: 0 });
});
