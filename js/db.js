// IndexedDB wrapper for Card Wallet

const DB_NAME = 'CardWalletDB';
const DB_VERSION = 1;
const CARDS_STORE = 'cards';
const SETTINGS_STORE = 'settings';

let dbInstance = null;

function open() {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains(CARDS_STORE)) {
        const store = db.createObjectStore(CARDS_STORE, { keyPath: 'id' });
        store.createIndex('mode', 'mode', { unique: false });
        store.createIndex('sport', 'sport', { unique: false });
        store.createIndex('dateAdded', 'dateAdded', { unique: false });
        store.createIndex('player', 'player', { unique: false });
        store.createIndex('year', 'year', { unique: false });
        store.createIndex('status', 'status', { unique: false });
      }

      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
      }
    };

    request.onsuccess = (e) => {
      dbInstance = e.target.result;
      resolve(dbInstance);
    };

    request.onerror = (e) => {
      reject(new Error('Failed to open database: ' + e.target.error));
    };
  });
}

function tx(storeName, mode = 'readonly') {
  return open().then(db => {
    const transaction = db.transaction(storeName, mode);
    return transaction.objectStore(storeName);
  });
}

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ===== Card CRUD =====

/** Save card to IndexedDB only (no events dispatched). Used by sync to avoid loops. */
export async function saveCardLocal(card) {
  if (!card.id) {
    card.id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = (Math.random() * 16) | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
  }
  if (!card.dateAdded) {
    card.dateAdded = new Date().toISOString();
  }
  const store = await tx(CARDS_STORE, 'readwrite');
  await promisifyRequest(store.put(card));
  return card;
}

export async function saveCard(card) {
  const saved = await saveCardLocal(card);
  window.dispatchEvent(new CustomEvent('card-saved', { detail: { card: saved } }));
  return saved;
}

export async function getCard(id) {
  const store = await tx(CARDS_STORE);
  return promisifyRequest(store.get(id));
}

export async function deleteCard(id) {
  const store = await tx(CARDS_STORE, 'readwrite');
  await promisifyRequest(store.delete(id));
  window.dispatchEvent(new CustomEvent('card-deleted', { detail: { id } }));
}

export async function deleteCards(ids) {
  const db = await open();
  const transaction = db.transaction(CARDS_STORE, 'readwrite');
  const store = transaction.objectStore(CARDS_STORE);
  for (const id of ids) {
    store.delete(id);
  }
  await new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  window.dispatchEvent(new CustomEvent('cards-deleted', { detail: { ids } }));
}

export async function getAllCards(includeDeleted = false) {
  const store = await tx(CARDS_STORE);
  const all = await promisifyRequest(store.getAll());
  return includeDeleted ? all : all.filter(c => c.status !== 'deleted');
}

export async function getCardsByMode(mode) {
  const store = await tx(CARDS_STORE);
  const index = store.index('mode');
  const cards = await promisifyRequest(index.getAll(mode));
  return cards.filter(c => c.status !== 'deleted');
}

/** Soft-delete: mark as deleted instead of removing from DB */
export async function softDeleteCard(id) {
  const card = await getCard(id);
  if (!card) return;
  card.status = 'deleted';
  card.lastModified = new Date().toISOString();
  await saveCard(card);
  window.dispatchEvent(new CustomEvent('trash-changed'));
  return card;
}

export async function softDeleteCards(ids) {
  for (const id of ids) {
    await softDeleteCard(id);
  }
}

export async function getCardCount() {
  const store = await tx(CARDS_STORE);
  return promisifyRequest(store.count());
}

// ===== Settings =====

export async function getSetting(key) {
  const store = await tx(SETTINGS_STORE);
  const result = await promisifyRequest(store.get(key));
  return result ? result.value : null;
}

export async function setSetting(key, value) {
  const store = await tx(SETTINGS_STORE, 'readwrite');
  return promisifyRequest(store.put({ key, value }));
}

export async function getAllSettings() {
  const store = await tx(SETTINGS_STORE);
  const all = await promisifyRequest(store.getAll());
  const settings = {};
  for (const item of all) {
    settings[item.key] = item.value;
  }
  return settings;
}

// ===== Active Listings =====

/** Get cards that are actively listed on eBay (status=listed + has ebayListingId) */
export async function getActiveListings() {
  const store = await tx(CARDS_STORE);
  const index = store.index('status');
  const cards = await promisifyRequest(index.getAll('listed'));
  return cards.filter(c => c.ebayListingId && c.status !== 'deleted');
}

/**
 * One-time migration: move non-active listing cards to collection.
 * Cards with status='listed' stay as mode='listing'.
 * All others (pending, sold, unsold, exported) move to mode='collection'.
 */
export async function migrateListingQueueToCollection() {
  const migrated = await getSetting('listingQueueMigrated');
  if (migrated) return;

  const store = await tx(CARDS_STORE);
  const index = store.index('mode');
  const listingCards = await promisifyRequest(index.getAll('listing'));

  let count = 0;
  for (const card of listingCards) {
    if (card.status === 'listed' || card.status === 'deleted') continue;
    card.mode = 'collection';
    card.lastModified = new Date().toISOString();
    await saveCardLocal(card);
    count++;
  }

  await setSetting('listingQueueMigrated', true);
  if (count > 0) {
    console.log(`[Migration] Moved ${count} non-active listing cards to collection`);
  }
}

// ===== Data Export / Import =====

export async function exportAllData() {
  const cards = await getAllCards(true); // include trashed cards in backup
  const settings = await getAllSettings();
  // Never export sensitive settings
  delete settings.apiKey;
  delete settings.firebaseConfig;
  return { cards, settings, exportDate: new Date().toISOString(), version: 2 };
}

export async function importData(data) {
  if (!data || !data.cards) throw new Error('Invalid import data');

  const db = await open();

  // Import cards
  const cardTx = db.transaction(CARDS_STORE, 'readwrite');
  const cardStore = cardTx.objectStore(CARDS_STORE);
  for (const card of data.cards) {
    cardStore.put(card);
  }
  await new Promise((resolve, reject) => {
    cardTx.oncomplete = () => resolve();
    cardTx.onerror = () => reject(cardTx.error);
  });

  // Import settings
  if (data.settings) {
    const settingsTx = db.transaction(SETTINGS_STORE, 'readwrite');
    const settingsStore = settingsTx.objectStore(SETTINGS_STORE);
    for (const [key, value] of Object.entries(data.settings)) {
      settingsStore.put({ key, value });
    }
    await new Promise((resolve, reject) => {
      settingsTx.oncomplete = () => resolve();
      settingsTx.onerror = () => reject(settingsTx.error);
    });
  }

  return data.cards.length;
}

export async function clearAllData() {
  const db = await open();
  const cardTx = db.transaction(CARDS_STORE, 'readwrite');
  cardTx.objectStore(CARDS_STORE).clear();
  await new Promise((resolve, reject) => {
    cardTx.oncomplete = () => resolve();
    cardTx.onerror = () => reject(cardTx.error);
  });
}
