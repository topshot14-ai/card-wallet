// Sync layer — Firestore push/pull with IndexedDB as local cache
// No Firebase Storage — thumbnails stored as base64 in Firestore docs, full images stay local only

import { isFirebaseConfigured, getFirestore } from './firebase.js';
import { getCurrentUser } from './auth.js';
import { saveCardLocal, getAllCards, getSetting, setSetting, getAllSettings } from './db.js';

let syncStatus = 'idle'; // 'idle' | 'syncing' | 'error'

function setSyncStatus(status) {
  syncStatus = status;
  window.dispatchEvent(new CustomEvent('sync-status-changed', { detail: { status } }));
}

export function getSyncStatus() {
  return syncStatus;
}

// Fields to exclude from Firestore doc (full image blobs are too large)
const EXCLUDED_FIELDS = ['imageBlob', 'imageBackBlob'];

function cardToFirestoreDoc(card) {
  const doc = {};
  for (const [key, value] of Object.entries(card)) {
    if (!EXCLUDED_FIELDS.includes(key)) {
      doc[key] = value === undefined ? null : value;
    }
  }
  // Store thumbnails in Firestore (small enough at ~5-15KB base64)
  // Full images (imageBlob, imageBackBlob) stay local only
  return doc;
}

function firestoreDocToCard(doc) {
  return { ...doc };
}

// ===== Push: Local → Cloud =====

export async function pushCard(card) {
  if (!isFirebaseConfigured()) return;
  const user = getCurrentUser();
  if (!user) return;

  const db = getFirestore();
  if (!db) return;

  try {
    setSyncStatus('syncing');

    const doc = cardToFirestoreDoc(card);
    await db.collection('users').doc(user.uid).collection('cards').doc(card.id).set(doc);

    setSyncStatus('idle');
  } catch (err) {
    console.error('Push card failed:', err);
    setSyncStatus('error');
  }
}

// ===== Pull: Cloud → Local (merge by lastModified) =====

export async function pullAllCards() {
  if (!isFirebaseConfigured()) return;
  const user = getCurrentUser();
  if (!user) return;

  const firestore = getFirestore();
  if (!firestore) return;

  try {
    setSyncStatus('syncing');

    const snapshot = await firestore
      .collection('users').doc(user.uid).collection('cards')
      .get();

    const localCards = await getAllCards();
    const localMap = new Map(localCards.map(c => [c.id, c]));

    let pullCount = 0;
    let conflictCount = 0;

    for (const doc of snapshot.docs) {
      const remoteCard = firestoreDocToCard(doc.data());
      const localCard = localMap.get(remoteCard.id);

      if (!localCard) {
        // Card exists remotely but not locally — pull it
        await saveCardLocal(remoteCard);
        pullCount++;
      } else {
        // Both exist — newer wins
        const remoteTime = new Date(remoteCard.lastModified || remoteCard.dateAdded || 0).getTime();
        const localTime = new Date(localCard.lastModified || localCard.dateAdded || 0).getTime();

        if (remoteTime > localTime) {
          // Remote is newer — merge but keep local full images
          const merged = { ...localCard, ...remoteCard };
          // Preserve local full images (they aren't in Firestore)
          if (localCard.imageBlob) merged.imageBlob = localCard.imageBlob;
          if (localCard.imageBackBlob) merged.imageBackBlob = localCard.imageBackBlob;
          await saveCardLocal(merged);
          conflictCount++;
        }
      }
    }

    // Notify about sync results
    if (conflictCount > 0) {
      window.dispatchEvent(new CustomEvent('sync-conflict', {
        detail: { message: `${conflictCount} card(s) updated from cloud (remote was newer)` }
      }));
    }

    // Push local-only cards to remote
    for (const [id, localCard] of localMap) {
      const existsRemote = snapshot.docs.some(d => d.id === id);
      if (!existsRemote) {
        await pushCard(localCard);
      }
    }

    setSyncStatus('idle');
    updateSyncBadge('Synced');
  } catch (err) {
    console.error('Pull all cards failed:', err);
    setSyncStatus('error');
    updateSyncBadge('Sync Error');
  }
}

