"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { MemoryRepository } = require("../lib/repository.cjs");
let mail;
try {
  mail = require("../lib/order-mail.cjs");
} catch (e) {
  if (e.code !== "MODULE_NOT_FOUND") throw e;
}
const now = 1789362000000;
const owner = { uid: "owner", id: "owner", role: "master", active: true };
const customer = {
  uid: "customer",
  id: "customer",
  role: "customer",
  active: true,
  storeIds: ["one"],
};
const staff = {
  uid: "staff",
  id: "staff",
  role: "salesman",
  active: true,
  storeIds: ["one"],
};
const other = {
  uid: "other",
  id: "other",
  role: "customer",
  active: true,
  storeIds: ["two"],
};
const order = {
  id: "order-one",
  storeId: "one",
  status: "submitted",
  createdBy: "customer",
  submittedBy: "customer",
  invoiceNumber: "AW-2026-000042",
  version: 2,
  submittedAt: now,
  storeSnapshot: { id: "one", name: "Original shop" },
  lines: [
    {
      id: "line",
      productId: "p",
      name: "Orange beverage",
      sku: "ORANGE",
      variant: "",
      quantity: 2,
      unit: "each",
      packSize: 1,
      eachQuantity: 2,
      unitPriceCents: 1200,
      lineTotalCents: 2400,
      taxCents: 198,
      taxable: true,
    },
  ],
  subtotalCents: 2400,
  taxCents: 198,
  totalCents: 2598,
  notes: "Deliver to receiving.",
};
const fixture = () =>
  new MemoryRepository({
    users: [owner, customer, staff, other],
    stores: [
      { id: "one", name: "Changed shop", active: true },
      { id: "two", name: "Other", active: true },
    ],
    orders: [order],
  });
const action = (repo, actor = customer, input = {}) =>
  mail.changeOrderMail(
    repo,
    actor,
    order.id,
    { requestId: "request-one", action: "send", expectedVersion: 0, ...input },
    { now },
  );
const options = (calls = [], extra = {}) => ({
  now,
  from: "Alabama Wholesale <sender@example.test>",
  transport: {
    async sendMail(message) {
      calls.push(message);
      return { accepted: [message.to] };
    },
  },
  render: async () => Buffer.from("%PDF-fixture"),
  ...extra,
});

