const { protos } = require("@google-cloud/firestore");
const DOCUMENT_BYTES = 1024 * 1024;
const REQUEST_BYTES = 10 * 1024 * 1024;
const stringBytes = (value) => Buffer.byteLength(value, "utf8") + 1;
const issue = (code, message) =>
  Object.assign(new Error(message), { code, status: 413, expose: true });

// App records contain JSON values (and occasionally dates/bytes). Follow the
// documented stored-size formula, including UTF-8, field names and map overhead:
// https://firebase.google.com/docs/firestore/storage-size
function valueInfo(value) {
  if (value == null) return { size: 1, proto: { nullValue: 0 } };
  if (typeof value === "string")
    return { size: stringBytes(value), proto: { stringValue: value } };
  if (typeof value === "boolean")
    return { size: 1, proto: { booleanValue: value } };
  if (typeof value === "number")
    return {
      size: 8,
      proto: Number.isInteger(value)
        ? { integerValue: String(value) }
        : { doubleValue: value },
    };
  if (value instanceof Date)
    return {
      size: 8,
      proto: {
        timestampValue: {
          seconds: Math.floor(value.getTime() / 1000),
          nanos: (value.getTime() % 1000) * 1000000,
        },
      },
    };
  if (value instanceof Uint8Array)
    return { size: value.byteLength, proto: { bytesValue: value } };
  if (Array.isArray(value)) {
    const entries = value.map(valueInfo);
    return {
      size: entries.reduce((sum, item) => sum + item.size, 0),
      proto: { arrayValue: { values: entries.map((item) => item.proto) } },
    };
  }
  const fields = Object.create(null);
  let size = 32;
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    const info = valueInfo(entry);
    size += stringBytes(key) + info.size;
    fields[key] = info.proto;
  }
  return { size, proto: { mapValue: { fields } } };
}

function validateRecordWrites(
  writes,
  {
    root = "apps/alabama-wholesale",
    prefix = "v2_",
    projectId = "local",
    databaseId = "(default)",
  } = {},
) {
  const database = `projects/${projectId}/databases/${databaseId}`;
  const encodedWrites = [];
  for (const write of writes) {
    const path = `${root}/${prefix}${write.collection}/${write.id}`;
    const name = `${database}/documents/${path}`;
    if (write.deleted) {
      encodedWrites.push({ delete: name });
      continue;
    }
    const info = valueInfo(write.data);
    const document = { name, fields: info.proto.mapValue.fields };
    const storedBytes =
      info.size +
      16 +
      path.split("/").reduce((sum, segment) => sum + stringBytes(segment), 0);
    const bytes = Math.max(
      storedBytes,
      protos.google.firestore.v1.Document.encode(document).finish().length,
    );
    if (bytes > DOCUMENT_BYTES)
      throw issue(
        "document_too_large",
        "This order or saved action exceeds the database’s 1 MiB record size capacity. No changes were committed; the draft is preserved. Export a copy and shorten long notes or split the order before retrying.",
      );
    encodedWrites.push({ update: document });
  }
  // The write-count limit was removed on March 29, 2023. Use the encoded request
  // size, with 1 KiB reserved for the transaction token and protocol metadata.
  // https://docs.cloud.google.com/firestore/docs/release-notes#March_29_2023
  const bytes =
    protos.google.firestore.v1.CommitRequest.encode({
      database,
      writes: encodedWrites,
    }).finish().length + 1024;
  if (bytes > REQUEST_BYTES)
    throw issue(
      "transaction_too_large",
      "This action exceeds the database’s 10 MiB transaction size capacity. No changes were committed; the draft is preserved. Export a copy and split the order before retrying.",
    );
}

function backendCapacityError(error) {
  // Only explicit deterministic backend rejections can clear a pending action.
  // In particular, a large response, resource quota, timeout or broken connection
  // can occur after commit and must retain the original uncertain-result path.
  const rejected = [
    3,
    9,
    11,
    "INVALID_ARGUMENT",
    "FAILED_PRECONDITION",
    "OUT_OF_RANGE",
  ].includes(error?.code);
  const message = String(error?.details || error?.message || "");
  const size =
    /\b(?:transaction|request|document)\b[^\n]*(?:too (?:big|large)|size[^\n]*(?:exceeds?|greater than|larger than)|exceeds?[^\n]*(?:size|bytes|MiB|MB))/i.test(
      message,
    );
  const indexes =
    /too many index entries|index entr(?:y|ies)[^\n]*(?:exceeds?|too (?:big|large))|(?:exceeds?|maximum)[^\n]*index entries/i.test(
      message,
    );
  if (rejected && (size || indexes))
    return issue(
      "storage_capacity_exceeded",
      "The database rejected this action because its record, transaction or index size exceeds storage capacity. No changes were committed; the draft is preserved. Export a copy, then shorten large notes or split the order before retrying.",
    );
  return error;
}

module.exports = { validateRecordWrites, backendCapacityError };
