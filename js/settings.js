// Settings management: API key, preferences, data export/import

import * as db from './db.js';
import { toast, confirm, $ } from './ui.js';
import { signInWithEmail, signUpWithEmail, signInWithGoogle, signOut as authSignOut } from './auth.js';
import { pullAllCards } from './sync.js';

export async function initSettings() {
  // Load saved settings
  await loadSettings();

  // API Key
  const apiKeyInput = $('#setting-api-key');
  const toggleBtn = $('#btn-toggle-api-key');

  apiKeyInput.addEventListener('change', async () => {
    await db.setSetting('apiKey', apiKeyInput.value.trim());
    toast('API key saved', 'success');
  });

  toggleBtn.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      toggleBtn.textContent = 'Hide';
    } else {
      apiKeyInput.type = 'password';
      toggleBtn.textContent = 'Show';
    }
  });

  // Model
  $('#setting-model').addEventListener('change', async (e) => {
    await db.setSetting('model', e.target.value);
    toast('Model updated', 'success');
  });

  // Default sport
  $('#setting-default-sport').addEventListener('change', async (e) => {
    await db.setSetting('defaultSport', e.target.value);
  });

  // Default condition
  $('#setting-default-condition').addEventListener('change', async (e) => {
    await db.setSetting('defaultCondition', e.target.value);
  });

  // Default price
  $('#setting-default-price').addEventListener('change', async (e) => {
    await db.setSetting('defaultPrice', parseFloat(e.target.value) || 0.99);
  });

  // Export data
  $('#btn-export-data').addEventListener('click', async () => {
    try {
      const data = await db.exportAllData();
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `card-wallet-backup-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast('Data exported', 'success');
    } catch (e) {
      toast('Export failed: ' + e.message, 'error');
    }
  });

  // Import data
  $('#btn-import-data').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const count = await db.importData(data);
      toast(`Imported ${count} cards`, 'success');
      await refreshStats();
      // Trigger refresh of other views
      window.dispatchEvent(new CustomEvent('data-imported'));
    } catch (err) {
      toast('Import failed: ' + err.message, 'error');
    }

    // Reset file input
    e.target.value = '';
  });

  // Clear data
  $('#btn-clear-data').addEventListener('click', async () => {
    const confirmed = await confirm('Clear All Data', 'This will permanently delete all cards. This cannot be undone.');
    if (confirmed) {
      await db.clearAllData();
      toast('All data cleared', 'success');
      await refreshStats();
      window.dispatchEvent(new CustomEvent('data-imported'));
    }
  });

  // Auth buttons
  $('#btn-sign-in').addEventListener('click', async () => {
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    if (!email || !password) { toast('Enter email and password', 'warning'); return; }
    try {
      await signInWithEmail(email, password);
      toast('Signed in', 'success');
    } catch (err) {
      toast(err.message, 'error', 4000);
    }
  });

  $('#btn-create-account').addEventListener('click', async () => {
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    if (!email || !password) { toast('Enter email and password', 'warning'); return; }
    try {
      await signUpWithEmail(email, password);
      toast('Account created', 'success');
    } catch (err) {
      toast(err.message, 'error', 4000);
    }
  });

  $('#btn-google-sign-in').addEventListener('click', async () => {
    try {
      await signInWithGoogle();
    } catch (err) {
      toast(err.message, 'error', 4000);
    }
  });

  $('#btn-sign-out').addEventListener('click', async () => {
    await authSignOut();
    toast('Signed out', 'success');
  });

  $('#btn-sync-now').addEventListener('click', async () => {
    try {
      toast('Syncing...', 'info');
      await pullAllCards();
      toast('Sync complete', 'success');
      await refreshStats();
      window.dispatchEvent(new CustomEvent('data-imported'));
    } catch (err) {
      toast('Sync failed: ' + err.message, 'error');
    }
  });

  // Auth state listener — toggle signed-in/out UI
  window.addEventListener('auth-state-changed', (e) => {
    const { user, signedIn } = e.detail;
    if (signedIn) {
      showAccountState('signed-in');
      $('#auth-user-email').textContent = user.email || user.displayName || 'Signed In';
    } else {
      showAccountState('signed-out');
      $('#auth-email').value = '';
      $('#auth-password').value = '';
    }
  });

  // Set initial account state — auth listener will switch to signed-in if already authed
  showAccountState('signed-out');

  await refreshStats();
}

function showAccountState(state) {
  $('#auth-signed-out').classList.add('hidden');
  $('#auth-signed-in').classList.add('hidden');

  if (state === 'signed-in') {
    $('#auth-signed-in').classList.remove('hidden');
  } else {
    $('#auth-signed-out').classList.remove('hidden');
  }
}

async function loadSettings() {
  const apiKey = await db.getSetting('apiKey');
  if (apiKey) $('#setting-api-key').value = apiKey;

  const model = await db.getSetting('model');
  if (model) $('#setting-model').value = model;

  const defaultSport = await db.getSetting('defaultSport');
  if (defaultSport) $('#setting-default-sport').value = defaultSport;

  const defaultCondition = await db.getSetting('defaultCondition');
  if (defaultCondition) $('#setting-default-condition').value = defaultCondition;

  const defaultPrice = await db.getSetting('defaultPrice');
  if (defaultPrice) $('#setting-default-price').value = defaultPrice;
}

export async function refreshStats() {
  const all = await db.getAllCards();
  const listings = all.filter(c => c.mode === 'listing');
  const collection = all.filter(c => c.mode === 'collection');

  $('#stat-total').textContent = all.length;
  $('#stat-listings').textContent = listings.length;
  $('#stat-collection').textContent = collection.length;
}

export async function getDefaults() {
  return {
    sport: await db.getSetting('defaultSport') || '',
    condition: await db.getSetting('defaultCondition') || 'Near Mint or Better',
    startPrice: await db.getSetting('defaultPrice') || 0.99
  };
}
