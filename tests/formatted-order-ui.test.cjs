const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(
  require("node:path").join(__dirname, "../public/app.js"),
  "utf8",
);
async function fixture({
  share,
  rich = true,
  copyError = false,
  orderOverride = {},
} = {}) {
  const { formatOrder, FORMAT_STYLES } = await import(
    "../public/order-format.mjs"
  );
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
    FORMAT_STYLES,
    location: { href: "" },
    document: {
      createRange: () => ({ selectNodeContents() {} }),
      getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    },
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
      clipboard: {
        write: async (items) => {
          if (copyError) throw Error("Clipboard blocked");
          richCopies.push(items);
        },
      },
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
    ...orderOverride,
  };
  context.showFormattedOrder(order);
  return {
    context,
    dialogs,
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
        .footer.children.concat(dialogs.at(-1).content.children)
        .find((button) => button.label === label)
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
  assert.equal(
    sheet.children.some(
      (node) => node.attrs?.class === "formatted-order-reference",
    ),
    false,
  );
  assert.equal(
    sheet.children.filter(
      (node) => node.attrs?.class === "formatted-order-separator",
    ).length,
    1,
  );
  assert.deepEqual(
    Array.from(
      sheet.children.filter((node) => node.tag === "ul"),
      (node) => node.children[0].children[0],
    ),
    ["Sweet <script> (3)", "Juice: Apple (2), Pear (4)"],
  );
});
test("blocked rich copying offers a selectable formatted preview instead of silently dropping formatting", async () => {
  const f = await fixture({ copyError: true });
  await f.click("Copy formatted order");
  assert.equal(f.copies.length, 0);
  assert.equal(f.dialogs.length, 2);
  await f.click("Select formatted text");
  await f.click("Copy plain text");
  assert.deepEqual(f.copies, [f.expected.text]);
});
test("email opens immediately with the complete formatted order and no clipboard or paste step", async () => {
  const f = await fixture({ rich: false, copyError: true });
  await f.click("Email order");
  assert.equal(
    f.context.location.href.startsWith("mailto:"),
    true,
    "Open the filled-in email from the first click.",
  );
  const url = new URL(f.context.location.href);
  assert.equal(url.pathname, "alwholesaleorders@gmail.com");
  assert.equal(url.searchParams.get("subject"), "Frozen <store>");
  assert.equal(
    url.searchParams.get("body"),
    f.expected.text.replace(/\n/g, "\r\n"),
  );
  assert.match(url.searchParams.get("body"), /\r\n\r\n\r\n\.\.\.\r\n\r\n\r\n/);
  assert.equal(url.searchParams.get("body").includes("AW-1"), false);
  assert.equal(f.dialogs.length, 1);
  assert.equal(f.copies.length + f.richCopies.length + f.shares.length, 0);
});
test("prefilled email encodes Unicode and reserved characters without creating extra recipients or fields", async () => {
  const f = await fixture({
    orderOverride: {
      storeSnapshot: {
        name: "Café & Sons + #1?\r\nBcc: nobody@example.invalid",
      },
      notes: "Check 50% + A&B? #fresh 🥭\r\nDeliver carefully",
    },
  });
  await f.click("Email order");
  assert.equal(f.context.location.href.startsWith("mailto:"), true);
  const url = new URL(f.context.location.href);
  assert.deepEqual([...url.searchParams.keys()], ["subject", "body"]);
  assert.equal(url.pathname, "alwholesaleorders@gmail.com");
  assert.equal(url.searchParams.get("subject"), f.expected.storeName);
  assert.doesNotMatch(url.searchParams.get("subject"), /[\r\n]/);
  assert.equal(
    url.searchParams.get("body"),
    f.expected.text.replace(/\n/g, "\r\n"),
  );
});
test("prefilled email preserves every line of a large order", async () => {
  const f = await fixture({
    orderOverride: {
      lines: Array.from({ length: 1201 }, (_, i) => ({
        productId: "p" + i,
        name: "Product " + i,
        quantity: i + 1,
        categoryNames: [i % 2 ? "Drinks" : "Tobacco"],
        variant: "Flavor 🥭",
        note: i === 1200 ? "Keep the final line" : "",
      })),
    },
  });
  await f.click("Email order");
  assert.equal(f.context.location.href.startsWith("mailto:"), true);
  const body = new URL(f.context.location.href).searchParams.get("body");
  assert.equal(body, f.expected.text.replace(/\n/g, "\r\n"));
  assert.equal(body.split("• ").length - 1, 1201);
  assert.match(body, /Product 1200: Flavor 🥭 \(1201\) — Keep the final line/);
});
test("native sharing uses the full order and cancelling does not copy or send", async () => {
  const f = await fixture({
    share: () => {
      throw Object.assign(Error("cancelled"), { name: "AbortError" });
    },
  });
  await f.click("Share plain text");
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
  await f.click("Share plain text");
  assert.deepEqual(f.copies, [f.expected.text]);
});
test("stale identity cannot copy, share, or enter the email flow", async () => {
  const f = await fixture({ share: () => {} });
  f.stale();
  for (const label of [
    "Copy formatted order",
    "Email order",
    "Share plain text",
    "Send / schedule email",
  ])
    await assert.rejects(() => Promise.resolve().then(() => f.click(label)));
  assert.equal(f.copies.length + f.richCopies.length + f.shares.length, 0);
  assert.equal(f.context.location.href, "");
});
