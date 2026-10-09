# Alabama Wholesale ordering layout proposal

This proposal improves the existing ordering app’s layout while retaining its workflows, permissions, account preferences, and data.

Status: approved by the user on 2026-10-08 for implementation in an isolated checkout. Production deployment is outside this change.

## Current problems

The existing source was reviewed at commit `d2c5604` in `alabama-wholesale`. A fresh local preview of the current source used synthetic records, with no production Firebase connection.

- At 390px, the two-row header gives the store picker less than half the screen width while refresh, notifications, cart, and appearance compete beside it.
- Six bottom navigation items constrain each item’s width and duplicate order access already available through the cart.
- Order heading actions, saving details, undo/redo, and global collapse controls occupy separate rows before the first product.
- The order total uses a floating sticky box within the document, which can cover order rows near the bottom of the viewport.
- Product headings, variant rows, totals, and row menus need clearer alignment and a consistent hierarchy.
- Catalog search, category navigation, view modes, columns, and compact controls have competing emphasis.
- Workspace tools appear as equally prominent cards, making occasional administration actions compete with daily ordering tasks.

## Recommended approach

Use a structured layout refinement. Keep the existing orange brand, Manrope font, light/dark appearances, grouped flavor rows, and continuous order sheet.

A smaller style-only pass would preserve every current control position and simplify testing, but would leave the crowded header and excess controls in place. A rebuild is unnecessary for the identified problems.

## Proposed layout

### Navigation and header

Desktop retains Overview, Catalog, Build order, Orders, Stores, and Workspace. Mobile prioritizes Catalog, Build, Orders, Stores, and More; Overview remains accessible through More.

Use a full-width store context with a clear current-store name. Keep notifications directly accessible. Put refresh, Gemini, appearance, and saving details in a labeled workspace-tools menu on mobile. Preserve all existing functionality and role restrictions.

### Orders

Place the order title, draft identity, Add items, and order options in one compact heading. Put undo/redo in the order-sheet toolbar. Keep each product above its flavor rows, with aligned quantity and amount columns and one accessible row menu.

On desktop, use an order summary beside the sheet. On mobile, reserve space for a fixed review strip above navigation. The final implementation must calculate these reserved spaces from actual chrome sizes, respect device safe areas, and keep the last row and notes reachable without overlap.

Keep notes in an expandable section. Keep additional flavors, product options, collapsible groups, save details, draft recovery, and alternate drafts reachable.

### Catalog

Give search and scanning a single row, with horizontal category and nested subcategory rows below. Keep list/grid and favorites controls separate from the category hierarchy. Move column-count and compact-card preferences into a display menu.

Use consistent image frames, complete product names, useful packing details, clear prices, and one Add action per item. Missing images use an honest placeholder. The proposal uses illustrative packaging and sample prices, not verified catalog imagery or prices.

### Other screens

Use a compact resume-current-order section in Overview, clear rows in Orders, grouped store cards in Stores, and grouped lists in Workspace. Group ordering, accounts/operations, saving/device, and administration without removing tools.

## Feature continuity

| Existing feature | Proposed handling |
| --- | --- |
| Accounts, roles, store ownership | Preserve the current authentication and server authorization |
| Store picker and multi-store ordering | Keep a prominent store picker and existing per-store drafts |
| Search, scan, categories, subcategories, favorites | Preserve behavior; clarify the control hierarchy |
| Products, flavors, notes, quantities, pricing | Preserve calculations and editing; improve row alignment |
| Builder density | Preserve each authenticated account’s small/medium/large preference |
| Drafts, undo/redo, cloud sync, offline recovery | Preserve logic and surface meaningful save failures |
| Review, submission, history, repeat orders | Preserve actions; improve layout and visibility |
| Formatted order and one-tap prefilled email | Preserve the existing direct email-draft workflow |
| Inventory, payments, returns, balances | Keep accessible under existing role restrictions |
| Gemini, photos, settings, team access, backup, audit | Preserve every existing tool in grouped workspace lists |

The mockup demonstrates layout and selected interactions with sample data. Its in-memory editing is not a replacement for the app’s storage, sync, or server behavior. Administrative buttons show explanatory preview dialogs rather than implementing administrative operations.

## Implementation boundaries and acceptance

After design approval, apply the layout to the current app without replacing its domain logic. Prefer focused shell markup and layout styles. Reuse current data rendering, validated commands, preferences, store picker, session guards, and text-safe DOM construction.

Validate at 320, 390, 768, and desktop widths in light and dark modes. Include long product/store names, many flavors, empty drafts, large orders, keyboard access, scrolling, dialogs, and error states. Verify that quantities and notes still save, account and store boundaries are enforced, the last order row stays reachable, the catalog hierarchy works, and the one-tap email flow retains the full formatted order. Preview screenshots alone do not prove cloud sync, physical iPhone behavior, or production deployment.

Approval received: the user approved the proposed navigation/control relocation and visual direction with “Yes I approve it.”
