const express = require("express");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { safeProfile } = require("./lib/auth.cjs");
const error = (status, code, message) =>
  Object.assign(new Error(message), { status, code, expose: true });
const { storeBalance } = require("./lib/domain.cjs");
const publicOrder = (order) => {
  const result = { ...order };
  if (result.legacy) {
    result.legacy = { ...result.legacy };
    delete result.legacy.rawLines;
  }
  return result;
};
const PUBLIC = path.join(__dirname, "public");
const BACKUP_COLLECTIONS = [
  "categories",
  "products",
  "stores",
  "orders",
  "inventory",
  "ledger",
  "payments",
  "returns",
  "notifications",
  "audit",
  "preferences",
  "legacyProfiles",
  "legacyDrafts",
  "legacySettings",
  "migrationExceptions",
  "migrations",
  "counters",
  "users",
  "settings",
  "commandReceipts",
  "invites",
  "outbox",
  "aiLimits",
  "inviteVersions",
];
function createApp({
  repo,
  auth,
  config = {},
  assistant,
  documents,
  assets,
  emailTransport,
  emailFrom,
  now = () => Date.now(),
}) {
  const app = express();
  app.use(require("compression")());
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
      "Content-Security-Policy":
        "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self' https://www.gstatic.com https://www.google.com https://www.recaptcha.net https://apis.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https://*.googleapis.com https://*.firebaseapp.com https://*.firebaseio.com https://www.google.com https://www.recaptcha.net https://www.gstatic.com; frame-src https://*.firebaseapp.com https://www.google.com https://www.recaptcha.net https://recaptcha.google.com; form-action 'self'; worker-src 'self' blob:",
    });
    if (
      config.emulators &&
      (req.hostname === "localhost" || req.hostname === "127.0.0.1")
    )
      res.set(
        "Content-Security-Policy",
        res
          .get("Content-Security-Policy")
          .replace(
            "connect-src 'self'",
            "connect-src 'self' http://127.0.0.1:9098 http://localhost:9098",
          )
          .replace(
            "frame-src ",
            "frame-src http://127.0.0.1:9098 http://localhost:9098 ",
          ),
      );
    if (req.secure)
      res.set(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    next();
  });
  app.get("/healthz", (_req, res) =>
    res.json({ status: "ok", version: "2", service: "alabama-wholesale" }),
  );
  app.get("/api/config", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(config);
  });
  app.get("/firebase-config.json", (_req, res) => {
    const {
      firebaseConfig,
      recaptchaSiteKey,
      appOrigin,
      emulators,
      emailDeliveryConfigured,
    } = config;
    res.set("Cache-Control", "public, max-age=60");
    res.json({
      firebaseConfig,
      recaptchaSiteKey,
      appOrigin,
      emulators,
      emailDeliveryConfigured,
    });
  });
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    next();
  });
  app.use("/api", async (req, _res, next) => {
    try {
      req.identity = await auth.authenticate(req);
      next();
    } catch (e) {
      next(e);
    }
  });
  app.use("/api", express.json({ limit: "9mb" }));
  app.post("/api/session/bootstrap", async (req, res) =>
    res.json(await auth.bootstrap(req.identity)),
  );
  app.post("/api/invites/accept", async (req, res) =>
    res.json({ me: await auth.accept(req.identity, req.body?.token) }),
  );
  app.use("/api", async (req, _res, next) => {
    try {
      req.actor = await auth.actor(req.identity);
      next();
    } catch (e) {
      next(e);
    }
  });
  const catalogCache = new Map();
  async function catalog(collection) {
    const cached = catalogCache.get(collection);
    if (cached && cached.expires > now()) return cached.value;
    const value = await repo.list(collection);
    catalogCache.set(collection, { value, expires: now() + 15000 });
    return value;
  }
  const master = (req) => {
    if (req.actor.role !== "master")
      throw error(
        403,
        "forbidden",
        "This action requires administrator access.",
      );
  };
  const owner = (req) => {
    master(req);
    if (!auth.isOwner(req.identity))
      throw error(
        403,
        "owner_required",
        "Sign in with the configured owner Google account for this action.",
      );
  };
  const access = (actor, storeId) => {
    if (actor.role !== "master" && !actor.storeIds.includes(storeId))
      throw error(
        403,
        "store_forbidden",
        "You do not have access to this store.",
      );
  };
  async function scoped(collection, actor, options = {}) {
    if (
      actor.role === "master" ||
      options.where?.some(([field, op]) => field === "storeId" && op === "==")
    )
      return repo.list(collection, options);
    if (!actor.storeIds.length) return [];
    const all = [];
    for (let i = 0; i < actor.storeIds.length; i += 30)
      all.push(
        ...(await repo.list(collection, {
          ...options,
          where: [
            ...(options.where || []),
            ["storeId", "in", actor.storeIds.slice(i, i + 30)],
          ],
        })),
      );
    const byId = [...new Map(all.map((r) => [r.id, r])).values()];
    return options.orderBy
      ? byId
          .sort(
            (a, b) =>
              (b.createdAt || 0) - (a.createdAt || 0) ||
              Buffer.compare(Buffer.from(b.id), Buffer.from(a.id)),
          )
          .slice(0, options.limit || Infinity)
      : byId;
  }
  async function notificationsFor(actor) {
    const rows = await scoped("notifications", actor, {
      orderBy: [["createdAt", "desc"]],
      limit: 100,
    });
    if (actor.role === "salesman")
      rows.push(
        ...(await repo.list("notifications", {
          where: [["audience", "==", "staff"]],
          orderBy: [["createdAt", "desc"]],
          limit: 100,
        })),
      );
    return [...new Map(rows.map((row) => [row.id, row])).values()]
      .sort(
        (a, b) =>
          (b.createdAt || 0) - (a.createdAt || 0) ||
          Buffer.compare(Buffer.from(b.id), Buffer.from(a.id)),
      )
      .slice(0, 100);
  }
  async function history(actor, { storeId, status, cursor, limit = 50 } = {}) {
    if (storeId) access(actor, storeId);
    if (cursor) {
      const order = await repo.get("orders", cursor);
      if (!order)
        throw error(409, "invalid_cursor", "Refresh the history list.");
      access(actor, order.storeId);
    }
    const orders = [];
    let scanCursor = cursor;
    while (orders.length <= limit) {
      const options = {
        where: [
          ...(storeId ? [["storeId", "==", storeId]] : []),
          ...(status ? [["status", "==", status]] : []),
        ],
        orderBy: [
          ["createdAt", "desc"],
          ["id", "desc"],
        ],
        limit: limit + 1,
        ...(scanCursor ? { startAfter: scanCursor } : {}),
      };
      const page = await scoped("orders", actor, options);
      if (!page.length) break;
      orders.push(...page.filter((order) => order.deleted !== true));
      if (page.length < limit + 1) break;
      scanCursor = page[page.length - 1].id;
    }
    return {
      orders: orders.slice(0, limit).map(publicOrder),
      nextCursor: orders.length > limit ? orders[limit - 1].id : null,
    };
  }

  app.get("/api/state", async (req, res) => {
    const actor = req.actor;
    if (
      config.requireMigration &&
      !(await repo.get("settings", "migrationGate"))?.complete
    )
      throw error(
        503,
        "upgrade_in_progress",
        "The app upgrade is being completed. Your existing records are protected. Please try again shortly.",
      );
    const [contactUsers, contactLegacy] = await Promise.all([
      repo.list("users"),
      repo.list("legacyProfiles"),
    ]);
    const [
      categories,
      products,
      allStores,
      orderPage,
      inventory,
      ledger,
      payments,
      returns,
      notifications,
      users,
      preferences,
      migration,
      legacyProfiles,
      audit,
    ] = await Promise.all([
      catalog("categories"),
      catalog("products"),
      actor.role === "master"
        ? repo.list("stores")
        : Promise.all(actor.storeIds.map((id) => repo.get("stores", id))).then(
            (r) => r.filter(Boolean),
          ),
      history(actor),
      repo.list("inventory", { where: [["onHand", ">=", 0]] }),
      scoped("ledger", actor),
      scoped("payments", actor),
      scoped("returns", actor),
      notificationsFor(actor),
      actor.role === "master" ? repo.list("users") : [],
      repo.get("preferences", actor.uid),
      actor.role === "master" ? repo.list("migrations") : [],
      actor.role === "master" ? repo.list("legacyProfiles") : [],
      actor.role === "master"
        ? repo.list("audit", { orderBy: [["createdAt", "desc"]], limit: 100 })
        : [],
    ]);
    const stores = allStores.map((store) => {
      const result = {
        ...store,
        balanceCents: store.migrationBlocked
          ? null
          : storeBalance(ledger, store.id),
      };
      delete result.legacy;
      const assigned = [...contactUsers, ...contactLegacy].find(
        (p) =>
          p.id === store.salesmanId ||
          p.uid === store.salesmanId ||
          p.legacyProfileId === store.salesmanId,
      );
      if (assigned) {
        const info = assigned.salesmanInfo || {};
        result.assignedSalesman = {
          name:
            info.name ||
            assigned.name ||
            assigned.displayName ||
            assigned.username ||
            "",
          phone: info.phone || assigned.phone || "",
          email: info.email || assigned.email || "",
        };
      }
      return result;
    });
    res.json({
      me: { ...actor, preferences: preferences || {} },
      categories,
      products,
      stores,
      orders: orderPage.orders,
      nextCursor: orderPage.nextCursor,
      inventory,
      ledger: ledger.map((row) => {
        const r = { ...row };
        delete r.legacy;
        return r;
      }),
      payments,
      returns,
      notifications: (preferences?.notificationPreferences?.inApp === false
        ? []
        : notifications
      ).filter(
        (row) =>
          !row.userId || row.userId === actor.uid || actor.role === "master",
      ),
      users: users.map(safeProfile),
      legacyProfiles: legacyProfiles.map((p) => {
        const r = { ...p };
        delete r.legacy;
        delete r.passwordHash;
        delete r.password;
        delete r.salt;
        return r;
      }),
      migration,
      audit,
    });
  });
  app.get("/api/orders", async (req, res) =>
    res.json(
      await history(req.actor, {
        storeId: req.query.storeId,
        status: req.query.status,
        cursor: req.query.cursor,
      }),
    ),
  );
  app.post("/api/commands", async (req, res) => {
    if (
      config.requireMigration &&
      !(await repo.get("settings", "migrationGate"))?.complete
    )
      throw error(
        503,
        "upgrade_in_progress",
        "The app upgrade is being completed. Please try again shortly.",
      );
    const { executeCommand } = require("./lib/domain.cjs");
    const result = await repo.transaction((tx) =>
      executeCommand(tx, req.actor, req.body, { now: now(), id: randomUUID }),
    );
    try {
      if (
        [
          "order.submit",
          "order.transition",
          "payment.report",
          "payment.verify",
          "payment.allocate",
          "return.create",
          "return.approve",
          "inventory.adjust",
        ].includes(req.body.type)
      )
        await require("./lib/notifications.cjs").queueNotifications(repo, {
          now: now(),
          id: randomUUID,
        });
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "notification_queue_pending",
          code: e.code || "queue_error",
        }),
      );
    }
    if (req.body.type === "product.save") catalogCache.delete("products");
    if (req.body.type === "category.save") catalogCache.delete("categories");
    res.json({ result });
  });
  app.post("/api/assets/upload", async (req, res) => {
    master(req);
    if (!assets)
      throw error(
        503,
        "assets_unavailable",
        "Product image uploads are not configured.",
      );
    res.json(await assets.upload(req.body?.image));
  });
  app.post("/api/users/:uid/access", async (req, res) => {
    master(req);
    res.json({
      user: await auth.updateAccess(req.actor, req.params.uid, req.body || {}),
    });
  });
  app.post("/api/invites", async (req, res) => {
    master(req);
    const invitation = await auth.invite(req.actor, req.body || {});
    const origin = config.appOrigin || `${req.protocol}://${req.get("host")}`;
    res.json({
      ...invitation,
      link: `${origin}/?invite=${encodeURIComponent(invitation.token)}`,
    });
  });
  app.post("/api/admin/migrate", async (req, res) => {
    owner(req);
    if (!repo.legacySnapshot)
      throw error(
        503,
        "migration_unavailable",
        "Legacy migration is not configured in this environment.",
      );
    const { buildMigration, migrate } = require("./lib/migration.cjs");
    const snapshot = await repo.legacySnapshot();
    const plan = buildMigration(snapshot, { now: now() });
    if (req.body?.dryRun !== false)
      return res.json({
        migrationId: plan.migrationId,
        sourceChecksum: plan.sourceChecksum,
        report: plan.report,
      });
    if (!config.legacyWritesFrozen)
      throw error(
        409,
        "freeze_required",
        "Legacy writes must be frozen and backed up before migration can run.",
      );
    if (req.body.sourceChecksum !== plan.sourceChecksum)
      throw error(
        409,
        "source_changed",
        "Legacy data changed. Review a fresh migration preview.",
      );
    await repo.archiveSnapshot(snapshot, plan.sourceChecksum);
    const result = await migrate(repo, snapshot, { now: now() });
    res.json({
      migrationId: result.migrationId,
      sourceChecksum: result.sourceChecksum,
      report: result.report,
      execution: result.execution,
    });
  });
  app.get("/api/admin/notifications", async (req, res) => {
    master(req);
    await require("./lib/notifications.cjs").queueNotifications(repo, {
      now: now(),
      id: randomUUID,
    });
    const rows = await repo.list("outbox");
    res.json({
      configured: !!emailTransport && !!emailFrom,
      from: emailFrom || null,
      outbox: rows.map((row) =>
        Object.fromEntries(
          [
            "id",
            "notificationId",
            "userId",
            "to",
            "subject",
            "status",
            "createdAt",
            "updatedAt",
            "sentAt",
            "attempts",
            "lastError",
            "failureReason",
          ]
            .filter((k) => row[k] !== undefined)
            .map((k) => [k, row[k]]),
        ),
      ),
    });
  });
  app.post("/api/admin/notifications/deliver", async (req, res) => {
    master(req);
    if (!emailTransport || !emailFrom)
      throw error(
        503,
        "sender_not_configured",
        "The email sender is not connected yet.",
      );
    const {
      queueNotifications,
      deliverOutbox,
    } = require("./lib/notifications.cjs");
    await queueNotifications(repo, { now: now(), id: randomUUID });
    res.json(
      await deliverOutbox(repo, {
        transport: emailTransport,
        from: emailFrom,
        limit: 20,
        now,
        id: randomUUID,
      }),
    );
  });
  app.post("/api/admin/notifications/:id/retry", async (req, res) => {
    master(req);
    const { retryOutbox } = require("./lib/notifications.cjs");
    res.json(
      await retryOutbox(repo, req.params.id, {
        actor: req.actor,
        reason: req.body?.reason,
        acknowledgeDuplicateRisk: req.body?.acknowledgeDuplicateRisk,
        now: now(),
        id: randomUUID,
      }),
    );
  });
  app.get("/api/admin/backup", async (req, res) => {
    owner(req);
    const collections = await repo.snapshot(BACKUP_COLLECTIONS);
    const data = {
      format: "alabama-wholesale-v2",
      createdAt: now(),
      collections,
    };
    const checksum = createHash("sha256")
      .update(JSON.stringify(data))
      .digest("hex");
    res.set(
      "Content-Disposition",
      'attachment; filename="alabama-wholesale-backup.json"',
    );
    res.json({ ...data, checksum });
  });
  app.post("/api/admin/restore", async (req, res) => {
    owner(req);
    const backup = req.body?.backup;
    if (
      !backup ||
      backup.format !== "alabama-wholesale-v2" ||
      !backup.collections ||
      typeof backup.collections !== "object"
    )
      throw error(
        400,
        "invalid_backup",
        "Choose a valid Alabama Wholesale v2 backup.",
      );
    const { checksum, ...data } = backup;
    const actual = createHash("sha256")
      .update(JSON.stringify(data))
      .digest("hex");
    if (checksum !== actual)
      throw error(
        400,
        "backup_checksum",
        "The backup contents do not match its checksum.",
      );
    const records = [];
    for (const [collection, rows] of Object.entries(backup.collections)) {
      if (!BACKUP_COLLECTIONS.includes(collection) || !Array.isArray(rows))
        throw error(
          400,
          "invalid_backup",
          "The backup contains an unsupported collection.",
        );
      const ids = new Set();
      for (const row of rows) {
        if (
          !row ||
          typeof row.id !== "string" ||
          row.id.includes("/") ||
          !row.id ||
          ids.has(row.id)
        )
          throw error(
            400,
            "invalid_backup",
            "The backup contains an invalid or duplicate record.",
          );
        ids.add(row.id);
        records.push({ collection, id: row.id, data: row });
      }
    }
    if (records.length > 20000)
      throw error(
        413,
        "backup_too_large",
        "Use the managed restore procedure for this backup.",
      );
    if (req.body.dryRun !== false)
      return res.json({
        backupId: checksum,
        recordCount: records.length,
        mode: "isolated-recovery",
      });
    if (req.body.backupId !== checksum)
      throw error(
        409,
        "preview_required",
        "Review the backup preview before restoring.",
      );
    if (!repo.isolated)
      throw error(
        503,
        "recovery_unavailable",
        "Recovery storage is not configured.",
      );
    const namespace = checksum.slice(0, 24);
    const target = repo.isolated(namespace);
    for (let i = 0; i < records.length; i += 100)
      await target.transaction(async (tx) => {
        for (const row of records.slice(i, i + 100))
          if (!(await tx.get(row.collection, row.id)))
            await tx.set(row.collection, row.id, row.data);
      });
    const restored = {};
    for (const [collection, rows] of Object.entries(backup.collections)) {
      const actualRows = await target.list(collection);
      const normalize = (list) =>
        require("./lib/migration.cjs").checksumSnapshot(
          list.sort((a, b) => a.id.localeCompare(b.id)),
        );
      if (normalize(actualRows) !== normalize(structuredClone(rows)))
        throw error(
          500,
          "recovery_verification_failed",
          "The restored copy could not be verified.",
        );
      restored[collection] = actualRows.length;
    }
    await repo.put("audit", randomUUID(), {
      type: "backup.restore_verified",
      actorId: req.actor.uid,
      createdAt: now(),
      checksum,
      namespace,
      recordCount: records.length,
    });
    res.json({
      restored: records.length,
      verified: true,
      namespace,
      collections: restored,
    });
  });

  app.post("/api/assistant/propose", async (req, res) => {
    const minute = Math.floor(now() / 60000),
      day = Math.floor(now() / 86400000);
    await repo.transaction(async (tx) => {
      for (const [period, key, limit] of [
        ["minute", minute, 10],
        ["day", day, 100],
      ]) {
        const id = createHash("sha256")
          .update(`${req.actor.uid}:${period}:${key}`)
          .digest("hex");
        const previous = await tx.get("aiLimits", id);
        if ((previous?.count || 0) >= limit)
          throw error(
            429,
            "assistant_rate_limit",
            `Your ${period === "minute" ? "minute" : "daily"} AI request limit has been reached. Try again later.`,
          );
        await tx.set("aiLimits", id, {
          id,
          userId: req.actor.uid,
          period,
          key,
          count: (previous?.count || 0) + 1,
          createdAt: now(),
          expiresAt: now() + 2 * 86400000,
        });
      }
    });
    const products = await repo.list("products");
    const propose = assistant || require("./lib/assistant.cjs").propose;
    res.json(
      await propose(req.body, {
        products,
        identity: req.identity,
        headers: req.headers,
        config,
      }),
    );
  });
  app.get("/api/documents/:orderId/:kind", async (req, res) => {
    const order = await repo.get(
      req.params.kind === "credit-memo" ? "returns" : "orders",
      req.params.orderId,
    );
    if (!order)
      throw error(404, "order_not_found", "This order was not found.");
    access(req.actor, order.storeId);
    const store = await repo.get("stores", order.storeId);
    const render = documents || require("./lib/documents.cjs").renderDocument;
    const buffer = await render(order, store, req.params.kind);
    res.type("application/pdf");
    res.set(
      "Content-Disposition",
      `inline; filename="${req.params.kind}-${order.id.replace(/[^a-zA-Z0-9_-]/g, "")}.pdf"`,
    );
    res.send(buffer);
  });
  app.use("/api", (_req, _res, next) =>
    next(error(404, "not_found", "This API endpoint does not exist.")),
  );
  app.get("/service-worker.js", (_req, res) => {
    res.set({ "Cache-Control": "no-store", "Service-Worker-Allowed": "/" });
    res.sendFile(path.join(PUBLIC, "sw.js"));
  });
  app.get("/media/products/:file", async (req, res) => {
    if (!assets) return res.status(404).send("Image not found");
    try {
      const image = await assets.read(req.params.file);
      res.set("Cache-Control", "public, max-age=31536000, immutable");
      res.type(image.type).send(image.bytes);
    } catch (e) {
      if (e.code === 404 || e.status === 404)
        return res.status(404).send("Image not found");
      throw e;
    }
  });
  app.use(
    express.static(PUBLIC, {
      dotfiles: "deny",
      index: "index.html",
      setHeaders: (res, file) => {
        res.set(
          "Cache-Control",
          file.includes(`${path.sep}assets${path.sep}`)
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        );
      },
    }),
  );
  app.use((_req, res) => res.status(404).send("Not found"));
  app.use((e, _req, res, _next) => {
    const status = e.status || 500;
    if (status >= 500)
      console.error(
        JSON.stringify({
          event: "request_failed",
          code: e.code || "internal",
          message: e.message,
        }),
      );
    res.status(status).json({
      error: {
        code: e.code || "internal_error",
        message:
          status >= 500 && !e.expose
            ? "The server could not complete this request. Please retry."
            : e.message,
      },
    });
  });
  return app;
}
function production() {
  const {
    initializeApp,
    applicationDefault,
    getApps,
  } = require("firebase-admin/app");
  const { getAuth } = require("firebase-admin/auth");
  const { getAppCheck } = require("firebase-admin/app-check");
  const { getFirestore } = require("firebase-admin/firestore");
  const { FirestoreRepository } = require("./lib/repository.cjs");
  const { createAuthService } = require("./lib/auth.cjs");
  const firebaseConfig = require("./config/firebase-web.json");
  if (!getApps().length)
    initializeApp({
      credential: applicationDefault(),
      projectId: firebaseConfig.projectId,
    });
  const db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });
  const repo = new FirestoreRepository(db);
  const config = {
    firebaseConfig,
    recaptchaSiteKey:
      process.env.RECAPTCHA_SITE_KEY ||
      "6Lf3U7otAAAAACGbmjPfLkPpdP3KUyo4-36lLq7T",
    appOrigin:
      process.env.APP_ORIGIN ||
      "https://alabama-wholesale--alabama-wholesale-ordering-app.us-east4.hosted.app",
    legacyWritesFrozen: process.env.LEGACY_WRITES_FROZEN === "true",
    requireMigration: true,
  };
  const auth = createAuthService({
    repo,
    ownerEmail: process.env.OWNER_EMAIL || "mshlalmnswb@gmail.com",
    verifyIdToken: (token, revoked) => getAuth().verifyIdToken(token, revoked),
    verifyAppCheckToken: (token) => getAppCheck().verifyToken(token),
    appId: firebaseConfig.appId,
    requireAppCheck: process.env.FIREBASE_AUTH_EMULATOR_HOST ? false : true,
  });
  const { getStorage } = require("firebase-admin/storage");
  const { createAssetService } = require("./lib/assets.cjs");
  const assets = createAssetService({
    bucket: getStorage().bucket(firebaseConfig.storageBucket),
  });
  const { createSmtpTransport } = require("./lib/notifications.cjs");
  const emailFrom = process.env.EMAIL_FROM || null;
  const emailTransport =
    process.env.SMTP_URL && emailFrom
      ? createSmtpTransport({ smtpUrl: process.env.SMTP_URL })
      : null;
  config.emailDeliveryConfigured = !!emailTransport;
  return createApp({ repo, auth, config, assets, emailTransport, emailFrom });
}
if (require.main === module)
  production().listen(process.env.PORT || 8080, () =>
    console.log("Alabama Wholesale API is ready."),
  );
module.exports = { createApp, production };
