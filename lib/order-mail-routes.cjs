"use strict";
const { createHash, timingSafeEqual } = require("node:crypto");
const {
  getOrderMail,
  getOrderMailConfig,
  changeOrderMail,
  updateOrderMailSettings,
  deliverOrderMail,
} = require("./order-mail.cjs");
const digest = (value) => createHash("sha256").update(value).digest();
function registerOrderMailWorker(app, options, workerToken) {
  app.post("/internal/order-email/run", async (req, res) => {
    const authorization = req.get("authorization") || "";
    const supplied = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    if (
      typeof workerToken !== "string" ||
      workerToken.length < 32 ||
      supplied.length > 4096 ||
      !supplied ||
      !timingSafeEqual(digest(workerToken), digest(supplied))
    )
      return res.status(401).json({
        error: {
          code: "worker_unauthorized",
          message: "Authorized scheduling service required.",
        },
      });
    res.set("Cache-Control", "no-store");
    res.json(await deliverOrderMail(options.repo, options));
  });
}
function registerOrderMailApi(app, options) {
  const configured =
    typeof options.transport?.sendMail === "function" && !!options.from;
  const config = () => getOrderMailConfig(options.repo, { configured });
  app.get("/api/order-email/config", async (_req, res) =>
    res.json(await config()),
  );
  app.get("/api/orders/:id/email", async (req, res) => {
    const job = await getOrderMail(options.repo, req.actor, req.params.id);
    res.json({ job, config: await config() });
  });
  app.post("/api/orders/:id/email", async (req, res) => {
    if (!configured && req.body?.action !== "cancel")
      return res
        .status(503)
        .json({
          error: {
            code: "sender_not_configured",
            message:
              "Connect the dedicated email sender before sending or scheduling order emails.",
          },
        });
    res.json({
      job: await changeOrderMail(
        options.repo,
        req.actor,
        req.params.id,
        req.body,
        { now: options.now },
      ),
    });
  });
  app.post("/api/admin/order-email/settings", async (req, res) => {
    await updateOrderMailSettings(options.repo, req.actor, req.body, {
      now: options.now,
      configured,
    });
    res.json(await config());
  });
}
module.exports = { registerOrderMailWorker, registerOrderMailApi };
