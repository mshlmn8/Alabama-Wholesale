// Synthetic, loopback-only preview. This file is excluded from the App Hosting runtime.
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9098";
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { createApp } = require("../server.js");
const { MemoryRepository } = require("../lib/repository.cjs");
const { createAuthService } = require("../lib/auth.cjs");
const { inventoryId } = require("../lib/domain.cjs");
initializeApp({ projectId: "demo-alabama-wholesale" });
const profiles = [
  {
    id: "demo-owner",
    uid: "demo-owner",
    name: "Demo Owner",
    email: "demoowner@example.com",
    role: "master",
    active: true,
    storeIds: [],
  },
  {
    id: "demo-customer",
    uid: "demo-customer",
    name: "Demo Customer",
    email: "democustomer@example.com",
    role: "customer",
    active: true,
    storeIds: ["store-one"],
  },
];
const repo = new MemoryRepository({
  users: profiles,
  categories: [
    { id: "drinks", name: "Drinks", version: 1 },
    { id: "snacks", name: "Snacks", version: 1 },
  ],
  products: [
    {
      id: "orange",
      name: "Orange Sparkling Water",
      categoryIds: ["drinks"],
      variants: ["Orange", "Lime"],
      priceCents: 250,
      variantPricesCents: {},
      packSize: 12,
      barcode: "123456789012",
      sku: "WATER-01",
      taxable: true,
      stockStatus: "in-stock",
      version: 1,
    },
    {
      id: "chips",
      name: "Sea Salt Potato Chips",
      categoryIds: ["snacks"],
      variants: [],
      priceCents: 175,
      variantPricesCents: {},
      packSize: 24,
      barcode: "123456789013",
      taxable: true,
      stockStatus: "in-stock",
      version: 1,
    },
    {
      id: "unpriced",
      name: "New Product — Price Needed",
      categoryIds: ["snacks"],
      variants: [],
      priceCents: null,
      packSize: null,
      taxable: false,
      version: 1,
    },
  ],
  stores: [
    {
      id: "store-one",
      name: "Magnolia Market",
      contact: "Jordan Lee",
      phone: "555-0100",
      email: "demo-customer@example.com",
      address: "123 Example Street, Birmingham, AL",
      taxRateBps: 800,
      creditLimitCents: 100000,
      terms: "Net 15",
      priceOverrides: {},
      version: 1,
    },
    {
      id: "store-two",
      name: "Riverfront Grocery",
      taxRateBps: 0,
      creditLimitCents: null,
      terms: "",
      priceOverrides: {},
      version: 1,
    },
  ],
  inventory: [
    {
      id: inventoryId("orange", "Orange"),
      productId: "orange",
      variant: "Orange",
      onHand: 48,
      reserved: 0,
      reorderPoint: 12,
      version: 1,
    },
    {
      id: inventoryId("orange", "Lime"),
      productId: "orange",
      variant: "Lime",
      onHand: 12,
      reserved: 0,
      reorderPoint: 12,
      version: 1,
    },
    {
      id: inventoryId("chips", ""),
      productId: "chips",
      variant: "",
      onHand: 100,
      reserved: 0,
      reorderPoint: 24,
      version: 1,
    },
  ],
  ledger: [
    {
      id: "opening",
      storeId: "store-one",
      type: "opening",
      deltaCents: 10000,
      amountCents: 10000,
      createdAt: Date.now(),
      version: 1,
    },
  ],
});
const objects = new Map();
const assets = require("../lib/assets.cjs").createAssetService({
  bucket: {
    file: (key) => ({
      save: async (bytes, options) => objects.set(key, { bytes, options }),
      download: async () => [objects.get(key).bytes],
      getMetadata: async () => [
        {
          size: objects.get(key)?.bytes.length,
          contentType: objects.get(key)?.options.metadata.contentType,
        },
      ],
    }),
  },
});
(async () => {
  for (const profile of profiles) {
    try {
      await getAuth().createUser({
        uid: profile.uid,
        email: profile.email,
        password: "DemoOnly!2026",
        emailVerified: true,
        displayName: profile.name,
      });
    } catch (e) {
      if (
        e.code !== "auth/uid-already-exists" &&
        e.code !== "auth/email-already-exists"
      )
        throw e;
    }
  }
  const auth = createAuthService({
    repo,
    ownerEmail: "demoowner@example.com",
    verifyIdToken: (t, r) => getAuth().verifyIdToken(t, r),
    requireAppCheck: false,
  });
  const config = {
    firebaseConfig: {
      projectId: "demo-alabama-wholesale",
      apiKey: "demo-api-key",
      authDomain: "demo-alabama-wholesale.firebaseapp.com",
      appId: "demo-app",
    },
    recaptchaSiteKey: null,
    emulators: { auth: "http://127.0.0.1:9098" },
    appOrigin: "http://localhost:8780",
    legacyWritesFrozen: false,
  };
  createApp({
    repo,
    auth,
    config,
    assets,
    assistant: async () => ({
      lines: [
        {
          productId: "orange",
          variant: "Orange",
          quantity: 2,
          unit: "each",
          note: "",
        },
      ],
      ambiguities: ["Synthetic preview response — no Gemini request was made."],
      summary: "Two orange waters for review.",
    }),
  }).listen(8780, "127.0.0.1", () =>
    console.log("Synthetic preview ready at http://localhost:8780"),
  );
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
