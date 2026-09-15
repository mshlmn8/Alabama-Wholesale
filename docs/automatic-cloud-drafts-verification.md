# Automatic cloud draft saving — 2026-09-14

Previously, editing a draft saved it only on the current device until the user explicitly synced it. Losing that copy before manual sync could lose the edits. The app now schedules online draft saves automatically, confirms the current revision before displaying “Saved online,” and preserves an explicit working copy in the open tab if device storage cannot accept the edit.

## Protection and recovery

- Online saves start after 600 ms of inactivity, with a maximum two-second debounce during continuous editing when no earlier request is pending. Requests are serialized per draft, with at most two requests in flight across drafts.
- A lost response retains the original command ID and body. Later edits wait behind that request. Recovery records survive reload when local storage permits; retries are bounded and known rejections stay paused across reload.
- Cloud version and local-tab conflicts preserve the local work and offer export, copying into a new draft, or explicit cloud reload. A newly recovered legacy draft still requires review before its first cloud save.
- Draft saving does not submit orders or change inventory, payments or balances. Submission waits for the reviewed draft revision and continues through the existing durable financial command queue.
- Protection indicators distinguish cloud confirmation, device-only work and work held only in the open tab. Sign-out attempts to finish saves, then offers export or staying open when work remains unconfirmed. Browser unload warnings are best effort.

## Verification

The isolated browser fixture and artifacts are retained locally under `.firebase/upgrade/cloud-draft-saving/`. Its synthetic backend records exact command IDs and revisions; it does not mutate production business data.

- 210 Node 22 tests pass, including 31 coordinator regressions and nine additional storage regressions. The production build and whitespace checks pass.
- Chromium and WebKit checks cover automatic saving, reopening from a second device, offline/reconnect, quota, missing storage plus missing network, response loss, newer edits during a request, reload recovery, account switches, version conflicts, submission, empty drafts, cart editing, pending submissions and legacy review.
- A native WebKit test reached `QuotaExceededError` at 5,242,877 stored characters. A new 2,049-character note still reached the cloud and showed “Saved online.” The original durable draft bytes and a separate 1 MB legacy record remained unchanged.
- In the 50-draft fixture, note input handlers averaged 1.04 ms in Chromium and 1.58 ms in WebKit, with maxima of 3.6 ms and 8 ms. The textarea remained stable, final text reached the cloud, and no horizontal overflow occurred. These are local synthetic measurements, not a production latency guarantee.

There is still a period before the server confirms a save. Offline edits cannot reach Firebase. If all copies of an unconfirmed edit are lost before reconnection, it cannot be recovered from the cloud. Keeping the tab open until “Saved online,” or exporting a separate copy while offline, remains necessary when that risk matters.
