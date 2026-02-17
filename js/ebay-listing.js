// eBay listing flow — format picker, image upload, create + publish listing

import * as db from './db.js';
import { toast, showLoading, hideLoading, $, restoreModalDOM } from './ui.js';
import { isEbayConnected } from './ebay-auth.js';
import { processPhoto } from './camera.js';
import {
  uploadImage,
  getBusinessPolicies,
  createInventoryItem,
  createOffer,
  publishOffer,
  deleteInventoryItem,
  cleanupSku,
} from './ebay-api.js';

/**
 * Initialize eBay listing module — wire up batch button.
 */
export function initEbayListing() {
  const batchBtn = document.getElementById('btn-ebay-batch');
  if (batchBtn) {
    batchBtn.addEventListener('click', handleBatchListing);
  }
}

/**
 * Ensure the user has a zip code saved for the shipping location.
 * Prompts once; saved for all future listings.
 */
async function ensureZipCode() {
  let zip = await db.getSetting('sellerZipCode');
  if (zip) return true;
  zip = await promptForZipCode();
  if (!zip) return false;
  await db.setSetting('sellerZipCode', zip);
  return true;
}

/**
 * One-time prompt for the seller's zip code.
 */
function promptForZipCode() {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modal-overlay');
    const modal = overlay.querySelector('.modal');

    modal.innerHTML = `
      <h3>Shipping Location</h3>
      <p style="font-size:14px;color:var(--gray-400);margin-bottom:16px">Enter your zip code so eBay knows where items ship from.</p>
      <div class="form-group">
        <label for="zip-input">Zip Code</label>
        <input type="text" id="zip-input" inputmode="numeric" maxlength="5" placeholder="12345" style="font-size:18px;text-align:center;padding:8px">
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="zip-cancel">Cancel</button>
        <button class="btn btn-primary" id="zip-confirm">Save</button>
      </div>
    `;

    overlay.classList.remove('hidden');
    document.getElementById('zip-input').focus();

    document.getElementById('zip-cancel').addEventListener('click', () => {
      overlay.classList.add('hidden');
      restoreModalDOM();
      resolve(null);
    });

    document.getElementById('zip-confirm').addEventListener('click', () => {
      const zip = document.getElementById('zip-input').value.trim();
      if (/^\d{5}$/.test(zip)) {
        overlay.classList.add('hidden');
        restoreModalDOM();
        resolve(zip);
      } else {
        toast('Enter a valid 5-digit zip code', 'warning');
      }
    });
  });
}

/**
 * Show the format picker modal and start the listing flow for a single card.
 * @param {object} card - The card to list
 */
export async function listCardOnEbay(card) {
  const connected = await isEbayConnected();
  if (!connected) {
    toast('Connect to eBay in Settings first', 'warning');
    return;
  }

  // Ensure we have a zip code for the shipping location (one-time prompt)
  if (!(await ensureZipCode())) return;

  // If no images, prompt user to add photos first
  if (!card.imageBlob) {
    const added = await promptForPhotos(card);
    if (!added) return; // User cancelled
  }

  // Show format picker modal
  const result = await showFormatPicker(card.startPrice || 0.99);
  if (!result) return; // User cancelled

  try {
    await executeListingFlow(card, result.format, result.price);
  } catch (err) {
    hideLoading();
    console.error('[eBay] Listing failed:', err);
    toast('eBay listing failed: ' + err.message, 'error', 5000);
  }
}

/**
 * Show format picker modal.
 * Returns { format: 'AUCTION'|'FIXED_PRICE', price: number } or null if cancelled.
 * For auctions, price=0 means no Buy It Now (pure auction).
 */
