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

  // eBay condition descriptors — required for trading cards (category 261328)
  // These are SEPARATE from product.aspects — they use numeric IDs
  // Ref: https://developer.ebay.com/api-docs/user-guides/static/mip-user-guide/mip-enum-condition-descriptor-ids-for-trading-cards.html
  const conditionDescriptors = [];

  if (card.graded === 'Yes') {
    aspects['Graded'] = ['Yes'];

    // Professional Grader (27501) — required for graded cards
    const graderMap = {
      'PSA': '275010', 'BCCG': '275011', 'BVG': '275012', 'BGS': '275013',
      'Beckett': '275013', 'CSG': '275014', 'CGC': '275015', 'SGC': '275016',
      'KSA': '275017', 'GMA': '275018', 'HGA': '275019',
    };
    conditionDescriptors.push({
      name: '27501',
      values: [graderMap[card.gradeCompany] || '2750123'], // 2750123 = Other
    });

    // Grade (27502) — required for graded cards
    // IDs: 275020=10, 275021=9.5, 275022=9, ..., 2750218=1
    const gradeMap = {
      '10': '275020', '9.5': '275021', '9': '275022', '8.5': '275023',
      '8': '275024', '7.5': '275025', '7': '275026', '6.5': '275027',
      '6': '275028', '5.5': '275029', '5': '2750210', '4.5': '2750211',
      '4': '2750212', '3.5': '2750213', '3': '2750214', '2.5': '2750215',
      '2': '2750216', '1.5': '2750217', '1': '2750218',
      'Authentic': '2750219',
    };
    conditionDescriptors.push({
      name: '27502',
      values: [gradeMap[card.gradeValue] || '275020'], // Default to 10
    });
  } else {
    aspects['Graded'] = ['No'];

    // Card Condition (40001) — required for ungraded cards
    // 400010=NM+, 400011=Excellent, 400012=Very Good, 400013=Poor
    const ungradedCondMap = {
      'Near Mint or Better': '400010',
      'Excellent': '400011',
      'Very Good': '400012',
      'Good': '400012',
      'Fair': '400013',
      'Poor': '400013',
    };
    conditionDescriptors.push({
      name: '40001',
      values: [ungradedCondMap[card.condition] || '400010'],
    });
  }

  // LIKE_NEW = Graded (2750), USED_VERY_GOOD = Ungraded (4000)
  const conditionEnum = card.graded === 'Yes' ? 'LIKE_NEW' : 'USED_VERY_GOOD';

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
    conditionDescriptors,
    product: {
      title,
      description: descParts.join(' | '),
      aspects,
      imageUrls: imageUrls,
    },
  };

  console.log('[eBay] createInventoryItem body:', JSON.stringify(body, null, 2));

  // Retry once on 500 (eBay transient errors)
  let resp;
  for (let attempt = 0; attempt < 2; attempt++) {
    resp = await ebayFetch(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    if (resp.status !== 500) break;
    if (attempt === 0) {
      console.log('[eBay] Got 500, retrying in 2s...');
      await new Promise(r => setTimeout(r, 2000));
    }
  }

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
 * Ensure a merchant location exists and return its key.
 * First checks for existing locations, then creates one if needed.
 */
async function ensureMerchantLocation() {
  if (ensureMerchantLocation._key) return ensureMerchantLocation._key;

  // Step 1: Check for existing locations
  try {
    const resp = await ebayFetch('/sell/inventory/v1/location?limit=5');
    if (resp.ok) {
      const data = await resp.json();
      console.log('[eBay] GET locations response:', JSON.stringify(data));
      if (data.locations && data.locations.length > 0) {
        const key = data.locations[0].merchantLocationKey;
        console.log('[eBay] Found existing location:', key);
        ensureMerchantLocation._key = key;
        return key;
      }
    }
  } catch (e) {
    console.warn('[eBay] Could not fetch locations:', e.message);
  }

  // Step 2: No existing locations — try creating one
  // eBay may require postalCode and other address fields
  const body = {
    location: {
      address: {
        postalCode: '00000',
        country: 'US',
      },
    },
    merchantLocationStatus: 'ENABLED',
    name: 'Default',
  };

  console.log('[eBay] Creating location with body:', JSON.stringify(body));
  const createResp = await ebayFetch('/sell/inventory/v1/location/default', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (createResp.status === 204 || createResp.status === 200 || createResp.status === 409) {
    console.log('[eBay] Location created: default');
    ensureMerchantLocation._key = 'default';
    return 'default';
  }

  const errBody = await createResp.json().catch(() => ({}));
  console.error('[eBay] Location creation failed:', createResp.status, JSON.stringify(errBody, null, 2));

  // If creation failed, try without merchantLocationKey and hope eBay uses seller's address
  console.warn('[eBay] Will try offer without location key');
  ensureMerchantLocation._key = '';
  return '';
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
  // Ensure merchant location exists (eBay requires Item.Country)
  const locationKey = await ensureMerchantLocation();

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

  if (locationKey) {
    body.merchantLocationKey = locationKey;
  }

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

    // If offer already exists (from a previous failed attempt), delete it and retry
    if (firstError?.errorId === 25002) {
      const existingId = firstError.parameters?.find(p => p.name === 'offerId')?.value;
      if (existingId) {
        console.log('[eBay] Deleting stale offer:', existingId);
        await ebayFetch(`/sell/inventory/v1/offer/${existingId}`, { method: 'DELETE' });
        // Retry creating a fresh offer
        const retryResp = await ebayFetch('/sell/inventory/v1/offer', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (retryResp.ok) {
          const retryData = await retryResp.json();
          console.log('[eBay] Fresh offer created:', retryData.offerId);
          return retryData.offerId;
        }
      }
    }

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
