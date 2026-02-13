// Main app initialization, tab navigation, view routing, scan flow

import * as db from './db.js';
import { toast, showLoading, hideLoading, showView, goBack, formatDate, $, $$ } from './ui.js';
import { processPhoto } from './camera.js';
import { identifyCard } from './ai.js';
import { createCard, generateEbayTitle, cardDisplayName, cardDetailLine } from './card-model.js';
import { initListings, refreshListings } from './listing.js';
import { initCollection, refreshCollection } from './collection.js';
import { lookupComps } from './comps.js';
import { initSettings, refreshStats, getDefaults } from './settings.js';
import { initFirebase } from './firebase.js';
import { initAuth } from './auth.js';
import { initSyncListeners, pullAllCards } from './sync.js';
import { initEbayAuth, isEbayConnected, updateEbayUI } from './ebay-auth.js';
import { initEbayListing, listCardOnEbay } from './ebay-listing.js';
import { initDashboard, refreshDashboard } from './dashboard.js';

let currentMode = 'listing';
let currentCard = null; // Card being reviewed
let returnView = 'view-scan'; // Where to return after detail view

// Staged photos before identification
let stagedFront = null; // { fullBase64, thumbnailBase64, imageBlob, imageThumbnail }
let stagedBack = null;

// Batch scanning state
let batchMode = false;
let batchQueue = []; // Array of { photo, status: 'pending'|'identifying'|'done'|'error', card, error }

// ===== Initialization =====

document.addEventListener('DOMContentLoaded', async () => {
  // Tab navigation
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const viewId = `view-${tab.dataset.view}`;
      showView(viewId);

      // Refresh data when switching tabs
      if (tab.dataset.view === 'dashboard') refreshDashboard();
      if (tab.dataset.view === 'listings') refreshListings();
      if (tab.dataset.view === 'collection') refreshCollection();
      if (tab.dataset.view === 'settings') refreshStats();
    });
  });

  // Mode toggle
  $$('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMode = btn.dataset.mode;
    });
  });

  // Camera inputs (front + back)
  $('#camera-input-front').addEventListener('change', (e) => handleStagedPhoto(e, 'front'));
  $('#camera-input-back').addEventListener('change', (e) => handleStagedPhoto(e, 'back'));
  $('#scan-clear-front').addEventListener('click', () => clearStagedPhoto('front'));
  $('#scan-clear-back').addEventListener('click', () => clearStagedPhoto('back'));
  $('#btn-identify').addEventListener('click', handleIdentify);

  // Batch mode toggle
  $('#batch-mode-toggle').addEventListener('change', (e) => {
    batchMode = e.target.checked;
    const batchSection = document.getElementById('batch-queue-section');
    const scanArea = document.querySelector('.scan-area');
    if (batchMode) {
      batchSection.classList.remove('hidden');
      scanArea.classList.add('hidden');
    } else {
      batchSection.classList.add('hidden');
      scanArea.classList.remove('hidden');
      batchQueue = [];
      renderBatchQueue();
    }
  });

  // Batch file upload (multiple photos)
  $('#batch-file-input').addEventListener('change', handleBatchFileUpload);
  $('#btn-batch-identify').addEventListener('click', handleBatchIdentify);

  // Add back photo from review screen
  $('#review-add-back-input').addEventListener('change', handleReviewAddBack);

  // Review form events
  $('#review-back').addEventListener('click', () => goBack());
  $('#review-save').addEventListener('click', saveCurrentCard);
  $('#field-ebayTitle').addEventListener('input', updateCharCount);
  $('#btn-lookup-comps').addEventListener('click', handleCompLookup);
  $('#btn-check-sold').addEventListener('click', handleCheckSoldPrices);
  $('#btn-use-suggested').addEventListener('click', applySuggestedPrice);

  // Auto-generate eBay title when fields change
  const titleFields = ['field-year', 'field-brand', 'field-setName', 'field-subset',
    'field-player', 'field-cardNumber', 'field-parallel', 'field-attributes',
    'field-serialNumber', 'field-gradeCompany', 'field-gradeValue'];
  titleFields.forEach(id => {
    const el = $(`#${id}`);
    if (el) el.addEventListener('change', autoGenerateTitle);
  });

  // Graded toggle - disable grade fields when not graded
  $('#field-graded').addEventListener('change', (e) => {
    const isGraded = e.target.value === 'Yes';
    const companyEl = $('#field-gradeCompany');
    const gradeEl = $('#field-gradeValue');
    companyEl.disabled = !isGraded;
    gradeEl.disabled = !isGraded;
    companyEl.closest('.form-group').style.opacity = isGraded ? '1' : '0.4';
    gradeEl.closest('.form-group').style.opacity = isGraded ? '1' : '0.4';
    if (!isGraded) {
      companyEl.value = '';
      gradeEl.value = '';
    }
  });

  // Show/hide listing-specific fields based on mode
  // (handled in populateReviewForm)

  // Detail view events
  $('#detail-back').addEventListener('click', () => goBack());
  $('#detail-edit').addEventListener('click', editDetailCard);

  // Card detail event (from listings/collection)
  window.addEventListener('show-card-detail', async (e) => {
    const card = await db.getCard(e.detail.id);
    if (card) {
      showCardDetail(card);
    }
  });

  // Data imported event - refresh views
  window.addEventListener('data-imported', () => {
    refreshListings();
    refreshCollection();
    loadRecentScans();
  });

  // Initialize modules
  await initFirebase();
  initAuth();
  initSyncListeners();
  await initDashboard();
  await initListings();
  await initCollection();
  await initSettings();
  await loadRecentScans();

  // Appearance
  initDarkMode();

  // eBay integration
  initEbaySettings();
  await initEbayAuth();
  initEbayListing();

  // Update eBay UI on auth changes
  window.addEventListener('ebay-auth-changed', () => updateEbayUI());
  window.addEventListener('refresh-listings', () => refreshListings());
  window.addEventListener('refresh-collection', () => refreshCollection());

  // Service worker registration
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // Onboarding (first-run)
  await initOnboarding();

  // API key gate check
  await checkApiKeyGate();

  // Event delegation for recent scans
  $('#recent-scans-list').addEventListener('click', (e) => {
    const item = e.target.closest('.recent-scan-item');
    if (item) {
      window.dispatchEvent(new CustomEvent('show-card-detail', { detail: { id: item.dataset.id } }));
    }
  });

  // Sync conflict notification
  window.addEventListener('sync-conflict', (e) => {
    toast(e.detail.message, 'info', 4000);
  });

  // On sign-in, pull remote cards and refresh views
  window.addEventListener('auth-state-changed', async (e) => {
    if (e.detail.signedIn) {
      try {
        await pullAllCards();
        await refreshListings();
        await refreshCollection();
        await loadRecentScans();
        await refreshStats();
      } catch (err) {
        console.error('Sync on sign-in failed:', err);
      }
    }
  });
});

