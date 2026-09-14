const { createHash } = require("node:crypto");
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status, code: "invalid_image" });
};
const types = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
function createAssetService({ bucket }) {
  async function upload(image) {
    if (!image || !types[image.mimeType] || typeof image.data !== "string")
      fail(400, "Choose a PNG, JPEG or WebP product image.");
    if (image.data.length > 7_000_000)
      fail(413, "Choose an image smaller than 5 MB.");
    if (
      /[^A-Za-z0-9+/=]/.test(image.data) ||
      Buffer.from(image.data, "base64").toString("base64") !== image.data
    )
      fail(400, "The image could not be read.");
    const bytes = Buffer.from(image.data, "base64");
    if (!bytes.length || bytes.length > 5 * 1024 * 1024)
      fail(413, "Choose an image smaller than 5 MB.");
    const valid =
      image.mimeType === "image/png"
        ? bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : image.mimeType === "image/jpeg"
          ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : bytes.toString("ascii", 0, 4) === "RIFF" &&
            bytes.toString("ascii", 8, 12) === "WEBP";
    if (!valid)
      fail(400, "The image contents do not match the selected file type.");
    const filename = `${createHash("sha256").update(bytes).digest("hex")}.${types[image.mimeType]}`;
    await bucket
      .file(`product-media/${filename}`)
      .save(bytes, {
        resumable: false,
        metadata: {
          contentType: image.mimeType,
          cacheControl: "public, max-age=31536000, immutable",
        },
      });
    return { url: `/media/products/${filename}` };
  }
  async function read(filename) {
    if (!/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(filename))
      fail(404, "Image not found.");
    const file = bucket.file(`product-media/${filename}`);
    const [metadata] = await file.getMetadata();
    if (!types[metadata.contentType] || Number(metadata.size) > 5 * 1024 * 1024)
      fail(404, "Image not found.");
    const [bytes] = await file.download();
    return { bytes, type: metadata.contentType };
  }
  return { upload, read };
}
module.exports = { createAssetService };
