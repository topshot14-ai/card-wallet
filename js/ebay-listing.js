// eBay listing flow — format picker, image upload, create + publish listing

import * as db from './db.js';
import { toast, showLoading, hideLoading, $ } from './ui.js';
import { isEbayConnected } from './ebay-auth.js';
import {
  uploadImage,
  getBusinessPolicies,
  createInventoryItem,
  createOffer,
  publishOffer,
  deleteInventoryItem,
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
 * Show the format picker modal and start the listing flow for a single card.
 * @param {object} card - The card to list
 */
export async function listCardOnEbay(card) {
  const connected = await isEbayConnected();
  if (!connected) {
    toast('Connect to eBay in Settings first', 'warning');
    return;
  }

  // Show format picker modal
  const result = await showFormatPicker(card.startPrice || 0.99);
  if (!result) return; // User cancelled

  await executeListingFlow(card, result.format, result.price);
}

/**
 * Show format picker modal.
 * Returns { format: 'AUCTION'|'FIXED_PRICE', price: number } or null if cancelled.
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
              <input type="radio" name="ebay-format" value="AUCTION" checked>
              <span>Auction (7 days)</span>
            </label>
            <label class="format-option">
              <input type="radio" name="ebay-format" value="FIXED_PRICE">
              <span>Buy It Now</span>
            </label>
          </div>
        </div>
        <div class="form-group">
          <label for="ebay-price">Price ($)</label>
          <input type="number" id="ebay-price" step="0.01" value="${defaultPrice}" min="0.01">
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="ebay-cancel">Cancel</button>
        <button class="btn btn-primary" id="ebay-confirm">List It</button>
      </div>
    `;

    overlay.classList.remove('hidden');

    document.getElementById('ebay-cancel').addEventListener('click', () => {
      overlay.classList.add('hidden');
      resolve(null);
    });

    document.getElementById('ebay-confirm').addEventListener('click', () => {
      const format = document.querySelector('input[name="ebay-format"]:checked').value;
      const price = parseFloat(document.getElementById('ebay-price').value) || 0.99;
      overlay.classList.add('hidden');
      resolve({ format, price });
    });
  });
}

/**
 * Execute the full listing flow for a single card.
 */
async function executeListingFlow(card, format, price) {
  const sku = card.id;

  showLoading('Uploading images...');
  try {
    // Step 1: Upload images
    const imageUrls = [];
    if (card.imageBlob) {
      const frontUrl = await uploadImage(card.imageBlob);
      if (frontUrl) imageUrls.push(frontUrl);
    }
    if (card.imageBackBlob) {
      const backUrl = await uploadImage(card.imageBackBlob);
      if (backUrl) imageUrls.push(backUrl);
    }

    if (imageUrls.length === 0) {
      hideLoading();
      toast('No images to upload. Add a photo first.', 'error');
      return;
    }

    // Step 2: Fetch business policies
    showLoading('Checking business policies...');
    const policies = await getBusinessPolicies();

    // Step 3: Create inventory item
    showLoading('Creating inventory item...');
    await createInventoryItem(sku, card, imageUrls);

    // Step 4: Create offer
    showLoading('Creating offer...');
    let offerId;
    try {
      offerId = await createOffer(sku, card, format, price, policies);
    } catch (err) {
      // Clean up inventory item on offer failure
      await deleteInventoryItem(sku);
      throw err;
    }

    // Step 5: Publish offer
    showLoading('Publishing listing...');
    let listingId;
    try {
      listingId = await publishOffer(offerId);
    } catch (err) {
      // Leave as draft on eBay, inform user
      hideLoading();
      toast('Listing saved as draft on eBay. Check Seller Hub to publish.', 'warning', 5000);
      return;
    }

    // Step 6: Update card with listing info
    card.status = 'listed';
    card.ebayListingId = listingId;
    card.ebayListingUrl = `https://www.ebay.com/itm/${listingId}`;
    card.lastModified = new Date().toISOString();
    await db.saveCard(card);

    hideLoading();

    const toastMsg = `Listed on eBay! Item #${listingId}`;
    toast(toastMsg, 'success', 5000);

  } catch (err) {
    hideLoading();
    toast('eBay listing failed: ' + err.message, 'error', 5000);
  }
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
      await executeListingFlow(card, result.format, card.startPrice || result.price);
      successCount++;
    } catch {
      failCount++;
    }
  }

  hideLoading();

  if (failCount > 0) {
    toast(`Listed ${successCount} of ${selectedIds.length} cards. ${failCount} failed.`, 'warning');
  } else {
    toast(`All ${successCount} cards listed on eBay!`, 'success');
  }

  // Refresh listings view
  window.dispatchEvent(new CustomEvent('refresh-listings'));
}
