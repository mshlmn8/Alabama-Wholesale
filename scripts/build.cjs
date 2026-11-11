const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const hosting = fs.readFileSync(path.join(root, "apphosting.yaml"), "utf8");
if (Object.keys(manifest.overrides || {}).length && /^\s+buildCommand:/m.test(hosting))
  throw Error(
    "Use package.json scripts.apphosting:build: the App Hosting YAML build override drops npm overrides.",
  );
for (const file of [
  "server.js",
  "lib/auth.cjs",
  "lib/domain.cjs",
  "lib/order-lists.cjs",
  "lib/return-evidence.cjs",
  "lib/purchasing.cjs", "lib/warehouse-routes.cjs", "lib/warehouse-movements.cjs", "lib/purchase-document.cjs", "lib/pick-list.cjs",
  "lib/order-assortments.cjs", "lib/store-operations.cjs", "lib/replenishment.cjs", "lib/replenishment-ai.cjs", "lib/store-operation-routes.cjs", "lib/order-credits.cjs",
  "lib/repository.cjs",
  "lib/record-capacity.cjs",
  "lib/migration.cjs",
  "lib/legacy-subcategories.cjs",
  "lib/restore-catalog-subcategories.cjs",
  "lib/assistant.cjs",
  "lib/assistant-chat.cjs",
  "lib/catalog-photo.cjs",
  "lib/product-images.cjs",
  "lib/product-image-provider.cjs",
  "lib/product-image-library.cjs",
  "lib/product-image-routes.cjs",
  "lib/image-source.cjs",
  "lib/documents.cjs",
  "lib/order-mail.cjs",
  "lib/order-mail-routes.cjs",
  "public/app.js",
  "public/more-tools.js",
  "public/warehouse/app.js", "public/warehouse/helpers.js", "public/warehouse/screens.js", "public/warehouse/sw.js",
  "public/store-operations.js", "public/order-assortments.js", "public/order-workflow.js", "public/order-credits.js",
  "public/category-navigation.js",
  "public/catalog-search.js",
  "public/order-names.mjs",
  "public/order-format.mjs",
  "public/order-collapse.js",
  "public/catalog-photo.js",
  "public/catalog-variants.js",
  "public/catalog-photo-edit.js",
  "public/order-selection.js",
  "public/store-picker.js",
  "public/workspace-chrome.js",
  "public/gemini-chat.js",
  "public/product-photos.js",
  "public/firebase.js",
  "public/storage.js",
  "public/device-storage.js",
  "public/storage-recovery.js",
  "public/session.js",
  "public/draft-sync.js",
  "public/order-downloads.js",
  "public/view-helpers.js",
  "public/phone-layout.js",
  "public/phone-catalog.js",
  "public/catalog-quantities.js",
  "public/sw.js",
])
  execFileSync(process.execPath, ["--check", path.join(root, file)], {
    stdio: "pipe",
  });
for (const file of [
  "public/index.html",
  "public/warehouse/index.html", "public/warehouse/styles.css", "public/warehouse/manifest.webmanifest", "public/warehouse/icon.svg",
  "public/styles.css",
  "public/more-menu.css",
  "public/store-operations.css", "public/order-operations.css",
  "public/builder-layout.css",
  "public/orders-layout.css",
  "public/workspace-layout.css",
  "public/mobile-layout.css",
  "public/phone-redesign.css",
  "public/assets/logo-transparent-v3.png",
  "public/assets/app-icon-v3-192.png",
  "public/assets/app-icon-v3-512.png",
  "public/assets/app-icon-maskable-v3-512.png",
  "public/assets/apple-touch-icon-v3.png",
  "public/assets/favicon-v3-32.png",
  "public/assets/favicon-v3-48.png",
  "public/apple-touch-icon.png",
  "public/favicon.ico",
  "public/warehouse/app-icon-v3-192.png",
  "public/warehouse/app-icon-v3-512.png",
  "public/warehouse/app-icon-maskable-v3-512.png",
  "public/catalog-photo.css",
  "public/catalog-variants.css",
  "public/order-selection.css",
  "public/store-picker.css",
  "config/firebase-web.json",
])
  if (!fs.existsSync(path.join(root, file)))
    throw Error(`Build file missing: ${file}`);
const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
if (Buffer.byteLength(html) > 100000)
  throw Error("App shell unexpectedly large");
if (/FIREBASE_APPCHECK_DEBUG_TOKEN|passwordHash|MASTER_PASS/.test(html))
  throw Error("Private configuration detected in app shell");
console.log(
  `Build verified: explicit Node server and ${Buffer.byteLength(html)}-byte HTML shell.`,
);
