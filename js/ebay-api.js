// eBay API client — all calls go through the Cloudflare Worker proxy

import { getSetting, setSetting } from './db.js';
import { getEbayAccessToken } from './ebay-auth.js';

let cachedPolicies = null;

/**
 * Make an authenticated request to eBay via the Worker proxy.
 * Retries once on 401 after refreshing the token.
 */
async function ebayFetch(path, options = {}) {
  const workerUrl = await getSetting('ebayWorkerUrl');
  if (!workerUrl) throw new Error('Worker URL not configured. Set it in Settings.');

  let token = await getEbayAccessToken();
  if (!token) throw new Error('Not connected to eBay. Sign in via Settings.');

  const url = `${workerUrl}/ebay${path}`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    ...options.headers,
  };

  console.log('[eBay] Request:', options.method || 'GET', url);
  let resp = await fetch(url, { ...options, headers });
  console.log('[eBay] Response:', resp.status, resp.statusText);

  // Retry once on 401 (token may have expired between check and use)
  if (resp.status === 401) {
    console.log('[eBay] 401 — refreshing token and retrying...');
    // Force refresh by clearing expiry
    await setSetting('ebayTokenExpiry', 0);
    token = await getEbayAccessToken();
    if (!token) throw new Error('Please reconnect eBay in Settings.');
    headers['Authorization'] = `Bearer ${token}`;
    resp = await fetch(url, { ...options, headers });
    console.log('[eBay] Retry response:', resp.status, resp.statusText);
  }

  return resp;
}

/**
 * Upload a base64 image to eBay image hosting via the Worker.
 * @param {string} base64DataUri - Full data URI (data:image/jpeg;base64,...)
 * @returns {string} eBay-hosted image URL
 */
export async function uploadImage(base64DataUri) {
  const workerUrl = await getSetting('ebayWorkerUrl');
  if (!workerUrl) throw new Error('Worker URL not configured');

  const token = await getEbayAccessToken();
  if (!token) throw new Error('Not connected to eBay');

  const resp = await fetch(`${workerUrl}/image-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base64Data: base64DataUri,
      accessToken: token,
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Image upload failed (${resp.status})`);
  }

  const data = await resp.json();
  const url = data.imageUrl || data.image_url || data.ImageUrl;
  if (!url) {
    throw new Error('eBay did not return an image URL');
  }
  return url;
}

/**
 * Fetch business policies (payment, return, fulfillment).
 * Cached after first successful call.
 */
export async function getBusinessPolicies() {
  if (cachedPolicies) return cachedPolicies;

  const resp = await ebayFetch('/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US');
  if (!resp.ok) {
    throw new Error('Missing business policies. Set up shipping/payment/returns in eBay Seller Hub first.');
  }
  const fulfillment = await resp.json();

  const returnResp = await ebayFetch('/sell/account/v1/return_policy?marketplace_id=EBAY_US');
  if (!returnResp.ok) {
    throw new Error('Missing return policies. Set up returns in eBay Seller Hub first.');
  }
  const returns = await returnResp.json();

  const paymentResp = await ebayFetch('/sell/account/v1/payment_policy?marketplace_id=EBAY_US');
  if (!paymentResp.ok) {
    throw new Error('Missing payment policies. Set up payment in eBay Seller Hub first.');
  }
  const payment = await paymentResp.json();

  cachedPolicies = {
    fulfillmentPolicyId: fulfillment.fulfillmentPolicies?.[0]?.fulfillmentPolicyId || null,
    returnPolicyId: returns.returnPolicies?.[0]?.returnPolicyId || null,
    paymentPolicyId: payment.paymentPolicies?.[0]?.paymentPolicyId || null,
  };

  if (!cachedPolicies.fulfillmentPolicyId || !cachedPolicies.returnPolicyId || !cachedPolicies.paymentPolicyId) {
    throw new Error('Missing business policies. Set up shipping/payment/returns in eBay Seller Hub first.');
  }

  return cachedPolicies;
}

/**
 * Create (or update) an inventory item on eBay.
 * @param {string} sku - Unique SKU (we use the card ID)
 * @param {object} card - Card data
 * @param {string[]} imageUrls - eBay-hosted image URLs
 */
