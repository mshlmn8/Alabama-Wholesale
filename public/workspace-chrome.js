// Presentation only. Reserve the actual space occupied by responsive chrome.
export function observeWorkspaceChrome(
  root,
  { header, navigation, dock },
  environment = window,
) {
  let active = true;
  const elements = [
    ["--workspace-header-height", header],
    ["--mobile-nav-height", navigation],
    ["--order-dock-height", dock],
  ];
  const measure = () => {
    if (!active) return;
    for (const [name, node] of elements) {
      const height = node ? Math.ceil(node.getBoundingClientRect().height) : 0;
      root.style.setProperty(name, `${height}px`);
    }
  };
  const observer = environment.ResizeObserver
    ? new environment.ResizeObserver(measure)
    : null;
  for (const [, node] of elements) if (node) observer?.observe(node);
  environment.addEventListener("resize", measure, { passive: true });
  measure();
  return () => {
    active = false;
    observer?.disconnect();
    environment.removeEventListener("resize", measure);
  };
}
