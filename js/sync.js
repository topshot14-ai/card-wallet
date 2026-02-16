// Sync layer — Firestore push/pull with IndexedDB as local cache
// Full images synced via Firebase Storage, thumbnails in Firestore docs

import { isFirebaseConfigured, getFirestore, getStorage } from './firebase.js';
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
  return doc;
}

function firestoreDocToCard(doc) {
  return { ...doc };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to convert blob'));
    reader.readAsDataURL(blob);
  });
}

// Safe wrapper — returns null instead of throwing if Storage SDK missing
function safeGetStorage() {
  try {
    return getStorage();
  } catch (err) {
    console.error('[Sync] Firebase Storage unavailable:', err.message);
    return null;
  }
}

// ===== Image Sync: explicit upload/download for ALL cards =====

/**
 * Sync all card images between local IndexedDB and Firebase Storage.
 * - Upload: local has imageBlob but no imageStorageUrl → upload to Storage
 * - Download: local has imageStorageUrl but no imageBlob → download from Storage
 * Returns { uploaded, downloaded } counts.
 */
export async function syncImages() {
  if (!isFirebaseConfigured()) return { uploaded: 0, downloaded: 0 };
  const user = getCurrentUser();
  if (!user) return { uploaded: 0, downloaded: 0 };

  const storage = safeGetStorage();
  const firestore = getFirestore();

  const allCards = await getAllCards();
  let uploaded = 0;
  let downloaded = 0;
  let errors = 0;

  console.log('[Sync] syncImages — checking', allCards.length, 'cards, storage available:', !!storage);

  for (const card of allCards) {
    let cardChanged = false;

    // === UPLOAD: local image exists but not in Storage ===
    if (storage && card.imageBlob && !card.imageStorageUrl) {
      try {
        console.log('[Sync] Uploading front image for', card.id);
        const ref = storage.ref(`users/${user.uid}/cards/${card.id}/front.jpg`);
        await ref.putString(card.imageBlob, 'data_url');
        card.imageStorageUrl = await ref.getDownloadURL();
        cardChanged = true;
        console.log('[Sync] Front uploaded OK');
      } catch (err) {
        console.error('[Sync] Front upload FAILED for', card.id, ':', err.message);
        errors++;
      }
    }

    if (storage && card.imageBackBlob && !card.imageBackStorageUrl) {
      try {
        console.log('[Sync] Uploading back image for', card.id);
        const ref = storage.ref(`users/${user.uid}/cards/${card.id}/back.jpg`);
        await ref.putString(card.imageBackBlob, 'data_url');
        card.imageBackStorageUrl = await ref.getDownloadURL();
        cardChanged = true;
        console.log('[Sync] Back uploaded OK');
      } catch (err) {
        console.error('[Sync] Back upload FAILED for', card.id, ':', err.message);
        errors++;
      }
    }

    // Save locally + update Firestore doc with new URLs
    if (cardChanged) {
      await saveCardLocal(card);
      if (firestore) {
        try {
          const update = {};
          if (card.imageStorageUrl) update.imageStorageUrl = card.imageStorageUrl;
          if (card.imageBackStorageUrl) update.imageBackStorageUrl = card.imageBackStorageUrl;
          await firestore.collection('users').doc(user.uid).collection('cards').doc(card.id).set(update, { merge: true });
        } catch (err) {
          console.error('[Sync] Failed to update Firestore with image URLs:', err.message);
        }
      }
      uploaded++;
    }

    // === DOWNLOAD: Storage URL exists but no local blob ===
    if (card.imageStorageUrl && !card.imageBlob) {
      try {
        console.log('[Sync] Downloading front image for', card.id);
        const resp = await fetch(card.imageStorageUrl);
        if (resp.ok) {
          const blob = await resp.blob();
          card.imageBlob = await blobToBase64(blob);
          await saveCardLocal(card);
          downloaded++;
          console.log('[Sync] Front downloaded OK');
        }
      } catch (err) {
        console.error('[Sync] Front download FAILED for', card.id, ':', err.message);
        errors++;
      }
    }

    if (card.imageBackStorageUrl && !card.imageBackBlob) {
      try {
        console.log('[Sync] Downloading back image for', card.id);
        const resp = await fetch(card.imageBackStorageUrl);
        if (resp.ok) {
          const blob = await resp.blob();
          card.imageBackBlob = await blobToBase64(blob);
          await saveCardLocal(card);
          if (!card.imageStorageUrl || card.imageBlob) downloaded++; // Don't double count
          console.log('[Sync] Back downloaded OK');
        }
      } catch (err) {
        console.error('[Sync] Back download FAILED for', card.id, ':', err.message);
        errors++;
      }
    }
  }

  console.log('[Sync] syncImages done — uploaded:', uploaded, 'downloaded:', downloaded, 'errors:', errors);

  if (uploaded > 0 || downloaded > 0) {
    window.dispatchEvent(new CustomEvent('refresh-listings'));
    window.dispatchEvent(new CustomEvent('refresh-collection'));
  }

  return { uploaded, downloaded, errors };
}

