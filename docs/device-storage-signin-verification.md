# Device storage sign-in recovery — 2026-09-14

The mobile report showed a Google-authenticated owner on “Your account needs access” with a browser storage error. The client treated all startup exceptions as enrollment problems. Refreshing the authorized state unconditionally wrote its cloud drafts to localStorage, and startup could also write an optional default theme.

## Reproduction

An isolated real-browser fixture returned successful owner bootstrap and state responses, then made localStorage writes throw QuotaExceededError. The old app reproduced the exact reported enrollment screen in Chromium and WebKit at 390px. A second WebKit run filled the origin naturally to 5,242,867 stored characters and reproduced the same failure without replacing the storage API. The fixture's existing draft, pending command and legacy key remained unchanged.

## Scope of the fix

- Authentication and enrollment remain enforced by the server. Only actual enrollment failures use the invitation screen; storage and other loading failures have their own recovery UI.
- Cloud draft caching and optional navigation/theme preferences must not prevent entry. Unsaved edits and commands still require durable storage before they can be reported as saved or sent.
- Existing drafts, queued command IDs and legacy browser records are preserved. No localStorage keys are cleared to recover space.
- A storage warning provides draft export and an explicit storage retry. Unreadable workspace JSON can be exported as a raw, account-scoped recovery file without exporting Firebase credentials.
- The service worker returns successful network responses even if Cache Storage fails. Cache errors cannot block installation or activation of the update.

## Validation

Browser reproduction and recovery scripts and screenshots are retained locally under `.firebase/upgrade/device-storage-signin/`. They use synthetic data and an isolated loopback origin; no business records are written.

- 170 Node 22 tests passed, including seven added storage regressions and eight service-worker regressions; production build and whitespace checks passed.
- Chromium and WebKit mobile runs cover successful entry under quota, browsing/search/store switching, reading cloud drafts, draft export with pending command records, strict failed edits and storage retry.
- Native WebKit quota reproduction now reaches the catalog, displays the storage warning, and preserves existing workspace/legacy bytes.
- Enrollment denial, server failure, blocked reads, corrupt JSON and offline startup use the appropriate distinct screens.
- Draft input checks cover explicit unsaved status, retained notes, failed quantity/unit rollback, durable retry, and Undo/Redo history preservation.

The phone itself is not remotely inspected. Validation reproduces its reported failure in isolated mobile browser contexts. A device that still refuses durable writes can browse and export, but cannot claim new edits are saved until storage works. This change does not clear the device’s storage or remove existing business data.
