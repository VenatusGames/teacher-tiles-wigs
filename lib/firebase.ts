import { initializeApp } from 'firebase/app';
import { initializeAuth, browserSessionPersistence, browserPopupRedirectResolver, GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';
import { initializeFirestore, memoryLocalCache } from 'firebase/firestore';

import { firebaseConfig as config } from './firebase-config';
export const firebaseConfigured = Object.values(config).every(value => typeof value === 'string' && value.length > 0);
// A named app and project-specific browser session keep WIGs separate from Teacher Tiles.
const app = firebaseConfigured ? initializeApp(config, 'teacher-tiles-wigs') : null;
export const auth = app ? initializeAuth(app, { persistence: browserSessionPersistence, popupRedirectResolver: browserPopupRedirectResolver }) : null;
export const db = app ? initializeFirestore(app, { localCache: memoryLocalCache() }) : null;
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });
export function googleSignIn() {
  if (!auth) throw new Error('WIGs sign-in is not configured yet.');
  return signInWithPopup(auth, provider);
}
export function logOut() { return auth ? signOut(auth) : Promise.resolve(); }
export function requireDb() {
  if (!db || !auth?.currentUser?.emailVerified) throw new Error('Sign in with Google to continue.');
  return db;
}
export function friendlyError(error: unknown) {
  const code = (error as { code?: string })?.code;
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return 'Sign-in was cancelled. Sign in with Google to continue.';
  if (code === 'auth/popup-blocked') return 'Allow pop-ups for this site, then try signing in again.';
  if (code === 'auth/unauthorized-domain') return 'This site address has not been enabled for WIGs sign-in yet.';
  if (code === 'permission-denied') return 'Access was denied. Your class assignment may have changed, or the WIGs database rules need to be published.';
  if (code === 'unavailable' || code === 'auth/network-request-failed') return 'Could not connect. Check your connection and try again.';
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
