# Upgrade operations

## Runtime and access

The deployed app is an Express server on Firebase App Hosting. `apphosting.yaml` explicitly sets the build/run commands and limits public content to `public/`. Firebase Admin uses the existing App Hosting service account. Its existing SDK role supplies Firestore, Auth lookup and App Check verification permissions; no new broad IAM grants were needed.

The configured owner signs in with Google. Other staff and customers receive invitations from Team access. Legacy username/password hashes are archived as historical source only and never authorize a new session. Existing users need individual invitations; new customer accounts cannot self-assign access. The owner account cannot be disabled or reassigned through the app.

## Cutover procedure

1. Pass unit, integration and browser checks and confirm the GitHub source revision.
2. Deploy Firestore indexes. Build the verified Git revision in App Hosting without creating a rollout, and wait until it is ready. Compile the deny-client rules before changing live access.
3. Freeze legacy writes by deploying `firestore.rules`. Capture a fresh legacy snapshot after the freeze.
4. Persist the complete snapshot in protected, byte-verified chunked storage. Keep a restricted local copy as well.
5. Apply the create-only migration. Verify counts, all source hashes, preserved opening balances, active/tombstone history and saved dates/totals. A repeated run must create zero duplicates.
6. Record the verified migration gate. Roll out the already-built source through App Hosting and verify health, private-path denial, owner sign-in, scoped data and live Gemini.

During cutover, previously cached clients cannot write to the legacy documents. Their local browser data is preserved; the upgraded app offers review of older device drafts. New runtime writes require the migration gate. Retain the legacy snapshot and existing managed backups throughout the transition.

## Recovery

The owner can export a consistent business snapshot in the app. “Verify backup restore” copies it into a separate recovery namespace and compares canonical contents; it never overlays a subset of financial records onto the live account. To perform a production recovery, first inspect that verified copy and use a controlled maintenance cutover. Command receipts, roles, owner binding and invitation generations are included so restore does not re-enable consumed commands or stale access links.

Daily managed Firestore backups with 50-day retention were already enabled and remain in place. Private source archives and recovery namespaces are denied to browser SDK access.

## Development

Run `npm ci`, `npm test`, and `npm run build`. Rules/concurrency tests require Java 21 and Firebase CLI 15.30.0:

```sh
npx firebase-tools@15.30.0 emulators:exec --only firestore --project demo-alabama-wholesale 'node --test tests/rules.integration.cjs'
```

`scripts/demo.cjs` is a loopback-only synthetic preview using the Firebase Auth emulator on port 9098. It is excluded from the production runtime. Do not copy emulator credentials or debug App Check tokens into production configuration.
