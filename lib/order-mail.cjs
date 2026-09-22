"use strict";
const { createHash, randomUUID } = require("node:crypto");
const { loadProductCategories } = require("./domain.cjs");
const {
  parseFrom,
  rejectedOutcome,
  boundedSend,
} = require("./notifications.cjs");
const RECIPIENT = "alwholesaleorders@gmail.com";
const COLLECTION = "orderMailJobs";
const LEASE_MS = 60000;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const jobId = (orderId) => `invoice-${hash(orderId)}`;
const fail = (status, code, message) => {
  throw Object.assign(new Error(message), { status, code, expose: true });
};
const validId = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 200 &&
  !/[\x00-\x20/]/.test(value);
const timestamp = (value) => {
  const result = typeof value === "function" ? value() : value ?? Date.now();
  if (!Number.isSafeInteger(result) || result < 0)
    throw new TypeError("now must provide epoch milliseconds");
  return result;
};
const publicJob = (row) =>
  row
    ? Object.fromEntries(
        [
          "id",
          "orderId",
          "storeId",
          "requestedBy",
          "source",
          "to",
          "status",
          "scheduledAt",
          "createdAt",
          "updatedAt",
          "sentAt",
          "version",
          "attempts",
          "retryable",
          "lastError",
          "deliveryStatus",
        ]
          .filter((key) => row[key] !== undefined)
          .map((key) => [key, row[key]]),
      )
    : null;
