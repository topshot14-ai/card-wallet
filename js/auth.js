// Authentication module — email/password + Google sign-in

import { getAuth, isFirebaseConfigured } from './firebase.js';

let currentUser = null;
let authInitialized = false;

export function getCurrentUser() {
  return currentUser;
}

export function initAuth() {
  if (authInitialized) return;
  if (!isFirebaseConfigured()) return;

  const auth = getAuth();
  if (!auth) return;

  authInitialized = true;
  auth.onAuthStateChanged((user) => {
    currentUser = user;
    window.dispatchEvent(new CustomEvent('auth-state-changed', {
      detail: { user, signedIn: !!user }
    }));
  });
}

export async function signUpWithEmail(email, password) {
  const auth = getAuth();
  if (!auth) throw new Error('Firebase not configured');

  try {
    const result = await auth.createUserWithEmailAndPassword(email, password);
    return result.user;
  } catch (err) {
    throw new Error(friendlyAuthError(err.code));
  }
}

export async function signInWithEmail(email, password) {
  const auth = getAuth();
  if (!auth) throw new Error('Firebase not configured');

  try {
    const result = await auth.signInWithEmailAndPassword(email, password);
    return result.user;
  } catch (err) {
    throw new Error(friendlyAuthError(err.code));
  }
}

export async function signInWithGoogle() {
  const auth = getAuth();
  if (!auth) throw new Error('Firebase not configured');

  const provider = new firebase.auth.GoogleAuthProvider();

  try {
    // Try popup first (works on desktop)
    const result = await auth.signInWithPopup(provider);
    return result.user;
  } catch (err) {
    if (err.code === 'auth/popup-blocked' || err.code === 'auth/popup-closed-by-user') {
      // Fall back to redirect (better for mobile)
      await auth.signInWithRedirect(provider);
      return null; // Page will reload
    }
    throw new Error(friendlyAuthError(err.code));
  }
}

export async function signOut() {
  const auth = getAuth();
  if (!auth) return;

  await auth.signOut();
}

function friendlyAuthError(code) {
  const messages = {
    'auth/email-already-in-use': 'An account with this email already exists.',
    'auth/invalid-email': 'Please enter a valid email address.',
    'auth/user-disabled': 'This account has been disabled.',
    'auth/user-not-found': 'No account found with this email.',
    'auth/wrong-password': 'Incorrect password.',
    'auth/weak-password': 'Password must be at least 6 characters.',
    'auth/too-many-requests': 'Too many attempts. Please try again later.',
    'auth/network-request-failed': 'Network error. Check your connection.',
    'auth/popup-blocked': 'Popup was blocked. Please allow popups for this site.',
    'auth/popup-closed-by-user': 'Sign-in popup was closed.',
    'auth/invalid-credential': 'Invalid email or password.',
    'auth/operation-not-allowed': 'This sign-in method is not enabled in your Firebase project.',
  };
  return messages[code] || `Authentication error: ${code}`;
}
