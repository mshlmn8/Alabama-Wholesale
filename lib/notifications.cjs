"use strict";
const { createHash, randomUUID } = require("node:crypto");
const LEASE_MS = 60000;
class NotificationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "NotificationError";
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}
const fail = (status, code, message) => {
  throw new NotificationError(status, code, message);
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const safeText = (value, max) =>
  typeof value === "string" &&
  value.length <= max &&
  !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value);
function email(value) {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value)
  )
    return null;
  return value.toLowerCase();
}
function timeSource(now) {
  const read =
    typeof now === "function" ? now : now === undefined ? Date.now : () => now;
  return () => {
    const value = read();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new TypeError("now must provide epoch milliseconds");
    return value;
  };
}
function eligibility(
  notification,
  user,
  preferences,
  { queuedEmail, allowEmailChange = false } = {},
) {
  if (!notification || notification.deleted) return "notification_unavailable";
  if (
    !user ||
    user.active !== true ||
    !["master", "salesman", "customer"].includes(user.role)
  )
    return "recipient_inactive";
  if (preferences?.notificationPreferences?.email !== true)
    return "recipient_opted_out";
  const uid = user.uid || user.id;
  if (notification.userId && notification.userId !== uid)
    return "recipient_forbidden";
  if (notification.storeId) {
    if (
      user.role !== "master" &&
      !user.storeIds?.includes(notification.storeId)
    )
      return "recipient_forbidden";
  } else if (!notification.userId) return "recipient_forbidden";
  const address = email(user.email);
  if (!address) return "recipient_email_invalid";
  if (!allowEmailChange && queuedEmail && address !== queuedEmail)
    return "recipient_email_changed";
  const enabledAt =
    preferences.notificationPreferences.emailEnabledAt ??
    preferences.updatedAt ??
    preferences.createdAt;
  if (
    Number.isSafeInteger(enabledAt) &&
    (!Number.isSafeInteger(notification.createdAt) ||
      notification.createdAt < enabledAt)
  )
    return "predates_email_opt_in";
  return null;
}
function subjectFor(type) {
  const subjects = {
    "order.submitted": "Order received",
    "order.approved": "Order approved",
    "order.picking": "Order being prepared",
    "order.delivered": "Order delivery update",
    "order.cancelled": "Order cancellation",
    "payment.verified": "Payment verified",
    "payment.reported": "Payment awaiting verification",
    "return.approved": "Return approved",
    "migration.reconciled": "Account balance reviewed",
  };
  return `Alabama Wholesale — ${subjects[type] || "Account update"}`;
}
async function queueNotifications(repo, options = {}) {
  const clock = timeSource(options.now);
  const notifications = await repo.list("notifications", {
    where: [["emailQueuePending", "==", true]],
    limit: 100,
  });
  if (!notifications.length)
    return { scanned: 0, created: 0, existing: 0, skipped: 0 };
  const [users, allPreferences] = await Promise.all([
    repo.list("users"),
    repo.list("preferences"),
  ]);
  const preferencesByUser = new Map(
    allPreferences.map((preferences) => [preferences.id, preferences]),
  );
  const summary = {
    scanned: notifications.length,
    created: 0,
    existing: 0,
    skipped: 0,
  };
  for (const notification of notifications) {
    if (notification.emailQueue?.completedAt != null) {
      summary.existing += notification.emailQueue.recipientCount || 0;
      continue;
    }
    let recipientCount = 0;
    if (
      !safeText(notification.id, 200) ||
      !notification.id ||
      !safeText(notification.message, 6000) ||
      !notification.message.trim() ||
      !Number.isSafeInteger(notification.createdAt)
    ) {
      summary.skipped++;
      continue;
    }
    for (const user of users) {
      const uid = user.uid || user.id;
      if (
        !safeText(uid, 200) ||
        !uid ||
        eligibility(notification, user, preferencesByUser.get(uid))
      )
        continue;
      const outboxId = `email-${digest(`${notification.id}\n${uid}`)}`;
      const outcome = await repo.transaction(async (tx) => {
        const [existing, currentUser, preferences, currentNotification] =
          await Promise.all([
            tx.get("outbox", outboxId),
            tx.get("users", uid),
            tx.get("preferences", uid),
            tx.get("notifications", notification.id),
          ]);
        if (existing) return "existing";
        if (eligibility(currentNotification, currentUser, preferences))
          return "skipped";
        const timestamp = clock();
        await tx.set("outbox", outboxId, {
          id: outboxId,
          channel: "email",
          notificationId: notification.id,
          userId: uid,
          storeId: currentNotification.storeId || null,
          to: email(currentUser.email),
          subject: subjectFor(currentNotification.type),
          text: currentNotification.message.trim(),
          status: "pending",
          attempts: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
          version: 1,
          retryable: true,
          claimToken: null,
          leaseExpiresAt: null,
          lastError: null,
        });
        return "created";
      });
      summary[outcome]++;
      if (outcome === "created" || outcome === "existing") recipientCount++;
    }
    await repo.transaction(async (tx) => {
      const current = await tx.get("notifications", notification.id);
      if (current && current.emailQueue?.completedAt == null)
        await tx.set("notifications", notification.id, {
          ...current,
          emailQueuePending: false,
          emailQueue: { completedAt: clock(), recipientCount },
          version: (current.version || 0) + 1,
        });
    });
  }
  return summary;
}
function parseFrom(value) {
  let address,
    name = "";
  if (typeof value === "string") {
    if (/[\r\n]/.test(value) || value.length > 500)
      fail(
        503,
        "invalid_email_sender",
        "Configure one valid sender email address.",
      );
    const display = value.match(/^([^<>]+)<([^<>]+)>$/);
    if (display) {
      name = display[1].trim().replace(/^"(.*)"$/, "$1");
      address = email(display[2].trim());
    } else address = email(value.trim());
  } else if (value && typeof value === "object") {
    address = email(value.address);
    name = value.name || "";
  }
  if (!address || !safeText(name, 200) || /[\r\n]/.test(name))
    fail(
      503,
      "invalid_email_sender",
      "Configure one valid sender email address.",
    );
  return { name, address };
}
function audit(tx, id, row, type, timestamp, fields = {}) {
  return tx.set("audit", `mail-${id()}`, {
    type,
    outboxId: row.id,
    userId: row.userId,
    storeId: row.storeId || null,
    at: timestamp,
    createdAt: timestamp,
    ...fields,
  });
}
async function claim(repo, outboxId, { clock, id, canSend }) {
  return repo.transaction(async (tx) => {
    const row = await tx.get("outbox", outboxId);
    if (!row) return { kind: "skipped" };
    const timestamp = clock();
    if (row.status === "sending") {
      if (
        !Number.isSafeInteger(row.leaseExpiresAt) ||
        row.leaseExpiresAt <= timestamp
      ) {
        const next = {
          ...row,
          status: "uncertain",
          retryable: false,
          updatedAt: timestamp,
          version: (row.version || 0) + 1,
          lastError: {
            code: "send_lease_expired",
            message:
              "The sending worker stopped before recording a result. Check the provider before requesting a retry.",
          },
        };
        await tx.set("outbox", row.id, next);
        await audit(tx, id, row, "email.uncertain", timestamp);
        return { kind: "uncertain" };
      }
      return { kind: "skipped" };
    }
    if (row.status !== "pending" || !canSend) return { kind: "skipped" };
    const [user, preferences, notification] = await Promise.all([
      tx.get("users", row.userId),
      tx.get("preferences", row.userId),
      tx.get("notifications", row.notificationId),
    ]);
    const reason = eligibility(notification, user, preferences, {
      queuedEmail: row.to,
    });
    if (reason) {
      await tx.set("outbox", row.id, {
        ...row,
        status: "failed",
        retryable: false,
        updatedAt: timestamp,
        version: (row.version || 0) + 1,
        lastError: {
          code: reason,
          message:
            "Email skipped because the recipient or notification is no longer eligible.",
        },
      });
      await audit(tx, id, row, "email.skipped", timestamp, { reason });
      return { kind: "skipped" };
    }
    const next = {
      ...row,
      status: "sending",
      claimToken: id(),
      leaseExpiresAt: timestamp + LEASE_MS,
      attempts: (Number.isSafeInteger(row.attempts) ? row.attempts : 0) + 1,
      startedAt: timestamp,
      updatedAt: timestamp,
      version: (row.version || 0) + 1,
      lastError: null,
    };
    await tx.set("outbox", row.id, next);
    return { kind: "claimed", row: next };
  });
}
function rejectedOutcome(error) {
  const responseCode =
    Number.isInteger(error?.responseCode) &&
    error.responseCode >= 400 &&
    error.responseCode <= 599
      ? error.responseCode
      : null;
  const beforeSubmission =
    ["EAUTH", "EENVELOPE", "EDNS", "ECONNECTION"].includes(error?.code) ||
    ["CONN", "EHLO", "HELO", "STARTTLS", "AUTH"].includes(error?.command);
  if (responseCode || beforeSubmission)
    return {
      status: "failed",
      retryable: true,
      lastError: {
        code: "smtp_rejected",
        message: responseCode
          ? `The mail server rejected this message (${responseCode}). Correct the cause before requesting a retry.`
          : "The message could not be submitted to the mail server. Check sender configuration before requesting a retry.",
      },
    };
  return {
    status: "uncertain",
    retryable: false,
    lastError: {
      code: "send_outcome_unknown",
      message:
        "Delivery outcome is unknown. Check the provider before requesting a retry to avoid a duplicate.",
    },
  };
}
async function boundedSend(transport, message, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => transport.sendMail(message)),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(new Error("Delivery timed out"), {
                code: "SEND_TIMEOUT",
              }),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function finish(repo, row, outcome, { clock, id }) {
  return repo.transaction(async (tx) => {
    const current = await tx.get("outbox", row.id);
    if (
      !current ||
      current.claimToken !== row.claimToken ||
      !["sending", "uncertain"].includes(current.status)
    )
      return false;
    const timestamp = clock();
    await tx.set("outbox", row.id, {
      ...current,
      ...outcome,
      updatedAt: timestamp,
      finishedAt: timestamp,
      ...(outcome.status === "sent" ? { sentAt: timestamp } : {}),
      leaseExpiresAt: null,
      version: (current.version || 0) + 1,
    });
    await audit(tx, id, row, `email.${outcome.status}`, timestamp);
    return true;
  });
}
async function deliverOutbox(repo, options = {}) {
  const {
    transport,
    from,
    limit = 20,
    id = randomUUID,
    sendTimeoutMs = 45000,
  } = options;
  const clock = timeSource(options.now);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new TypeError("limit must be between 1 and 100");
  if (
    !Number.isSafeInteger(sendTimeoutMs) ||
    sendTimeoutMs < 1 ||
    sendTimeoutMs > 45000
  )
    throw new TypeError("sendTimeoutMs must be between 1 and 45000");
  const configured = typeof transport?.sendMail === "function" && !!from;
  const sender = configured ? parseFrom(from) : null;
  const summary = {
    configured,
    scanned: 0,
    claimed: 0,
    sent: 0,
    failed: 0,
    uncertain: 0,
    skipped: 0,
  };
  const timestamp = clock();
  const rows = (await repo.list("outbox"))
    .filter(
      (row) =>
        (configured && row.status === "pending") ||
        (row.status === "sending" &&
          (!Number.isSafeInteger(row.leaseExpiresAt) ||
            row.leaseExpiresAt <= timestamp)),
    )
    .sort(
      (a, b) =>
        (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id),
    )
    .slice(0, limit);
  for (const candidate of rows) {
    summary.scanned++;
    const result = await claim(repo, candidate.id, {
      clock,
      id,
      canSend: configured,
    });
    if (result.kind !== "claimed") {
      summary[result.kind]++;
      continue;
    }
    summary.claimed++;
    const row = result.row;
    const messageId = `<aw-${digest(row.id)}@${sender.address.split("@")[1]}>`;
    let outcome;
    try {
      const info = await boundedSend(
        transport,
        {
          from: sender,
          to: row.to,
          subject: row.subject,
          text: row.text,
          messageId,
          disableFileAccess: true,
          disableUrlAccess: true,
        },
        sendTimeoutMs,
      );
      const accepted =
        Array.isArray(info?.accepted) &&
        info.accepted.some(
          (address) =>
            email(typeof address === "string" ? address : address?.address) ===
            row.to,
        );
      const rejected =
        Array.isArray(info?.rejected) &&
        info.rejected.some(
          (address) =>
            email(typeof address === "string" ? address : address?.address) ===
            row.to,
        );
      if (accepted)
        outcome = {
          status: "sent",
          deliveryStatus: "accepted-by-provider",
          messageId,
          retryable: false,
          lastError: null,
        };
      else if (rejected)
        outcome = {
          status: "failed",
          retryable: true,
          lastError: {
            code: "smtp_recipient_rejected",
            message:
              "The mail server rejected this recipient. Correct the address or server issue before requesting a retry.",
          },
        };
      else outcome = rejectedOutcome(null);
    } catch (error) {
      outcome = rejectedOutcome(error);
    }
    try {
      const saved = await finish(repo, row, outcome, { clock, id });
      if (saved) summary[outcome.status]++;
      else summary.uncertain++;
    } catch {
      // SMTP may already have accepted the message. Leave its durable sending lease
      // to become uncertain; never make the row pending again after a storage failure.
      summary.uncertain++;
    }
  }
  return summary;
}
async function retryOutbox(
  repo,
  outboxId,
  {
    actor,
    now,
    id = randomUUID,
    reason,
    acknowledgeDuplicateRisk = false,
  } = {},
) {
  if (!actor || actor.role !== "master" || !actor.uid || actor.active === false)
    fail(
      403,
      "email_retry_forbidden",
      "An administrator must request an email retry.",
    );
  if (!safeText(outboxId, 200) || !outboxId || outboxId.includes("/"))
    fail(400, "invalid_outbox_id", "Choose a valid queued email.");
  if (!safeText(reason, 2000) || reason.trim().length < 3)
    fail(
      400,
      "email_retry_reason_required",
      "Record why this email should be retried.",
    );
  const clock = timeSource(now);
  return repo.transaction(async (tx) => {
    const row = await tx.get("outbox", outboxId);
    if (!row) fail(404, "outbox_not_found", "This queued email was not found.");
    if (!["failed", "uncertain"].includes(row.status))
      fail(
        409,
        "email_not_retryable",
        "Only failed or uncertain emails can be explicitly retried.",
      );
    if (row.status === "uncertain" && acknowledgeDuplicateRisk !== true)
      fail(
        409,
        "duplicate_risk_acknowledgement_required",
        "Confirm the provider outcome and acknowledge that retrying could send a duplicate.",
      );
    const [user, preferences, notification] = await Promise.all([
      tx.get("users", row.userId),
      tx.get("preferences", row.userId),
      tx.get("notifications", row.notificationId),
    ]);
    if (
      eligibility(notification, user, preferences, { allowEmailChange: true })
    )
      fail(
        409,
        "email_recipient_ineligible",
        "The recipient must currently opt in and have access to this notification before retrying.",
      );
    const timestamp = clock();
    const next = {
      ...row,
      status: "pending",
      to: email(user.email),
      claimToken: null,
      leaseExpiresAt: null,
      retryable: true,
      lastError: null,
      updatedAt: timestamp,
      version: (row.version || 0) + 1,
      lastRetry: {
        requestedBy: actor.uid,
        requestedAt: timestamp,
        reason: reason.trim(),
        acknowledgedDuplicateRisk: row.status === "uncertain",
      },
    };
    await tx.set("outbox", row.id, next);
    await audit(tx, id, row, "email.retry_requested", timestamp, {
      actorUid: actor.uid,
      previousStatus: row.status,
      reason: reason.trim(),
      acknowledgedDuplicateRisk: row.status === "uncertain",
    });
    return next;
  });
}
// Creating a transport does not connect or send. Sender setup remains disabled until
// SMTP_URL and EMAIL_FROM are explicitly configured by the owner.
function createSmtpTransport({ smtpUrl, createTransport } = {}) {
  if (!smtpUrl) return null;
  const invalid = () =>
    fail(
      503,
      "invalid_smtp_configuration",
      "Configure SMTP_URL with a valid SMTP or SMTPS provider connection.",
    );
  if (
    typeof smtpUrl !== "string" ||
    smtpUrl.length > 4096 ||
    /[\r\n]/.test(smtpUrl)
  )
    invalid();
  let url;
  try {
    url = new URL(smtpUrl);
  } catch {
    invalid();
  }
  if (
    !["smtp:", "smtps:"].includes(url.protocol) ||
    !url.hostname ||
    !["", "/"].includes(url.pathname) ||
    url.hash ||
    url.search
  )
    invalid();
  let username, password;
  try {
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    invalid();
  }
  const secure = url.protocol === "smtps:";
  const port = url.port ? Number(url.port) : secure ? 465 : 587;
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid();
  const factory = createTransport || require("nodemailer").createTransport;
  return factory({
    host: url.hostname,
    port,
    secure,
    requireTLS: !secure,
    tls: { rejectUnauthorized: true },
    ...(username ? { auth: { user: username, pass: password } } : {}),
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    dnsTimeout: 15000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  });
}
module.exports = {
  queueNotifications,
  deliverOutbox,
  retryOutbox,
  createSmtpTransport,
  NotificationError,
};
