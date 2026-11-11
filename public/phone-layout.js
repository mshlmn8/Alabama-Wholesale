// Phone presentation switch. Desktop keeps its own navigation and layout.
export const PHONE_QUERY = "screen and (max-width: 800px)";

// [view, tab label, icon]
export const PHONE_TABS = [
  ["home", "Home", "home"],
  ["catalog", "Catalog", "catalog"],
  ["build", "Order", "cart"],
  ["orders", "History", "orders"],
  ["more", "More", "more"],
];

export function isPhone(environment = window) {
  return !!environment.matchMedia?.(PHONE_QUERY).matches;
}

export function phoneDestination(view) {
  return ["home", "catalog", "build", "orders"].includes(view) ? view : "more";
}

export function watchPhoneLayout(onChange, environment = window) {
  const list = environment.matchMedia?.(PHONE_QUERY);
  if (!list?.addEventListener) return () => {};
  const changed = (event) => onChange(!!event.matches);
  list.addEventListener("change", changed);
  return () => list.removeEventListener("change", changed);
}