function showFormatPicker(defaultPrice) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modal-overlay');
    const modal = overlay.querySelector('.modal');

    modal.innerHTML = `
      <h3>List on eBay</h3>
      <div class="format-picker">
        <div class="form-group">
          <label>Format</label>
          <div class="format-options">
            <label class="format-option">
              <input type="radio" name="ebay-format" value="FIXED_PRICE" checked>
              <span>Buy It Now</span>
            </label>
            <label class="format-option">
              <input type="radio" name="ebay-format" value="AUCTION">
              <span>Auction (7 days)</span>
            </label>
          </div>
          <p id="auction-note" style="display:none;font-size:12px;color:var(--gray-400);margin:4px 0 0">Bidding starts at $0.99. Buy It Now price is optional.</p>
        </div>
        <div class="form-group" id="ebay-price-group">
          <label for="ebay-price" id="ebay-price-label">Price ($)</label>
          <input type="number" id="ebay-price" step="0.01" value="${defaultPrice}" min="0.01">
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="ebay-cancel">Cancel</button>
        <button class="btn btn-primary" id="ebay-confirm">List It</button>
      </div>
    `;

    overlay.classList.remove('hidden');

    // Update UI when format changes
    document.querySelectorAll('input[name="ebay-format"]').forEach(radio => {
      radio.addEventListener('change', () => {
        const isAuction = document.querySelector('input[name="ebay-format"]:checked').value === 'AUCTION';
        document.getElementById('auction-note').style.display = isAuction ? 'block' : 'none';
        const priceInput = document.getElementById('ebay-price');
        if (isAuction) {
          document.getElementById('ebay-price-label').textContent = 'Buy It Now Price ($)';
          priceInput.placeholder = 'Optional';
          priceInput.value = '';
          priceInput.removeAttribute('min');
        } else {
          document.getElementById('ebay-price-label').textContent = 'Price ($)';
          priceInput.placeholder = '';
          priceInput.value = defaultPrice;
          priceInput.min = '0.01';
        }
      });
    });

    document.getElementById('ebay-cancel').addEventListener('click', () => {
      overlay.classList.add('hidden');
      restoreModalDOM();
      resolve(null);
    });

    document.getElementById('ebay-confirm').addEventListener('click', () => {
      const format = document.querySelector('input[name="ebay-format"]:checked').value;
      const price = parseFloat(document.getElementById('ebay-price').value) || 0;
      if (format === 'FIXED_PRICE' && price <= 0) {
        toast('Enter a price for Buy It Now', 'warning');
        return;
      }

      overlay.classList.add('hidden');
      restoreModalDOM();
      resolve({ format, price });
    });
  });
}

/**
 * Prompt user to add front (and optionally back) photos before listing.
 * Returns true if photos were added, false if cancelled.
 */
function promptForPhotos(card) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modal-overlay');
    const modal = overlay.querySelector('.modal');

    modal.innerHTML = `
      <h3>Add Photos</h3>
      <p style="font-size:14px;color:var(--gray-400);margin-bottom:16px">This card needs photos before listing on eBay.</p>
      <div class="photo-prompt-slots" style="display:flex;gap:12px;margin-bottom:16px">
        <div style="flex:1;text-align:center">
          <label style="display:flex;flex-direction:column;align-items:center;gap:8px;cursor:pointer;padding:16px;border:2px dashed var(--gray-500);border-radius:8px" id="photo-prompt-front-label">
            <img id="photo-prompt-front-preview" src="" style="display:none;max-height:120px;border-radius:4px">
            <span id="photo-prompt-front-text">&#128247; Front</span>
            <input type="file" accept="image/*" capture="environment" id="photo-prompt-front" style="display:none">
          </label>
        </div>
        <div style="flex:1;text-align:center">
          <label style="display:flex;flex-direction:column;align-items:center;gap:8px;cursor:pointer;padding:16px;border:2px dashed var(--gray-500);border-radius:8px" id="photo-prompt-back-label">
            <img id="photo-prompt-back-preview" src="" style="display:none;max-height:120px;border-radius:4px">
            <span id="photo-prompt-back-text">&#128247; Back (optional)</span>
            <input type="file" accept="image/*" capture="environment" id="photo-prompt-back" style="display:none">
          </label>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="photo-prompt-cancel">Cancel</button>
        <button class="btn btn-primary" id="photo-prompt-done" disabled>Continue</button>
      </div>
    `;

    overlay.classList.remove('hidden');

    let frontPhoto = null;
    let backPhoto = null;

    document.getElementById('photo-prompt-front').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        frontPhoto = await processPhoto(file);
        const preview = document.getElementById('photo-prompt-front-preview');
        preview.src = frontPhoto.thumbnailBase64;
        preview.style.display = 'block';
        document.getElementById('photo-prompt-front-text').textContent = 'Front added';
        document.getElementById('photo-prompt-done').disabled = false;
      } catch {
        toast('Failed to process photo', 'error');
      }
    });

    document.getElementById('photo-prompt-back').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        backPhoto = await processPhoto(file);
        const preview = document.getElementById('photo-prompt-back-preview');
        preview.src = backPhoto.thumbnailBase64;
        preview.style.display = 'block';
        document.getElementById('photo-prompt-back-text').textContent = 'Back added';
      } catch {
        toast('Failed to process photo', 'error');
      }
    });

    document.getElementById('photo-prompt-cancel').addEventListener('click', () => {
      overlay.classList.add('hidden');
      restoreModalDOM();
      resolve(false);
    });

    document.getElementById('photo-prompt-done').addEventListener('click', async () => {
      overlay.classList.add('hidden');
      restoreModalDOM();
      if (frontPhoto) {
        card.imageBlob = frontPhoto.imageBlob;
        card.imageThumbnail = frontPhoto.thumbnailBase64;
      }
      if (backPhoto) {
        card.imageBackBlob = backPhoto.imageBlob;
        card.imageBackThumb = backPhoto.thumbnailBase64;
      }
      card.lastModified = new Date().toISOString();
      await db.saveCard(card);
      resolve(true);
    });
  });
}

