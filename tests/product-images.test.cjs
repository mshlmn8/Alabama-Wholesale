const test = require("node:test");
const assert = require("node:assert/strict");
const { MemoryRepository } = require("../lib/repository.cjs");
const {
  queueProductImage,
  changeProductImages,
  runProductImages,
  getProductImages,
} = require("../lib/product-images.cjs");
const { createApp } = require("../server.js");
const p = {
  id: "p",
  name: "Exact branded product",
  image: "",
  version: 1,
  active: true,
  variants: ["Original"],
};
const matched = {
  image: { mimeType: "image/png", data: "fixture" },
  sourcePage: "https://manufacturer.example/product",
  sourceImage: "https://manufacturer.example/product.png",
  reason: "Exact brand and family visible",
  model: "fixture",
  confidence: 1,
};
const assets = {
  upload: async () => ({ url: "/media/products/" + "a".repeat(64) + ".png" }),
};
async function fixture() {
  const repo = new MemoryRepository({ products: [p] });
  await repo.transaction((tx) => queueProductImage(tx, p, { now: 100 }));
  return repo;
}
test("missing photo queue is durable/idempotent and preserves existing photos", async () => {
  const repo = await fixture();
  await repo.put("products", "existing", {
    ...p,
    id: "existing",
    image: "/assets/keep.png",
  });
  assert.deepEqual(
    await changeProductImages(
      repo,
      { action: "queue_missing" },
      { now: () => 200 },
    ),
    { queued: 0 },
  );
  assert.equal((await repo.list("productImageJobs")).length, 1);
  await runProductImages(repo, {
    provider: async () => matched,
    assets,
    now: () => 300,
  });
  assert.equal((await repo.get("products", "p")).version, 2);
  assert.equal(
    (await repo.get("products", "p")).imageSource.page,
    matched.sourcePage,
  );
  assert.equal(
    (await repo.get("products", "existing")).image,
    "/assets/keep.png",
  );
  assert.equal((await repo.list("audit")).length, 1);
  assert.equal(
    (await getProductImages(repo, { configured: true })).counts.withPhoto,
    2,
  );
  assert.equal(
    (
      await runProductImages(repo, {
        provider: async () => {
          throw Error("duplicate");
        },
        assets,
        now: () => 400,
      })
    ).processed,
    0,
  );
});
test("parallel workers claim a product only once", async () => {
  const repo = await fixture();
  let calls = 0;
  let release;
  const wait = new Promise((r) => (release = r));
  const first = runProductImages(repo, {
    provider: async () => {
      calls++;
      await wait;
      return matched;
    },
    assets,
    now: () => 300,
  });
  while (!calls) await new Promise((r) => setImmediate(r));
  assert.equal(
    (
      await runProductImages(repo, {
        provider: async () => {
          calls++;
          return matched;
        },
        assets,
        now: () => 400,
      })
    ).processed,
    0,
  );
  release();
  await first;
  assert.equal(calls, 1);
});
test("manual photo changes during Gemini processing are never overwritten", async () => {
  const repo = await fixture();
  const result = await runProductImages(repo, {
    provider: async () => {
      await repo.put("products", "p", {
        ...p,
        image: "/assets/manual.png",
        version: 2,
      });
      return matched;
    },
    assets,
    now: () => 300,
  });
  assert.equal(result.status, "skipped");
  assert.equal((await repo.get("products", "p")).image, "/assets/manual.png");
  assert.equal((await repo.list("audit")).length, 0);
});
test("changed product identity and newer jobs discard stale results", async () => {
  const repo = await fixture();
  const changed = { ...p, name: "Different product", version: 2 };
  const result = await runProductImages(repo, {
    provider: async () => {
      await repo.put("products", "p", changed);
      await repo.transaction((tx) =>
        queueProductImage(tx, changed, { now: 350 }),
      );
      return matched;
    },
    assets,
    now: () => 300,
  });
  assert.equal(result.status, "superseded");
  assert.equal((await repo.get("products", "p")).image, "");
  assert.equal((await repo.get("productImageJobs", "p")).status, "queued");
});
test("unrelated metadata edit preserves fresh fields when a verified image is added", async () => {
  const repo = await fixture();
  await runProductImages(repo, {
    provider: async () => {
      await repo.put("products", "p", { ...p, priceCents: 555, version: 2 });
      return matched;
    },
    assets,
    now: () => 300,
  });
  const product = await repo.get("products", "p");
  assert.equal(product.priceCents, 555);
  assert.equal(product.version, 3);
});
test("ambiguous images stay missing and failure does not leak upstream secrets", async () => {
  const repo = await fixture();
  await runProductImages(repo, {
    provider: async () => ({
      review: true,
      message: "Brand is not identified",
    }),
    assets,
    now: () => 300,
  });
  assert.equal((await repo.get("products", "p")).image, "");
  assert.equal(
    (await repo.get("productImageJobs", "p")).status,
    "needs_review",
  );
  await changeProductImages(
    repo,
    { action: "retry", productId: "p" },
    { now: () => 70000 },
  );
  await runProductImages(repo, {
    provider: async () => {
      throw Error("credential SECRET");
    },
    assets,
    now: () => 71000,
  });
  assert.equal((await repo.get("productImageJobs", "p")).status, "failed");
  assert.doesNotMatch(
    JSON.stringify(await repo.list("productImageJobs")),
    /SECRET/,
  );
});
test("daily budget is atomic and leaves additional products queued", async () => {
  const repo = await fixture();
  const p2 = { ...p, id: "p2" };
  await repo.put("products", "p2", p2);
  await repo.transaction((tx) => queueProductImage(tx, p2, { now: 101 }));
  await Promise.all(
    [1, 2].map(() =>
      runProductImages(repo, {
        provider: async () => ({ review: true }),
        assets,
        now: () => 300,
        dailyLimit: 1,
      }),
    ),
  );
  const jobs = await repo.list("productImageJobs");
  assert.equal(jobs.filter((j) => j.status === "needs_review").length, 1);
  assert.equal(jobs.filter((j) => j.status === "queued").length, 1);
});
test("expired leases retry safely and stop after three interrupted attempts", async () => {
  const repo = await fixture();
  const job = await repo.get("productImageJobs", "p");
  await repo.put("productImageJobs", "p", {
    ...job,
    status: "processing",
    lease: "stale",
    leaseUntil: 200,
    attempts: 3,
  });
  let calls = 0;
  await runProductImages(repo, {
    provider: async () => {
      calls++;
    },
    assets,
    now: () => 300,
  });
  assert.equal(calls, 0);
  assert.equal((await repo.get("productImageJobs", "p")).status, "failed");
});
test("supplied source pages require HTTPS and retries are throttled", async () => {
  const repo = await fixture();
  await assert.rejects(
    changeProductImages(
      repo,
      { action: "source", productId: "p", sourcePage: "http://localhost" },
      { now: () => 70000 },
    ),
    { code: "invalid_source" },
  );
  await assert.rejects(
    changeProductImages(
      repo,
      { action: "retry", productId: "p" },
      { now: () => 200 },
    ),
    { code: "photo_retry_limit" },
  );
  await changeProductImages(
    repo,
    {
      action: "source",
      productId: "p",
      sourcePage: "https://supplier.example/product#photo",
    },
    { now: () => 70000 },
  );
  assert.equal(
    (await repo.get("productImageJobs", "p")).sourcePage,
    "https://supplier.example/product",
  );
});
test("photo APIs require owner access and worker token is separate from user authentication", async (t) => {
  const repo = await fixture();
  const auth = {
    authenticate: async () => ({ uid: "u" }),
    actor: async () => ({ uid: "u", role: "customer", storeIds: [] }),
  };
  const app = createApp({
    repo,
    auth,
    assets,
    productImageProvider: async () => ({ review: true }),
    productImageWorkerToken: "w".repeat(48),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = "http://127.0.0.1:" + server.address().port;
  assert.equal((await fetch(base + "/api/admin/product-photos")).status, 403);
  assert.equal(
    (
      await fetch(base + "/api/admin/product-photos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "queue_missing" }),
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(base + "/internal/product-photos/run", { method: "POST" }))
      .status,
    401,
  );
  assert.equal(
    (
      await fetch(base + "/internal/product-photos/run", {
        method: "POST",
        headers: { Authorization: "Bearer " + "w".repeat(48) },
      })
    ).status,
    200,
  );
});
test("clearing an automatically added photo queues a fresh check", async () => {
  const repo = await fixture();
  await runProductImages(repo, {
    provider: async () => matched,
    assets,
    now: () => 300,
  });
  const product = {
    ...(await repo.get("products", "p")),
    image: "",
    version: 3,
  };
  await repo.put("products", "p", product);
  await repo.transaction((tx) => queueProductImage(tx, product, { now: 500 }));
  assert.equal((await repo.get("productImageJobs", "p")).status, "queued");
});
test("new product save commits its photo job atomically and command replay cannot queue stale names", async (t) => {
  const repo = new MemoryRepository();
  const auth = {
    authenticate: async () => ({ uid: "owner" }),
    actor: async () => ({ uid: "owner", role: "master", storeIds: [] }),
  };
  const app = createApp({
    repo,
    auth,
    assets,
    productImageProvider: async () => ({ review: true }),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => new Promise((r) => server.close(r)));
  const submit = async (command) =>
    fetch("http://127.0.0.1:" + server.address().port + "/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
  const command = {
    id: "new-product",
    type: "product.save",
    payload: {
      id: "new",
      name: "A new product",
      priceCents: 100,
      categoryIds: [],
      variants: [],
      packSize: 1,
    },
  };
  assert.equal((await submit(command)).status, 200);
  assert.equal(
    (await repo.get("productImageJobs", "new")).name,
    "A new product",
  );
  const changed = {
    id: "edit-product",
    type: "product.save",
    payload: { id: "new", name: "A renamed product", expectedVersion: 1 },
  };
  assert.equal((await submit(changed)).status, 200);
  assert.equal((await submit(command)).status, 200);
  assert.equal(
    (await repo.get("productImageJobs", "new")).name,
    "A renamed product",
  );
  const transaction = repo.transaction.bind(repo);
  repo.transaction = (callback) =>
    transaction((tx) =>
      callback({
        ...tx,
        set: async (collection, id, data) => {
          if (collection === "productImageJobs")
            throw Error("queue unavailable");
          return tx.set(collection, id, data);
        },
      }),
    );
  assert.equal(
    (
      await submit({
        ...command,
        id: "another-command",
        payload: { ...command.payload, id: "other" },
      })
    ).status,
    500,
  );
  assert.equal(await repo.get("products", "other"), null);
});
