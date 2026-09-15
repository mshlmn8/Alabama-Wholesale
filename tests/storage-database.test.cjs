const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
let modulePromise;
const load = () =>
  (modulePromise ||= import(
    "data:text/javascript;base64," +
      Buffer.from(
        fs.readFileSync(path.join(__dirname, "../public/storage.js"), "utf8"),
      ).toString("base64")
  ));
function adapter(raw) {
  let cache = raw,
    committed = raw,
    error = null;
  return {
    getItem: () => cache,
    setItem: (key, value) => {
      cache = value;
    },
    committedItem: () => committed,
    status: () => ({
      pending: cache !== committed,
      warning: error ? "Device write failed" : null,
      conflicted: error?.code === "DEVICE_STORAGE_CONFLICT",
    }),
    flush: async () => {
      if (error) throw error;
      committed = cache;
    },
    fail: (value) => {
      error = value;
    },
  };
}
async function setup() {
  const { Workspace } = await load(),
    records = new Map();
  let full = false;
  const storage = {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => {
      if (full) throw Error("quota");
      records.set(key, value);
    },
  };
  const workspace = new Workspace(storage, "owner");
  workspace.saveDraft({
    id: "draft",
    lines: [],
    notes: "local unsynced",
    version: 0,
  });
  workspace.enqueue({
    id: "receipt",
    type: "order.submit",
    payload: { id: "another" },
  });
  return {
    Workspace,
    workspace,
    records,
    full: () => {
      full = true;
    },
  };
}
test("database migration captures late edits and preserves all original localStorage bytes", async () => {
  const f = await setup(),
    original = f.records.get(f.workspace.key);
  f.full();
  const first = JSON.stringify(f.workspace.persistenceSnapshot()),
    database = adapter(first);
  f.workspace.saveDraftForCloud({
    ...f.workspace.getDraft("draft"),
    notes: "typed while database opened",
  });
  f.workspace.rememberPreferences({ theme: "dark" });
  f.workspace.adoptStorage(database);
  assert.equal(f.records.get(f.workspace.key), original);
  assert.equal(
    f.workspace.getDraft("draft").notes,
    "typed while database opened",
  );
  assert.equal(f.workspace.localDraftStatus("draft").localPersisted, false);
  await f.workspace.flushStorage();
  const restored = new f.Workspace(adapter(database.committedItem()), "owner");
  assert.equal(restored.getDraft("draft").notes, "typed while database opened");
  assert.equal(restored.preferences().theme, "dark");
  assert.equal(restored.pending()[0].command.id, "receipt");
  assert.equal(restored.localDraftStatus("draft").localPersisted, true);
});
test("a staged database write does not claim a durable device copy before commit", async () => {
  const f = await setup(),
    database = adapter(JSON.stringify(f.workspace.persistenceSnapshot()));
  f.workspace.adoptStorage(database);
  await f.workspace.flushStorage();
  f.workspace.saveDraftForCloud({
    ...f.workspace.getDraft("draft"),
    notes: "pending commit",
  });
  assert.equal(f.workspace.localDraftStatus("draft").localPersisted, false);
  assert.equal(f.workspace.storageStatus().unprotectedDraftCount, 1);
  await f.workspace.flushStorage();
  assert.equal(f.workspace.localDraftStatus("draft").localPersisted, true);
  assert.equal(f.workspace.storageStatus().unprotectedDraftCount, 0);
});
test("failed database writes retain working edits and honest protection state", async () => {
  const f = await setup(),
    database = adapter(JSON.stringify(f.workspace.persistenceSnapshot()));
  f.workspace.adoptStorage(database);
  await f.workspace.flushStorage();
  f.workspace.saveDraftForCloud({
    ...f.workspace.getDraft("draft"),
    notes: "not yet durable",
  });
  database.fail(Error("quota"));
  await assert.rejects(f.workspace.flushStorage(), { name: "StorageFailure" });
  assert(f.workspace.storageStatus().warning);
  assert.equal(f.workspace.localDraftStatus("draft").localPersisted, false);
  assert.equal(f.workspace.exportBackup().drafts[0].notes, "not yet durable");
  assert.equal(f.workspace.pending()[0].command.id, "receipt");
  database.fail(null);
  await f.workspace.flushStorage();
  assert.equal(f.workspace.localDraftStatus("draft").localPersisted, true);
  assert.equal(f.workspace.storageStatus().warning, null);
});
test("a confirmed cloud draft is separate from its pending device database write", async () => {
  const f = await setup(),
    database = adapter(JSON.stringify(f.workspace.persistenceSnapshot()));
  f.workspace.adoptStorage(database);
  await f.workspace.flushStorage();
  const sent = f.workspace.saveDraftForCloud({
    ...f.workspace.getDraft("draft"),
    notes: "saved on server",
  }).draft;
  f.workspace.ackCloudDraft(sent, { ...sent, status: "draft", version: 1 });
  assert.equal(f.workspace.storageStatus().unprotectedDraftCount, 0);
  assert.equal(f.workspace.storageStatus().cloudOnlyDraftCount, 1);
  assert.equal(f.workspace.localDraftStatus("draft").localPersisted, false);
  await f.workspace.flushStorage();
  assert.equal(f.workspace.localDraftStatus("draft").localPersisted, true);
});
test("database conflicts block edits and financial flushes without replacing either copy", async () => {
  const f = await setup(),
    database = adapter(JSON.stringify(f.workspace.persistenceSnapshot()));
  f.workspace.adoptStorage(database);
  await f.workspace.flushStorage();
  f.workspace.saveDraftForCloud({
    ...f.workspace.getDraft("draft"),
    notes: "this tab's pending edit",
  });
  database.fail(
    Object.assign(Error("newer database revision"), {
      code: "DEVICE_STORAGE_CONFLICT",
    }),
  );
  await assert.rejects(f.workspace.flushStorage(), { name: "DraftConflict" });
  assert.equal(f.workspace.localDraftStatus("draft").conflicted, true);
  assert.throws(
    () =>
      f.workspace.saveDraftForCloud({
        ...f.workspace.getDraft("draft"),
        notes: "unsafe overwrite",
      }),
    { name: "DraftConflict" },
  );
  assert.equal(f.workspace.getDraft("draft").notes, "this tab's pending edit");
  assert.equal(
    JSON.parse(database.committedItem()).drafts.draft.notes,
    "local unsynced",
  );
});
test("a conflicted backend does not claim its previous committed snapshot is still on the device", async () => {
  const f = await setup(),
    database = adapter(JSON.stringify(f.workspace.persistenceSnapshot()));
  f.workspace.adoptStorage(database);
  await f.workspace.flushStorage();
  database.fail(
    Object.assign(Error("foreign revision"), {
      code: "DEVICE_STORAGE_CONFLICT",
    }),
  );
  assert.equal(f.workspace.localDraftStatus("draft").localPersisted, false);
  assert.equal(f.workspace.storageStatus().unprotectedDraftCount, 1);
});
test("an unreadable database cannot authorize sending an old localStorage queue", async () => {
  const f = await setup();
  f.workspace.storage = {
    ...f.workspace.storage,
    databaseUnavailable: "The saved database could not be checked.",
    setItem() {
      throw Error("readonly");
    },
  };
  assert.equal(f.workspace.pending()[0].command.id, "receipt");
  await assert.rejects(f.workspace.flushStorage(), { name: "StorageFailure" });
  assert(f.workspace.storageStatus().warning);
});
