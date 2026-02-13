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
  // Store thumbnails in Firestore (small enough at ~5-15KB base64)
  // Full images (imageBlob, imageBackBlob) go to Firebase Storage
  return doc;
}

function firestoreDocToCard(doc) {
  return { ...doc };
}

// ===== Image Storage Helpers =====

/**
 * Upload a card's full images to Firebase Storage.
 * Stores at users/{uid}/cards/{cardId}/front.jpg and back.jpg.
 * Returns { imageStorageUrl, imageBackStorageUrl } with download URLs.
 */
async function uploadCardImages(uid, card) {
  const storage = getStorage();
  if (!storage) {
    console.warn('[Sync] uploadCardImages — no storage available');
    return {};
  }

  const urls = {};
  console.log('[Sync] uploadCardImages —', card.id,
    'hasBlob:', !!card.imageBlob, 'hasUrl:', !!card.imageStorageUrl,
    'hasBackBlob:', !!card.imageBackBlob, 'hasBackUrl:', !!card.imageBackStorageUrl);

  // Upload front image if it exists and hasn't been uploaded yet
  if (card.imageBlob && !card.imageStorageUrl) {
    try {
      console.log('[Sync] Uploading front image for', card.id, '...');
      const ref = storage.ref(`users/${uid}/cards/${card.id}/front.jpg`);
      await ref.putString(card.imageBlob, 'data_url');
      urls.imageStorageUrl = await ref.getDownloadURL();
      console.log('[Sync] Front image uploaded:', urls.imageStorageUrl.substring(0, 60) + '...');
    } catch (err) {
      console.error('[Sync] Failed to upload front image:', err);
    }
  }

  // Upload back image if it exists and hasn't been uploaded yet
  if (card.imageBackBlob && !card.imageBackStorageUrl) {
    try {
      console.log('[Sync] Uploading back image for', card.id, '...');
      const ref = storage.ref(`users/${uid}/cards/${card.id}/back.jpg`);
      await ref.putString(card.imageBackBlob, 'data_url');
      urls.imageBackStorageUrl = await ref.getDownloadURL();
      console.log('[Sync] Back image uploaded:', urls.imageBackStorageUrl.substring(0, 60) + '...');
    } catch (err) {
      console.error('[Sync] Failed to upload back image:', err);
    }
  }

  return urls;
}

/**
 * Download card images from Firebase Storage URLs into base64 data URIs.
 * Returns { imageBlob, imageBackBlob } for fields that were downloaded.
 */
