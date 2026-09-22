const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function worker({
  fetch = async () => new Response("fresh"),
  cache = {},
  caches = {},
} = {}) {
  const handlers = new Map();
  const calls = { skipped: 0, claimed: 0, deleted: [], added: [] };
  const storage = {
    addAll: async (urls) => {
      calls.added.push(...urls);
    },
    add: async (url) => {
      calls.added.push(url);
    },
    put: async () => {},
    match: async () => undefined,
    ...cache,
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../public/sw.js"), "utf8"),
    {
      URL,
      fetch,
      caches: {
        open: async () => storage,
        keys: async () => [],
        delete: async (key) => {
          calls.deleted.push(key);
          return true;
        },
        ...caches,
      },
      self: {
        location: { origin: "https://wholesale.example" },
        addEventListener: (type, handler) => handlers.set(type, handler),
        skipWaiting: async () => {
          calls.skipped++;
        },
        clients: {
          claim: async () => {
            calls.claimed++;
          },
        },
      },
    },
  );
  return {
    calls,
    async lifecycle(type) {
      const waits = [];
      handlers.get(type)({ waitUntil: (promise) => waits.push(promise) });
      await Promise.all(waits);
    },
    request(url = "https://wholesale.example/app.js", method = "GET") {
      const waits = [];
      let response;
      handlers.get("fetch")({
        request: { url, method },
        respondWith: (promise) => {
          response = promise;
        },
        waitUntil: (promise) => waits.push(promise),
      });
      return { response, settled: () => Promise.all(waits) };
    },
  };
}

test("a quota failure cannot replace a fresh network app with stale cached code", async () => {
  const sw = worker({
    cache: {
      put: async () => {
        throw new Error("QuotaExceededError");
      },
      match: async () => new Response("stale"),
    },
  });
  const request = sw.request();
  assert.equal(await (await request.response).text(), "fresh");
  await request.settled();
});

test("network remains usable when the Cache Storage API cannot open", async () => {
  const sw = worker({
    caches: {
      open: async () => {
        throw new Error("Storage blocked");
      },
    },
  });
  const request = sw.request();
  assert.equal(await (await request.response).text(), "fresh");
  await request.settled();
});

test("a slow device cache does not delay a successful network response", async () => {
  let finishWrite;
  const write = new Promise((resolve) => {
    finishWrite = resolve;
  });
  const sw = worker({ cache: { put: () => write } });
  const request = sw.request();
  try {
    const arrived = await Promise.race([
      request.response.then(() => true),
      new Promise((resolve) => setImmediate(() => resolve(false))),
    ]);
    assert.equal(arrived, true);
  } finally {
    finishWrite();
    await request.settled();
  }
});

test("offline requests still recover an existing cached shell", async () => {
  const sw = worker({
    fetch: async () => {
      throw new Error("Offline");
    },
    cache: {
      match: async (request, options) => {
        assert.equal(request.url, "https://wholesale.example/app.js");
        assert.equal(options.ignoreSearch, true);
        return new Response("offline shell");
      },
    },
  });
  assert.equal(await (await sw.request().response).text(), "offline shell");
});

test("storage preload failures do not prevent the new worker installing", async () => {
  for (const options of [
    {
      cache: {
        addAll: async () => {
          throw new Error("Quota exceeded");
        },
        add: async () => {
          throw new Error("Quota exceeded");
        },
      },
    },
    {
      caches: {
        open: async () => {
          throw new Error("Storage blocked");
        },
      },
    },
  ]) {
    const sw = worker(options);
    await sw.lifecycle("install");
    assert.equal(sw.calls.skipped, 1);
  }
});

test("cache cleanup failures do not prevent the new worker taking control", async () => {
  const sw = worker({
    caches: {
      keys: async () => {
        throw new Error("Storage blocked");
      },
    },
  });
  await sw.lifecycle("activate");
  assert.equal(sw.calls.claimed, 1);
});

test("activation removes old app caches without deleting unrelated caches", async () => {
  const sw = worker({
    caches: {
      keys: async () => [
        "aw-v2-20260914-2",
        "alabama-legacy",
        "aw-v2-20260922-2",
        "other-app",
      ],
    },
  });
  await sw.lifecycle("activate");
  assert.deepEqual(sw.calls.deleted, ["aw-v2-20260914-2", "alabama-legacy"]);
  assert.equal(sw.calls.claimed, 1);
});

test("worker leaves API, private records and non-GET requests outside its cache", () => {
  const sw = worker();
  for (const [url, method] of [
    ["https://wholesale.example/api/state", "GET"],
    ["https://wholesale.example/api/documents/order/invoice", "GET"],
    ["https://wholesale.example/private/orders.json", "GET"],
    ["https://wholesale.example/app.js", "POST"],
    ["https://other.example/app.js", "GET"],
  ])
    assert.equal(sw.request(url, method).response, undefined);
});