// ===== Delete images from Storage =====

async function deleteCardImages(uid, cardId) {
  const storage = safeGetStorage();
  if (!storage) return;

  const paths = [
    `users/${uid}/cards/${cardId}/front.jpg`,
    `users/${uid}/cards/${cardId}/back.jpg`,
  ];

  for (const path of paths) {
    try {
      await storage.ref(path).delete();
    } catch {
      // File may not exist — that's fine
    }
  }
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

    // Try to upload images to Firebase Storage
    const storage = safeGetStorage();
    if (storage) {
      if (card.imageBlob && !card.imageStorageUrl) {
        try {
          const ref = storage.ref(`users/${user.uid}/cards/${card.id}/front.jpg`);
          await ref.putString(card.imageBlob, 'data_url');
          card.imageStorageUrl = await ref.getDownloadURL();
          await saveCardLocal(card);
        } catch (err) {
          console.error('[Sync] pushCard image upload failed:', err.message);
        }
      }
      if (card.imageBackBlob && !card.imageBackStorageUrl) {
        try {
          const ref = storage.ref(`users/${user.uid}/cards/${card.id}/back.jpg`);
          await ref.putString(card.imageBackBlob, 'data_url');
          card.imageBackStorageUrl = await ref.getDownloadURL();
          await saveCardLocal(card);
        } catch (err) {
          console.error('[Sync] pushCard back image upload failed:', err.message);
        }
      }
    }

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
  console.log('[Sync] pullAllCards — called');
  if (!isFirebaseConfigured()) { console.log('[Sync] pullAllCards — firebase not configured'); return; }
  const user = getCurrentUser();
  if (!user) { console.log('[Sync] pullAllCards — no user'); return; }

  const firestore = getFirestore();
  if (!firestore) { console.log('[Sync] pullAllCards — no firestore'); return; }

  try {
    setSyncStatus('syncing');

    const snapshot = await firestore
      .collection('users').doc(user.uid).collection('cards')
      .get();

    const localCards = await getAllCards();
    const localMap = new Map(localCards.map(c => [c.id, c]));
    console.log('[Sync] pullAllCards — remote:', snapshot.docs.length, 'local:', localCards.length);

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
          const merged = { ...localCard, ...remoteCard };
          if (localCard.imageBlob) merged.imageBlob = localCard.imageBlob;
          if (localCard.imageBackBlob) merged.imageBackBlob = localCard.imageBackBlob;
          await saveCardLocal(merged);
          conflictCount++;
        } else {
          // Local is newer or same — preserve local but grab any Storage URLs from remote
          if (remoteCard.imageStorageUrl && !localCard.imageStorageUrl) {
            localCard.imageStorageUrl = remoteCard.imageStorageUrl;
            await saveCardLocal(localCard);
          }
          if (remoteCard.imageBackStorageUrl && !localCard.imageBackStorageUrl) {
            localCard.imageBackStorageUrl = remoteCard.imageBackStorageUrl;
            await saveCardLocal(localCard);
          }
        }
      }
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
    console.log('[Sync] pullAllCards done — pulled:', pullCount, 'conflicts:', conflictCount);

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
    await deleteCardImages(user.uid, cardId);
    await firestore.collection('users').doc(user.uid).collection('cards').doc(cardId).delete();
  } catch (err) {
    console.error('Delete card remote failed:', err);
  }
}

// ===== Settings Sync =====

const SYNCED_SETTING_KEYS = [
  'apiKey', 'model', 'defaultSport', 'defaultCondition', 'defaultPrice',
  'ebayWorkerUrl', 'ebayClientId', 'ebayRuName',
  'ebayAccessToken', 'ebayRefreshToken', 'ebayTokenExpiry', 'ebayConnected',
];

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

    console.log('[Sync] pushSettings — keys being pushed:', Object.keys(toSync).filter(k => k !== 'lastModified'));
    await firestore.collection('users').doc(user.uid).collection('settings').doc('prefs').set(toSync, { merge: true });
    console.log('[Sync] pushSettings — success');
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
    if (!doc.exists) {
      console.log('[Sync] pullSettings — no remote settings doc found');
      return;
    }

    const remote = doc.data();
    console.log('[Sync] pullSettings — remote keys:', Object.keys(remote).filter(k => k !== 'lastModified'));
    let pulledKeys = [];
    for (const key of SYNCED_SETTING_KEYS) {
      if (remote[key] !== undefined && remote[key] !== null) {
        const local = await getSetting(key);
        if (local === null || local === undefined) {
          await setSetting(key, remote[key]);
          pulledKeys.push(key);
          if (key === 'apiKey') {
            try { localStorage.setItem('cw_apiKey', remote[key]); } catch {}
          }
        }
      }
    }
    console.log('[Sync] pullSettings — pulled keys:', pulledKeys);
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