// ===== Photo Capture (staged front + back) =====

async function handleStagedPhoto(e, side) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';

  showLoading('Processing photo...');
  try {
    const photo = await processPhoto(file);
    hideLoading();

    if (side === 'front') {
      stagedFront = photo;
      $('#scan-preview-front').src = photo.thumbnailBase64;
      $('#scan-preview-front').classList.remove('hidden');
      $('#scan-clear-front').classList.remove('hidden');
    } else {
      stagedBack = photo;
      $('#scan-preview-back').src = photo.thumbnailBase64;
      $('#scan-preview-back').classList.remove('hidden');
      $('#scan-clear-back').classList.remove('hidden');
    }

    updateIdentifyButton();
  } catch (err) {
    hideLoading();
    toast('Failed to process photo: ' + err.message, 'error');
  }
}

function clearStagedPhoto(side) {
  if (side === 'front') {
    stagedFront = null;
    $('#scan-preview-front').classList.add('hidden');
    $('#scan-clear-front').classList.add('hidden');
  } else {
    stagedBack = null;
    $('#scan-preview-back').classList.add('hidden');
    $('#scan-clear-back').classList.add('hidden');
  }
  updateIdentifyButton();
}

function updateIdentifyButton() {
  const btn = $('#btn-identify');
  if (stagedFront) {
    btn.classList.remove('hidden');
    btn.textContent = stagedBack ? 'Identify Card (Front + Back)' : 'Identify Card';
  } else {
    btn.classList.add('hidden');
  }
}

async function handleIdentify() {
  if (!stagedFront) return;

  showLoading('Identifying card with AI...');

  let aiData = {};
  try {
    aiData = await identifyCard(
      stagedFront.fullBase64,
      stagedBack ? stagedBack.fullBase64 : null
    );
  } catch (aiErr) {
    hideLoading();
    toast(aiErr.message, 'error', 5000);
    aiData = {};
  }

  hideLoading();

  const defaults = await getDefaults();

  currentCard = createCard({
    mode: currentMode,
    sport: aiData.sport || defaults.sport,
    year: aiData.year || '',
    brand: aiData.brand || '',
    setName: aiData.setName || '',
    subset: aiData.subset || '',
    parallel: aiData.parallel || '',
    cardNumber: aiData.cardNumber || '',
    player: aiData.player || '',
    team: aiData.team || '',
    attributes: aiData.attributes || [],
    serialNumber: aiData.serialNumber || '',
    graded: aiData.graded || 'No',
    gradeCompany: aiData.gradeCompany || '',
    gradeValue: aiData.gradeValue || '',
    estimatedValueLow: null,
    estimatedValueHigh: null,
    condition: defaults.condition,
    startPrice: defaults.startPrice,
    imageBlob: stagedFront.imageBlob,
    imageThumbnail: stagedFront.thumbnailBase64,
    imageBackBlob: stagedBack ? stagedBack.imageBlob : null,
    imageBackThumb: stagedBack ? stagedBack.thumbnailBase64 : null
  });

  currentCard.ebayTitle = generateEbayTitle(currentCard);

  // Duplicate detection
  const existingCards = await db.getAllCards();
  const duplicate = existingCards.find(c =>
    c.player && currentCard.player &&
    c.player.toLowerCase() === currentCard.player.toLowerCase() &&
    c.year === currentCard.year &&
    c.brand === currentCard.brand &&
    c.setName === currentCard.setName &&
    c.cardNumber === currentCard.cardNumber &&
    (c.parallel || '') === (currentCard.parallel || '')
  );

  if (duplicate) {
    const { showModal } = await import('./ui.js');
    const choice = await showModal(
      'Possible Duplicate',
      `A card matching "${cardDisplayName(currentCard)}" already exists. What would you like to do?`,
      [
        { label: 'Add Anyway', value: 'add', class: 'btn-secondary' },
        { label: 'Update Existing', value: 'update', class: 'btn-primary' }
      ]
    );
    if (choice === 'update') {
      // Keep existing card's ID and images if new ones aren't better
      currentCard.id = duplicate.id;
      currentCard.dateAdded = duplicate.dateAdded;
      if (!currentCard.imageBlob && duplicate.imageBlob) {
        currentCard.imageBlob = duplicate.imageBlob;
        currentCard.imageThumbnail = duplicate.imageThumbnail;
      }
      if (!currentCard.imageBackBlob && duplicate.imageBackBlob) {
        currentCard.imageBackBlob = duplicate.imageBackBlob;
        currentCard.imageBackThumb = duplicate.imageBackThumb;
      }
    }
    // 'add' or null (dismissed) — proceed as new card
  }

  // Reset staged photos
  clearStagedPhoto('front');
  clearStagedPhoto('back');

  populateReviewForm(currentCard);
  showView('view-review');

  // Auto-fetch real sold prices in the background
  autoFetchSoldPrices(currentCard);
}

async function handleReviewAddBack(e) {
  const file = e.target.files[0];
  if (!file || !currentCard) return;
  e.target.value = '';

  showLoading('Processing back photo...');
  try {
    const photo = await processPhoto(file);
    hideLoading();

    currentCard.imageBackBlob = photo.imageBlob;
    currentCard.imageBackThumb = photo.thumbnailBase64;

    const backImg = $('#review-image-back');
    backImg.src = photo.imageBlob;
    backImg.classList.remove('hidden');
    $('#review-add-back-label').classList.add('hidden');

    toast('Back photo added', 'success');
  } catch (err) {
    hideLoading();
    toast('Failed to process photo: ' + err.message, 'error');
  }
}

