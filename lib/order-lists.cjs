"use strict";
const commands = ["order-list.save", "order-list.delete"];
function authorize(actor, type, payload, h) {
  h.authorizeStore(actor, payload.storeId);
}
async function execute(tx, actor, { type, payload }, context, h) {
  const store = await h.required(tx, "stores", payload.storeId, "Store");
  const id = payload.id ? h.recordId(payload.id, "List ID") : context.id();
  const previous = await tx.get("orderLists", id);
  if (
    previous &&
    (previous.userId !== actor.uid || previous.storeId !== store.id)
  )
    h.fail(
      "FORBIDDEN",
      "This saved list belongs to another account or store.",
      403,
    );
  if (previous?.deleted) h.fail("NOT_FOUND", "This list was removed.", 404);
  h.versionGuard(previous, payload.expectedVersion);
  if (type === "order-list.delete") {
    if (!previous) h.fail("NOT_FOUND", "This list was not found.", 404);
    const result = h.versioned(previous, { deleted: true }, context.now, actor);
    await tx.set("orderLists", id, result);
    return result;
  }
  if (!previous) {
    const existing = await tx.list("orderLists", {
      where: [
        ["userId", "==", actor.uid],
        ["storeId", "==", store.id],
      ],
    });
    if (existing.filter((row) => !row.deleted).length >= 50)
      h.fail(
        "INVALID_INPUT",
        "Keep up to 50 saved lists per store. Remove an old list first.",
      );
  }
  if (
    !Array.isArray(payload.lines) ||
    !payload.lines.length ||
    payload.lines.length > 300
  )
    h.fail("INVALID_INPUT", "Save between 1 and 300 order lines.");
  const lines = h.draftLines(payload.lines, { allowEmpty: false });
  const result = h.versioned(
    previous,
    {
      id,
      storeId: store.id,
      userId: actor.uid,
      name: h.text(payload.name, "List name", 100, true),
      notes: h.text(payload.notes, "List instructions", 10000),
      lines,
    },
    context.now,
    actor,
  );
  await tx.set("orderLists", id, result);
  return result;
}
module.exports = { commands, authorize, execute };
