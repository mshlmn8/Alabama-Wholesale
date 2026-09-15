"use strict";
const { createHash, randomUUID } = require("node:crypto");
const COLLECTION = "productImageJobs";
const fingerprint = (p) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        p.name || "",
        p.sku || "",
        p.barcode || "",
        p.variants || [],
      ]),
    )
    .digest("hex");
const eligible = (p) => p && !p.deleted && p.active !== false && !p.image;
const fail = (status, code, message) => {
  throw Object.assign(new Error(message), { status, code, expose: true });
};
function sourceUrl(value) {
  if (typeof value !== "string" || value.length > 2000)
    fail(
      400,
      "invalid_source",
      "Enter a manufacturer or supplier HTTPS product-page link.",
    );
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(400, "invalid_source", "Enter a valid HTTPS product-page link.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    fail(
      400,
      "invalid_source",
      "Use an HTTPS product-page link without a login or custom port.",
    );
  url.hash = "";
  return url.href;
}
async function queueProductImage(
  tx,
  product,
  { now = Date.now(), force = false, sourcePage = "" } = {},
) {
  if (!eligible(product)) return null;
  const previous = await tx.get(COLLECTION, product.id);
  const hash = fingerprint(product);
  if (
    !force &&
    previous?.fingerprint === hash &&
    !["applied", "skipped"].includes(previous.status)
  )
    return previous;
  if (previous?.status === "processing" && previous.leaseUntil > now) {
    if (force)
      fail(
        409,
        "image_in_progress",
        "This product photo is being checked. Try again shortly.",
      );
    if (previous.fingerprint === hash) return previous;
  }
  const job = {
    id: product.id,
    productId: product.id,
    name: product.name,
    fingerprint: hash,
    status: "queued",
    sourcePage,
    attempts: 0,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    message: "Waiting for Gemini to find and verify a matching photo.",
  };
  await tx.set(COLLECTION, product.id, job);
  return job;
}
async function getProductImages(repo, { configured = false } = {}) {
  const [products, jobs] = await Promise.all([
    repo.list("products"),
    repo.list(COLLECTION),
  ]);
  const active = products.filter((p) => !p.deleted && p.active !== false);
  const activeIds = new Set(active.map((p) => p.id));
  const visible = jobs.filter((j) => activeIds.has(j.productId));
  const counts = {
    withPhoto: active.filter((p) => !!p.image).length,
    missing: active.filter(eligible).length,
    queued: 0,
    processing: 0,
    applied: 0,
    needs_review: 0,
    failed: 0,
  };
  for (const job of visible)
    if (Object.hasOwn(counts, job.status)) counts[job.status]++;
  return {
    configured,
    automatic: configured,
    counts,
    jobs: visible
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map(({ productId, name, status, message, sourcePage, updatedAt }) => ({
        productId,
        name,
        status,
        message,
        sourcePage,
        updatedAt,
      })),
  };
}
async function changeProductImages(repo, input, { now = Date.now } = {}) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !["queue_missing", "retry", "source"].includes(input.action)
  )
    fail(400, "invalid_image_action", "Choose a product photo action.");
  if (
    Object.keys(input).some(
      (k) => !["action", "productId", "sourcePage"].includes(k),
    )
  )
    fail(400, "invalid_image_action", "Unknown product photo option.");
  if (input.action === "queue_missing") {
    const products = await repo.list("products");
    let queued = 0;
    const missing = products.filter(eligible);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(8, missing.length) }, async () => {
        while (cursor < missing.length) {
          const product = missing[cursor++];
          const didQueue = await repo.transaction(async (tx) => {
            const fresh = await tx.get("products", product.id);
            if (!eligible(fresh)) return false;
            const before = await tx.get(COLLECTION, product.id);
            const job = await queueProductImage(tx, fresh, { now: now() });
            return (
              job?.status === "queued" &&
              (before?.fingerprint !== job.fingerprint ||
                before?.status !== "queued")
            );
          });
          if (didQueue) queued++;
        }
      }),
    );
    return { queued };
  }
  if (
    typeof input.productId !== "string" ||
    !input.productId ||
    input.productId.length > 200 ||
    input.productId.includes("/")
  )
    fail(400, "invalid_product", "Select a product.");
  const page = input.action === "source" ? sourceUrl(input.sourcePage) : "";
  return repo.transaction(async (tx) => {
    const product = await tx.get("products", input.productId);
    if (!eligible(product))
      fail(
        409,
        "photo_not_missing",
        "This product already has a photo or is inactive. Refresh the catalog.",
      );
    const prior = await tx.get(COLLECTION, product.id);
    if (prior?.updatedAt > now() - 60000)
      fail(
        429,
        "photo_retry_limit",
        "Wait one minute before retrying this product.",
      );
    return {
      job: await queueProductImage(tx, product, {
        now: now(),
        force: true,
        sourcePage: page || prior?.sourcePage || "",
      }),
    };
  });
}
async function runProductImages(
  repo,
  {
    provider,
    assets,
    now = Date.now,
    onApplied = () => {},
    dailyLimit = 350,
  } = {},
) {
  if (!provider || !assets) return { configured: false, processed: 0 };
  const time = now();
  const rows = await repo.list(COLLECTION, {
    where: [["status", "in", ["queued", "processing"]]],
    limit: 1000,
  });
  const next = rows
    .filter((j) => j.status === "queued" || j.leaseUntil <= time)
    .sort((a, b) => a.updatedAt - b.updatedAt);
  let claim;
  for (const row of next) {
    claim = await repo.transaction(async (tx) => {
      const job = await tx.get(COLLECTION, row.id);
      if (
        !job ||
        !(
          job.status === "queued" ||
          (job.status === "processing" && job.leaseUntil <= time)
        )
      )
        return null;
      const p = await tx.get("products", job.productId);
      if (!eligible(p) || fingerprint(p) !== job.fingerprint) {
        await tx.set(COLLECTION, job.id, {
          ...job,
          status: "skipped",
          updatedAt: time,
          message:
            "Product changed or already has a photo; existing work was preserved.",
        });
        return null;
      }
      if (job.attempts >= 3) {
        await tx.set(COLLECTION, job.id, {
          ...job,
          status: "failed",
          updatedAt: time,
          message:
            "Photo matching was interrupted repeatedly. Retry from Product photos.",
        });
        return null;
      }
      const budgetId = `product-photos-${Math.floor(time / 86400000)}`;
      const budget = await tx.get("aiLimits", budgetId);
      if ((budget?.count || 0) >= dailyLimit) return null;
      const token = randomUUID();
      await tx.set("aiLimits", budgetId, {
        id: budgetId,
        count: (budget?.count || 0) + 1,
        expiresAt: time + 2 * 86400000,
      });
      await tx.set(COLLECTION, job.id, {
        ...job,
        status: "processing",
        lease: token,
        leaseUntil: time + 300000,
        attempts: (job.attempts || 0) + 1,
        updatedAt: time,
        message: "Gemini is checking a real product photo.",
      });
      return { job, product: p, token };
    });
    if (claim) break;
  }
  if (!claim) return { configured: true, processed: 0 };
  let result, uploaded;
  try {
    result = await provider(claim.product, {
      sourcePage: claim.job.sourcePage,
    });
    if (result.image) uploaded = await assets.upload(result.image);
  } catch (e) {
    result = {
      failed: true,
      message: [
        "provider_timeout",
        "provider_busy",
        "provider_unavailable",
        "invalid_response",
      ].includes(e.code)
        ? e.message
        : "The photo source could not be checked. Retry later or add a supplier product-page link.",
    };
  }
  const status = await repo.transaction(async (tx) => {
    const job = await tx.get(COLLECTION, claim.job.id);
    if (!job || job.lease !== claim.token || job.status !== "processing")
      return "superseded";
    const product = await tx.get("products", job.productId);
    let status = result.failed ? "failed" : "needs_review";
    let message = String(
      result.message ||
        "No confidently matching photo found. Add a supplier product-page link.",
    ).slice(0, 500);
    if (!eligible(product) || fingerprint(product) !== job.fingerprint) {
      status = "skipped";
      message =
        "Product changed or already has a photo; existing work was preserved.";
    } else if (uploaded?.url) {
      status = "applied";
      message =
        "A matching real product photo was added. Review it in the catalog.";
      const source = {
        page: result.sourcePage,
        image: result.sourceImage,
        model: result.model,
        confidence: result.confidence,
        reason: result.reason,
        verifiedAt: now(),
      };
      await tx.set("products", product.id, {
        ...product,
        image: uploaded.url,
        imageSource: source,
        version: (product.version || 0) + 1,
        updatedAt: now(),
        updatedBy: "product-photo-worker",
      });
      const id = randomUUID();
      await tx.set("audit", id, {
        id,
        type: "product.photo_added",
        productId: product.id,
        actorId: "product-photo-worker",
        createdAt: now(),
        sourcePage: result.sourcePage,
      });
    }
    await tx.set(COLLECTION, job.id, {
      ...job,
      status,
      message,
      updatedAt: now(),
      lease: "",
      leaseUntil: 0,
      ...(status === "applied" ? { sourcePage: result.sourcePage } : {}),
    });
    return status;
  });
  if (status === "applied") onApplied();
  return {
    configured: true,
    processed: 1,
    productId: claim.product.id,
    status,
  };
}
module.exports = {
  queueProductImage,
  getProductImages,
  changeProductImages,
  runProductImages,
  fingerprint,
  sourceUrl,
};
