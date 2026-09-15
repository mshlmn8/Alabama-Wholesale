# Device backup recovery — 2026-09-15

The device warning had two distinct causes. A transient failed write could leave
the banner on screen after autosave confirmed both the online and device copies:
the save-status update did not refresh the storage notice. A genuinely full
localStorage area also remained full after retrying the same workspace write.
Older versions of the app retained their catalog/history and draft under
`alwholesale_data_v1` and `alwholesale_order_v1` in that same limited storage area.

Both paths were reproduced in isolated Chromium and WebKit browsers. The natural
quota fixture reached 5,242,851 stored key/value characters. The current catalog
and its photos are not written to localStorage; ordinary fresh-app use wrote
594 characters in the fixture. The user's phone was not directly inspected.

The notice now follows each draft-save update without replacing the active
editor. When a warning is present, the app automatically retries device storage,
with a 30-second retry interval. If localStorage still cannot save, the app opens
an account-scoped IndexedDB workspace and copies the complete logical snapshot:
all device and cloud drafts, current session edits, preferences, pending command
IDs, and autosave recovery receipts. All original localStorage keys remain
untouched, including older app data and other accounts.

The database uses versioned transactions with strict durability and verified
readback. Synchronous staging does not mean persistence: the UI checks the last
committed copy, and financial commands wait for their receipt to commit before
sending. Online autosave can still protect an edit if both device stores fail.
Cross-tab writes use compare-and-swap; conflicting edits remain available for
export and cannot overwrite another tab. Writes from an older app to the retained
localStorage baseline also produce a conflict instead of replacing either copy.
Reloads open the database when it exists. If the database cannot be checked, the
older localStorage copy is read-only and the app explicitly warns that some
offline drafts may not be loaded.

The automatic recovery never sends queued financial actions. Delayed work cannot
apply to another account or replace active notes. Device writes already staged
before sign-out can finish without updating the next account's UI. An existing
working database remains connected when the same user refreshes their session.

Validation covers preservation of drafts and command identities, pending versus
committed device state, blocked storage, transaction/readback failures, bounded
retries, edits during recovery, account changes and cross-tab conflicts. Native
Chromium and WebKit checks cover a naturally full localStorage origin, reload and
offline durability, commit-before-submit, focused editor preservation and stale
warning removal. Diagnostic fixtures are retained in
`.firebase/upgrade/storage-quota-diagnosis/`.
