const { createHash } = require("node:crypto");
const {
  validateRecordWrites,
  backendCapacityError,
} = require("./record-capacity.cjs");
const clone = (value) =>
  value === undefined ? undefined : structuredClone(value);
function safeName(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("/") ||
    value.length > 700
  )
    throw Object.assign(new Error("Invalid record identifier"), {
      status: 400,
      code: "invalid_id",
    });
  return value;
}
function select(records, options = {}) {
  let out = records;
  for (const [field, op, value] of options.where || [])
    out = out.filter((row) =>
      op === "in"
        ? value.includes(row[field])
        : op === "=="
        ? row[field] === value
        : op === ">"
        ? row[field] > value
        : op === ">="
        ? row[field] != null && row[field] >= value
        : false,
    );
  const compare = (a, b) => {
    for (const [field, direction] of options.orderBy || []) {
      const left = a[field] ?? 0;
      const right = b[field] ?? 0;
      const difference =
        typeof left === "string" && typeof right === "string"
          ? Buffer.compare(Buffer.from(left), Buffer.from(right))
          : left < right
          ? -1
          : left > right
          ? 1
          : 0;
      if (difference) return difference * (direction === "desc" ? -1 : 1);
    }
    return 0;
  };
  if (options.orderBy?.length) out.sort(compare);
  if (options.startAfter) {
    // Firestore anchors to the cursor document's ordering values even if that
    // document belongs to another store-query chunk or is outside the filter.
    const cursor = records.find((row) => row.id === options.startAfter);
    if (!cursor)
      throw Object.assign(
        new Error("History cursor no longer exists; refresh the list."),
        { status: 409, code: "invalid_cursor" },
      );
    if (options.orderBy?.length)
      out = out.filter((row) => compare(row, cursor) > 0);
    else {
      const index = out.findIndex((row) => row.id === options.startAfter);
      if (index >= 0) out = out.slice(index + 1);
    }
  }
  return out.slice(0, options.limit ?? out.length).map((record) => {
    if (!options.fields) return clone(record);
    const projected = { id: record.id };
    for (const field of options.fields) {
      const parts = field.split(".");
      let value = record;
      for (const part of parts) value = value?.[part];
      if (value === undefined) continue;
      let target = projected;
      for (const part of parts.slice(0, -1)) target = target[part] ||= {};
      target[parts.at(-1)] = clone(value);
    }
    return projected;
  });
}
class MemoryRepository {
  constructor(seed = {}) {
    this.collections = new Map(
      Object.entries(seed).map(([name, rows]) => [
        name,
        new Map(rows.map((row) => [row.id, clone(row)])),
      ]),
    );
    this.pending = Promise.resolve();
    this.recoveries = new Map();
  }
  async get(collection, id) {
    safeName(collection);
    safeName(id);
    return clone(this.collections.get(collection)?.get(id)) ?? null;
  }
  async list(collection, options) {
    safeName(collection);
    return select(
      [...(this.collections.get(collection)?.values() || [])],
      options,
    );
  }
  async transaction(callback) {
    let release;
    const previous = this.pending;
    this.pending = new Promise((resolve) => (release = resolve));
    await previous;
    const copy = new MemoryRepository(
      Object.fromEntries(
        [...this.collections].map(([name, rows]) => [name, [...rows.values()]]),
      ),
    );
    const writes = new Map();
    const tx = {
      get: copy.get.bind(copy),
      list: copy.list.bind(copy),
      set: async (c, id, data) => {
        safeName(c);
        safeName(id);
        if (!copy.collections.has(c)) copy.collections.set(c, new Map());
        copy.collections.get(c).set(id, clone({ ...data, id }));
        writes.set(`${c}/${id}`, {
          collection: c,
          id,
          data: { ...clone(data), id },
        });
      },
      delete: async (c, id) => {
        safeName(c);
        safeName(id);
        copy.collections.get(c)?.delete(id);
        writes.set(`${c}/${id}`, { collection: c, id, deleted: true });
      },
    };
    try {
      const result = await callback(tx);
      validateRecordWrites(writes.values());
      this.collections = copy.collections;
      return result;
    } finally {
      release();
    }
  }
  isolated(namespace) {
    safeName(namespace);
    if (!this.recoveries.has(namespace))
      this.recoveries.set(namespace, new MemoryRepository());
    return this.recoveries.get(namespace);
  }
  async put(collection, id, data) {
    return this.transaction((tx) => tx.set(collection, id, data));
  }
  async snapshot(collections) {
    return this.transaction(async (tx) => {
      const data = {};
      for (const collection of collections)
        data[collection] = await tx.list(collection);
      return data;
    });
  }
}
class FirestoreRepository {
  constructor(db, { root = "apps/alabama-wholesale", prefix = "v2_" } = {}) {
    this.db = db;
    this.root = root;
    this.prefix = prefix;
  }
  collection(name) {
    return this.db.collection(`${this.root}/${this.prefix}${safeName(name)}`);
  }
  async get(collection, id) {
    const snap = await this.collection(collection).doc(safeName(id)).get();
    return snap.exists ? { ...snap.data(), id: snap.id } : null;
  }
  async query(collection, options = {}) {
    let query = this.collection(collection);
    for (const args of options.where || []) query = query.where(...args);
    for (const args of options.orderBy || []) query = query.orderBy(...args);
    if (options.fields) query = query.select(...options.fields);
    if (options.startAfter) {
      const cursor = await this.collection(collection)
        .doc(safeName(options.startAfter))
        .get();
      if (!cursor.exists)
        throw Object.assign(
          new Error("History cursor no longer exists; refresh the list."),
          { status: 409, code: "invalid_cursor" },
        );
      query = query.startAfter(cursor);
    }
    if (options.limit) query = query.limit(options.limit);
    return query;
  }
  async list(collection, options = {}) {
    const query = await this.query(collection, options);
    return (await query.get()).docs.map((doc) => ({
      ...doc.data(),
      id: doc.id,
    }));
  }
  async transaction(callback) {
    return this.db
      .runTransaction(async (firestoreTx) => {
        const writes = new Map();
        const key = (c, id) => `${safeName(c)}/${safeName(id)}`;
        const tx = {
          get: async (c, id) => {
            const pending = writes.get(key(c, id));
            if (pending) return pending.deleted ? null : clone(pending.data);
            const snap = await firestoreTx.get(this.collection(c).doc(id));
            return snap.exists ? { ...snap.data(), id: snap.id } : null;
          },
          list: async (c, options = {}) => {
            const query = await this.query(c, options);
            const snap = await firestoreTx.get(query);
            const map = new Map(
              snap.docs.map((d) => [d.id, { ...d.data(), id: d.id }]),
            );
            for (const value of writes.values())
              if (value.collection === c) {
                if (value.deleted) map.delete(value.id);
                else map.set(value.id, clone(value.data));
              }
            return select([...map.values()], options);
          },
          set: async (c, id, data) => {
            writes.set(key(c, id), {
              collection: c,
              id,
              data: { ...clone(data), id },
            });
          },
          delete: async (c, id) => {
            writes.set(key(c, id), { collection: c, id, deleted: true });
          },
        };
        const result = await callback(tx);
        validateRecordWrites(writes.values(), {
          root: this.root,
          prefix: this.prefix,
          projectId: this.db.projectId,
          databaseId: this.db.databaseId,
        });
        for (const value of writes.values()) {
          const ref = this.collection(value.collection).doc(value.id);
          if (value.deleted) firestoreTx.delete(ref);
          else firestoreTx.set(ref, value.data);
        }
        return result;
      })
      .catch((error) => {
        throw backendCapacityError(error);
      });
  }
  async put(collection, id, data) {
    validateRecordWrites([{ collection, id, data: { ...data, id } }], {
      root: this.root,
      prefix: this.prefix,
      projectId: this.db.projectId,
      databaseId: this.db.databaseId,
    });
    await this.collection(collection)
      .doc(safeName(id))
      .set({ ...data, id })
      .catch((error) => {
        throw backendCapacityError(error);
      });
  }
  async snapshot(collections) {
    return this.db.runTransaction(
      async (tx) => {
        const data = {};
        for (const collection of collections) {
          const result = await tx.get(this.collection(collection));
          data[collection] = result.docs.map((doc) => ({
            ...doc.data(),
            id: doc.id,
          }));
        }
        return data;
      },
      { readOnly: true },
    );
  }
  async legacySnapshot() {
    const [state, history] = await Promise.all([
      this.db.collection(`${this.root}/state`).get(),
      this.db.collection(`${this.root}/history`).get(),
    ]);
    const docs = Object.fromEntries(
      state.docs.map((d) => [d.id, { ...d.data(), id: d.id }]),
    );
    return {
      state: {
        data: docs.data || null,
        users: docs.users || null,
        drafts: state.docs
          .filter((d) => d.id === "order" || d.id.startsWith("order-"))
          .map((d) => ({ ...d.data(), id: d.id })),
        other: Object.fromEntries(
          Object.entries(docs).filter(
            ([id]) =>
              !["data", "users"].includes(id) &&
              id !== "order" &&
              !id.startsWith("order-"),
          ),
        ),
      },
      history: history.docs.map((d) => ({ ...d.data(), id: d.id })),
    };
  }
  isolated(namespace) {
    return new FirestoreRepository(this.db, {
      root: this.root,
      prefix: `recovery_${safeName(namespace)}_`,
    });
  }
  async archiveSnapshot(snapshot, checksum) {
    const bytes = Buffer.from(JSON.stringify(snapshot));
    const bytesChecksum = createHash("sha256").update(bytes).digest("hex");
    const archiveId = `legacy-${checksum}`;
    const base = this.db
      .collection(`${this.root}/privateArchives`)
      .doc(archiveId);
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 450000)
      chunks.push(bytes.subarray(offset, offset + 450000).toString("base64"));
    for (let i = 0; i < chunks.length; i += 10) {
      const batch = this.db.batch();
      for (let j = i; j < Math.min(i + 10, chunks.length); j++)
        batch.set(base.collection("chunks").doc(String(j).padStart(6, "0")), {
          base64: chunks[j],
        });
      await batch.commit();
    }
    const stored = await base.collection("chunks").orderBy("__name__").get();
    const restored = Buffer.concat(
      stored.docs.map((doc) => Buffer.from(doc.data().base64, "base64")),
    );
    if (createHash("sha256").update(restored).digest("hex") !== bytesChecksum)
      throw new Error(
        "Private archive verification failed. Migration was not started.",
      );
    await base.set({
      checksum,
      bytesChecksum,
      byteLength: bytes.length,
      chunks: chunks.length,
      createdAt: Date.now(),
      verified: true,
      complete: true,
    });
    return archiveId;
  }
}
module.exports = { MemoryRepository, FirestoreRepository, select, safeName };
