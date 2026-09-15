const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
let modulePromise;
function load() {
  return (modulePromise ||= import(
    "data:text/javascript;base64," +
      Buffer.from(
        fs.readFileSync(
          path.join(__dirname, "../public/device-storage.js"),
          "utf8",
        ),
      ).toString("base64")
  ));
}
const KEY = "aw:v2:owner";
const raw = (name = "first", revision = 1) =>
  JSON.stringify({
    format: "aw-workspace",
    version: 1,
    revision,
    drafts: { a: { id: "a", name, lines: [], syncState: "local" } },
    queue: [{ id: "pending" }],
    preferences: {},
  });
function memory(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
}
function fakeIDB(options = {}) {
  const stores = new Map(),
    keyPaths = new Map();
  let tail = Promise.resolve();
  const db = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore(name, { keyPath }) {
      stores.set(name, new Map());
      keyPaths.set(name, keyPath);
    },
    close() {},
    transaction(names, mode) {
      names = Array.isArray(names) ? names : [names];
      let views,
        active = false,
        pending = 0,
        aborted = false,
        finished = false,
        timer,
        release;
      const queued = [];
      const done = new Promise((resolve) => (release = resolve));
      const tx = {
        abort() {
          if (finished || aborted) return;
          aborted = true;
          clearTimeout(timer);
          release();
          queueMicrotask(() => tx.onabort?.());
        },
        objectStore(name) {
          const op = (action) => {
            const request = {};
            pending++;
            const run = () =>
              queueMicrotask(() => {
                if (aborted) return;
                try {
                  request.result = action();
                  request.onsuccess?.();
                } catch (error) {
                  request.error = error;
                  tx.error = error;
                  request.onerror?.();
                  tx.abort();
                  return;
                }
                pending--;
                if (!pending) {
                  clearTimeout(timer);
                  timer = setTimeout(() => {
                    if (
                      aborted ||
                      finished ||
                      pending ||
                      options.hangTransactions
                    )
                      return;
                    if (mode === "readwrite" && options.failCommit?.(names)) {
                      tx.abort();
                      return;
                    }
                    finished = true;
                    if (mode === "readwrite") {
                      for (const [n, view] of views) stores.set(n, view);
                      options.onCommit?.(names);
                    }
                    release();
                    tx.oncomplete?.();
                  }, 0);
                }
              });
            if (active) run();
            else queued.push(run);
            return request;
          };
          return {
            get: (key) =>
              op(() => {
                const value = structuredClone(views.get(name).get(key));
                options.onGet?.({ key, mode });
                return options.corruptRead && value
                  ? { ...value, raw: value.raw + "CORRUPT" }
                  : value;
              }),
            add: (value) =>
              op(() => {
                const key = value[keyPaths.get(name)];
                if (views.get(name).has(key)) throw Error("Constraint");
                views.get(name).set(key, structuredClone(value));
                return key;
              }),
            put: (value) =>
              op(() => {
                const key = value[keyPaths.get(name)];
                views.get(name).set(key, structuredClone(value));
                options.onPut?.(value);
                return key;
              }),
          };
        },
      };
      const previous = tail;
      tail = done;
      previous.then(() => {
        if (aborted) return;
        views = new Map(
          names.map((name) => [
            name,
            new Map(
              [...stores.get(name)].map(([key, value]) => [
                key,
                structuredClone(value),
              ]),
            ),
          ]),
        );
        active = true;
        for (const run of queued) run();
      });
      return tx;
    },
  };
  return {
    stores,
    options,
    open() {
      const request = {};
      if (options.hangOpen) return request;
      queueMicrotask(() => {
        if (options.openError) {
          request.onerror?.();
          return;
        }
        request.result = db;
        if (!stores.size) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}
function options(storage, indexedDB, extra = {}) {
  return {
    storage,
    indexedDB,
    BroadcastChannel: null,
    eventTarget: null,
    ...extra,
  };
}

test("creates a verified workspace without changing any localStorage key and restores it", async () => {
  const { createDeviceStorage, openDeviceStorage } = await load();
  const storage = memory({
      [KEY]: raw(),
      alwholesale_data_v1: "LEGACY",
      alwholesale_order_v1: "ORDER",
      firebaseAuth: "AUTH",
    }),
    indexedDB = fakeIDB();
  const before = [...storage.data];
  const adapter = await createDeviceStorage(
    KEY,
    raw("working"),
    options(storage, indexedDB),
  );
  assert.equal(adapter.getItem(KEY), raw("working"));
  assert.equal(adapter.committedItem(KEY), raw("working"));
  assert.equal(adapter.status().pending, false);
  assert.deepEqual([...storage.data], before);
  adapter.dispose();
  const reopened = await openDeviceStorage(KEY, options(storage, indexedDB));
  assert.equal(reopened.getItem(KEY), raw("working"));
  reopened.dispose();
});

test("open returns null only for an absent workspace; failures reject", async () => {
  const { openDeviceStorage } = await load();
  assert.equal(
    await openDeviceStorage(KEY, options(memory(), fakeIDB())),
    null,
  );
  await assert.rejects(
    () =>
      openDeviceStorage(KEY, options(memory(), fakeIDB({ openError: true }))),
    (e) => e.code === "DEVICE_STORAGE_FAILED",
  );
  await assert.rejects(
    () => openDeviceStorage(KEY, options(memory(), null)),
    (e) => e.code === "DEVICE_STORAGE_UNAVAILABLE",
  );
});

test("setItem stages immediately but isPersisted remains false until flush commits", async () => {
  const { createDeviceStorage } = await load();
  const storage = memory({ [KEY]: raw() }),
    indexedDB = fakeIDB();
  let notifications = 0;
  const adapter = await createDeviceStorage(
    KEY,
    raw(),
    options(storage, indexedDB, { onChange: () => notifications++ }),
  );
  adapter.setItem(KEY, raw("second"));
  assert.equal(adapter.getItem(KEY), raw("second"));
  assert.equal(adapter.committedItem(KEY), raw());
  assert.equal(adapter.status().pending, true);
  assert.equal(adapter.isPersisted(KEY, raw("second")), false);
  await adapter.flush();
  assert.equal(adapter.committedItem(KEY), raw("second"));
  assert.equal(adapter.status().pending, false);
  assert.equal(adapter.isPersisted(KEY, raw("second")), true);
  assert.ok(notifications >= 2);
  adapter.dispose();
});

test("rapid staged writes flush the newest snapshot while preserving pending queue", async () => {
  const { createDeviceStorage, openDeviceStorage } = await load();
  const storage = memory({ [KEY]: raw() }),
    indexedDB = fakeIDB();
  const adapter = await createDeviceStorage(
    KEY,
    raw(),
    options(storage, indexedDB),
  );
  for (let i = 0; i < 20; i++) adapter.setItem(KEY, raw(String(i), i + 2));
  await adapter.flush();
  assert.equal(adapter.committedItem(KEY), raw("19", 21));
  adapter.dispose();
  const reopened = await openDeviceStorage(KEY, options(storage, indexedDB));
  assert.deepEqual(JSON.parse(reopened.getItem(KEY)).queue, [
    { id: "pending" },
  ]);
  reopened.dispose();
});

test("revision-only retries are no-ops without dropping meaningful root fields", async () => {
  const { createDeviceStorage } = await load();
  const storage = memory({ [KEY]: raw() }),
    indexedDB = fakeIDB();
  const adapter = await createDeviceStorage(
    KEY,
    raw(),
    options(storage, indexedDB),
  );
  adapter.setItem(KEY, raw("first", 99));
  await adapter.flush();
  assert.equal(adapter.status().pending, false);
  assert.equal(adapter.committedItem(KEY), raw());
  assert.equal(indexedDB.stores.get("workspaces").get(KEY).version, 1);
  const changed = JSON.parse(raw("first", 100));
  changed.preferences.theme = "dark";
  adapter.setItem(KEY, JSON.stringify(changed));
  await adapter.flush();
  assert.equal(indexedDB.stores.get("workspaces").get(KEY).version, 2);
  adapter.dispose();
});

test("transaction commit failures preserve staged edits and existing committed snapshot; retry is honest", async () => {
  const { createDeviceStorage } = await load();
  const storage = memory({ [KEY]: raw() }),
    indexedDB = fakeIDB();
  const adapter = await createDeviceStorage(
    KEY,
    raw(),
    options(storage, indexedDB),
  );
  indexedDB.options.failCommit = () => true;
  adapter.setItem(KEY, raw("pending"));
  await assert.rejects(
    () => adapter.flush(),
    (e) => e.code === "DEVICE_STORAGE_FAILED",
  );
  assert.equal(adapter.getItem(KEY), raw("pending"));
  assert.equal(adapter.committedItem(KEY), raw());
  assert.equal(adapter.status().pending, true);
  assert.ok(adapter.status().warning);
  indexedDB.options.failCommit = null;
  await adapter.flush();
  assert.equal(adapter.committedItem(KEY), raw("pending"));
  assert.equal(adapter.status().warning, null);
  adapter.dispose();
});

test("two tabs use compare-and-swap and never overwrite another committed revision", async () => {
  const { createDeviceStorage, openDeviceStorage } = await load();
  const storage = memory({ [KEY]: raw() }),
    indexedDB = fakeIDB();
  const a = await createDeviceStorage(KEY, raw(), options(storage, indexedDB)),
    b = await openDeviceStorage(KEY, options(storage, indexedDB));
  a.setItem(KEY, raw("winner"));
  await a.flush();
  b.setItem(KEY, raw("loser"));
  await assert.rejects(
    () => b.flush(),
    (e) => e.code === "DEVICE_STORAGE_CONFLICT",
  );
  assert.equal(b.getItem(KEY), raw("loser"));
  assert.equal(b.status().conflicted, true);
  assert.equal(indexedDB.stores.get("workspaces").get(KEY).raw, raw("winner"));
  a.dispose();
  b.dispose();
});

test("refresh adopts external commits only while no local edits are pending", async () => {
  const { createDeviceStorage, openDeviceStorage } = await load();
  const storage = memory({ [KEY]: raw() }),
    indexedDB = fakeIDB();
  const a = await createDeviceStorage(KEY, raw(), options(storage, indexedDB)),
    b = await openDeviceStorage(KEY, options(storage, indexedDB));
  a.setItem(KEY, raw("external"));
  await a.flush();
  await b.refresh();
  assert.equal(b.getItem(KEY), raw("external"));
  assert.equal(b.status().conflicted, false);
  a.dispose();
  b.dispose();
});

test("changed original localStorage flags legacy conflict and preserves both copies", async () => {
  const { createDeviceStorage, openDeviceStorage } = await load();
  const storage = memory({ [KEY]: raw() }),
    indexedDB = fakeIDB();
  const adapter = await createDeviceStorage(
    KEY,
    raw("idb"),
    options(storage, indexedDB),
  );
  storage.setItem(KEY, raw("older-app"));
  adapter.setItem(KEY, raw("new-edit"));
  await assert.rejects(
    () => adapter.flush(),
    (e) => e.code === "DEVICE_STORAGE_CONFLICT",
  );
  assert.equal(adapter.status().legacyConflict, true);
  assert.equal(adapter.getItem(KEY), raw("new-edit"));
  assert.equal(storage.getItem(KEY), raw("older-app"));
  assert.equal(indexedDB.stores.get("workspaces").get(KEY).raw, raw("idb"));
  adapter.dispose();
  const reopened = await openDeviceStorage(KEY, options(storage, indexedDB));
  assert.equal(reopened.status().legacyConflict, true);
  reopened.dispose();
});

test("creation is CAS-only and rejects a different existing workspace", async () => {
  const { createDeviceStorage } = await load();
  const storage = memory({ [KEY]: raw() }),
    indexedDB = fakeIDB();
  const a = await createDeviceStorage(
    KEY,
    raw("first"),
    options(storage, indexedDB),
  );
  const b = await createDeviceStorage(
    KEY,
    raw("first", 999),
    options(storage, indexedDB),
  );
  b.dispose();
  await assert.rejects(
    () =>
      createDeviceStorage(KEY, raw("different"), options(storage, indexedDB)),
    (e) => e.code === "DEVICE_STORAGE_CONFLICT",
  );
  assert.equal(indexedDB.stores.get("workspaces").get(KEY).raw, raw("first"));
  a.dispose();
});

test("dispose silences callbacks but already staged authorized writes finish", async () => {
  const { createDeviceStorage, openDeviceStorage } = await load();
  const storage = memory({ [KEY]: raw() }),
    indexedDB = fakeIDB();
  let calls = 0;
  const adapter = await createDeviceStorage(
    KEY,
    raw(),
    options(storage, indexedDB, { onChange: () => calls++ }),
  );
  adapter.setItem(KEY, raw("last"));
  adapter.dispose();
  const before = calls;
  await adapter.flush();
  assert.equal(calls, before);
  const reopened = await openDeviceStorage(KEY, options(storage, indexedDB));
  assert.equal(reopened.getItem(KEY), raw("last"));
  reopened.dispose();
});

test("timeouts and invalid keys cannot alter original storage", async () => {
  const { openDeviceStorage, createDeviceStorage } = await load();
  const storage = memory({ [KEY]: raw() });
  for (const indexedDB of [
    fakeIDB({ hangOpen: true }),
    fakeIDB({ hangTransactions: true }),
  ])
    await assert.rejects(
      () =>
        openDeviceStorage(KEY, options(storage, indexedDB, { timeoutMs: 15 })),
      (e) => e.code === "DEVICE_STORAGE_TIMEOUT",
    );
  for (const key of [
    "alwholesale_data_v1",
    "firebase:authUser",
    "aw:v2:",
    "aw:v2:__proto__",
  ])
    await assert.rejects(
      () => createDeviceStorage(key, raw(), options(storage, fakeIDB())),
      (e) => e.code === "DEVICE_STORAGE_INVALID_KEY",
    );
  assert.equal(storage.getItem(KEY), raw());
});

test("change callbacks are deferred so Workspace can finish its own mutation", async () => {
  const { createDeviceStorage } = await load();
  const storage = memory({ [KEY]: raw() }),
    indexedDB = fakeIDB();
  let calls = 0;
  const adapter = await createDeviceStorage(
    KEY,
    raw(),
    options(storage, indexedDB, { onChange: () => calls++ }),
  );
  adapter.setItem(KEY, raw("second"));
  assert.equal(calls, 0);
  await adapter.flush();
  assert.ok(calls > 0);
  adapter.dispose();
});

test("a microtask edit scheduled by a durable callback is automatically persisted", async () => {
  const { createDeviceStorage } = await load();
  const storage = memory({ [KEY]: raw() }),
    indexedDB = fakeIDB();
  let adapter,
    inserted = false;
  adapter = await createDeviceStorage(
    KEY,
    raw(),
    options(storage, indexedDB, {
      onChange: (state) => {
        if (!state.pending && !inserted) {
          inserted = true;
          queueMicrotask(() => adapter.setItem(KEY, raw("third")));
        }
      },
    }),
  );
  adapter.setItem(KEY, raw("second"));
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(adapter.committedItem(KEY), raw("third"));
  adapter.dispose();
});

test("flush detects old localStorage writers even when there is no staged content change", async () => {
  const { createDeviceStorage } = await load();
  const storage = memory({ [KEY]: raw() }),
    indexedDB = fakeIDB();
  const adapter = await createDeviceStorage(
    KEY,
    raw(),
    options(storage, indexedDB),
  );
  storage.setItem(KEY, raw("old writer"));
  await assert.rejects(
    () => adapter.flush(),
    (e) => e.code === "DEVICE_STORAGE_CONFLICT" && e.legacyConflict,
  );
  adapter.dispose();
});

test("a committed write whose readback fails can be safely verified on retry", async () => {
  const { createDeviceStorage } = await load();
  const storage = memory({ [KEY]: raw() }),
    indexedDB = fakeIDB();
  const adapter = await createDeviceStorage(
    KEY,
    raw(),
    options(storage, indexedDB),
  );
  let corrupt = true;
  indexedDB.options.onCommit = () => {
    indexedDB.options.corruptRead = corrupt;
  };
  adapter.setItem(KEY, raw("second"));
  await assert.rejects(() => adapter.flush());
  assert.equal(adapter.committedItem(KEY), raw());
  corrupt = false;
  indexedDB.options.corruptRead = false;
  await adapter.flush();
  assert.equal(adapter.committedItem(KEY), raw("second"));
  assert.equal(adapter.status().conflicted, false);
  adapter.dispose();
});

function fakeBroadcast() {
  const members = new Set();
  return class Channel {
    constructor(name) {
      this.name = name;
      members.add(this);
    }
    postMessage(data) {
      for (const member of members)
        if (member !== this && member.name === this.name)
          queueMicrotask(() =>
            member.onmessage?.({ data: structuredClone(data) }),
          );
    }
    close() {
      members.delete(this);
    }
  };
}

test("BroadcastChannel refreshes idle same-account tabs without exposing or changing other workspaces", async () => {
  const { createDeviceStorage, openDeviceStorage } = await load();
  const storage = memory({ [KEY]: raw() }),
    indexedDB = fakeIDB(),
    BroadcastChannel = fakeBroadcast();
  const shared = options(storage, indexedDB, { BroadcastChannel });
  const a = await createDeviceStorage(KEY, raw(), shared),
    b = await openDeviceStorage(KEY, shared),
    other = await createDeviceStorage("aw:v2:another", raw("other"), shared);
  a.setItem(KEY, raw("shared"));
  await a.flush();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(b.getItem(KEY), raw("shared"));
  assert.equal(other.getItem("aw:v2:another"), raw("other"));
  a.dispose();
  b.dispose();
  other.dispose();
});

test("concurrent creation cannot replace a different first snapshot", async () => {
  const { createDeviceStorage } = await load();
  const storage = memory({ [KEY]: raw() }),
    indexedDB = fakeIDB();
  const results = await Promise.allSettled([
    createDeviceStorage(KEY, raw("a"), options(storage, indexedDB)),
    createDeviceStorage(KEY, raw("b"), options(storage, indexedDB)),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.find((r) => r.status === "rejected").reason.code,
    "DEVICE_STORAGE_CONFLICT",
  );
  for (const result of results)
    if (result.status === "fulfilled") result.value.dispose();
  assert.equal(storage.getItem(KEY), raw());
});

test("localStorage edits during an IndexedDB commit preserve both and flag conflict", async () => {
  const { createDeviceStorage } = await load();
  const storage = memory({ [KEY]: raw() }),
    indexedDB = fakeIDB();
  const adapter = await createDeviceStorage(
    KEY,
    raw(),
    options(storage, indexedDB),
  );
  indexedDB.options.onCommit = () =>
    storage.setItem(KEY, raw("old-tab-update"));
  adapter.setItem(KEY, raw("new-tab-update"));
  await assert.rejects(
    () => adapter.flush(),
    (e) => e.code === "DEVICE_STORAGE_CONFLICT" && e.legacyConflict,
  );
  assert.equal(storage.getItem(KEY), raw("old-tab-update"));
  assert.equal(
    indexedDB.stores.get("workspaces").get(KEY).raw,
    raw("new-tab-update"),
  );
  adapter.dispose();
});

test("new edits after uncertain commit are written only after verifying the attempted version", async () => {
  const { createDeviceStorage } = await load();
  const storage = memory({ [KEY]: raw() }),
    indexedDB = fakeIDB();
  const adapter = await createDeviceStorage(
    KEY,
    raw(),
    options(storage, indexedDB),
  );
  let corrupt = true;
  indexedDB.options.onCommit = () => {
    indexedDB.options.corruptRead = corrupt;
  };
  adapter.setItem(KEY, raw("second"));
  await assert.rejects(() => adapter.flush());
  corrupt = false;
  indexedDB.options.corruptRead = false;
  adapter.setItem(KEY, raw("third"));
  await adapter.flush();
  assert.equal(adapter.committedItem(KEY), raw("third"));
  assert.equal(indexedDB.stores.get("workspaces").get(KEY).version, 3);
  adapter.dispose();
});

test("refresh during an own write waits for commit verification without a false conflict", async () => {
  const { createDeviceStorage } = await load();
  const storage = memory({ [KEY]: raw() }),
    indexedDB = fakeIDB();
  const adapter = await createDeviceStorage(
    KEY,
    raw(),
    options(storage, indexedDB),
  );
  let refresh;
  indexedDB.options.onPut = () => {
    refresh = adapter.refresh();
    refresh.catch(() => {});
  };
  adapter.setItem(KEY, raw("own latest"));
  await adapter.flush();
  await refresh;
  assert.equal(adapter.committedItem(KEY), raw("own latest"));
  assert.deepEqual(adapter.status(), {
    pending: false,
    warning: null,
    conflicted: false,
    legacyConflict: false,
  });
  adapter.dispose();
});

test("refresh already opening the database tolerates an own write starting during that read", async () => {
  const { createDeviceStorage } = await load();
  const storage = memory({ [KEY]: raw() }),
    indexedDB = fakeIDB();
  const adapter = await createDeviceStorage(
    KEY,
    raw(),
    options(storage, indexedDB),
  );
  const refresh = adapter.refresh();
  adapter.setItem(KEY, raw("own latest"));
  await Promise.all([refresh, adapter.flush()]);
  assert.equal(adapter.getItem(KEY), raw("own latest"));
  assert.equal(adapter.status().conflicted, false);
  assert.equal(adapter.status().warning, null);
  adapter.dispose();
});

test("a real legacy conflict discovered during a pending write retains its warning", async () => {
  const { createDeviceStorage } = await load();
  const storage = memory({ [KEY]: raw() }),
    indexedDB = fakeIDB();
  const adapter = await createDeviceStorage(
    KEY,
    raw(),
    options(storage, indexedDB),
  );
  let refresh;
  indexedDB.options.onPut = () => {
    storage.setItem(KEY, raw("legacy writer"));
    refresh = adapter.refresh();
    refresh.catch(() => {});
  };
  adapter.setItem(KEY, raw("own latest"));
  await assert.rejects(
    () => adapter.flush(),
    (e) => e.code === "DEVICE_STORAGE_CONFLICT",
  );
  await assert.rejects(
    () => refresh,
    (e) => e.code === "DEVICE_STORAGE_CONFLICT",
  );
  assert.equal(adapter.status().conflicted, true);
  assert.equal(adapter.status().legacyConflict, true);
  assert.ok(adapter.status().warning);
  assert.equal(storage.getItem(KEY), raw("legacy writer"));
  adapter.dispose();
});

test("flush waits for an edit that starts while a previous read warning is being verified", async () => {
  const { createDeviceStorage } = await load();
  const storage = memory({ [KEY]: raw() }),
    indexedDB = fakeIDB();
  const adapter = await createDeviceStorage(
    KEY,
    raw(),
    options(storage, indexedDB),
  );
  indexedDB.options.openError = true;
  await assert.rejects(() => adapter.refresh());
  indexedDB.options.openError = false;
  let staged = false;
  indexedDB.options.onGet = ({ mode }) => {
    if (mode === "readonly" && !staged) {
      staged = true;
      adapter.setItem(KEY, raw("edit during retry"));
    }
  };
  await adapter.flush();
  assert.equal(adapter.committedItem(KEY), raw("edit during retry"));
  assert.equal(adapter.status().pending, false);
  assert.equal(adapter.status().conflicted, false);
  adapter.dispose();
});
