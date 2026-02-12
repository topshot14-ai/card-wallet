// Firebase initialization — hardcoded config, no user setup needed

let firebaseApp = null;
let firebaseConfigured = false;

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyD2gV5fO5suYV3g2tx08Icn1trNb_ZbGDQ",
  authDomain: "card-wallet-f634a.firebaseapp.com",
  projectId: "card-wallet-f634a",
  storageBucket: "card-wallet-f634a.firebasestorage.app",
  messagingSenderId: "414571917545",
  appId: "1:414571917545:web:66273ac5d7dad122264078"
};

export function isFirebaseConfigured() {
  return firebaseConfigured;
}

export function getAuth() {
  if (!firebaseConfigured) return null;
  return firebase.auth();
}

export function getFirestore() {
  if (!firebaseConfigured) return null;
  return firebase.firestore();
}

export async function initFirebase() {
  // Check if Firebase SDK is loaded
  if (typeof firebase === 'undefined') {
    console.warn('Firebase SDK not loaded');
    firebaseConfigured = false;
    return false;
  }

  try {
    if (!firebase.apps.length) {
      firebaseApp = firebase.initializeApp(FIREBASE_CONFIG);
    } else {
      firebaseApp = firebase.apps[0];
    }

    // Enable Firestore offline persistence
    try {
      await firebase.firestore().enablePersistence({ synchronizeTabs: true });
    } catch (err) {
      if (err.code === 'failed-precondition') {
        console.warn('Firestore persistence unavailable: multiple tabs open');
      } else if (err.code === 'unimplemented') {
        console.warn('Firestore persistence not supported in this browser');
      }
    }

    firebaseConfigured = true;
    return true;
  } catch (err) {
    console.error('Firebase init failed:', err);
    firebaseConfigured = false;
    return false;
  }
}
