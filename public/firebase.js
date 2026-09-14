import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth,
  connectAuthEmulator,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  getToken,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app-check.js";
let auth, appCheck;
export async function initializeIdentity(config, onChange) {
  if (!config?.firebaseConfig?.apiKey)
    throw new Error(
      "Firebase sign-in is not configured. Contact the workspace owner.",
    );
  const app = initializeApp(config.firebaseConfig);
  if (config.recaptchaSiteKey)
    appCheck = initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(config.recaptchaSiteKey),
      isTokenAutoRefreshEnabled: true,
    });
  auth = getAuth(app);
  if (
    config.emulators?.auth &&
    ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)
  ) {
    const url = new URL(config.emulators.auth);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      throw new Error("The authentication emulator must run on localhost.");
    connectAuthEmulator(auth, url.origin, { disableWarnings: true });
  }
  onAuthStateChanged(auth, onChange);
}
export const identity = () => auth?.currentUser;
export const signInGoogle = () =>
  signInWithPopup(auth, new GoogleAuthProvider());
export const signInEmail = (email, password) =>
  signInWithEmailAndPassword(auth, email, password);
export async function registerEmail(email, password) {
  const result = await createUserWithEmailAndPassword(auth, email, password);
  await sendEmailVerification(result.user);
  return result;
}
export const verifyEmail = () => sendEmailVerification(auth.currentUser);
export const resetPassword = (email) => sendPasswordResetEmail(auth, email);
export const logout = () => signOut(auth);
export async function credentials(force = false, user = auth?.currentUser) {
  if (!user) throw new Error("Sign in to continue.");
  const headers = {
    Authorization: `Bearer ${await user.getIdToken(force)}`,
  };
  if (appCheck)
    headers["X-Firebase-AppCheck"] = (await getToken(appCheck, force)).token;
  return headers;
}
export async function reloadIdentity() {
  await auth.currentUser?.reload();
  await auth.currentUser?.getIdToken(true);
  return auth.currentUser;
}
