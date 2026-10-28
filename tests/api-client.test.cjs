const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function fixture({ credentials = async () => ({}), fetch = async () => new Response('{}') } = {}) {
  const session = await import("data:text/javascript;base64," + Buffer.from(
    fs.readFileSync(path.join(__dirname, "../public/session.js"), "utf8"),
  ).toString("base64"));
  const timers = new Map(), scope = { identity: {} }, calls = [];
  let timer = 0, current = true;
  const context = vm.createContext({
    ...session, AbortController, DOMException, navigator: { onLine: true },
    operationScope: () => scope, scopeCurrent: () => current,
    firebase: { credentials },
    fetch: (...args) => { calls.push(args); return fetch(...args); },
    setTimeout: (fn, ms) => { timers.set(++timer, { fn, ms }); return timer; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(source.slice(source.indexOf("async function api("), source.indexOf("function editorIsActive(")), context);
  return { api: context.api, calls, timers, account: value => { current = value; },
    expire: () => { for (const { fn } of [...timers.values()]) fn(); } };
}
for (const status of [200, 503]) {
  test(`the request deadline covers a stalled ${status} response body`, async () => {
    const body = deferred();
    const f = await fixture({ fetch: async () => ({ ok: status === 200, status, json: () => body.promise }) });
    let outcome;
    const request = f.api("/api/commands", { method: "POST", body: { id: "same-command" } })
      .then(value => { outcome = { value }; }, error => { outcome = { error }; });
    await tick();
    f.expire();
    await tick();
    assert.equal(outcome?.error?.code, "NETWORK", "a stalled body must release the save");
    assert.match(outcome.error.message, /timed out/i);
    assert.equal(f.calls[0][1].signal.aborted, true);
    body.resolve({ result: {} });
    await request;
    assert.equal(f.timers.size, 0);
  });
}
test("a stalled credential refresh times out without sending a late command", async () => {
  const credentials = deferred();
  const f = await fixture({ credentials: () => credentials.promise });
  let outcome;
  const request = f.api("/api/commands", { method: "POST", body: { id: "same-command" } })
    .then(value => { outcome = { value }; }, error => { outcome = { error }; });
  await tick();
  f.expire();
  await tick();
  assert.equal(outcome?.error?.code, "NETWORK");
  credentials.resolve({ Authorization: "test" });
  await request;
  await tick();
  assert.equal(f.calls.length, 0, "expired credentials must not start a mutation later");
});
test("cancellation while credentials load does not send a command", async () => {
  const credentials = deferred(), controller = new AbortController();
  const f = await fixture({ credentials: () => credentials.promise });
  let outcome;
  const request = f.api("/api/commands", { method: "POST", body: {}, signal: controller.signal })
    .then(value => { outcome = { value }; }, error => { outcome = { error }; });
  controller.abort();
  await tick();
  assert.equal(outcome?.error?.name, "AbortError");
  credentials.resolve({});
  await request;
  await tick();
  assert.equal(f.calls.length, 0);
});
test("successful responses and proven server rejections keep their original meaning", async () => {
  const f = await fixture({ fetch: async () => Response.json({ result: { id: "confirmed" } }) });
  assert.equal((await f.api("/api/commands")).result.id, "confirmed");
  assert.equal(f.timers.size, 0);
  const rejected = await fixture({ fetch: async () => Response.json({
    error: { code: "VERSION_CONFLICT", message: "Refresh the order", outcome: "rejected" },
  }, { status: 409 }) });
  await assert.rejects(() => rejected.api("/api/commands"), {
    code: "VERSION_CONFLICT", status: 409, outcome: "rejected",
  });
  assert.equal(rejected.timers.size, 0);
});
test("account switches discard a delayed response", async () => {
  const response = deferred();
  const f = await fixture({ fetch: () => response.promise });
  const request = f.api("/api/commands");
  await tick();
  f.account(false);
  response.resolve(Response.json({ result: {} }));
  await assert.rejects(request, { code: "SESSION_CHANGED" });
});
