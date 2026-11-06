const test = require("node:test");
const assert = require("node:assert/strict");
const { MemoryRepository } = require("../lib/repository.cjs");
const { executeCommand } = require("../lib/domain.cjs");
const customer = { uid: "buyer", role: "customer", storeIds: ["s1"] };
const staff = { uid: "staff", role: "salesman", storeIds: ["s1"] };
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const line = {
  id: "line",
  productId: "p1",
  variant: "Orange",
  quantity: 2,
  unit: "each",
  note: "Keep dry",
};
function fixture() {
  const repo = new MemoryRepository({
    stores: [
      { id: "s1", name: "One" },
      { id: "s2", name: "Two" },
    ],
    products: [
      {
        id: "p1",
        name: "Drink",
        active: true,
        variants: ["Orange"],
        priceCents: 100,
        packSize: 12,
      },
    ],
    orders: [
      {
        id: "order",
        storeId: "s1",
        status: "delivered",
        invoiceNumber: "AW-1",
        subtotalCents: 200,
        taxCents: 0,
        totalCents: 200,
        lines: [
          {
            ...line,
            name: "Drink",
            sku: "D",
            unitPriceCents: 100,
            subtotalCents: 200,
            lineTotalCents: 200,
            taxCents: 0,
            taxRateBps: 0,
            eachQuantity: 2,
            packSize: 12,
          },
        ],
      },
    ],
  });
  let n = 0;
  return {
    repo,
    run: (type, payload, actor = customer, key) =>
      repo.transaction((tx) =>
        executeCommand(
          tx,
          actor,
          { id: key || `command-${++n}`, type, payload },
          { now: 1789372800000, id: () => `record-${++n}` },
        ),
      ),
  };
}
test("saved item lists are private, store scoped, versioned and never retain frozen prices", async () => {
  const f = fixture();
  const saved = await f.run(
    "order-list.save",
    {
      storeId: "s1",
      name: "Weekly restock",
      lines: [{ ...line, unitPriceCents: 1, totalCents: 1 }],
      notes: "Back door",
    },
    customer,
    "save-once",
  );
  assert.equal(saved.userId, "buyer");
  assert.equal(saved.storeId, "s1");
  assert.equal(saved.lines[0].unitPriceCents, undefined);
  assert.equal(saved.lines[0].quantity, 2);
  assert.deepEqual(
    await f.run(
      "order-list.save",
      {
        storeId: "s1",
        name: "Weekly restock",
        lines: [{ ...line, unitPriceCents: 1, totalCents: 1 }],
        notes: "Back door",
      },
      customer,
      "save-once",
    ),
    saved,
  );
  await assert.rejects(
    () =>
      f.run(
        "order-list.delete",
        { storeId: "s1", id: saved.id, expectedVersion: saved.version },
        staff,
      ),
    { code: "FORBIDDEN" },
  );
  await assert.rejects(
    () =>
      f.run("order-list.save", { storeId: "s2", name: "Other", lines: [line] }),
    { code: "FORBIDDEN" },
  );
  await assert.rejects(
    () =>
      f.run("order-list.save", {
        storeId: "s1",
        id: saved.id,
        name: "Stale",
        lines: [line],
        expectedVersion: 0,
      }),
    { code: "VERSION_CONFLICT" },
  );
  const removed = await f.run("order-list.delete", {
    storeId: "s1",
    id: saved.id,
    expectedVersion: 1,
  });
  assert.equal(removed.deleted, true);
});
test("saved item lists reject invalid quantities and preserve mix and each exclusions", async () => {
  const f = fixture();
  for (const quantity of [0, -1, 1.5, "2", 1000001])
    await assert.rejects(
      () =>
        f.run("order-list.save", {
          storeId: "s1",
          name: "List",
          lines: [{ ...line, quantity }],
        }),
      { code: "INVALID_INPUT" },
    );
  const mixed = {
    ...line,
    variant: "",
    selectionMode: "each",
    allowedVariants: ["Orange"],
    excludedVariants: ["Lime"],
  };
  const saved = await f.run("order-list.save", {
    storeId: "s1",
    name: "Each",
    lines: [mixed],
  });
  assert.equal(saved.lines[0].selectionMode, "each");
  assert.deepEqual(saved.lines[0].excludedVariants, ["Lime"]);
});
test("delivery evidence stays private and creates a pending request without credit or stock changes", async () => {
  const f = fixture(),
    payload = {
      orderId: "order",
      lines: [{ lineId: "line", variant: "Orange", quantity: 1 }],
      reason: "One item missing",
      issueType: "missing",
      pickupRequested: false,
      photos: [{ mimeType: "image/png", data: png }],
    };
  const result = await f.run("return.create", payload, customer, "issue-once");
  assert.equal(result.issueType, "missing");
  assert.equal(result.status, "pending");
  assert.equal(result.photos.length, 1);
  assert.equal(result.photos[0].data, undefined);
  const photo = await f.repo.get("returnPhotos", result.photos[0].id);
  assert.equal(photo.storeId, "s1");
  assert.equal(photo.returnId, result.id);
  assert.equal(photo.data, png);
  assert.deepEqual(await f.repo.list("ledger"), []);
  assert.deepEqual(await f.repo.list("inventory"), []);
  assert.deepEqual(
    await f.run("return.create", payload, customer, "issue-once"),
    result,
  );
  assert.equal((await f.repo.list("returnPhotos")).length, 1);
  await assert.rejects(
    () =>
      f.run(
        "return.pickup",
        {
          storeId: "s1",
          returnId: result.id,
          expectedVersion: 1,
          lines: [{ lineId: "line", variant: "Orange", quantity: 1 }],
        },
        staff,
      ),
    { code: "INVALID_TRANSITION" },
  );
});
test("delivery evidence rejects SVG, mislabeled images, oversized data and too many photos atomically", async () => {
  for (const photos of [
    [
      {
        mimeType: "image/svg+xml",
        data: Buffer.from("<svg/>").toString("base64"),
      },
    ],
    [{ mimeType: "image/jpeg", data: png }],
    [{ mimeType: "image/png", data: "!" }],
    [{ mimeType: "image/png", data: "a".repeat(300000) }],
    Array(4).fill({ mimeType: "image/png", data: png }),
  ]) {
    const f = fixture();
    await assert.rejects(() =>
      f.run("return.create", {
        orderId: "order",
        lines: [{ lineId: "line", variant: "Orange", quantity: 1 }],
        reason: "Damaged",
        issueType: "damaged",
        photos,
      }),
    );
    assert.equal((await f.repo.list("returns")).length, 0);
    assert.equal((await f.repo.list("returnPhotos")).length, 0);
  }
});