/**
 * Execute the full listing flow for a single card.
 * Throws on failure so callers can track success/failure.
 */
async function executeListingFlow(card, format, price) {
  const sku = card.id;

  // Check for images — prompt if missing
  if (!card.imageBlob && !card.imageBackBlob) {
    hideLoading();
    const added = await promptForPhotos(card);
    if (!added) throw new Error('No photos added');
  }

  showLoading('Uploading images...');

  // Step 1: Upload images
  console.log('[eBay] Step 1: Uploading images...');
  const imageUrls = [];
  if (card.imageBlob) {
    const frontUrl = await uploadImage(card.imageBlob);
    if (frontUrl) imageUrls.push(frontUrl);
    console.log('[eBay] Front image uploaded:', frontUrl);
  }
  if (card.imageBackBlob) {
    const backUrl = await uploadImage(card.imageBackBlob);
    if (backUrl) imageUrls.push(backUrl);
    console.log('[eBay] Back image uploaded:', backUrl);
  }

  if (imageUrls.length === 0) {
    hideLoading();
    throw new Error('Image upload failed. Check your eBay connection in Settings.');
  }

  // Step 2: Fetch business policies
  console.log('[eBay] Step 2: Fetching business policies...');
  showLoading('Checking business policies...');
  const policies = await getBusinessPolicies();
  console.log('[eBay] Policies:', JSON.stringify(policies));

  // Step 2.5: Clean up any stale offers/inventory from previous failed attempts
  console.log('[eBay] Cleaning up stale eBay state for SKU:', sku);
  showLoading('Preparing listing...');
  await cleanupSku(sku);

  // Step 3: Create inventory item
  console.log('[eBay] Step 3: Creating inventory item, SKU:', sku);
  showLoading('Creating inventory item...');
  await createInventoryItem(sku, card, imageUrls);
  console.log('[eBay] Inventory item created');

  // Step 4: Create offer
  console.log('[eBay] Step 4: Creating offer, format:', format, 'price:', price);
  showLoading('Creating offer...');
  let offerId;
  try {
    offerId = await createOffer(sku, card, format, price, policies);
    console.log('[eBay] Offer created:', offerId);
  } catch (err) {
    await deleteInventoryItem(sku);
    throw err;
  }

  // Step 5: Publish offer
  console.log('[eBay] Step 5: Publishing offer:', offerId);
  showLoading('Publishing listing...');
  let listingId;
  try {
    listingId = await publishOffer(offerId);
  } catch (err) {
    // Clean up on publish failure so next attempt starts completely fresh
    console.log('[eBay] Publish failed, cleaning up...');
    await deleteInventoryItem(sku);
    throw err;
  }
  console.log('[eBay] Published! Listing ID:', listingId);

  // Step 6: Update card with listing info
  card.status = 'listed';
  card.ebayListingId = listingId;
  card.ebayListingUrl = `https://www.ebay.com/itm/${listingId}`;
  card.lastModified = new Date().toISOString();
  await db.saveCard(card);

  hideLoading();
  toast(`Listed on eBay! Item #${listingId}`, 'success', 5000);
}

/**
 * Batch listing — list multiple selected cards sequentially.
 */
async function handleBatchListing() {
  const connected = await isEbayConnected();
  if (!connected) {
    toast('Connect to eBay in Settings first', 'warning');
    return;
  }

  // Ensure we have a zip code for the shipping location (one-time prompt)
  if (!(await ensureZipCode())) return;

  // Get selected card IDs from listing checkboxes
  const checkboxes = document.querySelectorAll('.listing-checkbox:checked');
  const selectedIds = Array.from(checkboxes).map(cb => cb.dataset.id);

  if (selectedIds.length === 0) {
    toast('Select cards to list on eBay', 'warning');
    return;
  }

  // Show format picker (applies to all cards in batch)
  const result = await showFormatPicker(0.99);
  if (!result) return;

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < selectedIds.length; i++) {
    showLoading(`Listing card ${i + 1} of ${selectedIds.length}...`);

    const card = await db.getCard(selectedIds[i]);
    if (!card) {
      failCount++;
      continue;
    }

    try {
      await executeListingFlow(card, result.format, result.price);
      successCount++;
    } catch (err) {
      hideLoading();
      toast(`Card ${i + 1} failed: ${err.message}`, 'error', 3000);
      failCount++;
    }
  }

  hideLoading();

  if (failCount > 0 && successCount > 0) {
    toast(`Listed ${successCount} of ${selectedIds.length} cards. ${failCount} failed.`, 'warning');
  } else if (successCount > 0) {
    toast(`All ${successCount} cards listed on eBay!`, 'success');
  }

  // Refresh listings view
  window.dispatchEvent(new CustomEvent('refresh-listings'));
}
