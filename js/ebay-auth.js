// eBay OAuth authentication flow
// Handles sign-in, token exchange, refresh, and disconnect

import { getSetting, setSetting } from './db.js';
import { toast } from './ui.js';

// Toggle between sandbox and production eBay environments
const SANDBOX = false;
const EBAY_AUTH_URL = SANDBOX
  ? 'https://auth.sandbox.ebay.com/oauth2/authorize'
  : 'https://auth.ebay.com/oauth2/authorize';
const SCOPES = [
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
];

/**
 * Initialize eBay auth on page load.
 * Checks for OAuth callback code in URL and wires up buttons.
 */
export async function initEbayAuth() {
  // Check for OAuth callback
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');

  if (code) {
    // Remove code from URL to prevent re-processing on reload
    const cleanUrl = window.location.origin + window.location.pathname;
    window.history.replaceState({}, document.title, cleanUrl);

    try {
      await exchangeCodeForTokens(code);
      toast('eBay connected successfully', 'success');
    } catch (err) {
      toast('eBay connection failed: ' + err.message, 'error', 5000);
    }
  }

  updateEbayUI();

  // Wire up buttons
  const signInBtn = document.getElementById('btn-ebay-sign-in');
  const disconnectBtn = document.getElementById('btn-ebay-disconnect');

  if (signInBtn) signInBtn.addEventListener('click', startEbaySignIn);
  if (disconnectBtn) disconnectBtn.addEventListener('click', disconnectEbay);
}

/**
 * Start the eBay OAuth sign-in flow — redirects user to eBay.
 */
async function startEbaySignIn() {
  const workerUrl = await getSetting('ebayWorkerUrl');
  const clientId = await getSetting('ebayClientId');

  if (!workerUrl || !clientId) {
    toast('Enter your Worker URL and eBay Client ID first', 'warning');
    return;
  }

  const ruName = await getSetting('ebayRuName');
  if (!ruName) {
    toast('Enter your eBay RuName in Settings first', 'warning');
    return;
  }

  const authUrl = new URL(EBAY_AUTH_URL);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', ruName);
  authUrl.searchParams.set('scope', SCOPES.join(' '));

  window.location.href = authUrl.toString();
}

/**
 * Exchange authorization code for access + refresh tokens via Worker.
 */
async function exchangeCodeForTokens(code) {
  const workerUrl = await getSetting('ebayWorkerUrl');
  if (!workerUrl) throw new Error('Worker URL not configured');

  const ruName = await getSetting('ebayRuName');
  if (!ruName) throw new Error('eBay RuName not configured');

  const resp = await fetch(`${workerUrl}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: ruName,
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Token exchange failed (${resp.status})`);
  }

  const data = await resp.json();
  await storeTokens(data);
}

/**
 * Store tokens in IndexedDB.
 */
async function storeTokens(tokenData) {
  await setSetting('ebayAccessToken', tokenData.access_token);
  await setSetting('ebayRefreshToken', tokenData.refresh_token);

  // Calculate expiry: expires_in is in seconds
  const expiryMs = Date.now() + (tokenData.expires_in * 1000) - 60000; // 1 min buffer
  await setSetting('ebayTokenExpiry', expiryMs);

  // Try to extract username from token response (may not always be present)
  if (tokenData.token_type) {
    await setSetting('ebayConnected', true);
  }

  window.dispatchEvent(new CustomEvent('ebay-auth-changed'));
}

/**
 * Get a valid eBay access token, auto-refreshing if expired.
 * @returns {string|null} Access token or null if not connected.
 */
export async function getEbayAccessToken() {
  const token = await getSetting('ebayAccessToken');
  if (!token) return null;

  const expiry = await getSetting('ebayTokenExpiry');
  if (expiry && Date.now() < expiry) {
    return token;
  }

  // Token expired — try refresh
  return refreshAccessToken();
}

/**
 * Refresh the access token using the refresh token.
 */
async function refreshAccessToken() {
  const workerUrl = await getSetting('ebayWorkerUrl');
  const refreshToken = await getSetting('ebayRefreshToken');

  if (!workerUrl || !refreshToken) {
    await clearTokens();
    return null;
  }

  try {
    const resp = await fetch(`${workerUrl}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });

    if (!resp.ok) {
      await clearTokens();
      toast('eBay session expired. Please reconnect.', 'warning');
      return null;
    }

    const data = await resp.json();
    await storeTokens(data);
    return data.access_token;
  } catch (err) {
    toast('Cannot reach eBay proxy. Check Worker URL in Settings.', 'error');
    return null;
  }
}

/**
 * Check if eBay is connected (has stored tokens).
 */
export async function isEbayConnected() {
  const token = await getSetting('ebayAccessToken');
  const refresh = await getSetting('ebayRefreshToken');
  return !!(token && refresh);
}

/**
 * Disconnect from eBay — clear all stored tokens.
 */
export async function disconnectEbay() {
  await clearTokens();
  toast('eBay disconnected', 'success');
  updateEbayUI();
}

async function clearTokens() {
  await setSetting('ebayAccessToken', null);
  await setSetting('ebayRefreshToken', null);
  await setSetting('ebayTokenExpiry', null);
  await setSetting('ebayConnected', null);
  window.dispatchEvent(new CustomEvent('ebay-auth-changed'));
}

/**
 * Update the eBay settings UI to reflect connection state.
 */
export async function updateEbayUI() {
  const connected = await isEbayConnected();
  const disconnectedEl = document.getElementById('ebay-disconnected');
  const connectedEl = document.getElementById('ebay-connected');

  if (disconnectedEl) {
    disconnectedEl.classList.toggle('hidden', connected);
  }
  if (connectedEl) {
    connectedEl.classList.toggle('hidden', !connected);
  }

  // Show/hide eBay listing buttons throughout the app
  document.querySelectorAll('.ebay-only').forEach(el => {
    el.classList.toggle('hidden', !connected);
  });
}
