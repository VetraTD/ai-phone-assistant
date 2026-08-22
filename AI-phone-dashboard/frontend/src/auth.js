import { initializeApp } from "firebase/app";
import {
  browserLocalPersistence,
  confirmPasswordReset,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  verifyPasswordResetCode,
} from "firebase/auth";

// ---------------------------------------------------------------------------
// Staff sign-in. Identity Platform, replacing Supabase Auth (B3).
//
// This is deliberately NOT a Supabase-shaped shim. A `supabase.auth`-lookalike
// would have kept the old vendor's shape — its session object, its
// `{ data, error }` envelope, its method names — in a codebase that no longer
// has that vendor in it, and the next person would have had to learn a dead API
// to read the login screen. The functions below are named for what the product
// does: sign in, sign out, get a token, reset a password.
//
// THE API KEY IS PUBLIC AND THAT IS CORRECT. An Identity Platform web key
// identifies the project; it authorises nothing, and it ships inside the
// JavaScript bundle by design. Terraform restricts it to identitytoolkit so a
// copy lifted out of the bundle cannot be spent on Vertex or Speech — see
// infra/terraform/identity-platform.tf.
//
// WHAT DID NOT SURVIVE THE SWAP, and it is the one real behaviour change:
// Supabase's password-reset link signed the person IN with a recovery session,
// and the app then called updateUser. Identity Platform issues a one-shot
// `oobCode` instead, which is exchanged for a password change and never becomes
// a session. That is a better shape — a reset link that logs you in is a
// session anybody with the email can take — and it is why resetPassword.jsx
// reads a code out of the URL rather than assuming it is already signed in.
// ---------------------------------------------------------------------------

const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
});

export const auth = getAuth(app);

// Survive a page reload and a closed tab, which is what Supabase did and what
// the dashboard's own §164.312(a)(2)(iii) idle timeout assumes — that hook is
// the thing that ends a session, and it cannot do its job if the browser has
// already forgotten one on every refresh. `setPersistence` returns a promise;
// it is not awaited because Firebase queues auth work behind it internally.
setPersistence(auth, browserLocalPersistence).catch(() => {
  // Private browsing with storage disabled. The session becomes in-memory only,
  // which is a degraded experience rather than a broken one.
});

/**
 * Human wording for Identity Platform's error codes.
 *
 * Two reasons this exists rather than showing `error.message`. Firebase's
 * message is `Firebase: Error (auth/invalid-credential).`, which tells a
 * receptionist nothing and names the vendor on the login screen. And the
 * mapping is where the enumeration decision lives: a wrong password and an
 * unknown address get the SAME sentence, so the form cannot be used to discover
 * which addresses have accounts.
 */
const MESSAGES = {
  "auth/invalid-credential": "That email or password is not right.",
  "auth/invalid-login-credentials": "That email or password is not right.",
  "auth/wrong-password": "That email or password is not right.",
  "auth/user-not-found": "That email or password is not right.",
  "auth/invalid-email": "That does not look like an email address.",
  "auth/user-disabled": "This account has been disabled. Contact your administrator.",
  "auth/too-many-requests": "Too many attempts. Wait a few minutes and try again.",
  "auth/email-already-in-use": "An account already exists for that email.",
  "auth/weak-password": "Choose a longer password — at least 6 characters.",
  "auth/missing-password": "Enter a password.",
  "auth/network-request-failed": "Could not reach the sign-in service. Check your connection.",
  "auth/expired-action-code": "That reset link has expired. Request a new one.",
  "auth/invalid-action-code": "That reset link is not valid. Request a new one.",
  "auth/requires-recent-login": "Sign in again before changing your password.",
};

/** @param {unknown} err @returns {string} */
function messageFor(err) {
  const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
  // The fallback deliberately does NOT include the raw message. An unmapped
  // code should read as a problem on our side, which is what it is.
  return MESSAGES[code] || "Something went wrong signing in. Try again.";
}

