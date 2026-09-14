# Firebase AI Logic setup

## Step 2: SDKs

This app serves HTML and browser JavaScript directly, without a bundler. It uses
Firebase's supported CDN module setup instead of npm imports. Installing the
Firebase npm package alone would not make `firebase/ai` imports work in this page.

`_loadFirebaseSDK()` loads version 12.19.0 of Firebase App, Authentication,
Firestore, AI Logic, and App Check. Keep these versions aligned when upgrading.
AI Logic is available as `sdk.ai` and App Check as `sdk.appCheck` on the returned
object.

The existing `cloudSyncEnable()` function initializes the Firebase app named
`aw-sync` with the project's configuration, then stores it in `CLOUD.app` after
authentication succeeds. Reuse this app for App Check and AI Logic so the AI
feature shares the existing Firebase project and authentication.

## Step 3: private local debug setup

The Firebase console shows **Basic - Enforced** for Firebase AI Logic.
The debug token named **Mashaal Safari local development** is registered for the
`alabama-wholesale` web app. Verification in Safari succeeded: Firebase accepted
the debug token and issued an App Check token. Step 3 is complete for local
development. Production registration is described below.

A private local launcher is saved on this Mac at
`.firebase/app-check-local/server.cjs`. Its token is stored in a separate file
with owner-only permissions. Both files are excluded from Git by `.firebase/`.

Run `node .firebase/app-check-local/server.cjs` from this app's directory, then
open `http://127.0.0.1:8770` in Safari. The setup page loads the same Firebase
configuration and SDK loader as the web app, initializes the debug provider,
and can verify the registered token without reading or writing business data.

The local `/app` route adds App Check initialization before Authentication and
Firestore. It uses the same private token and live Firebase project. The local
build disables service-worker registration and caching so the debug build
isn't retained as an offline production app. The server only binds to loopback.

The live site's address is
`https://alabama-wholesale--alabama-wholesale-ordering-app.us-east4.hosted.app`.
Never deploy the private local launcher, its token, or the generated debug HTML.

## Step 4: Gemini initialization

`_initializeFirebaseAI(app, sdk)` initializes the Gemini Developer API through
Firebase AI Logic and creates the `gemini-3.8-flash` model. It reuses the Firebase
app passed to it. The private local app calls this after App Check and stores
the resulting service and model in `CLOUD.ai` and `CLOUD.aiModel`.

The local setup page uses the same initializer. Safari confirmed the model was
initialized as `models/gemini-3.8-flash`.

## Step 5: successful Gemini test

The local setup page has a **Send test prompt to Gemini** button. Its fixed prompt
is: `Reply with exactly: Alabama Wholesale Gemini connection OK.` It verifies
App Check first, sends the prompt, and displays either the response or the error.
It does not read orders or other Firestore data.

On September 14, 2026, after the user completed prepay setup, Google AI Studio
showed **Tier 1 · Prepay** for `alabama-wholesale-ordering-app` with no prepay
warning. A fresh test in Safari passed App Check and Gemini returned:

> Alabama Wholesale Gemini connection OK.

This verifies SDK loading, App Check token acceptance, Gemini initialization,
and an actual generated response through the Firebase AI Logic SDK. The earlier
HTTP 429 billing blocker is resolved. Steps 2–5 are complete for local development.

To repeat the test, open `http://127.0.0.1:8770` and click the test button.

## Production App Check and Gemini

The web app is registered with Firebase App Check using reCAPTCHA Enterprise.
The site key named **Alabama Wholesale App Check** is restricted to
`alabama-wholesale--alabama-wholesale-ordering-app.us-east4.hosted.app`.
Domain verification is enabled; challenges and test mode are disabled. Firebase
App Check uses the default one-hour token lifetime and 0.5 risk threshold.

`_prepareFirebaseAI()` initializes App Check before Authentication and Firestore,
then initializes Gemini on the same Firebase app. Its errors are contained so
the cloud-sync initialization can continue if AI initialization fails.

In the app, go to **More → Settings → Gemini connection → Check connection**.
This verifies the App Check token and sends the fixed connection-test prompt.
The result appears below the button. No order or customer data is sent to Gemini.
This is an SDK connection test, not an order-assistant feature.

AI Logic remains enforced by App Check. Enforcement for Authentication,
Firestore, and Storage is unchanged. The production HTML contains the public
reCAPTCHA site key; it contains no debug token or Gemini API key.

Deploy the committed source through the existing Firebase App Hosting backend
`alabama-wholesale`. Keep `.firebase/` out of Git and all deployments.

## References

- [Firebase AI Logic setup](https://firebase.google.com/docs/ai-logic/get-started)
- [Firebase browser module setup](https://firebase.google.com/docs/web/alt-setup)
- [App Check for Firebase AI Logic](https://firebase.google.com/docs/ai-logic/app-check)
