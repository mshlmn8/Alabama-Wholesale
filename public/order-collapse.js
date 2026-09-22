// Presentation only: hide the existing DOM, preserving focusable field values.
export function bindOrderCollapse(
  toggle,
  content,
  { label, collapsed = false, onChange } = {},
) {
  function draw() {
    content.hidden = collapsed;
    toggle.textContent = collapsed ? "Expand" : "Collapse";
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-controls", content.id);
    toggle.setAttribute(
      "aria-label",
      `${collapsed ? "Expand" : "Collapse"} ${label}`,
    );
  }
  toggle.addEventListener("click", () => {
    collapsed = !collapsed;
    draw();
    onChange?.(collapsed);
  });
  draw();
}
