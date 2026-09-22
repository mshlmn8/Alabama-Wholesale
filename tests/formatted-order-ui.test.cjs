const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(
  require("node:path").join(__dirname, "../public/app.js"),
  "utf8",
);
async function fixture({ share, rich = true } = {}) {
  const { formatOrder } = await import("../public/order-format.mjs");
  const copies = [],
    richCopies = [],
    shares = [],
    dialogs = [];
  let current = true;
  const el = (tag, attrs, ...children) => ({
    tag,
    attrs,
    children: children.flat(Infinity).filter(Boolean),
  });
  const context = vm.createContext({
    Blob,
    formatOrder,
    state: { products: [], categories: [] },
    storeById: () => ({ name: "Current name" }),
    operationScope: () => "identity",
    scopeCurrent: () => current,
    SessionChanged: class extends Error {},
    el,
    append: (node, ...children) => node.children.push(...children),
    toast() {},
    isHistoricalOrder: () => false,
    orderDocumentOptions: () => [["invoice"]],
    modal: () => {
      const m = {
        content: el("div", {}),
        footer: el("footer", {}),
        close() {},
      };
      dialogs.push(m);
      return m;
    },
    button: (label, click) => ({ label, click }),
    copyText: async (value) => copies.push(value),
    ClipboardItem: rich
      ? class {
          constructor(data) {
            this.data = data;
          }
        }
      : undefined,
    navigator: {
      clipboard: { write: async (items) => richCopies.push(items) },
      share: share
        ? async (payload) => {
            shares.push(payload);
            return share(payload);
          }
        : undefined,
    },
    showOrderEmail: async () => {},
  });
  vm.runInContext(
    source.slice(
      source.indexOf("function formattedOrder("),
      source.indexOf("async function showOrder("),
    ),
    context,
  );
  const order = {
    id: "one",
    invoiceNumber: "AW-1",
    storeSnapshot: { name: "Frozen <store>" },
    notes: "Deliver\ncarefully",
    lines: [
      {
        productId: "drink",
        name: "Juice",
        variant: "Pear",
        quantity: 4,
        categoryNames: ["Drinks"],
      },
      {
        productId: "candy",
        name: "Sweet <script>",
        variant: "",
        quantity: 3,
        categoryNames: ["Candy"],
      },
      {
        productId: "drink",
        name: "Juice",
        variant: "Apple",
        quantity: 2,
        categoryNames: ["Drinks"],
      },
    ],
  };
  context.showFormattedOrder(order);
  return {
    copies,
    richCopies,
    shares,
    order,
    expected: formatOrder(order),
    dialog: dialogs.at(-1),
    stale: () => {
      current = false;
    },
    click: (label) =>
      dialogs
        .at(-1)
        .footer.children.find((button) => button.label === label)
        .click(),
  };
}
test("formatted order copies escaped HTML and complete text from the same ordered snapshot", async () => {
  const f = await fixture();
  await f.click("Copy formatted order");
  const data = f.richCopies[0][0].data;
  assert.equal(await data["text/html"].text(), f.expected.html);
  assert.equal(await data["text/plain"].text(), f.expected.text);
  assert.match(await data["text/html"].text(), /Sweet &lt;script&gt;/);
  assert.equal(f.copies.length, 0);
  const sheet = f.dialog.content.children[0];
  assert.equal(sheet.children[0].children[0], "Frozen <store>");
  assert.deepEqual(
    Array.from(
      sheet.children.filter((node) => node.tag === "ul"),
      (node) => node.children[0].children[0],
    ),
    ["Sweet <script> (3)", "Juice: Apple (2), Pear (4)"],
  );
});
test("plain copying remains available without rich clipboard support", async () => {
  const f = await fixture({ rich: false });
  await f.click("Copy formatted order");
  assert.deepEqual(f.copies, [f.expected.text]);
});
test("native sharing uses the full order and cancelling does not copy or send", async () => {
  const f = await fixture({
    share: () => {
      throw Object.assign(Error("cancelled"), { name: "AbortError" });
    },
  });
  await f.click("Share order");
  assert.equal(f.shares[0].text, f.expected.text);
  assert.equal(f.shares[0].title, f.expected.subject);
  assert.equal(f.copies.length, 0);
});
test("a rejected native share falls back to the full copyable text", async () => {
  const f = await fixture({
    share: () => {
      throw Error("unsupported");
    },
  });
  await f.click("Share order");
  assert.deepEqual(f.copies, [f.expected.text]);
});
test("stale identity cannot copy, share, or enter the email flow", async () => {
  const f = await fixture({ share: () => {} });
  f.stale();
  for (const label of [
    "Copy formatted order",
    "Share order",
    "Send / schedule email",
  ])
    await assert.rejects(() => Promise.resolve().then(() => f.click(label)));
  assert.equal(f.copies.length + f.richCopies.length + f.shares.length, 0);
});