async function downloadCardImages(card) {
  const images = {};

  if (card.imageStorageUrl && !card.imageBlob) {
    try {
      const resp = await fetch(card.imageStorageUrl);
      if (resp.ok) {
        const blob = await resp.blob();
        images.imageBlob = await blobToBase64(blob);
      }
    } catch (err) {
      console.error('Failed to download front image:', err);
    }
  }

  if (card.imageBackStorageUrl && !card.imageBackBlob) {
    try {
      const resp = await fetch(card.imageBackStorageUrl);
      if (resp.ok) {
        const blob = await resp.blob();
        images.imageBackBlob = await blobToBase64(blob);
      }
    } catch (err) {
      console.error('Failed to download back image:', err);
    }
  }

  return images;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to convert blob'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Delete card images from Firebase Storage.
 */
async function deleteCardImages(uid, cardId) {
  const storage = getStorage();
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

    // Upload images to Firebase Storage if needed
    const imageUrls = await uploadCardImages(user.uid, card);

    // If new URLs were generated, save them on the card locally and include in Firestore doc
    if (imageUrls.imageStorageUrl) {
      card.imageStorageUrl = imageUrls.imageStorageUrl;
      await saveCardLocal(card);
    }
    if (imageUrls.imageBackStorageUrl) {
      card.imageBackStorageUrl = imageUrls.imageBackStorageUrl;
      await saveCardLocal(card);
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
    const imagesToDownload = [];

    for (const doc of snapshot.docs) {
      const remoteCard = firestoreDocToCard(doc.data());
      const localCard = localMap.get(remoteCard.id);

      if (!localCard) {
        // Card exists remotely but not locally — pull it
        await saveCardLocal(remoteCard);
        pullCount++;

        // Queue image download if URLs exist
        if (remoteCard.imageStorageUrl || remoteCard.imageBackStorageUrl) {
          imagesToDownload.push(remoteCard);
        }
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

        // Download images if remote has URLs but local has no blobs
        if ((remoteCard.imageStorageUrl && !localCard.imageBlob) ||
            (remoteCard.imageBackStorageUrl && !localCard.imageBackBlob)) {
          const cardToFetch = { ...localCard, ...remoteCard };
          // Keep existing local blobs so downloadCardImages only fetches missing ones
          if (localCard.imageBlob) cardToFetch.imageBlob = localCard.imageBlob;
          if (localCard.imageBackBlob) cardToFetch.imageBackBlob = localCard.imageBackBlob;
          imagesToDownload.push(cardToFetch);
        }
      }
    }

    // Notify about sync results
    if (conflictCount > 0) {
      window.dispatchEvent(new CustomEvent('sync-conflict', {
        detail: { message: `${conflictCount} card(s) updated from cloud (remote was newer)` }
      }));
    }

    // Push local-only cards to remote (and upload any missing images)
    for (const [id, localCard] of localMap) {
      const existsRemote = snapshot.docs.some(d => d.id === id);
      if (!existsRemote) {
        await pushCard(localCard);
      } else if (localCard.imageBlob && !localCard.imageStorageUrl) {
        // Card exists remote but images were never uploaded — upload now
        console.log('[Sync] Card', id, 'exists remote but has no imageStorageUrl — uploading images');
        await pushCard(localCard);
      }
    }

    setSyncStatus('idle');
    updateSyncBadge('Synced');

    // Download images in background (non-blocking)
    console.log('[Sync] pullAllCards done — pulled:', pullCount, 'conflicts:', conflictCount, 'imagesToDownload:', imagesToDownload.length);
    if (imagesToDownload.length > 0) {
      downloadImagesInBackground(imagesToDownload);
    }
  } catch (err) {
    console.error('Pull all cards failed:', err);
    setSyncStatus('error');
    updateSyncBadge('Sync Error');
  }
}

/**
 * Download images for multiple cards in background.
 * Updates IndexedDB and refreshes views when done.
 */
async function downloadImagesInBackground(cards) {
  console.log('[Sync] Downloading images for', cards.length, 'card(s)...');
  let downloadedCount = 0;

  for (const card of cards) {
    console.log('[Sync] Downloading images for card', card.id,
      'frontUrl:', !!card.imageStorageUrl, 'backUrl:', !!card.imageBackStorageUrl);
    const images = await downloadCardImages(card);

    if (Object.keys(images).length > 0) {
      // Merge downloaded images into the card and save locally
      Object.assign(card, images);
      await saveCardLocal(card);
      downloadedCount++;
      console.log('[Sync] Downloaded', Object.keys(images).length, 'image(s) for card', card.id);
    }
  }

  console.log('[Sync] Image download complete —', downloadedCount, 'of', cards.length, 'cards updated');
  if (downloadedCount > 0) {
    // Refresh views so images appear
    window.dispatchEvent(new CustomEvent('refresh-listings'));
    window.dispatchEvent(new CustomEvent('refresh-collection'));
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
    // Delete images from Storage
    await deleteCardImages(user.uid, cardId);

    // Delete doc from Firestore
    await firestore.collection('users').doc(user.uid).collection('cards').doc(cardId).delete();
  } catch (err) {
    console.error('Delete card remote failed:', err);
  }
}

// ===== Settings Sync =====

// Keys to sync to Firestore (excludes sensitive tokens like eBay auth)
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
