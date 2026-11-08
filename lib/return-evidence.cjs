"use strict";
const TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
function validatePhotos(value, h) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 3)
    h.fail("INVALID_INPUT", "Attach up to three delivery photos.");
  return value.map((photo) => {
    h.object(photo, "Delivery photo");
    if (
      !TYPES.has(photo.mimeType) ||
      typeof photo.data !== "string" ||
      !photo.data.length ||
      photo.data.length > 273068 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(photo.data)
    )
      h.fail("INVALID_INPUT", "Choose a PNG, JPEG or WebP photo up to 200 KB.");
    const bytes = Buffer.from(photo.data, "base64");
    if (bytes.length > 200 * 1024 || bytes.toString("base64") !== photo.data)
      h.fail("INVALID_INPUT", "The delivery photo could not be read.");
    const valid =
      photo.mimeType === "image/png"
        ? bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : photo.mimeType === "image/jpeg"
          ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : bytes.toString("ascii", 0, 4) === "RIFF" &&
            bytes.toString("ascii", 8, 12) === "WEBP";
    if (!valid)
      h.fail(
        "INVALID_INPUT",
        "The delivery photo contents do not match its file type.",
      );
    return { mimeType: photo.mimeType, data: photo.data, size: bytes.length };
  });
}
async function attachPhotos(tx, record, photos) {
  const result = [];
  for (const [index, photo] of photos.entries()) {
    const id = `${record.id}--${index}`;
    await tx.set("returnPhotos", id, {
      id,
      returnId: record.id,
      storeId: record.storeId,
      createdBy: record.createdBy,
      createdAt: record.createdAt,
      ...photo,
    });
    result.push({ id, mimeType: photo.mimeType, size: photo.size });
  }
  return result;
}
function registerReturnEvidence(app, { repo, access }) {
  app.get("/api/returns/:returnId/photos/:photoId", async (req, res) => {
    const record = await repo.get("returns", req.params.returnId);
    if (!record || record.deleted)
      return res.status(404).json({
        error: { code: "not_found", message: "Delivery photo not found." },
      });
    access(req.actor, record.storeId);
    if (!(record.photos || []).some((photo) => photo.id === req.params.photoId))
      return res.status(404).json({
        error: { code: "not_found", message: "Delivery photo not found." },
      });
    const photo = await repo.get("returnPhotos", req.params.photoId);
    if (
      !photo ||
      photo.returnId !== record.id ||
      photo.storeId !== record.storeId ||
      !TYPES.has(photo.mimeType)
    )
      return res.status(404).json({
        error: { code: "not_found", message: "Delivery photo not found." },
      });
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Content-Disposition", "inline");
    res.type(photo.mimeType).send(Buffer.from(photo.data, "base64"));
  });
}
module.exports = { validatePhotos, attachPhotos, registerReturnEvidence };