// ===== Review Form =====

function populateReviewForm(card) {
  // Front image
  const frontImg = $('#review-image-front');
  if (card.imageBlob) {
    frontImg.src = card.imageBlob;
    frontImg.classList.remove('hidden');
  } else {
    frontImg.classList.add('hidden');
  }

  // Back image
  const backImg = $('#review-image-back');
  const addBackLabel = $('#review-add-back-label');
  if (card.imageBackBlob) {
    backImg.src = card.imageBackBlob;
    backImg.classList.remove('hidden');
    addBackLabel.classList.add('hidden');
  } else {
    backImg.classList.add('hidden');
    addBackLabel.classList.remove('hidden');
  }

  // Valuation badge
  const valuationBadge = $('#review-valuation-badge');
  if (card.estimatedValueLow && card.estimatedValueHigh) {
    const low = Number(card.estimatedValueLow).toFixed(2);
    const high = Number(card.estimatedValueHigh).toFixed(2);
    valuationBadge.textContent = `Est. Value: $${low} – $${high}`;
    valuationBadge.classList.remove('hidden');
  } else if (card.estimatedValueLow) {
    valuationBadge.textContent = `Est. Value: ~$${Number(card.estimatedValueLow).toFixed(2)}`;
    valuationBadge.classList.remove('hidden');
  } else {
    valuationBadge.classList.add('hidden');
  }

  // Fields
  $('#field-sport').value = card.sport || '';
  $('#field-year').value = card.year || '';
  $('#field-brand').value = card.brand || '';
  $('#field-setName').value = card.setName || '';
  $('#field-subset').value = card.subset || '';
  $('#field-parallel').value = card.parallel || '';
  $('#field-cardNumber').value = card.cardNumber || '';
  $('#field-serialNumber').value = card.serialNumber || '';
  $('#field-player').value = card.player || '';
  $('#field-team').value = card.team || '';
  $('#field-attributes').value = (card.attributes || []).join(', ');
  $('#field-graded').value = card.graded || 'No';
  $('#field-gradeCompany').value = card.gradeCompany || '';
  $('#field-gradeValue').value = card.gradeValue || '';
  $('#field-condition').value = card.condition || 'Near Mint or Better';
  $('#field-ebayTitle').value = card.ebayTitle || '';
  $('#field-startPrice').value = card.startPrice || '';
  $('#field-purchasePrice').value = card.purchasePrice || '';
  $('#field-notes').value = card.notes || '';

  // Comp fields
  if (card.compData && card.compData.low) {
    $('#field-compLow').value = card.compData.low;
    $('#field-compAvg').value = card.compData.avg;
    $('#field-compHigh').value = card.compData.high;
    $('#comp-results').classList.remove('hidden');
  } else {
    $('#field-compLow').value = '';
    $('#field-compAvg').value = '';
    $('#field-compHigh').value = '';
    $('#comp-results').classList.remove('hidden');
  }

  // Show/hide listing-specific fields
  const listingFields = $('#listing-fields');
  if (card.mode === 'collection') {
    listingFields.classList.add('hidden');
  } else {
    listingFields.classList.remove('hidden');
  }

  // Reset sold prices
  const soldResults = $('#sold-prices-results');
  if (soldResults) soldResults.classList.add('hidden');
  lastSoldStats = null;

  updateCharCount();
}

function readFormIntoCard() {
  if (!currentCard) return null;

  currentCard.sport = $('#field-sport').value;
  currentCard.year = $('#field-year').value.trim();
  currentCard.brand = $('#field-brand').value.trim();
  currentCard.setName = $('#field-setName').value.trim();
  currentCard.subset = $('#field-subset').value.trim();
  currentCard.parallel = $('#field-parallel').value.trim();
  currentCard.cardNumber = $('#field-cardNumber').value.trim();
  currentCard.serialNumber = $('#field-serialNumber').value.trim();
  currentCard.player = $('#field-player').value.trim();
  currentCard.team = $('#field-team').value.trim();
  currentCard.attributes = $('#field-attributes').value
    .split(',')
    .map(a => a.trim())
    .filter(Boolean);
  currentCard.graded = $('#field-graded').value;
  currentCard.gradeCompany = $('#field-gradeCompany').value;
  currentCard.gradeValue = $('#field-gradeValue').value.trim();
  currentCard.condition = $('#field-condition').value;
  currentCard.ebayTitle = $('#field-ebayTitle').value.trim();
  currentCard.startPrice = parseFloat($('#field-startPrice').value) || 0.99;
  currentCard.purchasePrice = parseFloat($('#field-purchasePrice').value) || null;
  currentCard.notes = $('#field-notes').value.trim();

  // Comp data
  const compLow = parseFloat($('#field-compLow').value);
  const compAvg = parseFloat($('#field-compAvg').value);
  const compHigh = parseFloat($('#field-compHigh').value);
  if (!isNaN(compLow) || !isNaN(compAvg) || !isNaN(compHigh)) {
    const hadComps = currentCard.compData && (currentCard.compData.low || currentCard.compData.avg || currentCard.compData.high);
    currentCard.compData = {
      low: isNaN(compLow) ? null : compLow,
      avg: isNaN(compAvg) ? null : compAvg,
      high: isNaN(compHigh) ? null : compHigh
    };
    // Set timestamp if comps are new or changed
    if (!hadComps || compLow !== currentCard.compData?.low) {
      currentCard.compLookedUpAt = currentCard.compLookedUpAt || new Date().toISOString();
    }
  }

  return currentCard;
}

