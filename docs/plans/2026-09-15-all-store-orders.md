# Combined store order history

The Orders page will offer **Selected store** and **All stores** buttons. Selected store remains the initial view. All stores combines the stores the signed-in account can access, retains the status filter and older-order pagination, and labels every row with its store. Changing this view does not change the store selected for order building or the active draft.

Reuse the authenticated `/api/orders` endpoint: omit `storeId` for the combined view and retain server-side account permissions. Reset pagination when changing store scope or status and discard stale responses. Load the first filtered page when changing the order view so older matching records are discoverable immediately. Keep newest records first. Reset the view and outstanding reads on identity change. Store-specific return links open the selected-store history.

Validate assigned-store restrictions, cross-store pagination, mobile layout, selected store/draft preservation, invoice opening, status filtering and delayed responses. Run the unit/API suite, build and CI checks, then verify the deployed build, assets and access enforcement.