/**
 * Subscribe to sign-in and sign-out.
 *
 * The callback receives the Identity Platform user or null. Returns the
 * unsubscribe function directly — Supabase returned it three levels down
 * (`data.subscription.unsubscribe`), which is a shape worth losing.
 *
 * @param {(user: import("firebase/auth").User | null) => void} cb
 * @returns {() => void}
 */
export function onAuthChange(cb) {
  return onAuthStateChanged(auth, cb);
}

/** The signed-in user, or null. Synchronous, and null before the first auth check resolves. */
export function currentUser() {
  return auth.currentUser;
}

/**
 * The bearer token to send with an API request.
 *
 * `getIdToken()` returns the cached token and refreshes it only when it is
 * within five minutes of expiry, so this is cheap enough for an axios request
 * interceptor. `forceRefresh` mints a new one — used by authRetry.js when a
 * server reports the token is past the session-age ceiling.
 *
 * @param {{ forceRefresh?: boolean }} [opts]
 * @returns {Promise<string|null>}
 */
export async function getAccessToken({ forceRefresh = false } = {}) {
  const user = auth.currentUser;
  if (!user) return null;
  try {
    return await user.getIdToken(forceRefresh);
  } catch {
    // The refresh token is gone or revoked. Null makes the request go out
    // unauthenticated and come back 401, which is the honest outcome — better
    // than throwing inside an interceptor, where it surfaces as a network error.
    return null;
  }
}

/**
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ error?: string }>}
 */
export async function signIn(email, password) {
  try {
    await signInWithEmailAndPassword(auth, email, password);
    return {};
  } catch (err) {
    return { error: messageFor(err) };
  }
}

/**
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ error?: string }>}
 */
export async function signUp(email, password) {
  try {
    await createUserWithEmailAndPassword(auth, email, password);
    return {};
  } catch (err) {
    return { error: messageFor(err) };
  }
}

/** @returns {Promise<void>} */
export async function signOut() {
  await firebaseSignOut(auth).catch(() => {});
}

/**
 * Send a password-reset email.
 *
 * `continueUrl` is where the person lands AFTER the reset, and Identity Platform
 * refuses any domain not in `authorized_domains` — see the Terraform. A domain
 * missing there produces a reset email whose link is rejected, and the person
 * who sees that is a locked-out member of staff rather than a deploy.
 *
 * Resolves the same way whether or not the address has an account. Telling the
 * difference here would hand anyone a way to test which staff addresses exist.
 *
 * @param {string} email
 * @param {{ continueUrl?: string }} [opts]
 * @returns {Promise<{ error?: string }>}
 */
export async function sendPasswordReset(email, { continueUrl } = {}) {
  try {
    await sendPasswordResetEmail(auth, email, continueUrl ? { url: continueUrl } : undefined);
    return {};
  } catch (err) {
    const code = err && typeof err === "object" ? String(err.code) : "";
    // Not an error the person should see: it would confirm the address has no
    // account. Everything else — a malformed address, rate limiting — is real
    // feedback about what they typed.
    if (code === "auth/user-not-found") return {};
    return { error: messageFor(err) };
  }
}

/**
 * Check a reset code before showing the new-password form.
 *
 * Without this, an expired link renders a form that fails only after somebody
 * has typed a password into it twice.
 *
 * @param {string} oobCode
 * @returns {Promise<{ email?: string, error?: string }>}
 */
export async function checkPasswordResetCode(oobCode) {
  try {
    return { email: await verifyPasswordResetCode(auth, oobCode) };
  } catch (err) {
    return { error: messageFor(err) };
  }
}

/**
 * Exchange a reset code for a new password.
 *
 * Deliberately does NOT sign the person in afterwards. Identity Platform
 * invalidates existing sessions on a password change, and sending them to the
 * login screen to use the password they just chose is the confirmation that it
 * worked.
 *
 * @param {string} oobCode
 * @param {string} newPassword
 * @returns {Promise<{ error?: string }>}
 */
export async function completePasswordReset(oobCode, newPassword) {
  try {
    await confirmPasswordReset(auth, oobCode, newPassword);
    return {};
  } catch (err) {
    return { error: messageFor(err) };
  }
}