async function saveCurrentCard() {
  const card = readFormIntoCard();
  if (!card) return;

  // Validation
  if (card.mode === 'listing' && !card.ebayTitle && !card.player) {
    toast('Please enter a player name or eBay title', 'warning');
    return;
  }
  if (card.mode === 'listing' && card.startPrice <= 0) {
    toast('Start price must be greater than $0', 'warning');
    return;
  }

  card.lastModified = new Date().toISOString();

  try {
    await db.saveCard(card);
    toast(`Card saved to ${card.mode === 'listing' ? 'listings' : 'collection'}`, 'success');

    // Refresh the appropriate view
    if (card.mode === 'listing') {
      await refreshListings();
    } else {
      await refreshCollection();
    }

    await loadRecentScans();
    goBack();
  } catch (err) {
    toast('Failed to save: ' + err.message, 'error');
  }
}

function autoGenerateTitle() {
  if (!currentCard) return;
  readFormIntoCard();
  const title = generateEbayTitle(currentCard);
  $('#field-ebayTitle').value = title;
  currentCard.ebayTitle = title;
  updateCharCount();
}

function updateCharCount() {
  const input = $('#field-ebayTitle');
  const count = $('#title-char-count');
  const len = input.value.length;
  count.textContent = `(${len}/80)`;
  count.style.color = len > 75 ? 'var(--danger)' : len > 60 ? 'var(--warning)' : 'var(--gray-400)';
}

// ===== Comp Lookup =====

async function handleCompLookup() {
  if (!currentCard) return;
  readFormIntoCard();

  showLoading('Looking up comps...');
  try {
    const result = await lookupComps(currentCard);
    hideLoading();

    if (result.success && result.data) {
      $('#comp-results').classList.remove('hidden');
      currentCard.compLookedUpAt = new Date().toISOString();
      toast('Comp data loaded', 'success');
    } else {
      // Opened in new tab
      $('#comp-results').classList.remove('hidden');
      currentCard.compLookedUpAt = new Date().toISOString();
      toast('Paste your comp results after checking 130point', 'info', 4000);
    }
  } catch (err) {
    hideLoading();
    toast('Comp lookup failed: ' + err.message, 'error');
  }
}

// ===== Recent Scans =====

let recentScansShown = 20;

async function loadRecentScans() {
  const all = await db.getAllCards();
  const sorted = all.sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded));
  const recent = sorted.slice(0, recentScansShown);

  const container = $('#recent-scans-list');

  if (recent.length === 0) {
    container.innerHTML = `<div class="empty-state-rich">
      <div class="empty-state-icon">&#128247;</div>
      <div class="empty-state-title">No cards scanned yet</div>
      <div class="empty-state-desc">Tap the camera above to snap a photo of any trading card and get started.</div>
    </div>`;
    return;
  }

  container.innerHTML = recent.map(card => `
    <div class="recent-scan-item" data-id="${card.id}">
      ${card.imageThumbnail
        ? `<img src="${card.imageThumbnail}" alt="Card">`
        : '<div style="width:48px;height:48px;background:var(--gray-100);border-radius:4px"></div>'}
      <div class="recent-scan-info">
        <div class="name">${escapeHtml(cardDisplayName(card))}</div>
        <div class="detail">${escapeHtml(cardDetailLine(card))} &middot; ${formatDate(card.dateAdded)}</div>
      </div>
      <span class="recent-scan-mode ${card.mode}">${card.mode === 'listing' ? 'List' : 'Collect'}</span>
    </div>
  `).join('');

  // Show "Load More" if there are more cards
  if (sorted.length > recentScansShown) {
    container.innerHTML += `<button class="btn btn-secondary btn-sm" id="btn-load-more-scans" style="align-self:center;margin-top:8px">Show More (${sorted.length - recentScansShown} remaining)</button>`;
    document.getElementById('btn-load-more-scans').addEventListener('click', () => {
      recentScansShown += 20;
      loadRecentScans();
    });
  }
}

// ===== Card Detail View =====

