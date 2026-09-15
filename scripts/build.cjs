const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
for (const file of [
  "server.js",
  "lib/auth.cjs",
  "lib/domain.cjs",
  "lib/repository.cjs",
  "lib/migration.cjs",
  "lib/assistant.cjs",
  "lib/assistant-chat.cjs",
  "lib/product-images.cjs",
  "lib/product-image-provider.cjs",
  "lib/product-image-routes.cjs",
  "lib/image-source.cjs",
  "lib/documents.cjs",
  "lib/order-mail.cjs",
  "lib/order-mail-routes.cjs",
  "public/app.js",
  "public/gemini-chat.js",
  "public/product-photos.js",
  "public/firebase.js",
  "public/storage.js",
  "public/session.js",
  "public/draft-sync.js",
  "public/order-downloads.js",
  "public/view-helpers.js",
  "public/sw.js",
])
  execFileSync(process.execPath, ["--check", path.join(root, file)], {
    stdio: "pipe",
  });
for (const file of [
  "public/index.html",
  "public/styles.css",
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
