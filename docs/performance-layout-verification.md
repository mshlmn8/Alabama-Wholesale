# Catalog layout and performance correction — September 14, 2026

The catalog no longer rebuilds the entire workspace on each search keystroke. Search keeps its input, filters and reusable product cards; inventory search uses indexed variant lookups and updates its rows. Draft notes still save immediately on this device and retain Undo/Redo without rebuilding every order line. Startup and confirmed commands render once after refreshing.

Product cards share natural title/detail rows, so full long names wrap without overlapping metadata or prices. Prices sit above full-width Add buttons. Page actions wrap before squeezing the heading. Editor controls keep consistent heights, including Safari selects, and workspace tool buttons align at the bottom of their cards. Older browsers without subgrid retain a wrapping flex fallback.

History lists load compact summaries; opening an order fetches its complete saved details through an authorized, private endpoint. Loading, retry and cancellation are explicit. All cloud drafts remain complete, including drafts outside the first history page. Historical text, frozen prices and full backups remain available. Financial records, access profiles, assignments, stock and migration gates are read fresh.

Verification:

- 155 Node 22 tests pass, production build passes, and the diff passes whitespace checks. New regressions cover history lookahead, summary/detail access, complete older drafts, original backup records, freshness/revocation, and rejected or superseded detail requests.
- A read-only local HTTP benchmark against production Firestore reduced state JSON from 1,585,193 to 450,017 bytes (71.6%). Warm data requests fell from 2.38–2.58 seconds to 0.43–0.60 seconds. This benchmark excludes live authentication and browser rendering; it is not an end-to-end loading guarantee.
- A synthetic 628-product, 75-store, 120-line draft browser fixture exercised Chromium and WebKit at widths 390, 768, 1024 and 1440. No product-title clipping, overlapping text or horizontal overflow remained. Safari/WebKit editor inputs and selects have matching 46.5-pixel heights.
- Median catalog input CPU time fell from about 5–7 ms to 0.6–2 ms; 120-line draft note edits fell from about 11–17 ms to 0–1 ms. Full catalog navigation uses roughly 12 ms of synchronous work in Chromium because full visible name sizing replaces per-card layout containment; not every operation became faster.
- Both browser engines passed stable catalog/inventory inputs, draft notes Undo/Redo and reload, complete order-detail loading, failure/retry, and cancellation of a delayed detail result. No live orders, products, payments or credits were changed for these checks.

The service worker shell version is advanced so the updated interface is installed for subsequent offline use. Private API responses remain excluded from its cache.
