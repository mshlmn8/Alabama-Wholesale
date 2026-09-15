# Automatic cloud draft saving

Drafts should reach Firebase automatically while connected. A device-only copy is not a backup against loss of that device. The existing manual sync control is insufficient because users may reasonably assume editing an order protects it online.

## Behavior

Every accepted draft edit schedules an authenticated `order.save` command after 600 ms of inactivity, with a maximum two-second delay during continuous edits. Saves are serialized per draft. The UI reports “Saved online” only after the current edit is confirmed by the server; it distinguishes saving, a device-only offline copy, and changes held only in the open app when device storage fails.

Device persistence is attempted immediately. A new, explicit cloud-saving storage API can retain a working draft in memory if the local write fails; the strict storage API and financial command queue still require durable writes. This permits online draft saving on a full device without pretending there is an offline backup.

The coordinator stores the exact immutable in-flight command and draft snapshot when possible. A lost response retries the same command ID before sending newer edits. Version conflicts stop automatic writes until the user reviews the competing versions. Switching accounts disposes timers and ignores late responses; commands already accepted by the server cannot be undone by signing out.

Draft submission remains a separate explicit financial action: await confirmation of the reviewed draft revision, verify it did not change, pause autosave, and then submit through the existing durable queue. Autosave never submits an order, reserves stock, changes balances, or clears recovered-draft review requirements.

## Recovery and limits

Startup and reconnect resume pending draft saves. Existing synced drafts are available on another device. Exports include working drafts and recovery records, but imports never replay financial commands or old autosave records. Uncertain saves retain their request identity. Local copies that conflict with a newer cloud draft are preserved for review instead of overwriting it.

There remains a short interval before server acknowledgement. Offline changes cannot reach Firebase; if their only device copy is lost before reconnection, recovery is not guaranteed. Status indicators and unload/sign-out warnings make that limit visible.

## Implementation and verification

1. Extend Workspace with explicit working-draft staging, cloud acknowledgement, recovery records and optimistic checks against another tab's local edits; retain strict write behavior for existing APIs.
2. Add a standalone per-account autosave coordinator, with debouncing, exact-request retries, offline resume, version-conflict handling and disposal tests.
3. Route the app's draft editing/import/recovery paths through staging; integrate status, manual retry, conflict review and submit/sign-out guards without rebuilding the page on each save.
4. Test real Chromium/WebKit browser flows against an isolated mutable backend, including another device, quota, offline/reconnect, delayed/lost responses, newer in-flight edits, conflicting versions and account switches.
5. Run the full suite/build/CI, review, release through the existing Firebase App Hosting pipeline, and verify production assets and health. Authenticated mutation flows use the isolated fixture; production business records are not used for mutation tests.
