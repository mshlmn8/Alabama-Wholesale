const test = require("node:test");
const assert = require("node:assert/strict");
const { createAssetService } = require("../lib/assets.cjs");
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
test("product uploads store only validated raster bytes under a content-derived path", async () => {
  const objects = new Map();
  const bucket = {
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
  };
  const assets = createAssetService({ bucket });
  const first = await assets.upload({ mimeType: "image/png", data: png });
  assert.match(first.url, /^\/media\/products\/[a-f0-9]{64}\.png$/);
  assert.deepEqual(
    await assets.upload({ mimeType: "image/png", data: png }),
    first,
  );
  assert.equal(objects.size, 1);
  const loaded = await assets.read(first.url.split("/").pop());
  assert.equal(loaded.type, "image/png");
  assert.deepEqual(loaded.bytes, Buffer.from(png, "base64"));
});
test("mislabeled images, scripts, oversized data, and arbitrary storage paths are rejected", async () => {
  const assets = createAssetService({
    bucket: {
      file() {
        throw Error("Must not touch storage");
      },
    },
  });
  for (const image of [
    {
      mimeType: "image/svg+xml",
      data: Buffer.from("<svg/>").toString("base64"),
    },
    { mimeType: "image/jpeg", data: png },
    { mimeType: "image/png", data: "not-base64!" },
    { mimeType: "image/png", data: "x".repeat(8_000_000) },
  ])
    await assert.rejects(
      () => assets.upload(image),
      (e) => e.status === 400 || e.status === 413,
    );
  await assert.rejects(
    () => assets.read("../private.json"),
    (e) => e.status === 404,
  );
});
