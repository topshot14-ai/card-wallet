// eBay listing flow — format picker, image upload, create + publish listing

import * as db from './db.js';
import { toast, showLoading, hideLoading, $ } from './ui.js';
import { isEbayConnected } from './ebay-auth.js';
import { processPhoto } from './camera.js';
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
    toast('eBay listing failed: ' + err.message, 'error', 5000);
  }
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
      resolve(false);
    });

    document.getElementById('photo-prompt-done').addEventListener('click', async () => {
      overlay.classList.add('hidden');
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
    throw new Error('Image upload failed. Check your eBay connection in Settings.');
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
    await deleteInventoryItem(sku);
    throw err;
  }

  // Step 5: Publish offer
  showLoading('Publishing listing...');
  const listingId = await publishOffer(offerId);

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
