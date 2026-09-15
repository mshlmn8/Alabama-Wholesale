const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
let modulePromise;
async function load() {
  const modulePath = path.join(__dirname, "../public/order-downloads.js");
  assert.ok(
    fs.existsSync(modulePath),
    "The completed-order download module is available",
  );
  return (modulePromise ||= import(
    "data:text/javascript;base64," +
      Buffer.from(fs.readFileSync(modulePath, "utf8")).toString("base64")
  ));
}
function order(overrides = {}) {
  return {
    id: "order-1",
    storeId: "store-1",
    version: 2,
    status: "submitted",
    invoiceNumber: "AW-2026-000123",
    submittedAt: 1789372800000,
    storeSnapshot: { id: "store-1", name: "Original customer" },
    lines: [
      {
        id: "line-1",
        productId: "product-1",
        name: "Original product",
        variant: "Lime",
        quantity: 2,
        unit: "each",
        unitPriceCents: 125,
        lineTotalCents: 250,
        taxCents: 20,
        note: "Receiving note",
      },
    ],
    subtotalCents: 250,
    taxCents: 20,
    totalCents: 270,
    notes: "Order note",
    ...overrides,
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
  const { createOrderDownloads } = await load();
  const downloads = [],
    changes = [],
    fetches = [];
  let current = true;
  const downloader = createOrderDownloads({
    fetchPdf: async (record) => {
      fetches.push(record);
      return options.fetchPdf
        ? options.fetchPdf(record)
        : new Blob(["%PDF-1.7\nconfirmed invoice\n%%EOF"], {
            type: "application/pdf",
          });
    },
    download: async (name, content, mime) => {
      downloads.push({ name, content, mime });
      return options.download?.(name, content, mime);
    },
    isCurrent: () => current,
    onChange: (id, status) => {
      changes.push({ id, status });
      options.onChange?.(id, status);
    },
  });
  return {
    downloader,
    downloads,
    changes,
    fetches,
    switchAccount() {
      current = false;
    },
  };
}
test("device copies default to enabled PDF and honor explicit off and supported formats", async () => {
  const { normalizeDeviceCopyOptions } = await load();
  assert.deepEqual(normalizeDeviceCopyOptions(), {
    enabled: true,
    format: "pdf",
  });
  assert.deepEqual(
    normalizeDeviceCopyOptions({ enabled: false, format: "both" }),
    { enabled: false, format: "both" },
  );
  assert.deepEqual(
    normalizeDeviceCopyOptions({ enabled: "false", format: "unsupported" }),
    { enabled: true, format: "pdf" },
  );
  const f = await fixture();
  const off = await f.downloader.automatic(order(), {
    requestId: "confirmed-1",
    options: { enabled: false },
  });
  assert.equal(off.phase, "idle");
  assert.equal(f.fetches.length, 0);
  assert.equal(f.downloads.length, 0);
});
test("a confirmed submission requests an invoice PDF without claiming a disk save", async () => {
  const f = await fixture();
  const result = await f.downloader.automatic(order(), {
    requestId: "submit-1",
  });
  assert.equal(result.phase, "requested");
  assert.deepEqual(result.requestedFormats, ["pdf"]);
  assert.equal(f.downloads.length, 1);
  assert.equal(f.downloads[0].mime, "application/pdf");
  assert.equal(f.downloads[0].name, "AW-2026-000123-order-1.pdf");
  assert.equal(
    await f.downloads[0].content.text(),
    "%PDF-1.7\nconfirmed invoice\n%%EOF",
  );
  assert.equal("saved" in result, false);
  assert.equal(f.changes[0].status.phase, "preparing");
});
test("PDF and browser-download failures resolve separate errors rather than failing submission", async () => {
  for (const options of [
    {
      fetchPdf: async () => {
        throw new Error("PDF is unavailable");
      },
    },
    {
      download: async () => {
        throw new Error("Browser blocked download");
      },
    },
  ]) {
    const f = await fixture(options);
    const result = await f.downloader.automatic(order(), {
      requestId: "submit-1",
    });
    assert.equal(result.phase, "error");
    assert.deepEqual(result.failedFormats, ["pdf"]);
    assert.ok(result.error);
    assert.equal(result.requestedFormats.length, 0);
  }
});
test("automatic receipts deduplicate while manual retry remains available with automatic copies off", async () => {
  const f = await fixture();
  await f.downloader.automatic(order(), { requestId: "submit-1" });
  await f.downloader.automatic(order(), { requestId: "submit-1" });
  assert.equal(f.fetches.length, 1);
  await f.downloader.save(order(), { enabled: false, format: "pdf" });
  assert.equal(f.fetches.length, 2);
});
test("JSON archives contain complete frozen order data and no command replay wrapper", async () => {
  const f = await fixture();
  const result = await f.downloader.save(order(), { format: "json" });
  assert.equal(result.phase, "requested");
  assert.equal(f.fetches.length, 0);
  assert.equal(f.downloads[0].mime, "application/json");
  const archive = JSON.parse(f.downloads[0].content);
  assert.equal(archive.format, "aw-order-copy");
  assert.equal(archive.version, 1);
  assert.deepEqual(archive.order, order());
  assert.ok(Number.isFinite(Date.parse(archive.exportedAt)));
  assert.equal(archive.commands, undefined);
  assert.equal(archive.queue, undefined);
});
test("both formats can report partial success without repeating the successful submission", async () => {
  const f = await fixture({
    fetchPdf: async () => {
      throw new Error("offline");
    },
  });
  const result = await f.downloader.automatic(order(), {
    requestId: "submit-1",
    options: { format: "both" },
  });
  assert.equal(result.phase, "partial");
  assert.deepEqual(result.requestedFormats, ["json"]);
  assert.deepEqual(result.failedFormats, ["pdf"]);
  assert.equal(f.downloads[0].mime, "application/json");
  await f.downloader.automatic(order(), {
    requestId: "submit-1",
    options: { format: "both" },
  });
  assert.equal(f.downloads.length, 1);
});
test("drafts, summaries, legacy history and incomplete invoices never download", async () => {
  for (const bad of [
    order({ status: "draft" }),
    order({ summary: true }),
    order({ status: "legacy" }),
    order({ invoiceNumber: null }),
    order({ lines: [] }),
    order({ lines: [{ quantity: 1 }] }),
    order({ totalCents: 999 }),
    order({ legacy: { needsPriceReview: true } }),
  ]) {
    const f = await fixture();
    const result = await f.downloader.save(bad, { format: "both" });
    assert.equal(result.phase, "error");
    assert.equal(f.fetches.length, 0);
    assert.equal(f.downloads.length, 0);
  }
});
test("account changes or disposal during PDF preparation prevent late downloads", async () => {
  for (const dispose of [false, true]) {
    const gate = deferred();
    const f = await fixture({ fetchPdf: () => gate.promise });
    const waiting = f.downloader.automatic(order(), { requestId: "submit-1" });
    await Promise.resolve();
    if (dispose) f.downloader.dispose();
    else f.switchAccount();
    const changes = f.changes.length;
    gate.resolve(new Blob(["%PDF-1.7\n%%EOF"]));
    const result = await waiting;
    assert.equal(result.phase, "idle");
    assert.equal(result.code, "SESSION_CHANGED");
    assert.equal(f.downloads.length, 0);
    assert.equal(f.changes.length, changes);
  }
});
test("concurrent requests for one order share preparation and duplicate receipts do not restart failures", async () => {
  const gate = deferred();
  const f = await fixture({ fetchPdf: () => gate.promise });
  const a = f.downloader.automatic(order(), { requestId: "submit-1" }),
    b = f.downloader.automatic(order(), { requestId: "submit-2" }),
    c = f.downloader.save(order());
  await Promise.resolve();
  assert.equal(f.fetches.length, 1);
  gate.reject(new Error("temporarily unavailable"));
  const results = await Promise.all([a, b, c]);
  assert.ok(results.every((result) => result.phase === "error"));
  await f.downloader.automatic(order(), { requestId: "submit-1" });
  await f.downloader.automatic(order(), { requestId: "submit-2" });
  assert.equal(f.fetches.length, 1);
});
test("both downloads use a frozen snapshot even if the visible order changes during PDF preparation", async () => {
  const gate = deferred();
  const f = await fixture({ fetchPdf: () => gate.promise });
  const original = order();
  const waiting = f.downloader.save(original, { format: "both" });
  original.notes = "edited later";
  original.lines[0].name = "new catalog name";
  await Promise.resolve();
  gate.resolve(new Blob(["%PDF-1.7\n%%EOF"]));
  const result = await waiting;
  assert.equal(result.phase, "requested");
  assert.deepEqual(result.requestedFormats, ["pdf", "json"]);
  const archive = JSON.parse(f.downloads[1].content);
  assert.equal(archive.order.notes, "Order note");
  assert.equal(archive.order.lines[0].name, "Original product");
  assert.equal(f.fetches[0].lines[0].name, "Original product");
});
test("final fulfillment and cancellation invoices remain downloadable while unknown statuses do not", async () => {
  for (const status of [
    "submitted",
    "approved",
    "picking",
    "delivered",
    "cancelled",
  ]) {
    const f = await fixture();
    assert.equal(
      (await f.downloader.save(order({ status }), { format: "json" })).phase,
      "requested",
    );
  }
  const f = await fixture();
  assert.equal(
    (await f.downloader.save(order({ status: "payment-pending" }))).phase,
    "error",
  );
  assert.equal(f.fetches.length, 0);
});
test("HTML, incomplete PDFs and non-Blob responses are not downloaded as invoices", async () => {
  for (const content of [
    new Blob(["<html>Login required</html>"], { type: "text/html" }),
    new Blob(["%PD"]),
    { type: "application/pdf", size: 123 },
  ]) {
    const f = await fixture({ fetchPdf: async () => content });
    const result = await f.downloader.save(order());
    assert.equal(result.phase, "error");
    assert.equal(result.code, "INVALID_PDF");
    assert.equal(f.downloads.length, 0);
  }
});
test("filenames are bounded path-safe names and do not embed raw invoice text", async () => {
  const f = await fixture();
  await f.downloader.save(
    order({
      id: "../../order\\unsafe",
      invoiceNumber: "../ Invoice / <name>\u0000 " + "x".repeat(200),
    }),
    { format: "both" },
  );
  for (const item of f.downloads) {
    assert.match(item.name, /^[A-Za-z0-9_-]+\.(pdf|json)$/);
    assert.ok(item.name.length < 170);
  }
});
test("a late account change during PDF-byte validation prevents downloading private content", async () => {
  const gate = deferred();
  class DelayedBlob extends Blob {
    slice() {
      return { text: () => gate.promise };
    }
  }
  const f = await fixture({
    fetchPdf: async () => new DelayedBlob(["%PDF-1.7\n%%EOF"]),
  });
  const waiting = f.downloader.save(order());
  for (let i = 0; i < 10; i++) await Promise.resolve();
  f.switchAccount();
  gate.resolve("%PDF-");
  assert.equal((await waiting).code, "SESSION_CHANGED");
  assert.equal(f.downloads.length, 0);
});
test("observer exceptions cannot reject successful downloads and status snapshots cannot mutate internal state", async () => {
  const f = await fixture({
    onChange: () => {
      throw new Error("view closed");
    },
  });
  const result = await f.downloader.save(order(), { format: "json" });
  assert.equal(result.phase, "requested");
  result.requestedFormats.push("forged");
  const snapshot = f.downloader.status("order-1");
  assert.deepEqual(snapshot.requestedFormats, ["json"]);
  snapshot.phase = "error";
  assert.equal(f.downloader.status("order-1").phase, "requested");
});
test("new work after disposal or a mismatched receipt never fetches another order", async () => {
  const f = await fixture();
  await f.downloader.automatic(order(), { requestId: "submit-1" });
  const mismatch = await f.downloader.automatic(order({ id: "order-2" }), {
    requestId: "submit-1",
  });
  assert.equal(mismatch.code, "RECEIPT_MISMATCH");
  assert.equal(f.fetches.length, 1);
  f.downloader.dispose();
  const after = await f.downloader.save(order({ id: "order-3" }));
  assert.equal(after.code, "SESSION_CHANGED");
  assert.equal(f.fetches.length, 1);
});

test("both formats let the first browser navigation settle before requesting the second download", async () => {
  let firstNavigationSettled = false;
  const f = await fixture({
    download: (_name, _content, mime) => {
      if (mime === "application/pdf")
        setTimeout(() => {
          firstNavigationSettled = true;
        }, 50);
      else
        assert.equal(
          firstNavigationSettled,
          true,
          "The JSON click must occur in a later browser task.",
        );
    },
  });
  const result = await f.downloader.save(order(), { format: "both" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(result.phase, "requested");
  assert.deepEqual(result.requestedFormats, ["pdf", "json"]);
});
test("an account switch between format downloads suppresses the second private file", async () => {
  let f;
  f = await fixture({
    download: (_name, _content, mime) => {
      if (mime === "application/pdf") setTimeout(() => f.switchAccount(), 0);
    },
  });
  const result = await f.downloader.save(order(), { format: "both" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.downloads.length, 1);
  assert.equal(f.downloads[0].mime, "application/pdf");
  assert.equal(result.code, "SESSION_CHANGED");
});
