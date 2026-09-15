# Mobile reliability and order delivery

The approved scope is to repair Build editing and continuous draft saving, compact and align the mobile interface, rank exact product searches first, offer one through five catalog columns, explain the order AI, and add direct/scheduled invoice email delivery. Recipient: alwholesaleorders@gmail.com. A new dedicated Gmail sender is requested; Google signup requires the user's personal verification. Scheduling emails an already submitted order; it never submits a draft automatically.

## Implementation

- Preserve per-account storage and strict, idempotent financial commands. Remove redundant storage writes and duplicate recovery metadata without deleting drafts or legacy records.
- Reconcile the visible draft with the merged workspace after refresh; restore the latest available draft per store on another device. Preserve rejected input and expose concurrent editing conflicts.
- Keep cloud autosave on each accepted edit, bounded debounce, plus foreground refresh when no editor/dialog is active. Save valid offline recovery edits immediately on the device.
- Use exact/prefix/token search priority. Provide compact catalog density and 1–5 columns, with simple details tiles for narrow 4–5 column layouts. Keep mobile inputs at 16px to prevent focus zoom while preserving pinch zoom.
- Make Ask AI discoverable with an order example and dictation instructions. Proposals still require review before adding or submitting.
- Add an authorized, versioned mail outbox with frozen invoice PDF, fixed recipient, send/schedule/cancel controls, worker leases, and explicit handling of uncertain SMTP delivery. Automatic sending becomes available only after the sender is connected and enabled; allow five minutes to change its schedule.
- Verify isolated 100-user requests and deployment scaling configuration without production business writes. Check domain availability without purchasing.

## Verification and release

Run focused storage, draft, search, authorization, mail idempotency/scheduling tests, the full Node22 suite and build. Exercise Chromium/WebKit on mobile/tablet/desktop, draft refresh and restoration, failed device writes, offline edits, email controls and existing completed-order downloads. Review the integrated diff, update the service worker, merge after CI, verify deployed revision/assets and health. Do not describe the sender as linked until Google authentication and a real provider test have succeeded.
