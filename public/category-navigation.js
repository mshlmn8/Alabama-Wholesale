export function categoryTrail(categories, id) {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const seen = new Set();
  const trail = [];
  for (
    let item = byId.get(id);
    item && !seen.has(item.id);
    item = byId.get(item.parentId)
  ) {
    seen.add(item.id);
    trail.unshift(item);
  }
  return trail;
}

export function categoryFilterIds(categories, id) {
  const ids = new Set([id]);
  const children = new Map();
  for (const item of categories) {
    if (!children.has(item.parentId)) children.set(item.parentId, []);
    children.get(item.parentId).push(item.id);
  }
  for (const parent of ids)
    for (const child of children.get(parent) || []) ids.add(child);
  return ids;
}

export function categoryLabel(categories, item) {
  return categoryTrail(categories, item.id)
    .map((category) => category.name)
    .join(" / ");
}