function showCardDetail(card) {
  const content = $('#detail-content');
  content.dataset.cardId = card.id;

  const fields = [
    ['Sport', card.sport],
    ['Year', card.year],
    ['Brand', card.brand],
    ['Set', card.setName],
    ['Subset', card.subset],
    ['Parallel', card.parallel],
    ['Card #', card.cardNumber],
    ['Player', card.player],
    ['Team', card.team],
    ['Attributes', (card.attributes || []).join(', ')],
    ['Serial #', card.serialNumber],
    ['Graded', card.graded === 'Yes' ? `${card.gradeCompany} ${card.gradeValue}` : 'No'],
    ['Condition', card.condition],
  ];

  if (card.estimatedValueLow && card.estimatedValueHigh) {
    fields.push(['Est. Value', `$${Number(card.estimatedValueLow).toFixed(2)} – $${Number(card.estimatedValueHigh).toFixed(2)}`]);
  } else if (card.estimatedValueLow) {
    fields.push(['Est. Value', `~$${Number(card.estimatedValueLow).toFixed(2)}`]);
  }

  if (card.purchasePrice) {
    fields.push(['Cost', `$${Number(card.purchasePrice).toFixed(2)}`]);
  }

  if (card.mode === 'listing') {
    fields.push(['eBay Title', card.ebayTitle]);
    fields.push(['Start Price', card.startPrice ? `$${Number(card.startPrice).toFixed(2)}` : '']);
  }

  if (card.soldPrice) {
    fields.push(['Sold For', `$${Number(card.soldPrice).toFixed(2)}`]);
    if (card.purchasePrice) {
      const profit = card.soldPrice - card.purchasePrice;
      const profitClass = profit >= 0 ? 'profit-positive' : 'profit-negative';
      fields.push(['Profit', `<span class="${profitClass}">${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}</span>`]);
    }
  }

  if (card.shippingStatus && card.shippingStatus !== 'not_shipped') {
    const statusLabel = card.shippingStatus === 'shipped' ? 'Shipped' : 'Delivered';
    let shippingStr = statusLabel;
    if (card.trackingNumber) {
      shippingStr += ` — ${card.shippingCarrier || ''} ${card.trackingNumber}`;
    }
    fields.push(['Shipping', shippingStr.trim()]);
  }

  if (card.compData && (card.compData.low || card.compData.avg || card.compData.high)) {
    const comp = [];
    if (card.compData.low) comp.push(`Low: $${card.compData.low}`);
    if (card.compData.avg) comp.push(`Avg: $${card.compData.avg}`);
    if (card.compData.high) comp.push(`High: $${card.compData.high}`);
    let compStr = comp.join(' | ');
    if (card.compLookedUpAt) {
      compStr += ` (${formatDate(card.compLookedUpAt)})`;
    }
    fields.push(['Comps', compStr]);
  }

  if (card.ebayListingId) {
    fields.push(['eBay', `<a href="${escapeHtml(card.ebayListingUrl || '')}" target="_blank">Item #${escapeHtml(card.ebayListingId)}</a>`]);
  }

  if (card.notes) {
    fields.push(['Notes', card.notes]);
  }

  if (card.mode === 'listing' && card.status && card.status !== 'pending') {
    fields.push(['Status', card.status.charAt(0).toUpperCase() + card.status.slice(1)]);
  }

  fields.push(['Added', formatDate(card.dateAdded)]);
  fields.push(['Mode', card.mode === 'listing' ? 'Listing' : 'Collection']);

  content.innerHTML = `
    <div class="detail-images">
      ${card.imageBlob
        ? `<img src="${card.imageBlob}" alt="Card front" class="detail-image">`
        : ''}
      ${card.imageBackBlob
        ? `<img src="${card.imageBackBlob}" alt="Card back" class="detail-image">`
        : ''}
    </div>
    <div class="detail-fields">
      ${fields
        .filter(([_, val]) => val)
        .map(([label, val]) => `
          <div class="detail-field">
            <span class="label">${label}</span>
            <span class="value">${label === 'eBay' ? val : escapeHtml(String(val))}</span>
          </div>
        `).join('')}
    </div>
    ${card.ebayListingId
      ? `<div class="ebay-listed-badge">Listed on eBay — <a href="${escapeHtml(card.ebayListingUrl || '')}" target="_blank">#${escapeHtml(card.ebayListingId)}</a></div>`
      : ''}
    <div class="detail-actions">
      ${card.mode === 'listing' && !card.ebayListingId
        ? '<button class="btn btn-ebay ebay-only hidden" id="detail-ebay-btn">List on eBay</button>'
        : ''}
      ${card.mode === 'listing' && card.status !== 'sold'
        ? '<button class="btn btn-success" id="detail-mark-sold-btn">Mark as Sold</button>'
        : ''}
      ${card.mode === 'listing' && card.status === 'sold'
        ? '<button class="btn btn-secondary" id="detail-mark-unsold-btn">Mark as Unsold</button>'
        : ''}
      ${card.status === 'sold' && card.shippingStatus !== 'delivered'
        ? `<button class="btn btn-secondary" id="detail-shipping-btn">${card.shippingStatus === 'shipped' ? 'Update Shipping' : 'Add Shipping'}</button>`
        : ''}
      <button class="btn btn-secondary" id="detail-move-btn">${card.mode === 'listing' ? 'Move to Collection' : 'Move to Listings'}</button>
      <button class="btn btn-danger" id="detail-delete-btn">Delete Card</button>
    </div>
  `;

  // eBay listing from detail
  const ebayBtn = document.getElementById('detail-ebay-btn');
  if (ebayBtn) {
    // Show/hide based on eBay connection status
    isEbayConnected().then(connected => {
      if (connected) ebayBtn.classList.remove('hidden');
    });
    ebayBtn.addEventListener('click', async () => {
      await listCardOnEbay(card);
      // Refresh detail view after listing
      const updatedCard = await db.getCard(card.id);
      if (updatedCard) showCardDetail(updatedCard);
    });
  }

  // Mark as Sold (prompt for sold price)
  const soldBtn = document.getElementById('detail-mark-sold-btn');
  if (soldBtn) {
    soldBtn.addEventListener('click', async () => {
      const { showModal: showSoldModal } = await import('./ui.js');
      // Create a custom modal with price input
      const overlay = document.getElementById('modal-overlay');
      document.getElementById('modal-title').textContent = 'Mark as Sold';
      document.getElementById('modal-message').textContent = '';
      const actionsContainer = document.getElementById('modal-actions');
      actionsContainer.innerHTML = '';

      // Build custom content
      const msgEl = document.getElementById('modal-message');
      msgEl.innerHTML = `
        <div class="form-group" style="margin-bottom:12px">
          <label style="font-size:13px;font-weight:500;color:var(--gray-600)">Sold Price ($)</label>
          <input type="number" id="modal-sold-price" step="0.01" placeholder="${card.startPrice || '0.00'}" value="${card.startPrice || ''}" style="padding:10px 12px;border:1px solid var(--gray-300);border-radius:8px;font-size:15px;width:100%;margin-top:4px">
        </div>
      `;

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-secondary btn-sm';
      cancelBtn.textContent = 'Cancel';
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'btn btn-success btn-sm';
      confirmBtn.textContent = 'Mark Sold';

      actionsContainer.appendChild(cancelBtn);
      actionsContainer.appendChild(confirmBtn);
      overlay.classList.remove('hidden');

      await new Promise(resolve => {
        cancelBtn.addEventListener('click', () => { overlay.classList.add('hidden'); resolve(); });
        confirmBtn.addEventListener('click', async () => {
          overlay.classList.add('hidden');
          const soldPrice = parseFloat(document.getElementById('modal-sold-price').value) || card.startPrice || 0;
          card.status = 'sold';
          card.soldPrice = soldPrice;
          card.lastModified = new Date().toISOString();
          await db.saveCard(card);
          toast('Card marked as sold', 'success');
          await refreshListings();
          showCardDetail(card);
          resolve();
        });
      });
    });
  }

  // Mark as Unsold
  const unsoldBtn = document.getElementById('detail-mark-unsold-btn');
  if (unsoldBtn) {
    unsoldBtn.addEventListener('click', async () => {
      card.status = 'unsold';
      card.lastModified = new Date().toISOString();
      await db.saveCard(card);
      toast('Card marked as unsold', 'success');
      await refreshListings();
      showCardDetail(card);
    });
  }

  // Move between modes
  const moveBtn = document.getElementById('detail-move-btn');
  if (moveBtn) {
    moveBtn.addEventListener('click', async () => {
      const newMode = card.mode === 'listing' ? 'collection' : 'listing';
      card.mode = newMode;
      card.lastModified = new Date().toISOString();
      await db.saveCard(card);
      toast(`Card moved to ${newMode === 'listing' ? 'listings' : 'collection'}`, 'success');
      await refreshListings();
      await refreshCollection();
      showCardDetail(card);
    });
  }

  // Shipping from detail
  const shippingBtn = document.getElementById('detail-shipping-btn');
  if (shippingBtn) {
    shippingBtn.addEventListener('click', async () => {
      const overlay = document.getElementById('modal-overlay');
      document.getElementById('modal-title').textContent = 'Shipping Details';
      const msgEl = document.getElementById('modal-message');
      msgEl.innerHTML = `
        <div class="form-group" style="margin-bottom:10px">
          <label style="font-size:13px;font-weight:500;color:var(--gray-600)">Carrier</label>
          <select id="modal-carrier" style="padding:10px 12px;border:1px solid var(--gray-300);border-radius:8px;font-size:15px;width:100%;margin-top:4px">
            <option value="USPS" ${card.shippingCarrier === 'USPS' ? 'selected' : ''}>USPS</option>
            <option value="UPS" ${card.shippingCarrier === 'UPS' ? 'selected' : ''}>UPS</option>
            <option value="FedEx" ${card.shippingCarrier === 'FedEx' ? 'selected' : ''}>FedEx</option>
            <option value="Other" ${card.shippingCarrier === 'Other' ? 'selected' : ''}>Other</option>
          </select>
        </div>
        <div class="form-group" style="margin-bottom:10px">
          <label style="font-size:13px;font-weight:500;color:var(--gray-600)">Tracking Number</label>
          <input type="text" id="modal-tracking" value="${escapeHtml(card.trackingNumber || '')}" placeholder="Tracking number" style="padding:10px 12px;border:1px solid var(--gray-300);border-radius:8px;font-size:15px;width:100%;margin-top:4px">
        </div>
        <div class="form-group">
          <label style="font-size:13px;font-weight:500;color:var(--gray-600)">Status</label>
          <select id="modal-ship-status" style="padding:10px 12px;border:1px solid var(--gray-300);border-radius:8px;font-size:15px;width:100%;margin-top:4px">
            <option value="shipped" ${card.shippingStatus === 'shipped' ? 'selected' : ''}>Shipped</option>
            <option value="delivered" ${card.shippingStatus === 'delivered' ? 'selected' : ''}>Delivered</option>
          </select>
        </div>
      `;
      const actionsContainer = document.getElementById('modal-actions');
      actionsContainer.innerHTML = '';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-secondary btn-sm';
      cancelBtn.textContent = 'Cancel';
      const saveBtn = document.createElement('button');
      saveBtn.className = 'btn btn-primary btn-sm';
      saveBtn.textContent = 'Save';
      actionsContainer.appendChild(cancelBtn);
      actionsContainer.appendChild(saveBtn);
      overlay.classList.remove('hidden');

      await new Promise(resolve => {
        cancelBtn.addEventListener('click', () => { overlay.classList.add('hidden'); resolve(); });
        saveBtn.addEventListener('click', async () => {
          overlay.classList.add('hidden');
          card.shippingCarrier = document.getElementById('modal-carrier').value;
          card.trackingNumber = document.getElementById('modal-tracking').value.trim();
          card.shippingStatus = document.getElementById('modal-ship-status').value;
          card.lastModified = new Date().toISOString();
          await db.saveCard(card);
          toast('Shipping info saved', 'success');
          showCardDetail(card);
          resolve();
        });
      });
    });
  }

  // Delete from detail (soft delete → trash)
  $('#detail-delete-btn').addEventListener('click', async () => {
    const { confirm: confirmFn } = await import('./ui.js');
    const confirmed = await confirmFn('Delete Card', 'Card will be moved to trash. You can restore it from Settings.');
    if (confirmed) {
      await db.softDeleteCard(card.id);
      toast('Card moved to trash', 'success');
      await refreshListings();
      await refreshCollection();
      await loadRecentScans();
      goBack();
    }
  });

  showView('view-detail');
}

function editDetailCard() {
  const cardId = $('#detail-content').dataset.cardId;
  if (!cardId) return;

  db.getCard(cardId).then(card => {
    if (!card) return;
    currentCard = card;
    populateReviewForm(card);
    showView('view-review');
  });
}

// ===== Sold Price Lookup =====

let lastSoldStats = null;

async function handleCheckSoldPrices() {
  if (!currentCard) return;
  readFormIntoCard();

  const workerUrl = await db.getSetting('ebayWorkerUrl');
  if (!workerUrl) {
    toast('Set your Worker URL in Settings first', 'warning');
    return;
  }

  // Build search query from card fields
  const parts = [];
  if (currentCard.year) parts.push(currentCard.year);
  if (currentCard.brand) parts.push(currentCard.brand);
  if (currentCard.setName) parts.push(currentCard.setName);
  if (currentCard.player) parts.push(currentCard.player);
  if (currentCard.parallel) parts.push(currentCard.parallel);
  if (currentCard.cardNumber) parts.push(`#${currentCard.cardNumber}`);

  const query = parts.join(' ');
  if (!query.trim()) {
    toast('Add card details first so we can search', 'warning');
    return;
  }

  showLoading('Checking sold prices...');

  try {
    const resp = await fetch(`${workerUrl}/sold-search?q=${encodeURIComponent(query)}`);
    hideLoading();

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      toast(err.error || 'Sold price search failed', 'error');
      return;
    }

    const data = await resp.json();
    displaySoldPrices(data);
  } catch (err) {
    hideLoading();
    toast('Cannot reach worker. Check Worker URL in Settings.', 'error');
  }
}

