// Firebase initialization — reads config from IndexedDB, graceful no-op if not set

import { getSetting } from './db.js';

let firebaseApp = null;
let firebaseConfigured = false;

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

export function getStorage() {
  if (!firebaseConfigured) return null;
  return firebase.storage();
}

export async function initFirebase() {
  const configJson = await getSetting('firebaseConfig');
  if (!configJson) {
    firebaseConfigured = false;
    return false;
  }

  let config;
  try {
    config = typeof configJson === 'string' ? JSON.parse(configJson) : configJson;
  } catch {
    console.warn('Invalid Firebase config JSON');
    firebaseConfigured = false;
    return false;
  }

  if (!config.apiKey || !config.projectId) {
    console.warn('Firebase config missing required fields (apiKey, projectId)');
    firebaseConfigured = false;
    return false;
  }

  // Check if Firebase SDK is loaded
  if (typeof firebase === 'undefined') {
    console.warn('Firebase SDK not loaded');
    firebaseConfigured = false;
    return false;
  }

  try {
    // Avoid re-initializing if already done
    if (!firebase.apps.length) {
      firebaseApp = firebase.initializeApp(config);
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
