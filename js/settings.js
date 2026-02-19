// Settings management: API key, preferences, data export/import

import * as db from './db.js';
import { toast, confirm, $, escapeHtml } from './ui.js';
import { signInWithEmail, signUpWithEmail, signInWithGoogle, resetPassword, signOut as authSignOut, getCurrentUser } from './auth.js';
import { pullAllCards, pullSettings, pushSettings, syncImages } from './sync.js';

export async function initSettings() {
  // Load saved settings
  await loadSettings();

  // API Key
  const apiKeyInput = $('#setting-api-key');
  const toggleBtn = $('#btn-toggle-api-key');

  let apiKeySaving = false;
  const saveApiKey = async () => {
    if (apiKeySaving) return;
    apiKeySaving = true;
    try {
      const key = apiKeyInput.value.trim();
      await db.setSetting('apiKey', key);
      try { localStorage.setItem('cw_apiKey', key); } catch {}
      toast('API key saved', 'success');
      window.dispatchEvent(new CustomEvent('apikey-changed'));
    } finally {
      apiKeySaving = false;
    }
  };

  // Save on blur (when user taps away)
  apiKeyInput.addEventListener('blur', saveApiKey);

  // Also save after user stops typing for 1.5 seconds
  let apiKeyTimer = null;
  apiKeyInput.addEventListener('input', () => {
    clearTimeout(apiKeyTimer);
    apiKeyTimer = setTimeout(saveApiKey, 1500);
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
    window.dispatchEvent(new CustomEvent('settings-changed'));
  });

  // Default sport
  $('#setting-default-sport').addEventListener('change', async (e) => {
    await db.setSetting('defaultSport', e.target.value);
    window.dispatchEvent(new CustomEvent('settings-changed'));
  });

  // Default condition
  $('#setting-default-condition').addEventListener('change', async (e) => {
    await db.setSetting('defaultCondition', e.target.value);
    window.dispatchEvent(new CustomEvent('settings-changed'));
  });

  // Default price
  $('#setting-default-price').addEventListener('change', async (e) => {
    await db.setSetting('defaultPrice', parseFloat(e.target.value) || 0.99);
    window.dispatchEvent(new CustomEvent('settings-changed'));
  });

  // Refresh all sold prices / comps
  $('#btn-refresh-comps').addEventListener('click', async () => {
    if (typeof refreshAllComps !== 'function') {
      toast('Refresh not available', 'error');
      return;
    }
    toast('Refreshing sold prices for all cards...', 'info');
    $('#btn-refresh-comps').disabled = true;
    $('#btn-refresh-comps').textContent = 'Refreshing...';
    try {
      await refreshAllComps(true);
      toast('Sold prices refreshed', 'success');
    } catch {
      toast('Refresh failed', 'error');
    }
    $('#btn-refresh-comps').disabled = false;
    $('#btn-refresh-comps').textContent = 'Refresh All Sold Prices';
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
    const rememberMe = $('#auth-remember-me')?.checked !== false;
    try {
      await signInWithEmail(email, password, rememberMe);
      toast('Signed in', 'success');
    } catch (err) {
      toast(err.message, 'error', 4000);
    }
  });

  $('#btn-create-account').addEventListener('click', async () => {
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    if (!email || !password) { toast('Enter email and password', 'warning'); return; }
    const rememberMe = $('#auth-remember-me')?.checked !== false;
    try {
      await signUpWithEmail(email, password, rememberMe);
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

  $('#btn-forgot-password').addEventListener('click', async () => {
    const email = $('#auth-email').value.trim();
    if (!email) { toast('Enter your email address first', 'warning'); return; }
    try {
      await resetPassword(email);
      toast('Password reset email sent. Check your inbox.', 'success', 4000);
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
      toast('Syncing settings...', 'info');
      await pushSettings();
      await pullSettings();
      await loadSettings();

      toast('Syncing cards...', 'info');
      await pullAllCards();

      toast('Syncing images...', 'info');
      const imgResult = await syncImages();

      await refreshStats();
      window.dispatchEvent(new CustomEvent('data-imported'));

      // Show detailed result
      const parts = ['Sync complete'];
      if (imgResult.uploaded > 0) parts.push(`${imgResult.uploaded} image(s) uploaded`);
      if (imgResult.downloaded > 0) parts.push(`${imgResult.downloaded} image(s) downloaded`);
      if (imgResult.errors > 0) {
        // Show first error message so user can see what went wrong
        const firstErr = imgResult.errorMessages?.[0] || 'unknown error';
        parts.push(`${imgResult.errors} error(s): ${firstErr}`);
      }
      toast(parts.join('. '), imgResult.errors > 0 ? 'warning' : 'success', 6000);
    } catch (err) {
      toast('Sync failed: ' + err.message, 'error');
    }
  });

  // Auth state listener — toggle signed-in/out UI and reload settings
  window.addEventListener('auth-state-changed', async (e) => {
    const { user, signedIn } = e.detail;
    if (signedIn) {
      showAccountState('signed-in');
      $('#auth-user-email').textContent = user.email || user.displayName || 'Signed In';
      // Sync settings: push local to cloud, then pull cloud to local
      await pushSettings();
      await pullSettings();
      await loadSettings();
      window.dispatchEvent(new CustomEvent('apikey-changed'));
    } else {
      showAccountState('signed-out');
      $('#auth-email').value = '';
      $('#auth-password').value = '';
    }
  });

  // Set initial account state — check current auth directly (event may have already fired)
  const user = getCurrentUser();
  if (user) {
    showAccountState('signed-in');
    $('#auth-user-email').textContent = user.email || user.displayName || 'Signed In';
  } else {
    showAccountState('signed-out');
  }

  // Trash management
  initTrash();

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
  let apiKey = await db.getSetting('apiKey');
  // Fall back to localStorage if IndexedDB lost the key
  if (!apiKey) {
    try { apiKey = localStorage.getItem('cw_apiKey'); } catch {}
    if (apiKey) await db.setSetting('apiKey', apiKey); // restore to IndexedDB
  }
  if (apiKey) $('#setting-api-key').value = apiKey;

  const model = await db.getSetting('model');
  if (model) $('#setting-model').value = model;

  const defaultSport = await db.getSetting('defaultSport');
  if (defaultSport) $('#setting-default-sport').value = defaultSport;

  const defaultCondition = await db.getSetting('defaultCondition');
  if (defaultCondition) $('#setting-default-condition').value = defaultCondition;

  const defaultPrice = await db.getSetting('defaultPrice');
  if (defaultPrice) $('#setting-default-price').value = defaultPrice;

  // eBay settings
  const ebayWorkerUrl = await db.getSetting('ebayWorkerUrl');
  if (ebayWorkerUrl) $('#setting-ebay-worker-url').value = ebayWorkerUrl;

  const ebayClientId = await db.getSetting('ebayClientId');
  if (ebayClientId) $('#setting-ebay-client-id').value = ebayClientId;

  const ebayRuName = await db.getSetting('ebayRuName');
  if (ebayRuName) $('#setting-ebay-runame').value = ebayRuName;
}

export async function refreshStats() {
  const all = await db.getAllCards(); // excludes deleted by default
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

// ===== Trash (Soft Delete) =====

function initTrash() {
  const restoreBtn = document.getElementById('btn-restore-all-trash');
  const emptyBtn = document.getElementById('btn-empty-trash');

  if (restoreBtn) {
    restoreBtn.addEventListener('click', async () => {
      const all = await db.getAllCards(true);
      const trashed = all.filter(c => c.status === 'deleted');
      for (const card of trashed) {
        card.status = 'pending';
        card.lastModified = new Date().toISOString();
        await db.saveCard(card);
      }
      toast(`${trashed.length} card(s) restored`, 'success');
      await refreshTrash();
      await refreshStats();
      window.dispatchEvent(new CustomEvent('data-imported'));
    });
  }

  if (emptyBtn) {
    emptyBtn.addEventListener('click', async () => {
      const confirmed = await confirm('Empty Trash', 'Permanently delete all trashed cards? This cannot be undone.');
      if (!confirmed) return;
      const all = await db.getAllCards(true);
      const trashed = all.filter(c => c.status === 'deleted');
      const ids = trashed.map(c => c.id);
      if (ids.length > 0) {
        await db.deleteCards(ids);
        toast(`${ids.length} card(s) permanently deleted`, 'success');
        await refreshTrash();
        await refreshStats();
      }
    });
  }

  refreshTrash();

  // Listen for trash changes
  window.addEventListener('trash-changed', () => refreshTrash());
}

export async function refreshTrash() {
  const all = await db.getAllCards(true); // include deleted
  const trashed = all.filter(c => c.status === 'deleted');

  const emptyMsg = document.getElementById('trash-empty-msg');
  const listEl = document.getElementById('trash-list');
  const actionsEl = document.getElementById('trash-actions');

  if (!listEl) return;

  if (trashed.length === 0) {
    if (emptyMsg) emptyMsg.classList.remove('hidden');
    listEl.innerHTML = '';
    if (actionsEl) actionsEl.classList.add('hidden');
    return;
  }

  if (emptyMsg) emptyMsg.classList.add('hidden');
  if (actionsEl) actionsEl.classList.remove('hidden');

  listEl.innerHTML = trashed.map(card => {
    const name = card.player || card.ebayTitle || 'Unknown Card';
    const date = card.lastModified ? new Date(card.lastModified).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    return `
      <div class="trash-item" data-id="${card.id}">
        <span class="trash-item-name">${escapeHtml(name)}</span>
        <span class="trash-item-date">${date}</span>
        <button class="btn btn-sm btn-secondary trash-restore-btn" data-id="${card.id}">Restore</button>
      </div>
    `;
  }).join('');

  // Restore individual cards
  listEl.querySelectorAll('.trash-restore-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = await db.getCard(btn.dataset.id);
      if (card) {
        card.status = 'pending';
        card.lastModified = new Date().toISOString();
        await db.saveCard(card);
        toast('Card restored', 'success');
        await refreshTrash();
        await refreshStats();
        window.dispatchEvent(new CustomEvent('data-imported'));
      }
    });
  });
}

