# Completed-order device copy implementation plan

**Goal:** Keep cloud confirmation visible and automatically request a device file after a successful order submission, with a device-specific switch.

**Architecture:** Reuse the existing authenticated invoice endpoint and browser download helper. A small per-account download controller manages document preparation and request status independently of the financial command queue. The shared submission confirmation path covers ordinary submission and recovery through Sync center.

**Tech stack:** Existing vanilla JavaScript client, Firebase-authenticated Node API, PDFKit invoice renderer, Node tests and Playwright Chromium/WebKit.

## Behavior and limits

- “Finish an order” means the server confirms `order.submit`. Merely editing a draft does not create a device file.
- The setting defaults to enabled with PDF and is visible in order review and Workspace backup. PDF, a structured JSON order archive, or both can be selected. Settings belong to the current account on this device; storage failure keeps the setting for the current session and retains the existing storage warning.
- Submission records its chosen setting in local command metadata. The confirmed submission result triggers the file request once per command in the active account. Retrying the financial request through Sync center uses the same captured choice.
- The order remains “Saved online” if document generation or the browser download fails. Document retries request only a file. They never resubmit the order.
- The download panel reports preparing, download requested, partial preparation, or failure, with a manual download action. Browser initiation cannot prove a file reached disk, so the app never labels it “Saved on device.”
- PDF uses the existing invoice route. JSON has a separate versioned completed-order envelope containing the confirmed order, without queued commands or automatic financial-import semantics. It is an archive for backup and review.
- A changed account or disposed controller prevents late file requests. All response bodies and observer callbacks are guarded. Draft autosave and financial queue persistence are unchanged.

## Tasks

- [ ] Add `public/order-downloads.js` and meaningful tests in `tests/order-downloads.test.cjs`. Verify disabled/default settings, finalized-order validation, request deduplication, manual retry, independent document failure, account disposal, filenames and selected formats.
- [ ] Integrate device settings, shared confirmed-submit side effect and visible download status/actions in `public/app.js`. Capture the setting in submission metadata and guard both automatic and existing manual PDF responses after reading the blob.
- [ ] Add the module to `public/sw.js` and `scripts/build.cjs`, advance the shell version and update its test fixture.
- [ ] Verify actual downloads against an isolated mutable backend in Chromium and WebKit: default PDF, disabled setting, account isolation, formats, failed/slow document requests, retry without resubmission, recovered submission, and no download after a failed submission or draft save.
- [ ] Run all Node 22 tests, build, whitespace checks and independent review. Publish through the existing PR and Firebase App Hosting workflow and compare the production assets with the verified source.

## Browser behavior

The browser controls file placement and permissions. Use the existing Blob download anchor, with a user-visible repeat action if it is blocked or cancelled; avoid depending on a delayed popup, share sheet or filesystem picker. See the [HTML download algorithm](https://html.spec.whatwg.org/multipage/links.html#downloading-resources) and [Safari website download settings](https://support.apple.com/guide/safari/websites-ibrwe2159f50/mac).
