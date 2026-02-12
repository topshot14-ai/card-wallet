// Sync layer — Firestore + Storage push/pull with IndexedDB as local cache

import { isFirebaseConfigured, getFirestore, getStorage } from './firebase.js';
import { getCurrentUser } from './auth.js';
import { saveCardLocal, getAllCards, getCard } from './db.js';

let syncStatus = 'idle'; // 'idle' | 'syncing' | 'error'

function setSyncStatus(status) {
  syncStatus = status;
  window.dispatchEvent(new CustomEvent('sync-status-changed', { detail: { status } }));
}

export function getSyncStatus() {
  return syncStatus;
}

// Fields to exclude from Firestore doc (full images stored in Storage)
const EXCLUDED_FIELDS = ['imageBlob', 'imageBackBlob'];

function cardToFirestoreDoc(card, imageUrl, imageBackUrl) {
  const doc = {};
  for (const [key, value] of Object.entries(card)) {
    if (!EXCLUDED_FIELDS.includes(key)) {
      doc[key] = value === undefined ? null : value;
    }
  }
  doc.imageUrl = imageUrl || null;
  doc.imageBackUrl = imageBackUrl || null;
  return doc;
}

function firestoreDocToCard(doc) {
  const card = { ...doc };
  // imageUrl/imageBackUrl serve as imageBlob/imageBackBlob for <img src>
  if (card.imageUrl && !card.imageBlob) {
    card.imageBlob = card.imageUrl;
  }
  if (card.imageBackUrl && !card.imageBackBlob) {
    card.imageBackBlob = card.imageBackUrl;
  }
  return card;
}

// ===== Image Upload to Firebase Storage =====

async function uploadImage(uid, cardId, blob, filename) {
  const storage = getStorage();
  if (!storage || !blob) return null;

  // Only upload base64 data URIs (not URLs that are already in Storage)
  if (typeof blob === 'string' && blob.startsWith('https://')) {
    return blob; // Already a Storage URL
  }

  const ref = storage.ref(`users/${uid}/cards/${cardId}/${filename}`);

  if (typeof blob === 'string' && blob.startsWith('data:')) {
    // Base64 data URI
    await ref.putString(blob, 'data_url');
  } else {
    await ref.put(blob);
  }

  return ref.getDownloadURL();
}

async function deleteCardImages(uid, cardId) {
  const storage = getStorage();
  if (!storage) return;

  const files = ['front.jpg', 'back.jpg'];
  for (const file of files) {
    try {
      await storage.ref(`users/${uid}/cards/${cardId}/${file}`).delete();
    } catch (err) {
      // Ignore not-found errors
      if (err.code !== 'storage/object-not-found') {
        console.warn('Failed to delete storage file:', err);
      }
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

    // Upload full images to Storage
    const imageUrl = await uploadImage(user.uid, card.id, card.imageBlob, 'front.jpg');
    const imageBackUrl = await uploadImage(user.uid, card.id, card.imageBackBlob, 'back.jpg');

    // Write card doc to Firestore (without full image blobs)
    const doc = cardToFirestoreDoc(card, imageUrl, imageBackUrl);
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

    for (const doc of snapshot.docs) {
      const remoteCard = firestoreDocToCard(doc.data());
      const localCard = localMap.get(remoteCard.id);

      if (!localCard) {
        // Card exists remotely but not locally — pull it
        await saveCardLocal(remoteCard);
      } else {
        // Both exist — newer wins
        const remoteTime = new Date(remoteCard.lastModified || remoteCard.dateAdded || 0).getTime();
        const localTime = new Date(localCard.lastModified || localCard.dateAdded || 0).getTime();

        if (remoteTime > localTime) {
          // Remote is newer — keep local images if remote only has URLs
          if (!remoteCard.imageBlob && localCard.imageBlob && !localCard.imageBlob.startsWith('https://')) {
            // Local has original blob, remote has URL — prefer keeping local blob for offline
          }
          await saveCardLocal({ ...localCard, ...remoteCard });
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
    await deleteCardImages(user.uid, cardId);
  } catch (err) {
    console.error('Delete card remote failed:', err);
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
