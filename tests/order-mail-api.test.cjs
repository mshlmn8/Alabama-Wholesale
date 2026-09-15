"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../server.js");
const { MemoryRepository } = require("../lib/repository.cjs");
const { createAuthService } = require("../lib/auth.cjs");
const now = 1789362000000;
const workerToken = "synthetic-worker-secret-not-production-1234567890";
async function fixture(
  t,
  { configured = true, automatic = false, worker = true } = {},
) {
  const users = [
    { id: "owner", uid: "owner", role: "master", active: true, storeIds: [] },
    {
      id: "customer",
      uid: "customer",
      role: "customer",
      active: true,
      storeIds: ["one"],
    },
    {
      id: "other",
      uid: "other",
      role: "customer",
      active: true,
      storeIds: ["two"],
    },
  ];
  const repo = new MemoryRepository({
    users,
    products: [
      {
        id: "p",
        name: "Synthetic drink",
        priceCents: 1200,
        variants: [],
        packSize: 1,
        taxable: true,
        version: 1,
      },
    ],
    stores: [
      {
        id: "one",
        name: "Synthetic shop",
        taxRateBps: 0,
        creditLimitCents: null,
        active: true,
        version: 1,
      },
    ],
    settings: [{ id: "orderMail", automatic, version: 1 }],
    orders: [
      {
        id: "draft",
        storeId: "one",
        status: "draft",
        createdBy: "customer",
        version: 1,
        lines: [
          {
            id: "l",
            productId: "p",
            variant: "",
            quantity: 2,
            unit: "each",
            note: "",
          },
        ],
        notes: "Synthetic test invoice",
      },
    ],
  });
  const calls = [];
  let currentTime = now;
  const auth = createAuthService({
    repo,
    ownerEmail: "owner@example.test",
    requireAppCheck: false,
    verifyIdToken: async (token) => {
      if (!users.some((u) => u.uid === token)) throw Error("bad");
      return { uid: token, firebase: { sign_in_provider: "google.com" } };
    },
  });
  const app = createApp({
    repo,
    auth,
    now: () => currentTime,
    config: { firebaseConfig: { projectId: "synthetic" } },
    ...(configured
      ? {
          emailTransport: {
            async sendMail(message) {
              calls.push(message);
              return { accepted: [message.to] };
            },
          },
          emailFrom: "Synthetic <sender@example.test>",
        }
      : {}),
    orderMailWorkerToken: worker ? workerToken : undefined,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => new Promise((r) => server.close(r)));
  const request = async (
    route,
    { actor = "customer", body, token, method } = {},
  ) => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}${route}`,
      {
        method: method || (body ? "POST" : "GET"),
        headers: {
          "Content-Type": "application/json",
          ...(token !== null
            ? { Authorization: `Bearer ${token || actor}` }
            : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: response.status, data, text };
  };
  const submit = () =>
    request("/api/commands", {
      body: {
        id: "submit-once",
        type: "order.submit",
        payload: { id: "draft", expectedVersion: 1 },
      },
    });
  return {
    repo,
    calls,
    request,
    submit,
    setTime: (value) => (currentTime = value),
  };
}
test("mail endpoints require a current authenticated user, scope jobs, and do not expose worker credentials", async (t) => {
  const { request, submit } = await fixture(t);
  assert.equal(
    (await request("/api/order-email/config", { token: null })).status,
    401,
  );
  const config = await request("/api/order-email/config");
  assert.equal(config.status, 200);
  assert.equal(config.data.configured, true);
  assert.equal(config.data.recipient, "alwholesaleorders@gmail.com");
  assert.equal(config.data.automatic, false);
  assert.equal(config.text.includes(workerToken), false);
  await submit();
  assert.equal(
    (await request("/api/orders/draft/email", { actor: "other" })).status,
    403,
  );
  assert.equal(
    (await request("/api/order-email/config")).text.includes(
      "sender@example.test",
    ),
    false,
  );
  assert.equal(
    (await request("/api/config")).text.includes(workerToken),
    false,
  );
});
test("automatic job commits with first submission and retries create one invoice and one mail job", async (t) => {
  const { repo, calls, request, submit, setTime } = await fixture(t, {
    automatic: true,
  });
  const first = await submit();
  assert.equal(first.status, 200, first.text);
  const second = await submit();
  assert.equal(second.status, 200, second.text);
  assert.equal((await repo.list("orderMailJobs")).length, 1);
  assert.equal((await repo.list("ledger")).length, 1);
  assert.equal(calls.length, 0);
  const result = await request("/api/orders/draft/email");
  assert.equal(result.data.job.scheduledAt, now + 300000);
  assert.equal(result.text.includes("claimToken"), false);
  setTime(now + 300000);
  const dispatch = await request("/internal/order-email/run", {
    token: workerToken,
    method: "POST",
  });
  assert.equal(dispatch.status, 200, dispatch.text);
  assert.equal(dispatch.data.sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].attachments[0].content.subarray(0, 5).toString(),
    "%PDF-",
  );
  assert.ok(calls[0].attachments[0].content.length > 1000);
  assert.equal(
    (
      await request("/internal/order-email/run", {
        token: workerToken,
        method: "POST",
      })
    ).data.sent,
    0,
  );
  assert.equal(calls.length, 1);
});
test("unconfigured automatic submissions create no delayed surprise jobs", async (t) => {
  const { repo, submit, request } = await fixture(t, {
    configured: false,
    automatic: true,
  });
  assert.equal((await submit()).status, 200);
  assert.equal((await repo.list("orderMailJobs")).length, 0);
  const enabled = await request("/api/admin/order-email/settings", {
    actor: "owner",
    body: { automatic: true, expectedVersion: 1 },
  });
  assert.equal(enabled.status, 503);
  assert.equal(enabled.data.error.code, "sender_not_configured");
});
test("automatic off does not backfill old submissions when later enabled", async (t) => {
  const { repo, submit, request } = await fixture(t);
  await submit();
  assert.equal((await repo.list("orderMailJobs")).length, 0);
  assert.equal(
    (
      await request("/api/admin/order-email/settings", {
        actor: "customer",
        body: { automatic: true, expectedVersion: 1 },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/admin/order-email/settings", {
        actor: "owner",
        body: { automatic: true, expectedVersion: 1 },
      })
    ).status,
    200,
  );
  await submit();
  assert.equal((await repo.list("orderMailJobs")).length, 0);
});
test("scheduler endpoint denies absent, wrong, query-only and short credentials and accepts only POST", async (t) => {
  const { request } = await fixture(t);
  for (const token of [null, "customer", "wrong"])
    assert.equal(
      (await request("/internal/order-email/run", { token, method: "POST" }))
        .status,
      401,
    );
  assert.equal(
    (
      await request(`/internal/order-email/run?token=${workerToken}`, {
        token: null,
        method: "POST",
      })
    ).status,
    401,
  );
  assert.notEqual(
    (await request("/internal/order-email/run", { token: workerToken })).status,
    200,
  );
  const disabled = await fixture(t, { worker: false });
  assert.equal(
    (
      await disabled.request("/internal/order-email/run", {
        token: workerToken,
        method: "POST",
      })
    ).status,
    401,
  );
});
test("manual future schedule, reschedule, cancel and send-now use the same versioned job", async (t) => {
  const { request, calls, submit } = await fixture(t);
  await submit();
  const modify = (body) => request("/api/orders/draft/email", { body });
  let response = await modify({
    requestId: "schedule-1",
    action: "schedule",
    expectedVersion: 0,
    scheduledAt: now + 600000,
  });
  assert.equal(response.status, 200, response.text);
  const id = response.data.job.id;
  response = await modify({
    requestId: "reschedule",
    action: "schedule",
    expectedVersion: response.data.job.version,
    scheduledAt: now + 900000,
  });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.data.job.id, id);
  response = await modify({
    requestId: "cancel",
    action: "cancel",
    expectedVersion: response.data.job.version,
  });
  assert.equal(response.data.job.status, "cancelled");
  response = await modify({
    requestId: "send-now",
    action: "send",
    expectedVersion: response.data.job.version,
  });
  assert.equal(response.data.job.status, "queued");
  assert.equal(response.data.job.id, id);
  const dispatch = await request("/internal/order-email/run", {
    token: workerToken,
    method: "POST",
  });
  assert.equal(dispatch.data.sent, 1, dispatch.text);
  assert.equal(calls.length, 1);
});
test("automatic enqueue failure rolls back invoice, ledger and receipt together", async (t) => {
  const { repo, submit } = await fixture(t, { automatic: true });
  const transaction = repo.transaction.bind(repo);
  repo.transaction = (fn) =>
    transaction((tx) =>
      fn({
        ...tx,
        set: async (c, id, value) => {
          if (c === "orderMailJobs")
            throw Object.assign(Error("Synthetic mail write failure"), {
              status: 503,
              code: "synthetic_mail_write_failed",
              expose: true,
            });
          return tx.set(c, id, value);
        },
      }),
    );
  const response = await submit();
  assert.equal(response.status, 503);
  assert.equal((await repo.get("orders", "draft")).status, "draft");
  assert.equal((await repo.list("ledger")).length, 0);
  assert.equal((await repo.list("commandReceipts")).length, 0);
});
test("disconnected sender rejects new explicit email requests without accumulating a backlog", async (t) => {
  const { request, submit, repo } = await fixture(t, { configured: false });
  await submit();
  for (const [action, extra] of [
    ["send", {}],
    ["schedule", { scheduledAt: now + 60000 }],
  ]) {
    const response = await request("/api/orders/draft/email", {
      body: { requestId: action, action, expectedVersion: 0, ...extra },
    });
    assert.equal(response.status, 503);
    assert.equal(response.data.error.code, "sender_not_configured");
  }
  assert.equal((await repo.list("orderMailJobs")).length, 0);
});
