"use strict";
const { createHash, timingSafeEqual } = require("node:crypto");
const {
  getProductImages,
  changeProductImages,
  runProductImages,
} = require("./product-images.cjs");
const digest = (value) => createHash("sha256").update(value).digest();
function registerProductImageWorker(app, options, token) {
  app.post("/internal/product-photos/run", async (req, res) => {
    const authorization = req.get("authorization") || "";
    const supplied = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    if (
      typeof token !== "string" ||
      token.length < 32 ||
      !supplied ||
      supplied.length > 4096 ||
      !timingSafeEqual(digest(token), digest(supplied))
    )
      return res
        .status(401)
        .json({
          error: {
            code: "worker_unauthorized",
            message: "Authorized photo worker required.",
          },
        });
    res.set("Cache-Control", "no-store");
    res.json(await runProductImages(options.repo, options));
  });
}
function registerProductImageApi(app, options) {
  const configured = !!options.provider && !!options.assets;
  const owner = (req, res) => {
    if (req.actor.role === "master") return true;
    res
      .status(403)
      .json({
        error: {
          code: "forbidden",
          message: "Owner access is required to manage product photos.",
        },
      });
    return false;
  };
  app.get("/api/admin/product-photos", async (req, res) => {
    if (!owner(req, res)) return;
    res.json(await getProductImages(options.repo, { configured }));
  });
  app.post("/api/admin/product-photos", async (req, res) => {
    if (!owner(req, res)) return;
    if (!configured)
      return res
        .status(503)
        .json({
          error: {
            code: "photos_not_configured",
            message: "Product photo matching is not configured yet.",
          },
        });
    res.json(await changeProductImages(options.repo, req.body, options));
  });
}
module.exports = { registerProductImageWorker, registerProductImageApi };