function displaySoldPrices(data) {
  const resultsEl = $('#sold-prices-results');
  const statsEl = $('#sold-prices-stats');
  const listEl = $('#sold-prices-list');

  if (!data.stats || data.stats.count === 0) {
    statsEl.innerHTML = '<p style="font-size:13px;color:var(--gray-500);text-align:center">No recent sold listings found for this card.</p>';
    listEl.innerHTML = '';
    resultsEl.classList.remove('hidden');
    $('#btn-use-suggested').classList.add('hidden');
    lastSoldStats = null;
    return;
  }

  const s = data.stats;
  lastSoldStats = s;

  statsEl.innerHTML = `
    <div class="sold-stat">
      <div class="sold-stat-value">$${s.low.toFixed(2)}</div>
      <div class="sold-stat-label">Low</div>
    </div>
    <div class="sold-stat">
      <div class="sold-stat-value">$${s.median.toFixed(2)}</div>
      <div class="sold-stat-label">Median</div>
    </div>
    <div class="sold-stat">
      <div class="sold-stat-value">$${s.average.toFixed(2)}</div>
      <div class="sold-stat-label">Average</div>
    </div>
    <div class="sold-stat suggested">
      <div class="sold-stat-value">$${s.median.toFixed(2)}</div>
      <div class="sold-stat-label">Suggested</div>
    </div>
  `;

  listEl.innerHTML = (data.items || []).map(item => `
    <div class="sold-item">
      <span class="sold-item-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span>
      <span class="sold-item-price">$${item.price.toFixed(2)}</span>
    </div>
  `).join('');

  resultsEl.classList.remove('hidden');
  $('#btn-use-suggested').classList.remove('hidden');
}