test("order mail module exports the agreed queue and worker contract", () => {
  for (const name of [
    "changeOrderMail",
    "queueAutomaticOrderMail",
    "getOrderMail",
    "getOrderMailConfig",
    "updateOrderMailSettings",
    "deliverOrderMail",
  ])
    assert.equal(typeof mail?.[name], "function", name);
});
test("explicit email is durable, fixed-recipient and same-request idempotent", async () => {
  const repo = fixture();
  const first = await action(repo);
  const again = await action(repo);
  assert.equal(first.status, "queued");
  assert.equal(first.to, "alwholesaleorders@gmail.com");
  assert.deepEqual(again, first);
  assert.equal((await repo.list("orderMailJobs")).length, 1);
  await assert.rejects(
    action(repo, customer, { action: "schedule", scheduledAt: now + 60000 }),
    (e) => e.code === "mail_request_conflict",
  );
  await assert.rejects(
    action(repo, customer, {
      requestId: "request-two",
      to: "attacker@example.test",
    }),
    (e) => e.code === "invalid_mail_input",
  );
});
test("queueing enforces current profile, store and customer ownership", async () => {
  const repo = fixture();
  await assert.rejects(action(repo, other), (e) => e.status === 403);
  await repo.put("users", "customer", { ...customer, storeIds: [] });
  await assert.rejects(action(repo), (e) => e.status === 403);
  await repo.put("users", "customer", customer);
  await repo.put("orders", order.id, { ...order, createdBy: "owner" });
  await assert.rejects(action(repo), (e) => e.status === 403);
  assert.equal((await action(repo, staff)).status, "queued");
});
test("only confirmed active invoices can be emailed; never drafts or cancellations", async () => {
  for (const patch of [
    { status: "draft" },
    { status: "cancelled" },
    { invoiceNumber: null },
    { deleted: true },
    { legacy: { needsPriceReview: true } },
  ]) {
    const repo = fixture();
    await repo.put("orders", order.id, { ...order, ...patch });
    await assert.rejects(action(repo), (e) => [404, 409].includes(e.status));
  }
});
test("scheduling persists across workers and waits until due with a PDF attachment", async () => {
  const repo = fixture(),
    calls = [];
  await action(repo, customer, {
    action: "schedule",
    scheduledAt: now + 60000,
  });
  assert.equal((await mail.deliverOrderMail(repo, options(calls))).sent, 0);
  assert.equal(calls.length, 0);
  assert.equal(
    (await mail.deliverOrderMail(repo, options(calls, { now: now + 60000 })))
      .sent,
    1,
  );
  assert.equal(calls[0].to, "alwholesaleorders@gmail.com");
  assert.match(calls[0].subject, /AW-2026-000042/);
  assert.match(calls[0].text, /Original shop/);
  assert.equal(calls[0].attachments[0].content.toString(), "%PDF-fixture");
  assert.equal(calls[0].attachments[0].contentType, "application/pdf");
  assert.match(calls[0].attachments[0].filename, /AW-2026-000042/);
  assert.equal(calls[0].disableFileAccess, true);
  assert.equal(
    (await mail.getOrderMail(repo, customer, order.id)).status,
    "sent",
  );
  assert.equal(
    (await mail.deliverOrderMail(repo, options(calls, { now: now + 600000 })))
      .sent,
    0,
  );
  assert.equal(calls.length, 1);
});
test("settings are master-only and automatic queuing shares the transaction, with no historic backfill", async () => {
  const repo = fixture();
  assert.equal((await mail.getOrderMailConfig(repo)).automatic, false);
  await assert.rejects(
    mail.updateOrderMailSettings(
      repo,
      customer,
      { automatic: false, expectedVersion: 0 },
      { now },
    ),
    (e) => e.status === 403,
  );
  await mail.updateOrderMailSettings(
    repo,
    owner,
    { automatic: false, expectedVersion: 0 },
    { now },
  );
  assert.equal(
    await repo.transaction((tx) =>
      mail.queueAutomaticOrderMail(tx, customer, order, {
        now,
        configured: true,
      }),
    ),
    null,
  );
  await mail.updateOrderMailSettings(
    repo,
    owner,
    { automatic: true, expectedVersion: 1 },
    { now, configured: true },
  );
  await assert.rejects(
    repo.transaction(async (tx) => {
      await mail.queueAutomaticOrderMail(tx, customer, order, {
        now,
        configured: true,
      });
      throw Error("rollback");
    }),
    /rollback/,
  );
  assert.equal((await repo.list("orderMailJobs")).length, 0);
  await repo.transaction((tx) =>
    mail.queueAutomaticOrderMail(tx, customer, order, {
      now,
      configured: true,
    }),
  );
  await repo.transaction((tx) =>
    mail.queueAutomaticOrderMail(tx, customer, order, {
      now,
      configured: true,
    }),
  );
  assert.equal((await repo.list("orderMailJobs")).length, 1);
});
test("missing sender leaves queued jobs untouched and performs no render or send", async () => {
  const repo = fixture();
  const row = await action(repo);
  const result = await mail.deliverOrderMail(repo, {
    now,
    render: () => {
      throw Error("must not render");
    },
  });
  assert.equal(result.configured, false);
  assert.deepEqual(await mail.getOrderMail(repo, customer, order.id), row);
});
test("concurrent workers lease one job and send exactly once", async () => {
  const repo = fixture(),
    calls = [];
  await action(repo);
  let release, started;
  const waiting = new Promise((r) => (started = r)),
    blocked = new Promise((r) => (release = r));
  const opts = options(calls, {
    transport: {
      async sendMail(message) {
        calls.push(message);
        started();
        await blocked;
        return { accepted: [message.to] };
      },
    },
  });
  const first = mail.deliverOrderMail(repo, opts);
  await waiting;
  const second = await mail.deliverOrderMail(repo, opts);
  release();
  await first;
  assert.equal(second.claimed, 0);
  assert.equal(calls.length, 1);
});
test("revoked access and cancelled orders are checked before dispatch", async () => {
  for (const mutate of [
    (repo) => repo.put("users", "customer", { ...customer, active: false }),
    (repo) => repo.put("users", "customer", { ...customer, storeIds: [] }),
    (repo) => repo.put("orders", order.id, { ...order, status: "cancelled" }),
    (repo) => repo.put("stores", "one", { id: "one", active: false }),
  ]) {
    const repo = fixture(),
      calls = [];
    await action(repo);
    await mutate(repo);
    await mail.deliverOrderMail(repo, options(calls));
    assert.equal(calls.length, 0);
    assert.equal((await repo.list("orderMailJobs"))[0].status, "failed");
  }
});
test("access revoked while PDF renders prevents SMTP submission", async () => {
  const repo = fixture(),
    calls = [];
  await action(repo);
  await mail.deliverOrderMail(
    repo,
    options(calls, {
      render: async () => {
        await repo.put("users", "customer", { ...customer, active: false });
        return Buffer.from("%PDF-fixture");
      },
    }),
  );
  assert.equal(calls.length, 0);
});
test("requestor cancellation while preparing invalidates the lease without email", async () => {
  const repo = fixture(),
    calls = [];
  await action(repo);
  await mail.deliverOrderMail(
    repo,
    options(calls, {
      render: async () => {
        const job = await mail.getOrderMail(repo, customer, order.id);
        await action(repo, customer, {
          requestId: "cancel-one",
          action: "cancel",
          expectedVersion: job.version,
        });
        return Buffer.from("%PDF-fixture");
      },
    }),
  );
  assert.equal(calls.length, 0);
  assert.equal(
    (await mail.getOrderMail(repo, customer, order.id)).status,
    "cancelled",
  );
});
test("cancel and reschedule require current versions and requestor or accessible staff", async () => {
  const repo = fixture();
  const job = await action(repo, staff, {
    action: "schedule",
    scheduledAt: now + 60000,
  });
  await assert.rejects(
    action(repo, customer, {
      requestId: "cancel-customer",
      action: "cancel",
      expectedVersion: job.version,
    }),
    (e) => e.status === 403,
  );
  await assert.rejects(
    action(repo, staff, {
      requestId: "stale",
      action: "schedule",
      scheduledAt: now + 120000,
      expectedVersion: 0,
    }),
    (e) => e.code === "mail_version_conflict",
  );
  const later = await action(repo, owner, {
    requestId: "later",
    action: "schedule",
    scheduledAt: now + 120000,
    expectedVersion: job.version,
  });
  assert.equal(later.scheduledAt, now + 120000);
  assert.equal(
    (
      await action(repo, owner, {
        requestId: "cancel",
        action: "cancel",
        expectedVersion: later.version,
      })
    ).status,
    "cancelled",
  );
});
test("rejected SMTP can be retried explicitly while uncertain outcomes require master acknowledgment", async () => {
  for (const [smtpError, status] of [
    [{ code: "EAUTH" }, "failed"],
    [{ code: "ETIMEDOUT", command: "DATA" }, "uncertain"],
  ]) {
    const repo = fixture();
    await action(repo);
    await mail.deliverOrderMail(
      repo,
      options([], {
        transport: {
          sendMail: async () => {
            throw smtpError;
          },
        },
      }),
    );
    let job = await mail.getOrderMail(repo, customer, order.id);
    assert.equal(job.status, status);
    if (status === "uncertain") {
      await assert.rejects(
        action(repo, customer, {
          requestId: "retry",
          action: "retry",
          expectedVersion: job.version,
          acknowledgeDuplicateRisk: true,
        }),
        (e) => e.status === 403,
      );
      await assert.rejects(
        action(repo, owner, {
          requestId: "retry",
          action: "retry",
          expectedVersion: job.version,
        }),
        (e) => e.code === "mail_duplicate_risk",
      );
    }
    job = await action(repo, status === "uncertain" ? owner : customer, {
      requestId: "retry",
      action: "retry",
      expectedVersion: job.version,
      acknowledgeDuplicateRisk: true,
    });
    assert.equal(job.status, "queued");
  }
});
test("expired sending lease and timed-out SMTP become uncertain without automatic resubmission", async () => {
  const repo = fixture(),
    calls = [];
  await action(repo);
  await mail.deliverOrderMail(
    repo,
    options(calls, {
      sendTimeoutMs: 5,
      transport: { sendMail: () => new Promise(() => {}) },
    }),
  );
  assert.equal(
    (await mail.getOrderMail(repo, customer, order.id)).status,
    "uncertain",
  );
  await mail.deliverOrderMail(repo, options(calls, { now: now + 120000 }));
  assert.equal(calls.length, 0);
  const job = (await repo.list("orderMailJobs"))[0];
  await repo.put("orderMailJobs", job.id, {
    ...job,
    status: "sending",
    leaseExpiresAt: now - 1,
    nextRunAt: now - 1,
  });
  await mail.deliverOrderMail(repo, options(calls));
  assert.equal(
    (await mail.getOrderMail(repo, customer, order.id)).status,
    "uncertain",
  );
  assert.equal(calls.length, 0);
});
test("PDF failure is safe to retry and cannot affect confirmed order", async () => {
  const repo = fixture(),
    calls = [];
  await action(repo);
  await mail.deliverOrderMail(
    repo,
    options(calls, { render: async () => Buffer.from("not-pdf") }),
  );
  const job = await mail.getOrderMail(repo, customer, order.id);
  assert.equal(job.status, "failed");
  assert.equal(job.retryable, true);
  assert.equal(calls.length, 0);
  assert.deepEqual(await repo.get("orders", order.id), order);
});
test("SMTP success followed by persistence failure leaves a sending lease, never a new pending job", async () => {
  const repo = fixture(),
    calls = [];
  await action(repo);
  const original = repo.transaction.bind(repo);
  await mail.deliverOrderMail(
    repo,
    options(calls, {
      transport: {
        async sendMail(message) {
          calls.push(message);
          repo.transaction = async () => {
            throw Error("disk failed");
          };
          return { accepted: [message.to] };
        },
      },
    }),
  );
  repo.transaction = original;
  assert.equal(
    (await mail.getOrderMail(repo, customer, order.id)).status,
    "sending",
  );
  await mail.deliverOrderMail(repo, options(calls, { now: now + 120000 }));
  assert.equal(
    (await mail.getOrderMail(repo, customer, order.id)).status,
    "uncertain",
  );
  assert.equal(calls.length, 1);
});