function actorAccess(actor, storeId) {
  if (
    !actor ||
    actor.active !== true ||
    !["master", "salesman", "customer"].includes(actor.role)
  )
    fail(
      403,
      "mail_access_denied",
      "Your account no longer has access to send this order.",
    );
  if (actor.role !== "master" && !actor.storeIds?.includes(storeId))
    fail(403, "store_forbidden", "You do not have access to this store.");
}
async function authorizedOrder(
  repo,
  actor,
  orderId,
  { confirmed = true } = {},
) {
  if (!validId(orderId) || !validId(actor?.uid))
    fail(400, "invalid_mail_input", "Choose a valid order and account.");
  const [order, user] = await Promise.all([
    repo.get("orders", orderId),
    repo.get("users", actor.uid),
  ]);
  if (!order || order.deleted)
    fail(404, "order_not_found", "This order was not found.");
  actorAccess(user, order.storeId);
  if (
    confirmed &&
    (!["submitted", "approved", "picking", "delivered"].includes(
      order.status,
    ) ||
      !order.invoiceNumber ||
      order.legacy?.needsPriceReview ||
      order.legacy?.requiresReview ||
      order.migrationBlocked)
  )
    fail(
      409,
      "order_not_confirmed",
      "Only submitted orders with confirmed invoice details can be emailed.",
    );
  if (confirmed) {
    const store = await repo.get("stores", order.storeId);
    if (!store || store.active === false)
      fail(409, "mail_store_inactive", "This store is no longer active.");
    return { order, user, store };
  }
  return { order, user };
}
function manage(user, order, row) {
  if (
    user.role === "customer" &&
    (order.createdBy !== (user.uid || user.id) ||
      (row && row.requestedBy !== (user.uid || user.id)))
  )
    fail(
      403,
      "mail_manage_forbidden",
      "Only the requester or authorized staff can manage this order email.",
    );
}
async function getOrderMailConfig(repo, { configured = false } = {}) {
  const settings = await repo.get("settings", "orderMail");
  return {
    configured: !!configured,
    recipient: RECIPIENT,
    automatic: settings?.automatic === true,
    automaticDelaySeconds: 300,
    version: settings?.version || 0,
  };
}
async function updateOrderMailSettings(
  repo,
  actor,
  input,
  { now, configured = false } = {},
) {
  if (
    !input ||
    typeof input.automatic !== "boolean" ||
    Object.keys(input).some(
      (key) => !["automatic", "expectedVersion"].includes(key),
    )
  )
    fail(
      400,
      "invalid_mail_input",
      "Choose whether new submitted orders are emailed automatically.",
    );
  return repo.transaction(async (tx) => {
    const user = actor?.uid && (await tx.get("users", actor.uid));
    if (!user || user.active !== true || user.role !== "master")
      fail(
        403,
        "mail_settings_forbidden",
        "An administrator must change automatic order email settings.",
      );
    if (input.automatic && !configured)
      fail(
        503,
        "sender_not_configured",
        "Connect the dedicated email sender before enabling automatic order emails.",
      );
    const current = await tx.get("settings", "orderMail");
    if (input.expectedVersion !== (current?.version || 0))
      fail(
        409,
        "mail_version_conflict",
        "Email settings changed. Refresh before saving.",
      );
    const next = {
      id: "orderMail",
      automatic: input.automatic,
      version: (current?.version || 0) + 1,
      updatedAt: timestamp(now),
      updatedBy: actor.uid,
    };
    await tx.set("settings", "orderMail", next);
    await tx.set("audit", randomUUID(), {
      type: "order.email.settings",
      actorId: actor.uid,
      automatic: input.automatic,
      createdAt: next.updatedAt,
    });
    return { automatic: next.automatic, version: next.version };
  });
}
async function getOrderMail(repo, actor, orderId) {
  await authorizedOrder(repo, actor, orderId, { confirmed: false });
  return publicJob(await repo.get(COLLECTION, jobId(orderId)));
}
function makeJob(
  order,
  actor,
  now,
  { source = "manual", scheduledAt = now } = {},
) {
  return {
    id: jobId(order.id),
    orderId: order.id,
    storeId: order.storeId,
    requestedBy: actor.uid,
    source,
    to: RECIPIENT,
    status: "queued",
    scheduledAt,
    nextRunAt: scheduledAt,
    createdAt: now,
    updatedAt: now,
    version: 1,
    attempts: 0,
    claimToken: null,
    leaseExpiresAt: null,
    retryable: true,
    lastError: null,
  };
}
async function queueAutomaticOrderMail(
  tx,
  actor,
  order,
  { now, configured = false } = {},
) {
  const settings = await tx.get("settings", "orderMail");
  if (!configured || settings?.automatic !== true) return null;
  const existing = await tx.get(COLLECTION, jobId(order.id));
  if (existing) return publicJob(existing);
  // Called only inside the transaction that first changes draft -> submitted.
  const { user } = await authorizedOrder(tx, actor, order.id);
  manage(user, order, null);
  const row = makeJob(order, actor, timestamp(now), {
    source: "automatic",
    scheduledAt: timestamp(now) + 300000,
  });
  await tx.set(COLLECTION, row.id, row);
  return publicJob(row);
}
async function changeOrderMail(repo, actor, orderId, input, { now } = {}) {
  if (
    !input ||
    !validId(input.requestId) ||
    !["send", "schedule", "cancel", "retry"].includes(input.action) ||
    Object.keys(input).some(
      (key) =>
        ![
          "requestId",
          "action",
          "scheduledAt",
          "expectedVersion",
          "acknowledgeDuplicateRisk",
        ].includes(key),
    )
  )
    fail(
      400,
      "invalid_mail_input",
      "Choose a valid email action and request ID.",
    );
  const clock = timestamp(now);
  if (input.action !== "schedule" && input.scheduledAt !== undefined)
    fail(
      400,
      "invalid_mail_input",
      "A scheduled time is only accepted for scheduling.",
    );
  const fingerprint = hash(
    JSON.stringify([
      orderId,
      input.action,
      input.scheduledAt ?? null,
      input.expectedVersion ?? null,
      input.acknowledgeDuplicateRisk === true,
    ]),
  );
  return repo.transaction(async (tx) => {
    const { order, user } = await authorizedOrder(tx, actor, orderId, {
      confirmed: input.action !== "cancel",
    });
    const id = jobId(orderId),
      receiptId = `order-mail-${hash(`${actor.uid}\n${input.requestId}`)}`;
    const [row, receipt] = await Promise.all([
      tx.get(COLLECTION, id),
      tx.get("commandReceipts", receiptId),
    ]);
    manage(user, order, row);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint)
        fail(
          409,
          "mail_request_conflict",
          "This request ID was already used for a different email action.",
        );
      return receipt.result;
    }
    // An exact lost-response retry must work even after its original scheduled time.
    if (
      input.action === "schedule" &&
      (!Number.isSafeInteger(input.scheduledAt) ||
        input.scheduledAt <= clock ||
        input.scheduledAt > clock + 366 * 86400000)
    )
      fail(
        400,
        "invalid_mail_schedule",
        "Choose a future time within the next year.",
      );
    if (input.expectedVersion !== (row?.version || 0))
      fail(
        409,
        "mail_version_conflict",
        "This email changed. Refresh its status before trying again.",
      );
    let next;
    if (input.action === "cancel") {
      if (!row || !["queued", "preparing", "cancelled"].includes(row.status))
        fail(
          409,
          "mail_already_started",
          "An email can only be cancelled before sending begins.",
        );
      next = {
        ...row,
        status: "cancelled",
        nextRunAt: null,
        claimToken: null,
        leaseExpiresAt: null,
        retryable: false,
      };
    } else {
      if (row?.status === "sent")
        fail(
          409,
          "mail_already_sent",
          "The mail provider already accepted this invoice. It will not be sent again automatically.",
        );
      if (row?.status === "sending")
        fail(
          409,
          "mail_already_started",
          "This email is being sent. Wait for its final status.",
        );
      if (input.action === "retry") {
        if (!row || !["failed", "uncertain"].includes(row.status))
          fail(
            409,
            "mail_retry_unavailable",
            "Only a failed or uncertain email can be retried.",
          );
        if (row.status === "uncertain") {
          if (user.role !== "master")
            fail(
              403,
              "mail_retry_forbidden",
              "An administrator must review an uncertain email before retrying.",
            );
          if (input.acknowledgeDuplicateRisk !== true)
            fail(
              409,
              "mail_duplicate_risk",
              "Check the sender account, then acknowledge that retrying might send a duplicate.",
            );
        }
      } else if (row && ["failed", "uncertain"].includes(row.status))
        fail(
          409,
          "mail_retry_required",
          "Review the failed email and use its explicit retry action.",
        );
      next = {
        ...(row || makeJob(order, actor, clock)),
        requestedBy: actor.uid,
        status: "queued",
        scheduledAt: input.action === "schedule" ? input.scheduledAt : clock,
        nextRunAt: input.action === "schedule" ? input.scheduledAt : clock,
        claimToken: null,
        leaseExpiresAt: null,
        lastError: null,
        retryable: true,
      };
    }
    next = { ...next, updatedAt: clock, version: (row?.version || 0) + 1 };
    const result = publicJob(next);
    await tx.set(COLLECTION, id, next);
    await tx.set("commandReceipts", receiptId, {
      id: receiptId,
      fingerprint,
      result,
      createdAt: clock,
      actorId: actor.uid,
    });
    await tx.set("audit", randomUUID(), {
      type: `order.email.${input.action}`,
      orderId,
      storeId: order.storeId,
      actorId: actor.uid,
      jobId: id,
      createdAt: clock,
      ...(row?.status === "uncertain"
        ? { acknowledgeDuplicateRisk: true }
        : {}),
    });
    return result;
  });
}
async function finish(tx, row, outcome, now) {
  const next = {
    ...row,
    ...outcome,
    nextRunAt: null,
    leaseExpiresAt: null,
    updatedAt: now,
    version: row.version + 1,
    ...(outcome.status === "sent" ? { sentAt: now } : {}),
  };
  await tx.set(COLLECTION, row.id, next);
  await tx.set("audit", randomUUID(), {
    type: `order.email.${outcome.status}`,
    jobId: row.id,
    orderId: row.orderId,
    storeId: row.storeId,
    actorId: row.requestedBy,
    createdAt: now,
  });
  return next;
}
const unavailable = () => ({
  status: "failed",
  retryable: true,
  lastError: {
    code: "mail_access_changed",
    message:
      "The order, requester or store is no longer eligible. Restore access and review the order before retrying.",
  },
});
const uncertain = () => ({
  status: "uncertain",
  retryable: false,
  lastError: {
    code: "send_outcome_unknown",
    message:
      "The email outcome is unknown. Check the sender account before requesting an administrator retry to avoid a duplicate.",
  },
});
async function claim(repo, id, clock) {
  return repo.transaction(async (tx) => {
    const row = await tx.get(COLLECTION, id),
      now = timestamp(clock);
    if (
      !row ||
      !["queued", "preparing", "sending"].includes(row.status) ||
      row.nextRunAt > now
    )
      return null;
    if (row.status === "sending") {
      await finish(tx, row, uncertain(), now);
      return { outcome: "uncertain" };
    }
    let data;
    try {
      data = await authorizedOrder(tx, { uid: row.requestedBy }, row.orderId);
    } catch (e) {
      if (!e.expose) throw e;
      await finish(tx, row, unavailable(), now);
      return { outcome: "failed" };
    }
    const next = {
      ...row,
      status: "preparing",
      claimToken: randomUUID(),
      leaseExpiresAt: now + LEASE_MS,
      nextRunAt: now + LEASE_MS,
      updatedAt: now,
      version: row.version + 1,
    };
    await tx.set(COLLECTION, row.id, next);
    return { row: next, ...data };
  });
}
async function beginSend(repo, claimed, clock) {
  return repo.transaction(async (tx) => {
    const row = await tx.get(COLLECTION, claimed.id),
      now = timestamp(clock);
    if (
      !row ||
      row.status !== "preparing" ||
      row.claimToken !== claimed.claimToken ||
      row.leaseExpiresAt <= now
    )
      return null;
    try {
      await authorizedOrder(tx, { uid: row.requestedBy }, row.orderId);
    } catch (e) {
      if (!e.expose) throw e;
      await finish(tx, row, unavailable(), now);
      return { outcome: "failed" };
    }
    const next = {
      ...row,
      status: "sending",
      attempts: row.attempts + 1,
      leaseExpiresAt: now + LEASE_MS,
      nextRunAt: now + LEASE_MS,
      updatedAt: now,
      version: row.version + 1,
    };
    await tx.set(COLLECTION, row.id, next);
    return { row: next };
  });
}
async function saveOutcome(repo, claimed, outcome, clock) {
  return repo.transaction(async (tx) => {
    const row = await tx.get(COLLECTION, claimed.id);
    if (
      !row ||
      row.claimToken !== claimed.claimToken ||
      !["preparing", "sending", "uncertain"].includes(row.status)
    )
      return false;
    await finish(tx, row, outcome, timestamp(clock));
    return true;
  });
}
async function formatInvoiceEmail(repo, order, store) {
  // Issued snapshots are authoritative, including explicit uncategorized [].
  // Older invoices need only their own products and category ancestor paths.
  const productIds = new Set(
    (order.lines || [])
      .filter((line) => !Array.isArray(line.categoryNames))
      .map((line) => line.productId || line.itemId)
      .filter((id) => typeof id === "string" && id),
  );
  const products = [];
  for (const id of productIds) {
    const product = await repo.get("products", id);
    if (product) products.push(product);
  }
  const categories = await loadProductCategories(repo, products);
  const { formatOrder } = await import("../public/order-format.mjs");
  return formatOrder(order, {
    store,
    products,
    categories: [...categories.values()],
  });
}
async function deliverOrderMail(
  repo,
  {
    transport,
    from,
    now,
    limit = 20,
    workBudgetMs = 135000,
    sendTimeoutMs = 30000,
    render = require("./documents.cjs").renderDocument,
  } = {},
) {
  if (
    !Number.isSafeInteger(workBudgetMs) ||
    workBudgetMs < 1 ||
    workBudgetMs > 135000
  )
    throw new TypeError("workBudgetMs must be 1–135000");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
    throw new TypeError("limit must be 1–20");
  if (
    !Number.isSafeInteger(sendTimeoutMs) ||
    sendTimeoutMs < 1 ||
    sendTimeoutMs > 45000
  )
    throw new TypeError("sendTimeoutMs must be 1–45000");
  const configured = typeof transport?.sendMail === "function" && !!from;
  const summary = {
    configured,
    scanned: 0,
    claimed: 0,
    sent: 0,
    failed: 0,
    uncertain: 0,
    skipped: 0,
  };
  if (!configured) return summary;
  const sender = parseFrom(from),
    time = timestamp(now);
  const rows = await repo.list(COLLECTION, {
    where: [["status", "in", ["queued", "preparing", "sending"]]],
    orderBy: [["nextRunAt", "asc"]],
    limit,
  });
  async function processCandidate(candidate) {
    if (candidate.nextRunAt > time) return;
    summary.scanned++;
    const claimed = await claim(repo, candidate.id, now);
    if (!claimed) {
      summary.skipped++;
      return;
    }
    if (claimed.outcome) {
      summary[claimed.outcome]++;
      return;
    }
    summary.claimed++;
    let bytes, formatted;
    try {
      // Finish all catalog reads, formatting, and rendering before the sending
      // transition. Preparation failures cannot become uncertain SMTP attempts.
      [bytes, formatted] = await boundedSend(
        {
          sendMail: () =>
            Promise.all([
              render(claimed.order, claimed.store, "invoice"),
              formatInvoiceEmail(repo, claimed.order, claimed.store),
            ]),
        },
        null,
        45000,
      );
      if (
        !Buffer.isBuffer(bytes) ||
        bytes.length < 5 ||
        bytes.length > 10 * 1024 * 1024 ||
        bytes.subarray(0, 5).toString() !== "%PDF-"
      )
        throw Error("Invalid invoice PDF");
    } catch {
      const saved = await saveOutcome(
        repo,
        claimed.row,
        {
          status: "failed",
          retryable: true,
          lastError: {
            code: "invoice_pdf_failed",
            message:
              "The invoice email and PDF could not be prepared. The order remains saved online; retry the email after the preparation issue is fixed.",
          },
        },
        now,
      );
      summary[saved ? "failed" : "skipped"]++;
      return;
    }
    const started = await beginSend(repo, claimed.row, now);
    if (!started) {
      summary.skipped++;
      return;
    }
    if (started.outcome) {
      summary[started.outcome]++;
      return;
    }
    const row = started.row;
    const messageId = `<aw-order-${hash(row.id)}@${
      sender.address.split("@")[1]
    }>`;
    let outcome;
    try {
      const { orderFilename } = await import("../public/order-names.mjs");
      const info = await boundedSend(
        transport,
        {
          from: sender,
          to: RECIPIENT,
          subject: formatted.subject,
          text: formatted.text,
          html: formatted.html,
          messageId,
          attachments: [
            {
              filename: orderFilename(claimed.order),
              content: bytes,
              contentType: "application/pdf",
            },
          ],
          disableFileAccess: true,
          disableUrlAccess: true,
        },
        sendTimeoutMs,
      );
      const includes = (addresses) =>
        Array.isArray(addresses) &&
        addresses.some(
          (a) =>
            String(typeof a === "string" ? a : a?.address).toLowerCase() ===
            RECIPIENT,
        );
      outcome = includes(info?.accepted)
        ? {
            status: "sent",
            retryable: false,
            lastError: null,
            deliveryStatus: "accepted-by-provider",
            messageId,
          }
        : includes(info?.rejected)
        ? {
            status: "failed",
            retryable: true,
            lastError: {
              code: "smtp_recipient_rejected",
              message:
                "The mail server rejected the recipient. Correct the sender configuration before retrying.",
            },
          }
        : uncertain();
    } catch (error) {
      outcome = rejectedOutcome(error);
    }
    try {
      const saved = await saveOutcome(repo, row, outcome, now);
      summary[saved ? outcome.status : "uncertain"]++;
    } catch {
      // The SMTP server may have accepted the invoice. Never requeue on a lost DB acknowledgement.
      summary.uncertain++;
    }
  }
  const startedAt = performance.now();
  let cursor = 0;
  // Three independent leases allow normal batches to drain quickly. Stop starting
  // new work with 75 seconds left for the bounded PDF + SMTP attempt to finish.
  const runners = await Promise.allSettled(
    Array.from({ length: 3 }, async () => {
      while (
        cursor < rows.length &&
        performance.now() - startedAt < workBudgetMs
      ) {
        const candidate = rows[cursor++];
        await processCandidate(candidate);
      }
    }),
  );
  const rejected = runners.find((result) => result.status === "rejected");
  if (rejected) throw rejected.reason;
  return summary;
}
module.exports = {
  RECIPIENT,
  COLLECTION,
  queueAutomaticOrderMail,
  changeOrderMail,
  getOrderMail,
  getOrderMailConfig,
  updateOrderMailSettings,
  deliverOrderMail,
};