// ===== Delete: Remove from Cloud =====

export async function deleteCardRemote(cardId) {
  if (!isFirebaseConfigured()) return;
  const user = getCurrentUser();
  if (!user) return;

  const firestore = getFirestore();
  if (!firestore) return;

  try {
    await firestore.collection('users').doc(user.uid).collection('cards').doc(cardId).delete();
  } catch (err) {
    console.error('Delete card remote failed:', err);
  }
}

// ===== Settings Sync =====

// Keys to sync to Firestore (excludes sensitive tokens like eBay auth)
const SYNCED_SETTING_KEYS = ['apiKey', 'model', 'defaultSport', 'defaultCondition', 'defaultPrice', 'ebayWorkerUrl'];

export async function pushSettings() {
  if (!isFirebaseConfigured()) return;
  const user = getCurrentUser();
  if (!user) return;

  const firestore = getFirestore();
  if (!firestore) return;

  try {
    const allSettings = await getAllSettings();
    const toSync = {};
    for (const key of SYNCED_SETTING_KEYS) {
      if (allSettings[key] !== undefined && allSettings[key] !== null) {
        toSync[key] = allSettings[key];
      }
    }
    toSync.lastModified = new Date().toISOString();

    await firestore.collection('users').doc(user.uid).collection('settings').doc('prefs').set(toSync, { merge: true });
  } catch (err) {
    console.error('Push settings failed:', err);
  }
}

export async function pullSettings() {
  if (!isFirebaseConfigured()) return;
  const user = getCurrentUser();
  if (!user) return;

  const firestore = getFirestore();
  if (!firestore) return;

  try {
    const doc = await firestore.collection('users').doc(user.uid).collection('settings').doc('prefs').get();
    if (!doc.exists) return;

    const remote = doc.data();
    for (const key of SYNCED_SETTING_KEYS) {
      if (remote[key] !== undefined && remote[key] !== null) {
        // Only overwrite if local is empty
        const local = await getSetting(key);
        if (!local) {
          await setSetting(key, remote[key]);
          // Also backup API key to localStorage
          if (key === 'apiKey') {
            try { localStorage.setItem('cw_apiKey', remote[key]); } catch {}
          }
        }
      }
    }
  } catch (err) {
    console.error('Pull settings failed:', err);
  }
}

// ===== Event Listeners: auto-push on local changes =====

export function initSyncListeners() {
  window.addEventListener('card-saved', async (e) => {
    const { card } = e.detail;
    if (card) {
      await pushCard(card);
    }
  });

  window.addEventListener('card-deleted', async (e) => {
    const { id } = e.detail;
    if (id) {
      await deleteCardRemote(id);
    }
  });

  // Push settings to cloud when API key or other settings change
  window.addEventListener('apikey-changed', () => pushSettings());
  window.addEventListener('settings-changed', () => pushSettings());

  window.addEventListener('cards-deleted', async (e) => {
    const { ids } = e.detail;
    if (ids) {
      for (const id of ids) {
        await deleteCardRemote(id);
      }
    }
  });

  // Update sync badge on status changes
  window.addEventListener('sync-status-changed', (e) => {
    const { status } = e.detail;
    const badge = document.getElementById('auth-sync-badge');
    if (!badge) return;

    if (status === 'syncing') {
      badge.textContent = 'Syncing...';
      badge.className = 'sync-badge syncing';
    } else if (status === 'error') {
      badge.textContent = 'Sync Error';
      badge.className = 'sync-badge error';
    } else {
      badge.textContent = 'Synced';
      badge.className = 'sync-badge';
    }
  });
}

function updateSyncBadge(text) {
  const badge = document.getElementById('auth-sync-badge');
  if (badge) badge.textContent = text;
}