test("automatic email waits for connected sender and gives a five-minute scheduling grace", async () => {
  const repo = fixture();
  await assert.rejects(
    mail.updateOrderMailSettings(
      repo,
      owner,
      { automatic: true, expectedVersion: 0 },
      { now },
    ),
    (e) => e.code === "sender_not_configured",
  );
  await mail.updateOrderMailSettings(
    repo,
    owner,
    { automatic: true, expectedVersion: 0 },
    { now, configured: true },
  );
  assert.equal(
    await repo.transaction((tx) =>
      mail.queueAutomaticOrderMail(tx, customer, order, { now }),
    ),
    null,
  );
  const job = await repo.transaction((tx) =>
    mail.queueAutomaticOrderMail(tx, customer, order, {
      now,
      configured: true,
    }),
  );
  assert.equal(job.scheduledAt, now + 300000);
  assert.equal(
    (await mail.getOrderMailConfig(repo, { configured: true }))
      .automaticDelaySeconds,
    300,
  );
  const calls = [];
  await mail.deliverOrderMail(repo, options(calls));
  assert.equal(calls.length, 0);
  await action(repo, customer, {
    requestId: "send-now",
    expectedVersion: job.version,
  });
  await mail.deliverOrderMail(repo, options(calls));
  assert.equal(calls.length, 1);
});
test("a lost scheduling response remains idempotent after its scheduled time has passed", async () => {
  const repo = fixture();
  const input = {
    requestId: "scheduled-lost-response",
    action: "schedule",
    expectedVersion: 0,
    scheduledAt: now + 60000,
  };
  const first = await mail.changeOrderMail(repo, customer, order.id, input, {
    now,
  });
  const second = await mail.changeOrderMail(repo, customer, order.id, input, {
    now: now + 120000,
  });
  assert.deepEqual(second, first);
  assert.equal((await repo.list("orderMailJobs")).length, 1);
});
test("an expired preparation lease recovers safely without duplicating an SMTP attempt", async () => {
  const repo = fixture(),
    calls = [];
  const first = await action(repo);
  const row = (await repo.list("orderMailJobs"))[0];
  await repo.put("orderMailJobs", row.id, {
    ...row,
    status: "preparing",
    claimToken: "crashed",
    leaseExpiresAt: now - 1,
    nextRunAt: now - 1,
  });
  assert.equal((await mail.deliverOrderMail(repo, options(calls))).sent, 1);
  assert.equal(calls.length, 1);
  assert.equal((await mail.getOrderMail(repo, customer, order.id)).attempts, 1);
});
test("the email cannot be cancelled or rescheduled once SMTP sending starts", async () => {
  const repo = fixture(),
    calls = [];
  await action(repo);
  let release, started;
  const waiting = new Promise((r) => (started = r)),
    blocked = new Promise((r) => (release = r));
  const running = mail.deliverOrderMail(
    repo,
    options(calls, {
      transport: {
        async sendMail(message) {
          calls.push(message);
          started();
          await blocked;
          return { accepted: [message.to] };
        },
      },
    }),
  );
  await waiting;
  const job = await mail.getOrderMail(repo, customer, order.id);
  for (const [actionType, extra] of [
    ["cancel", {}],
    ["schedule", { scheduledAt: now + 60000 }],
  ])
    await assert.rejects(
      action(repo, customer, {
        requestId: actionType,
        action: actionType,
        expectedVersion: job.version,
        ...extra,
      }),
      (e) => e.code === "mail_already_started",
    );
  release();
  await running;
  assert.equal(calls.length, 1);
});
async function queueMany(repo, count) {
  for (let n = 0; n < count; n++) {
    const current = {
      ...order,
      id: `order-${n}`,
      invoiceNumber: `AW-2026-${n}`,
    };
    await repo.put("orders", current.id, current);
    await mail.changeOrderMail(
      repo,
      customer,
      current.id,
      { requestId: `request-${n}`, action: "send", expectedVersion: 0 },
      { now },
    );
  }
}
test("worker drains a useful batch while preparing at most three invoice emails concurrently", async () => {
  const repo = fixture(),
    calls = [];
  await queueMany(repo, 8);
  let active = 0,
    peak = 0;
  const result = await mail.deliverOrderMail(
    repo,
    options(calls, {
      render: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 8));
        active--;
        return Buffer.from("%PDF-fixture");
      },
    }),
  );
  assert.equal(result.sent, 8);
  assert.equal(peak, 3);
  assert.equal(calls.length, 8);
});
test("worker stops claiming new work after its elapsed budget and leaves the rest queued", async () => {
  const repo = fixture(),
    calls = [];
  await queueMany(repo, 8);
  const result = await mail.deliverOrderMail(
    repo,
    options(calls, {
      workBudgetMs: 5,
      render: async () => {
        await new Promise((r) => setTimeout(r, 12));
        return Buffer.from("%PDF-fixture");
      },
    }),
  );
  assert.ok(result.sent > 0 && result.sent <= 3);
  assert.equal(
    (await repo.list("orderMailJobs")).filter((j) => j.status === "queued")
      .length,
    8 - result.sent,
  );
});