// Auto-fetch sold prices after scan (non-blocking)
async function autoFetchSoldPrices(card) {
  const workerUrl = await db.getSetting('ebayWorkerUrl');
  if (!workerUrl) return; // No worker configured, skip silently

  const parts = [];
  if (card.year) parts.push(card.year);
  if (card.brand) parts.push(card.brand);
  if (card.setName) parts.push(card.setName);
  if (card.player) parts.push(card.player);
  if (card.parallel) parts.push(card.parallel);
  if (card.cardNumber) parts.push(`#${card.cardNumber}`);

  const query = parts.join(' ');
  if (!query.trim()) return;

  try {
    const resp = await fetch(`${workerUrl}/sold-search?q=${encodeURIComponent(query)}`);
    if (!resp.ok) return;

    const data = await resp.json();
    if (!data.stats || data.stats.count === 0) return;

    // Use real sold data as the estimated value
    card.estimatedValueLow = data.stats.low;
    card.estimatedValueHigh = data.stats.high;

    // Update the valuation badge on the review screen
    const valuationBadge = $('#review-valuation-badge');
    if (valuationBadge) {
      const low = data.stats.low.toFixed(2);
      const high = data.stats.high.toFixed(2);
      const median = data.stats.median.toFixed(2);
      valuationBadge.innerHTML = `Sold: $${low} – $${high} (median $${median})<br><span style="font-size:11px;font-weight:400;opacity:0.85">Based on ${data.stats.count} recent sale${data.stats.count > 1 ? 's' : ''}</span>`;
      valuationBadge.classList.remove('hidden');
    }

    // Also populate the sold prices results section
    displaySoldPrices(data);

    // Auto-set suggested price for listings
    if (card.mode === 'listing' && data.stats.median) {
      card.startPrice = data.stats.median;
      $('#field-startPrice').value = data.stats.median.toFixed(2);
    }

    if (currentCard && currentCard.id === card.id) {
      currentCard.estimatedValueLow = card.estimatedValueLow;
      currentCard.estimatedValueHigh = card.estimatedValueHigh;
    }
  } catch {
    // Silently fail — user can still manually check sold prices
  }
}

function applySuggestedPrice() {
  if (!lastSoldStats || !lastSoldStats.median) return;
  $('#field-startPrice').value = lastSoldStats.median.toFixed(2);
  if (currentCard) {
    currentCard.startPrice = lastSoldStats.median;
  }
  toast(`Price set to $${lastSoldStats.median.toFixed(2)} (median sold)`, 'success');
}

// ===== Dark Mode =====

function initDarkMode() {
  const toggle = $('#setting-dark-mode');
  if (!toggle) return;

  // Apply saved preference (dark mode on by default)
  db.getSetting('darkMode').then(isDark => {
    if (isDark === false) {
      document.documentElement.removeAttribute('data-theme');
      toggle.checked = false;
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      toggle.checked = true;
    }
  });

  toggle.addEventListener('change', () => {
    if (toggle.checked) {
      document.documentElement.setAttribute('data-theme', 'dark');
      db.setSetting('darkMode', true);
      try { localStorage.setItem('cw_darkMode', 'true'); } catch {}
    } else {
      document.documentElement.removeAttribute('data-theme');
      db.setSetting('darkMode', false);
      try { localStorage.setItem('cw_darkMode', 'false'); } catch {}
    }
  });
}

// ===== eBay Settings =====

function initEbaySettings() {
  const workerUrlInput = $('#setting-ebay-worker-url');
  const clientIdInput = $('#setting-ebay-client-id');

  if (workerUrlInput) {
    // Load saved values
    db.getSetting('ebayWorkerUrl').then(val => {
      if (val) workerUrlInput.value = val;
    });
    workerUrlInput.addEventListener('change', () => {
      db.setSetting('ebayWorkerUrl', workerUrlInput.value.trim());
    });
  }

  if (clientIdInput) {
    db.getSetting('ebayClientId').then(val => {
      if (val) clientIdInput.value = val;
    });
    clientIdInput.addEventListener('change', () => {
      db.setSetting('ebayClientId', clientIdInput.value.trim());
    });
  }
}

// ===== Onboarding (First Run) =====

