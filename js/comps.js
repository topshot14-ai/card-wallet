// 130point.com comp lookup

import { buildSearchQuery } from './card-model.js';
import { toast } from './ui.js';

const COMP_BASE_URL = 'https://www.130point.com/sales';
const COMP_API_URL = 'https://back.130point.com/sales/';

/**
 * Look up comps for a card.
 * Tier 1 (default): Copy query to clipboard + open 130point in new tab.
 * Tier 2: Attempt direct fetch (will likely fail due to CORS).
 */
export async function lookupComps(card) {
  const query = buildSearchQuery(card);

  // Tier 2: Try direct API fetch first
  try {
    const data = await fetchComps(query);
    if (data) {
      return { success: true, data, query };
    }
  } catch (e) {
    // Expected to fail due to CORS, fall through to Tier 1
  }

  // Tier 1: Copy to clipboard + open in new tab
  await copyAndOpen(query);
  return { success: false, query };
}

async function fetchComps(query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(COMP_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) return null;

    const data = await response.json();
    return data;
  } catch (e) {
    clearTimeout(timeout);
    return null;
  }
}

async function copyAndOpen(query) {
  // Copy query to clipboard
  try {
    await navigator.clipboard.writeText(query);
    toast('Search query copied to clipboard', 'success');
  } catch (e) {
    // Fallback: use textarea trick
    const textarea = document.createElement('textarea');
    textarea.value = query;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      toast('Search query copied to clipboard', 'success');
    } catch (e2) {
      toast('Could not copy query: ' + query, 'warning', 5000);
    }
    document.body.removeChild(textarea);
  }

  // Open 130point in new tab
  const url = `${COMP_BASE_URL}`;
  window.open(url, '_blank');
}
