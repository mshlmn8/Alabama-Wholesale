export function bindCatalogSearch(field, onSearch) {
  let composing = false;
  const apply = () => onSearch(field.value);

  // Some browser search controls commit or clear with a search/change event.
  // Always read the visible value so committing can recover a missed input.
  for (const type of ["input", "change", "search"])
    field.addEventListener(type, apply);
  field.addEventListener("compositionstart", () => {
    composing = true;
  });
  field.addEventListener("compositionend", () => {
    composing = false;
    apply();
  });
  field.addEventListener("keydown", (event) => {
    if (
      event.key !== "Enter" ||
      composing ||
      event.isComposing ||
      event.keyCode === 229
    )
      return;
    event.preventDefault();
    apply();
  });
}