async function initOnboarding() {
  const hasLaunched = localStorage.getItem('cw_hasLaunched');
  if (hasLaunched) return;

  const overlay = $('#onboarding-overlay');
  overlay.classList.remove('hidden');

  $('#onboarding-setup-btn').addEventListener('click', () => {
    overlay.classList.add('hidden');
    localStorage.setItem('cw_hasLaunched', 'true');
    // Navigate to settings
    showView('view-settings');
    // Focus the API key input after a tick
    setTimeout(() => {
      const input = $('#setting-api-key');
      if (input) { input.focus(); input.scrollIntoView({ behavior: 'smooth' }); }
    }, 300);
  });

  $('#onboarding-skip-btn').addEventListener('click', () => {
    overlay.classList.add('hidden');
    localStorage.setItem('cw_hasLaunched', 'true');
  });
}

// ===== API Key Gate =====

async function checkApiKeyGate() {
  let apiKey = await db.getSetting('apiKey');
  if (!apiKey) {
    try { apiKey = localStorage.getItem('cw_apiKey'); } catch {}
  }

  const gate = $('#api-key-gate');
  const scanArea = document.querySelector('.scan-area');

  if (!apiKey) {
    gate.classList.remove('hidden');
    if (scanArea) scanArea.style.opacity = '0.4';
    if (scanArea) scanArea.style.pointerEvents = 'none';
  } else {
    gate.classList.add('hidden');
    if (scanArea) scanArea.style.opacity = '';
    if (scanArea) scanArea.style.pointerEvents = '';
  }

  $('#gate-go-settings').addEventListener('click', () => {
    showView('view-settings');
    setTimeout(() => {
      const input = $('#setting-api-key');
      if (input) { input.focus(); input.scrollIntoView({ behavior: 'smooth' }); }
    }, 300);
  });
}

// Re-check gate when returning to scan view
window.addEventListener('apikey-changed', () => checkApiKeyGate());

// ===== Batch Scanning =====

async function handleBatchFileUpload(e) {
  const files = Array.from(e.target.files);
  if (!files.length) return;
  e.target.value = '';

  showLoading(`Processing ${files.length} photo${files.length > 1 ? 's' : ''}...`);

  for (const file of files) {
    try {
      const photo = await processPhoto(file);
      batchQueue.push({
        photo,
        status: 'pending',
        card: null,
        error: null
      });
    } catch (err) {
      batchQueue.push({
        photo: null,
        status: 'error',
        card: null,
        error: 'Failed to process photo'
      });
    }
  }

  hideLoading();
  renderBatchQueue();
  updateBatchIdentifyButton();
}

function renderBatchQueue() {
  const container = document.getElementById('batch-queue');
  if (!container) return;

  if (batchQueue.length === 0) {
    container.innerHTML = '<p class="empty-state" style="padding:16px 0;font-size:13px">Upload photos of cards to scan in batch.</p>';
    return;
  }

  container.innerHTML = batchQueue.map((item, i) => {
    let statusHtml = '';
    let statusClass = '';
    if (item.status === 'pending') {
      statusHtml = 'Ready to scan';
    } else if (item.status === 'identifying') {
      statusHtml = 'Identifying...';
      statusClass = '';
    } else if (item.status === 'done') {
      statusHtml = item.card ? escapeHtml(item.card.player || 'Identified') : 'Done';
      statusClass = 'identified';
    } else if (item.status === 'error') {
      statusHtml = item.error || 'Error';
      statusClass = 'error';
    }

    const thumb = item.photo ? item.photo.thumbnailBase64 : '';
    return `
      <div class="batch-queue-item">
        ${thumb ? `<img src="${thumb}" alt="Card ${i + 1}">` : '<div style="width:48px;height:48px;background:var(--gray-100);border-radius:4px"></div>'}
        <span class="batch-queue-status ${statusClass}">${statusHtml}</span>
        <button class="btn btn-danger btn-sm batch-remove-btn" data-index="${i}" style="padding:4px 8px;font-size:11px">&times;</button>
      </div>
    `;
  }).join('');

  // Wire up remove buttons
  container.querySelectorAll('.batch-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index);
      batchQueue.splice(idx, 1);
      renderBatchQueue();
      updateBatchIdentifyButton();
    });
  });
}

function updateBatchIdentifyButton() {
  const btn = document.getElementById('btn-batch-identify');
  const pendingCount = batchQueue.filter(q => q.status === 'pending').length;
  btn.disabled = pendingCount === 0;
  btn.textContent = pendingCount > 0 ? `Identify All (${pendingCount})` : 'Identify All';
}

async function handleBatchIdentify() {
  const pending = batchQueue.filter(q => q.status === 'pending');
  if (pending.length === 0) return;

  const defaults = await getDefaults();
  let processed = 0;

  for (const item of pending) {
    if (!item.photo) continue;

    item.status = 'identifying';
    renderBatchQueue();

    try {
      const aiData = await identifyCard(item.photo.fullBase64, null);

      const card = createCard({
        mode: currentMode,
        sport: aiData.sport || defaults.sport,
        year: aiData.year || '',
        brand: aiData.brand || '',
        setName: aiData.setName || '',
        subset: aiData.subset || '',
        parallel: aiData.parallel || '',
        cardNumber: aiData.cardNumber || '',
        player: aiData.player || '',
        team: aiData.team || '',
        attributes: aiData.attributes || [],
        serialNumber: aiData.serialNumber || '',
        graded: aiData.graded || 'No',
        gradeCompany: aiData.gradeCompany || '',
        gradeValue: aiData.gradeValue || '',
        estimatedValueLow: null,
        estimatedValueHigh: null,
        condition: defaults.condition,
        startPrice: defaults.startPrice,
        imageBlob: item.photo.imageBlob,
        imageThumbnail: item.photo.thumbnailBase64
      });

      card.ebayTitle = generateEbayTitle(card);
      await db.saveCard(card);

      // Auto-fetch sold prices in background
      autoFetchSoldPrices(card);

      item.card = card;
      item.status = 'done';
      processed++;
    } catch (err) {
      item.status = 'error';
      item.error = err.message || 'AI identification failed';
    }

    renderBatchQueue();
    updateBatchIdentifyButton();
  }

  if (processed > 0) {
    toast(`${processed} card${processed > 1 ? 's' : ''} identified and saved`, 'success');
    await refreshListings();
    await refreshCollection();
    await loadRecentScans();
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
