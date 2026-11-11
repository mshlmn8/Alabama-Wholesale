const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const file = path.join(__dirname, "../public/phone-layout.js");
const mod = fs.existsSync(file)
  ? import(
      "data:text/javascript;base64," +
        Buffer.from(fs.readFileSync(file, "utf8")).toString("base64")
    )
  : Promise.resolve({});

function media(matches) {
  const listeners = new Set();
  const list = {
    matches,
    addEventListener: (type, fn) => type === "change" && listeners.add(fn),
    removeEventListener: (type, fn) => listeners.delete(fn),
  };
  return {
    queries: [],
    matchMedia(query) {
      this.queries.push(query);
      return list;
    },
    flip() {
      list.matches = !list.matches;
      for (const fn of [...listeners]) fn({ matches: list.matches });
    },
    listeners,
  };
}

test("phone means the 800px breakpoint the phone stylesheet uses", async () => {
  const { PHONE_QUERY, isPhone } = await mod;
  assert.equal(PHONE_QUERY, "screen and (max-width: 800px)");
  const phone = media(true);
  assert.equal(isPhone(phone), true);
  assert.deepEqual(phone.queries, [PHONE_QUERY]);
  assert.equal(isPhone(media(false)), false);
  assert.equal(isPhone({}), false);
});

test("phone tabs are Home, Catalog, Order, History and More", async () => {
  const { PHONE_TABS } = await mod;
  assert.deepEqual(
    PHONE_TABS.map(([view, label]) => [view, label]),
    [
      ["home", "Home"],
      ["catalog", "Catalog"],
      ["build", "Order"],
      ["orders", "History"],
      ["more", "More"],
    ],
  );
});

test("every view lights one phone tab and Stores lives under More", async () => {
  const { phoneDestination } = await mod;
  assert.equal(phoneDestination("home"), "home");
  assert.equal(phoneDestination("catalog"), "catalog");
  assert.equal(phoneDestination("build"), "build");
  assert.equal(phoneDestination("orders"), "orders");
  assert.equal(phoneDestination("stores"), "more");
  assert.equal(phoneDestination("documents"), "more");
  assert.equal(phoneDestination("notifications"), "more");
  assert.equal(phoneDestination(undefined), "more");
});

test("crossing the breakpoint calls back until stopped", async () => {
  const { watchPhoneLayout } = await mod;
  const environment = media(true);
  const seen = [];
  const stop = watchPhoneLayout((phone) => seen.push(phone), environment);
  environment.flip();
  environment.flip();
  stop();
  environment.flip();
  assert.deepEqual(seen, [false, true]);
  assert.equal(environment.listeners.size, 0);
  assert.equal(typeof watchPhoneLayout(() => {}, {}), "function");
});