export async function createInventoryItem(sku, card, imageUrls) {
  const aspects = {};
  if (card.sport) aspects['Sport'] = [card.sport];
  if (card.player) aspects['Player/Athlete'] = [card.player];
  if (card.team) aspects['Team'] = [card.team];
  if (card.brand) aspects['Manufacturer'] = [card.brand];
  if (card.setName) aspects['Set'] = [card.setName];
  if (card.year) aspects['Season'] = [card.year];
  if (card.cardNumber) aspects['Card Number'] = [card.cardNumber];
  if (card.parallel) aspects['Parallel/Variety'] = [card.parallel];

  const features = [];
  if (card.attributes && card.attributes.length > 0) features.push(...card.attributes);
  if (card.subset && card.subset.toLowerCase() !== 'base') features.push(card.subset);
  if (features.length > 0) aspects['Features'] = features;

  if (card.graded === 'Yes') {
    aspects['Graded'] = ['Yes'];
    if (card.gradeCompany) aspects['Professional Grader'] = [card.gradeCompany];
    if (card.gradeValue) aspects['Grade'] = [card.gradeValue];
  } else {
    aspects['Graded'] = ['No'];
  }

  // eBay Sell Inventory API requires ConditionEnum strings, not numeric IDs
  const conditionEnumMap = {
    'Near Mint or Better': 'LIKE_NEW',
    'Excellent': 'USED_EXCELLENT',
    'Very Good': 'USED_VERY_GOOD',
    'Good': 'USED_GOOD',
    'Fair': 'USED_ACCEPTABLE',
    'Poor': 'USED_ACCEPTABLE',
  };
  const conditionEnum = card.graded === 'Yes' ? 'LIKE_NEW' : (conditionEnumMap[card.condition] || 'LIKE_NEW');

  // Build description
  const descParts = [`${card.year || ''} ${card.brand || ''} ${card.setName || ''}`.trim()];
  if (card.player) descParts.push(`Player: ${card.player}`);
  if (card.team) descParts.push(`Team: ${card.team}`);
  if (card.cardNumber) descParts.push(`Card #${card.cardNumber}`);
  if (card.parallel) descParts.push(`Parallel: ${card.parallel}`);
  if (card.serialNumber) descParts.push(`Serial: ${card.serialNumber}`);
  if (card.condition) descParts.push(`Condition: ${card.condition}`);

  // Ensure title is valid and within 80 char limit
  let title = card.ebayTitle || `${card.year || ''} ${card.brand || ''} ${card.player || ''}`.trim();
  if (!title) title = 'Sports Trading Card';
  if (title.length > 80) title = title.substring(0, 80);

  const body = {
    availability: {
      shipToLocationAvailability: {
        quantity: 1,
      },
    },
    condition: conditionEnum,
    conditionDescription: card.condition || '',
    product: {
      title,
      description: descParts.join(' | '),
      aspects,
      imageUrls: imageUrls,
    },
  };

  console.log('[eBay] createInventoryItem body:', JSON.stringify(body, null, 2));

  const resp = await ebayFetch(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });

  // PUT returns 204 on success (create or update)
  if (resp.status !== 204 && resp.status !== 200) {
    const errBody = await resp.json().catch(() => ({}));
    console.error('[eBay] Inventory item error:', JSON.stringify(errBody, null, 2));
    const firstError = errBody.errors?.[0];
    const detail = firstError?.longMessage || firstError?.message || `HTTP ${resp.status}`;
    throw new Error(detail);
  }
}

/**
 * Create an offer for an inventory item.
 * @param {string} sku - The inventory item SKU
 * @param {object} card - Card data
 * @param {string} format - 'AUCTION' or 'FIXED_PRICE'
 * @param {number} price - Listing price
 * @param {object} policyIds - Business policy IDs
 * @returns {string} offerId
 */
export async function createOffer(sku, card, format, price, policyIds) {
  const body = {
    sku,
    marketplaceId: 'EBAY_US',
    format,
    categoryId: '261328', // Sports Trading Card Singles
    listingPolicies: {
      fulfillmentPolicyId: policyIds.fulfillmentPolicyId,
      returnPolicyId: policyIds.returnPolicyId,
      paymentPolicyId: policyIds.paymentPolicyId,
    },
  };

  if (format === 'AUCTION') {
    body.pricingSummary = {
      auctionStartPrice: { value: String(price), currency: 'USD' },
    };
    body.listingDuration = 'DAYS_7';
  } else {
    body.pricingSummary = {
      price: { value: String(price), currency: 'USD' },
    };
  }

  const resp = await ebayFetch('/sell/inventory/v1/offer', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({}));
    console.error('[eBay] Create offer error:', JSON.stringify(errBody, null, 2));
    const firstError = errBody.errors?.[0];
    const detail = firstError?.longMessage || firstError?.message || `HTTP ${resp.status}`;
    throw new Error(detail);
  }

  const data = await resp.json();
  return data.offerId;
}

/**
 * Publish an offer — makes it live on eBay.
 * @param {string} offerId
 * @returns {string} eBay listing ID
 */
export async function publishOffer(offerId) {
  const resp = await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`, {
    method: 'POST',
  });

  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({}));
    console.error('[eBay] Publish offer error:', JSON.stringify(errBody, null, 2));
    const firstError = errBody.errors?.[0];
    const detail = firstError?.longMessage || firstError?.message || `HTTP ${resp.status}`;
    throw new Error(detail);
  }

  const data = await resp.json();
  return data.listingId;
}

/**
 * Delete an inventory item (cleanup on error).
 */
export async function deleteInventoryItem(sku) {
  try {
    await ebayFetch(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
      method: 'DELETE',
    });
  } catch {
    // Best-effort cleanup
  }
}
