// Main app initialization, tab navigation, view routing, scan flow

import * as db from './db.js';
import { toast, showLoading, hideLoading, showView, goBack, formatDate, $, $$, escapeHtml } from './ui.js';
import { processPhoto } from './camera.js';
import { identifyCard } from './ai.js';
import { createCard, generateEbayTitle, cardDisplayName, cardDetailLine } from './card-model.js';
import { initListings, refreshListings } from './listing.js';
import { initCollection, refreshCollection } from './collection.js';
import { initSettings, refreshStats, getDefaults } from './settings.js';
import { initFirebase } from './firebase.js';
import { initAuth } from './auth.js';
import { initSyncListeners, pullAllCards, pullSettings, pushSettings } from './sync.js';
import { initEbayAuth, isEbayConnected, updateEbayUI } from './ebay-auth.js';
import { initEbayListing, listCardOnEbay } from './ebay-listing.js';
import { initDashboard, refreshDashboard } from './dashboard.js';
import { showScanner, autoEnhance } from './scanner.js';

let currentMode = 'listing';
let currentCard = null; // Card being reviewed

// Staged photos before identification
let stagedFront = null; // { fullBase64, thumbnailBase64, imageBlob, imageThumbnail }
let stagedBack = null;
// Used by review screen to re-add photos


// Scan queue (unified single + multi-card flow)
let scanQueue = []; // Array of { photo, backPhoto, status, card, error }

// ===== Initialization =====

document.addEventListener('DOMContentLoaded', async () => {
  // Tab navigation
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const viewId = `view-${tab.dataset.view}`;
      showView(viewId);

      // Notify which view is now active (used by listings auto-refresh)
      window.dispatchEvent(new CustomEvent('view-changed', { detail: { view: viewId } }));

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

  // Manual entry button
  $('#btn-manual-entry').addEventListener('click', handleManualEntry);

  // Scan wizard — unified step-by-step flow
  $('#camera-input-front').addEventListener('change', handleScanFront);
  $('#camera-input-back').addEventListener('change', handleScanBack);
  $('#btn-skip-back').addEventListener('click', handleSkipBack);
  $('#btn-identify-now').addEventListener('click', handleIdentifyNow);
  $('#btn-scan-more').addEventListener('click', handleScanMore);
  $('#gallery-upload').addEventListener('change', handleGalleryUpload);
  $('#btn-identify-all').addEventListener('click', handleIdentifyAll);

  // Add front/back photo from review screen
  $('#review-add-front-input').addEventListener('change', handleReviewAddFront);
  $('#review-add-back-input').addEventListener('change', handleReviewAddBack);

  // Review form events
  $('#review-back').addEventListener('click', () => goBack());
  $('#review-save').addEventListener('click', saveCurrentCard);
  $('#field-ebayTitle').addEventListener('input', updateCharCount);
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

  // Pull to refresh (mobile gesture)
  initPullToRefresh();

  // Global search
  initGlobalSearch();

  // Onboarding (first-run)
  await initOnboarding();

  // Demo banner — show if demo cards exist
  if (localStorage.getItem('cw_hasDemo') === 'true') {
    const allCards = await db.getAllCards();
    if (allCards.some(c => c.isDemo === true)) {
      document.getElementById('demo-banner').classList.remove('hidden');
    } else {
      localStorage.removeItem('cw_hasDemo');
    }
  }

  // Demo clear button
  document.getElementById('demo-clear-btn').addEventListener('click', clearDemoCards);

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

  // Background comp refresher — fetch sold prices for all cards periodically
  initCompRefresher();

  // On sign-in, pull remote cards and refresh views
  window.addEventListener('auth-state-changed', async (e) => {
    if (e.detail.signedIn) {
      try {
        await pushSettings();  // push local settings to cloud first
        await pullSettings();  // then pull anything missing from cloud
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

// ===== Scan Wizard (unified single + multi-card flow) =====

function resetScanWizard() {
  stagedFront = null;
  stagedBack = null;

  // Show step 1, hide step 2 and ready prompt
  document.getElementById('scan-step-front').classList.remove('hidden');
  document.getElementById('scan-step-back').classList.add('hidden');
  document.getElementById('scan-step-ready').classList.add('hidden');

  // Clear previews
  const fp = document.getElementById('scan-preview-front');
  fp.classList.add('hidden');
  fp.src = '';
  document.querySelector('#scan-slot-front .scan-btn').style.display = '';

  const bp = document.getElementById('scan-preview-back');
  bp.classList.add('hidden');
  bp.src = '';
  document.querySelector('#scan-slot-back .scan-btn').style.display = '';

  // Reset file inputs
  document.getElementById('camera-input-front').value = '';
  document.getElementById('camera-input-back').value = '';
}

async function handleScanFront(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';

  showLoading('Processing front...');
  try {
    stagedFront = await processPhoto(file);
    hideLoading();

    // Scanner step — enhance eBay listing image
    const scanResult = await showScanner(stagedFront.fullBase64);
    if (scanResult.enhanced) {
      stagedFront.fullBase64 = scanResult.fullBase64;
      stagedFront.imageBlob = scanResult.imageBlob;
    }

    // Show preview
    const preview = document.getElementById('scan-preview-front');
    preview.src = stagedFront.thumbnailBase64;
    preview.classList.remove('hidden');
    document.querySelector('#scan-slot-front .scan-btn').style.display = 'none';

    // Move to step 2
    document.getElementById('scan-step-back').classList.remove('hidden');
  } catch (err) {
    hideLoading();
    toast('Failed to process photo: ' + err.message, 'error');
  }
}

async function handleScanBack(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';

  showLoading('Processing back...');
  try {
    stagedBack = await processPhoto(file);
    hideLoading();

    // Scanner step — enhance eBay listing image
    const scanResult = await showScanner(stagedBack.fullBase64);
    if (scanResult.enhanced) {
      stagedBack.fullBase64 = scanResult.fullBase64;
      stagedBack.imageBlob = scanResult.imageBlob;
    }

    // Show preview
    const preview = document.getElementById('scan-preview-back');
    preview.src = stagedBack.thumbnailBase64;
    preview.classList.remove('hidden');
    document.querySelector('#scan-slot-back .scan-btn').style.display = 'none';

    // Auto-advance to ready prompt
    setTimeout(showReadyPrompt, 300);
  } catch (err) {
    hideLoading();
    toast('Failed to process photo: ' + err.message, 'error');
  }
}

function handleSkipBack() {
  stagedBack = null;
  showReadyPrompt();
}

function showReadyPrompt() {
  document.getElementById('scan-step-front').classList.add('hidden');
  document.getElementById('scan-step-back').classList.add('hidden');
  document.getElementById('scan-step-ready').classList.remove('hidden');

  // Update the "Identify" button label based on queue
  const btn = document.getElementById('btn-identify-now');
  const pending = scanQueue.filter(q => q.status === 'pending').length;
  btn.textContent = pending > 0 ? `Identify All (${pending + 1})` : 'Identify Card';
}

function handleScanMore() {
  if (!stagedFront) return;

  // Add to queue
  scanQueue.push({
    photo: stagedFront,
    backPhoto: stagedBack,
    status: 'pending',
    card: null,
    error: null
  });

  renderScanQueue();
  updateIdentifyAllButton();

  // Show queue section
  document.getElementById('scan-queue-section').classList.remove('hidden');

  toast(`Card queued (${scanQueue.filter(q => q.status === 'pending').length} ready)`, 'success');

  // Reset wizard for next card
  resetScanWizard();
}

async function handleIdentifyNow() {
  if (!stagedFront) return;

  // If there are queued cards, add this one and identify all
  if (scanQueue.filter(q => q.status === 'pending').length > 0) {
    scanQueue.push({
      photo: stagedFront,
      backPhoto: stagedBack,
      status: 'pending',
      card: null,
      error: null
    });
    resetScanWizard();
    renderScanQueue();
    await handleIdentifyAll();
    return;
  }

  // Single card — identify and go to review
  showLoading('Identifying card with AI...');

  let aiData = {};
  try {
    aiData = await identifyCard(
      stagedFront.apiBase64,
      stagedBack ? stagedBack.apiBase64 : null,
      (status) => showLoading(status)
    );
  } catch (aiErr) {
    hideLoading();
    toast(aiErr.message, 'error', 5000);
    aiData = {};
  }

  hideLoading();

  if (aiData._fallback) {
    toast('Haiku struggled — used Sonnet for better accuracy', 'info', 3000);
    delete aiData._fallback;
  }

  // Parallel validation notification
  if (aiData._parallelNeedsReview) {
    toast(`"${aiData._parallelNeedsReview}" isn't a known ${aiData.setName || ''} parallel — please fill in`, 'warning', 5000);
    delete aiData._parallelNeedsReview;
  }

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
  }

  resetScanWizard();
  populateReviewForm(currentCard);
  showView('view-review');
  autoFetchSoldPrices(currentCard);
}

// ===== Manual Card Entry (no AI needed) =====

async function handleManualEntry() {
  const defaults = await getDefaults();

  currentCard = createCard({
    mode: currentMode,
    sport: defaults.sport,
    condition: defaults.condition,
    startPrice: defaults.startPrice,
    estimatedValueLow: null,
    estimatedValueHigh: null
  });

  currentCard.ebayTitle = '';
  populateReviewForm(currentCard);
  showView('view-review');
}

async function handleReviewAddFront(e) {
  const file = e.target.files[0];
  if (!file || !currentCard) return;
  e.target.value = '';

  showLoading('Processing photo...');
  try {
    const photo = await processPhoto(file);
    hideLoading();

    // Scanner step — enhance eBay listing image
    const scanResult = await showScanner(photo.fullBase64);
    if (scanResult.enhanced) {
      photo.fullBase64 = scanResult.fullBase64;
      photo.imageBlob = scanResult.imageBlob;
    }

    currentCard.imageBlob = photo.imageBlob;
    currentCard.imageThumbnail = photo.thumbnailBase64;

    const frontImg = $('#review-image-front');
    frontImg.src = photo.imageBlob;
    frontImg.classList.remove('hidden');
    $('#review-add-front-label').classList.add('hidden');

    toast('Photo added', 'success');
  } catch (err) {
    hideLoading();
    toast('Failed to process photo: ' + err.message, 'error');
  }
}

async function handleReviewAddBack(e) {
  const file = e.target.files[0];
  if (!file || !currentCard) return;
  e.target.value = '';

  showLoading('Processing back photo...');
  try {
    const photo = await processPhoto(file);
    hideLoading();

    // Scanner step — enhance eBay listing image
    const scanResult = await showScanner(photo.fullBase64);
    if (scanResult.enhanced) {
      photo.fullBase64 = scanResult.fullBase64;
      photo.imageBlob = scanResult.imageBlob;
    }

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
  const addFrontLabel = $('#review-add-front-label');
  if (card.imageBlob) {
    frontImg.src = card.imageBlob;
    frontImg.classList.remove('hidden');
    addFrontLabel.classList.add('hidden');
  } else {
    frontImg.classList.add('hidden');
    addFrontLabel.classList.remove('hidden');
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
  // Sync graded field disabled state
  const isGraded = (card.graded || 'No') === 'Yes';
  $('#field-gradeCompany').disabled = !isGraded;
  $('#field-gradeValue').disabled = !isGraded;
  $('#field-gradeCompany').closest('.form-group').style.opacity = isGraded ? '1' : '0.4';
  $('#field-gradeValue').closest('.form-group').style.opacity = isGraded ? '1' : '0.4';
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
    $('#comp-results').classList.add('hidden');
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
  const purchaseVal = parseFloat($('#field-purchasePrice').value);
  currentCard.purchasePrice = isNaN(purchaseVal) ? null : purchaseVal;
  currentCard.notes = $('#field-notes').value.trim();

  // Comp data
  const compLow = parseFloat($('#field-compLow').value);
  const compAvg = parseFloat($('#field-compAvg').value);
  const compHigh = parseFloat($('#field-compHigh').value);
  if (!isNaN(compLow) || !isNaN(compAvg) || !isNaN(compHigh)) {
    const oldLow = currentCard.compData?.low;
    const hadComps = currentCard.compData && (oldLow || currentCard.compData.avg || currentCard.compData.high);
    currentCard.compData = {
      low: isNaN(compLow) ? null : compLow,
      avg: isNaN(compAvg) ? null : compAvg,
      high: isNaN(compHigh) ? null : compHigh
    };
    // Set timestamp if comps are new or changed
    if (!hadComps || compLow !== oldLow) {
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

    // Quick List: auto-trigger eBay listing if in listing mode and not yet listed
    if (card.mode === 'listing' && !card.ebayListingId) {
      const connected = await isEbayConnected();
      if (connected) {
        toast('Card saved — starting eBay listing...', 'success');
        await loadRecentScans();
        goBack();
        // Trigger eBay listing flow (non-blocking for the save)
        try {
          await listCardOnEbay(card);
          await refreshListings();
        } catch (ebayErr) {
          // Card is saved; listing flow failed or was cancelled
          // Move card to collection since it's not listed
          card.mode = 'collection';
          card.lastModified = new Date().toISOString();
          await db.saveCard(card);
          await refreshCollection();
          console.warn('[Quick List] eBay listing cancelled/failed:', ebayErr.message);
        }
        return;
      } else {
        // eBay not connected — save to collection instead
        card.mode = 'collection';
        card.lastModified = new Date().toISOString();
        await db.saveCard(card);
        toast('Card saved to collection — connect eBay in Settings to Quick List', 'info', 4000);
        await refreshCollection();
        await loadRecentScans();
        goBack();
        return;
      }
    }

    toast(`Card saved to ${card.mode === 'listing' ? 'active listings' : 'collection'}`, 'success');

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

// ===== Recent Scans =====

let recentScansShown = 20;

async function loadRecentScans() {
  let all;
  try {
    all = await db.getAllCards();
  } catch (err) {
    console.error('Failed to load recent scans:', err);
    return;
  }
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
      <span class="recent-scan-mode ${card.status === 'sold' ? 'sold' : card.ebayListingId ? 'listed' : card.mode}">${card.status === 'sold' ? 'Sold' : card.ebayListingId ? 'Listed' : card.mode === 'listing' ? 'Quick List' : 'Collect'}</span>
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

  const detailImages = [card.imageBlob, card.imageBackBlob].filter(Boolean);

  content.innerHTML = `
    <div class="detail-images">
      ${card.imageBlob
        ? `<img src="${card.imageBlob}" alt="Card front" class="detail-image" data-viewer-index="0">`
        : ''}
      ${card.imageBackBlob
        ? `<img src="${card.imageBackBlob}" alt="Card back" class="detail-image" data-viewer-index="${card.imageBlob ? 1 : 0}">`
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
    <div class="detail-section" id="detail-comps">
      <h3 style="font-size:15px;font-weight:600;color:var(--gray-700);margin-bottom:8px">Recent Sales</h3>
      <div id="detail-comps-loading" style="font-size:13px;color:var(--gray-500);text-align:center;padding:8px 0">Checking sold prices...</div>
      <div id="detail-comps-stats" class="hidden"></div>
      <div id="detail-comps-list" class="hidden"></div>
    </div>
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
      <button class="btn btn-secondary" id="detail-share-btn">Share Card</button>
      ${card.mode === 'collection' ? '<button class="btn btn-secondary" id="detail-duplicate-listing-btn">Duplicate to Listings</button>' : ''}
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
          const soldPriceEl = document.getElementById('modal-sold-price');
          const soldPrice = soldPriceEl ? (parseFloat(soldPriceEl.value) || card.startPrice || 0) : (card.startPrice || 0);
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

  // Share card
  const shareBtn = document.getElementById('detail-share-btn');
  if (shareBtn) {
    shareBtn.addEventListener('click', async () => {
      const parts = [];
      if (card.year) parts.push(card.year);
      if (card.brand) parts.push(card.brand);
      if (card.setName) parts.push(card.setName);
      if (card.player) parts.push(card.player);
      if (card.parallel) parts.push(card.parallel);
      if (card.cardNumber) parts.push(`#${card.cardNumber}`);
      const title = parts.join(' ') || 'Trading Card';

      const lines = [title];
      if (card.team) lines.push(`Team: ${card.team}`);
      if (card.graded === 'Yes') lines.push(`Grade: ${card.gradeCompany} ${card.gradeValue}`);
      if (card.estimatedValueLow && card.estimatedValueHigh) {
        lines.push(`Value: $${card.estimatedValueLow.toFixed(2)} - $${card.estimatedValueHigh.toFixed(2)}`);
      }
      const text = lines.join('\n');

      if (navigator.share) {
        try {
          await navigator.share({ title, text });
        } catch {
          // User cancelled or share failed
        }
      } else {
        // Fallback: copy to clipboard
        try {
          await navigator.clipboard.writeText(text);
          toast('Card info copied to clipboard', 'success');
        } catch {
          toast('Could not share or copy', 'error');
        }
      }
    });
  }

  // Duplicate collection card to listings
  const dupBtn = document.getElementById('detail-duplicate-listing-btn');
  if (dupBtn) {
    dupBtn.addEventListener('click', async () => {
      const newCard = createCard({
        ...card,
        id: undefined, // Generate new ID
        mode: 'listing',
        status: 'pending',
        ebayListingId: null,
        ebayListingUrl: null,
        soldPrice: null,
        shippingCarrier: '',
        trackingNumber: '',
        shippingStatus: 'not_shipped'
      });
      newCard.ebayTitle = generateEbayTitle(newCard);
      newCard.dateAdded = new Date().toISOString();
      newCard.lastModified = new Date().toISOString();
      await db.saveCard(newCard);
      toast('Card duplicated to listings', 'success');
      await refreshListings();
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
          card.shippingCarrier = document.getElementById('modal-carrier')?.value || '';
          card.trackingNumber = (document.getElementById('modal-tracking')?.value || '').trim();
          card.shippingStatus = document.getElementById('modal-ship-status')?.value || 'shipped';
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

  // Image viewer — tap detail images to zoom
  content.querySelectorAll('.detail-image').forEach(img => {
    img.addEventListener('click', () => {
      const idx = parseInt(img.dataset.viewerIndex) || 0;
      window.openImageViewer(detailImages, idx);
    });
  });

  // Recent Sales: show cached data immediately, then fetch fresh
  renderDetailComps(card);
  fetchAndUpdateDetailComps(card);

  showView('view-detail');
}

function renderDetailComps(card) {
  const section = document.getElementById('detail-comps');
  const loading = document.getElementById('detail-comps-loading');
  const statsEl = document.getElementById('detail-comps-stats');
  const listEl = document.getElementById('detail-comps-list');

  if (!section) return;

  // Hide section if no worker configured
  db.getSetting('ebayWorkerUrl').then(url => {
    if (!url) section.classList.add('hidden');
  });

  if (card.compData && card.compData.items && card.compData.items.length > 0) {
    loading.classList.add('hidden');
    renderDetailCompsData(card.compData, statsEl, listEl);
  }
}

function renderDetailCompsData(compData, statsEl, listEl) {
  // Stats row
  const parts = [];
  if (compData.avg) parts.push(`<div class="detail-comps-stat"><div class="detail-comps-stat-value">$${Number(compData.avg).toFixed(2)}</div><div class="detail-comps-stat-label">Average</div></div>`);
  if (compData.low && compData.high) parts.push(`<div class="detail-comps-stat"><div class="detail-comps-stat-value">$${Number(compData.low).toFixed(2)} – $${Number(compData.high).toFixed(2)}</div><div class="detail-comps-stat-label">Range</div></div>`);

  if (parts.length > 0) {
    statsEl.innerHTML = `<div class="detail-comps-stats">${parts.join('')}</div>`;
    statsEl.classList.remove('hidden');
  }

  // Individual items (filter out ad/promoted listings with no real title)
  const validItems = (compData.items || []).filter(i => i.title && i.title !== 'Unknown' && i.itemUrl);
  if (validItems.length > 0) {
    listEl.innerHTML = validItems.map(item => {
      const dateStr = item.soldDate ? formatDate(item.soldDate) : '';
      const titleText = escapeHtml((item.title || '').length > 60 ? item.title.substring(0, 57) + '...' : item.title || '');
      const link = item.itemUrl ? ` onclick="window.open('${escapeHtml(item.itemUrl)}', '_blank')"` : '';
      return `<div class="detail-comps-item"${link} style="${item.itemUrl ? 'cursor:pointer' : ''}">
        <div class="detail-comps-item-info">
          <span class="detail-comps-item-title">${titleText}</span>
          ${dateStr ? `<span class="detail-comps-item-date">${dateStr}</span>` : ''}
        </div>
        <span class="detail-comps-item-price">$${item.price.toFixed(2)}</span>
      </div>`;
    }).join('');
    listEl.classList.remove('hidden');
  }
}

async function fetchAndUpdateDetailComps(card) {
  // Skip fetch if we have recent data (< 1 hour old) to avoid rate limits
  if (card.compData && card.compData.fetchedAt) {
    const age = Date.now() - new Date(card.compData.fetchedAt).getTime();
    if (age < 60 * 60 * 1000) {
      const loading = document.getElementById('detail-comps-loading');
      if (loading) loading.classList.add('hidden');
      return;
    }
  }

  const result = await fetchCompsForCard(card);
  const loading = document.getElementById('detail-comps-loading');
  const statsEl = document.getElementById('detail-comps-stats');
  const listEl = document.getElementById('detail-comps-list');
  const section = document.getElementById('detail-comps');

  if (!section || !loading) return;

  loading.classList.add('hidden');

  if (!result) {
    // No results — hide if no cached data either
    if (!card.compData || !card.compData.items || card.compData.items.length === 0) {
      if (statsEl) statsEl.innerHTML = '<p style="font-size:13px;color:var(--gray-500);text-align:center">No recent sold listings found.</p>';
      if (statsEl) statsEl.classList.remove('hidden');
    }
    return;
  }

  // Update card with fresh data
  card.estimatedValueLow = result.stats.low;
  card.estimatedValueHigh = result.stats.high;
  card.compData = {
    low: result.stats.low,
    avg: result.stats.average,
    high: result.stats.high,
    items: result.items,
    fetchedAt: new Date().toISOString()
  };

  // Save locally (no sync event)
  try { await db.saveCardLocal(card); } catch {}

  // Re-render the comps section with fresh data
  if (statsEl) { statsEl.innerHTML = ''; statsEl.classList.add('hidden'); }
  if (listEl) { listEl.innerHTML = ''; listEl.classList.add('hidden'); }
  renderDetailCompsData(card.compData, statsEl, listEl);
}

// ===== Background Comp Refresher =====

const COMP_REFRESH_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const COMP_STALE_AGE = 0; // TEMP: force refresh all comps
const COMP_CALL_DELAY = 2000; // 2s between calls

function initCompRefresher() {
  // First run after 5s delay (let app finish loading)
  setTimeout(() => refreshAllComps(), 5000);
  // Then every 4 hours
  setInterval(() => refreshAllComps(), COMP_REFRESH_INTERVAL);
}

async function refreshAllComps() {
  const workerUrl = await db.getSetting('ebayWorkerUrl');
  if (!workerUrl) {
    console.log('[Comps] No worker URL configured, skipping refresh');
    return;
  }

  let cards;
  try {
    cards = await db.getAllCards();
  } catch { return; }

  // Only cards with enough info to search
  const searchable = cards.filter(c => c.player && (c.year || c.brand || c.setName));

  // Filter to cards that need a refresh (no data, or stale)
  const needsRefresh = searchable.filter(c => {
    if (!c.compData || !c.compData.fetchedAt) return true;
    const age = Date.now() - new Date(c.compData.fetchedAt).getTime();
    return age >= COMP_STALE_AGE;
  });

  if (needsRefresh.length === 0) return;

  console.log(`[Comps] Refreshing ${needsRefresh.length} cards...`);

  for (let i = 0; i < needsRefresh.length; i++) {
    const card = needsRefresh[i];
    try {
      const result = await fetchCompsForCard(card);
      if (result) {
        card.estimatedValueLow = result.stats.low;
        card.estimatedValueHigh = result.stats.high;
        card.compData = {
          low: result.stats.low,
          avg: result.stats.average,
          high: result.stats.high,
          items: result.items,
          fetchedAt: new Date().toISOString()
        };
        await db.saveCardLocal(card);
      }
    } catch {
      // Skip this card, continue with others
    }

    // Delay between calls (skip delay after last card)
    if (i < needsRefresh.length - 1) {
      await new Promise(r => setTimeout(r, COMP_CALL_DELAY));
    }
  }

  console.log(`[Comps] Background refresh complete`);
}

function editDetailCard() {
  const cardId = $('#detail-content').dataset.cardId;
  if (!cardId) return;

  db.getCard(cardId).then(card => {
    if (!card) return;
    currentCard = card;
    populateReviewForm(card);
    showView('view-review');
  }).catch(err => {
    console.error('Failed to load card for edit:', err);
    toast('Failed to load card', 'error');
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

// Reusable function to fetch sold comps for any card
async function fetchCompsForCard(card) {
  const workerUrl = await db.getSetting('ebayWorkerUrl');
  if (!workerUrl) return null;

  // Use structured fields for 130point search (eBay titles have too much noise)
  const query = [
    card.year, card.brand, card.setName,
    card.player, card.parallel
  ].filter(Boolean).join(' ');
  if (!query.trim()) return null;

  // Build filter terms for tighter title matching
  const filterTerms = [];
  if (card.setName) filterTerms.push(card.setName);
  if (card.parallel) filterTerms.push(card.parallel);
  if (card.cardNumber) filterTerms.push(card.cardNumber);
  const filterParam = filterTerms.length > 0 ? `&filter=${encodeURIComponent(filterTerms.join(','))}` : '';

  try {
    const resp = await fetch(`${workerUrl}/sold-search?q=${encodeURIComponent(query)}${filterParam}`);
    if (!resp.ok) return null;

    const data = await resp.json();
    if (!data.stats || data.stats.count === 0) return null;

    return {
      stats: data.stats,
      items: (data.items || []).map(item => ({
        title: item.title,
        price: item.price,
        soldDate: item.soldDate || null,
        condition: item.condition || null,
        itemUrl: item.itemUrl || null
      }))
    };
  } catch {
    return null;
  }
}

// Auto-fetch sold prices after scan (non-blocking)
async function autoFetchSoldPrices(card) {
  const result = await fetchCompsForCard(card);
  if (!result) return;

  const { stats, items } = result;

  // Use real sold data as the estimated value
  card.estimatedValueLow = stats.low;
  card.estimatedValueHigh = stats.high;

  // Store comp data with items
  card.compData = {
    low: stats.low,
    avg: stats.average,
    high: stats.high,
    items,
    fetchedAt: new Date().toISOString()
  };

  // Update the valuation badge on the review screen
  const valuationBadge = $('#review-valuation-badge');
  if (valuationBadge) {
    const low = stats.low.toFixed(2);
    const high = stats.high.toFixed(2);
    const median = stats.median.toFixed(2);
    const countLabel = stats.filteredCount && stats.filteredCount !== stats.count
      ? `${stats.filteredCount} of ${stats.count}`
      : `${stats.count}`;
    valuationBadge.innerHTML = `Sold: $${low} – $${high} (median $${median})<br><span style="font-size:11px;font-weight:400;opacity:0.85">Based on ${countLabel} recent sale${stats.count > 1 ? 's' : ''}</span>`;
    valuationBadge.classList.remove('hidden');
  }

  // Also populate the sold prices results section
  displaySoldPrices({ stats, items });

  // Auto-set suggested price for listings
  if (card.mode === 'listing' && stats.median) {
    card.startPrice = stats.median;
    $('#field-startPrice').value = stats.median.toFixed(2);
  }

  if (currentCard && currentCard.id === card.id) {
    currentCard.estimatedValueLow = card.estimatedValueLow;
    currentCard.estimatedValueHigh = card.estimatedValueHigh;
    currentCard.compData = card.compData;
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

  const ruNameInput = $('#setting-ebay-runame');
  if (ruNameInput) {
    db.getSetting('ebayRuName').then(val => {
      if (val) ruNameInput.value = val;
    });
    ruNameInput.addEventListener('change', () => {
      db.setSetting('ebayRuName', ruNameInput.value.trim());
    });
  }
}

// ===== Demo Mode =====

const DEMO_CARDS_DATA = [
  {
    player: 'Victor Wembanyama', team: 'San Antonio Spurs', sport: 'Basketball',
    year: '2023', brand: 'Panini', setName: 'Prizm', subset: 'Base',
    parallel: 'Silver', cardNumber: '275',
    estimatedValueLow: 45, estimatedValueHigh: 80, mode: 'collection'
  },
  {
    player: 'Shohei Ohtani', team: 'Los Angeles Dodgers', sport: 'Baseball',
    year: '2024', brand: 'Topps', setName: 'Chrome', subset: 'Base',
    parallel: 'Refractor', cardNumber: '1',
    estimatedValueLow: 25, estimatedValueHigh: 55, mode: 'collection'
  },
  {
    player: 'Patrick Mahomes', team: 'Kansas City Chiefs', sport: 'Football',
    year: '2023', brand: 'Panini', setName: 'Donruss Optic', subset: 'Base',
    parallel: 'Purple Shock', cardNumber: '50',
    estimatedValueLow: 15, estimatedValueHigh: 30, mode: 'collection'
  },
  {
    player: 'Connor McDavid', team: 'Edmonton Oilers', sport: 'Hockey',
    year: '2023', brand: 'Upper Deck', setName: 'Series 1', subset: 'Base',
    parallel: '', cardNumber: '75',
    estimatedValueLow: 5, estimatedValueHigh: 12, mode: 'collection'
  },
  {
    player: 'Luka Doncic', team: 'Dallas Mavericks', sport: 'Basketball',
    year: '2024', brand: 'Panini', setName: 'Select', subset: 'Courtside',
    parallel: 'Tie-Dye', cardNumber: '225', serialNumber: '/25',
    graded: 'Yes', gradeCompany: 'PSA', gradeValue: '10',
    estimatedValueLow: 200, estimatedValueHigh: 350, mode: 'listing',
    status: 'listed', startPrice: 249.99
  }
];

function generateCardThumbnail(card) {
  const canvas = document.createElement('canvas');
  canvas.width = 200;
  canvas.height = 280;
  const ctx = canvas.getContext('2d');

  // Sport-based colors
  const colors = {
    Basketball: '#e67e22',
    Baseball: '#c0392b',
    Football: '#27ae60',
    Hockey: '#2980b9'
  };
  const bg = colors[card.sport] || '#7f8c8d';

  // Background
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 200, 280);

  // Lighter inner card area
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(10, 10, 180, 260, 8);
  } else {
    ctx.rect(10, 10, 180, 260);
  }
  ctx.fill();

  // Sport label at top
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '600 12px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(card.sport.toUpperCase(), 100, 34);

  // Player name (centered)
  ctx.fillStyle = 'white';
  ctx.font = '700 18px -apple-system, sans-serif';
  const words = card.player.split(' ');
  if (words.length > 1) {
    ctx.fillText(words[0], 100, 120);
    ctx.fillText(words.slice(1).join(' '), 100, 144);
  } else {
    ctx.fillText(card.player, 100, 132);
  }

  // Team
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.font = '500 13px -apple-system, sans-serif';
  ctx.fillText(card.team, 100, 172);

  // Set info at bottom
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '400 11px -apple-system, sans-serif';
  const setLine = [card.year, card.brand, card.setName].filter(Boolean).join(' ');
  ctx.fillText(setLine, 100, 240);
  if (card.parallel) {
    ctx.fillText(card.parallel, 100, 256);
  }

  return canvas.toDataURL('image/png');
}

async function loadDemoCards() {
  for (const data of DEMO_CARDS_DATA) {
    const thumb = generateCardThumbnail(data);
    const card = createCard({
      ...data,
      condition: 'Near Mint or Better',
      imageThumbnail: thumb,
      imageBlob: thumb
    });
    card.isDemo = true;
    card.ebayTitle = generateEbayTitle(card);
    await db.saveCardLocal(card);
  }

  localStorage.setItem('cw_hasDemo', 'true');

  await refreshCollection();
  await refreshDashboard();
  await refreshListings();
  await loadRecentScans();
}

async function clearDemoCards() {
  const all = await db.getAllCards();
  const demoIds = all.filter(c => c.isDemo === true).map(c => c.id);
  if (demoIds.length > 0) {
    await db.deleteCards(demoIds);
  }

  localStorage.removeItem('cw_hasDemo');
  document.getElementById('demo-banner').classList.add('hidden');

  await refreshCollection();
  await refreshDashboard();
  await refreshListings();
  await loadRecentScans();
}

// ===== Onboarding (First Run) =====

async function initOnboarding() {
  const hasLaunched = localStorage.getItem('cw_hasLaunched');
  if (hasLaunched) return;

  const overlay = $('#onboarding-overlay');
  overlay.classList.remove('hidden');

  $('#onboarding-demo-btn').addEventListener('click', async () => {
    overlay.classList.add('hidden');
    localStorage.setItem('cw_hasLaunched', 'true');
    await loadDemoCards();
    document.getElementById('demo-banner').classList.remove('hidden');
    // Navigate to collection to see the cards
    showView('view-collection');
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === 'collection'));
  });

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
  const scanArea = document.getElementById('scan-wizard');
  const queueSection = document.getElementById('scan-queue-section');

  if (!apiKey) {
    gate.classList.remove('hidden');
    if (scanArea) scanArea.style.opacity = '0.4';
    if (scanArea) scanArea.style.pointerEvents = 'none';
    if (queueSection) queueSection.style.opacity = '0.4';
    if (queueSection) queueSection.style.pointerEvents = 'none';
  } else {
    gate.classList.add('hidden');
    if (scanArea) scanArea.style.opacity = '';
    if (scanArea) scanArea.style.pointerEvents = '';
    if (queueSection) queueSection.style.opacity = '';
    if (queueSection) queueSection.style.pointerEvents = '';
  }

  // Only bind once
  const gateBtn = $('#gate-go-settings');
  if (!gateBtn.dataset.bound) {
    gateBtn.dataset.bound = 'true';
    gateBtn.addEventListener('click', () => {
      showView('view-settings');
      setTimeout(() => {
        const input = $('#setting-api-key');
        if (input) { input.focus(); input.scrollIntoView({ behavior: 'smooth' }); }
      }, 300);
    });
  }
}

// Re-check gate when returning to scan view
window.addEventListener('apikey-changed', () => checkApiKeyGate());

// ===== Global Search =====

function initGlobalSearch() {
  const btn = $('#btn-global-search');
  const overlay = document.getElementById('global-search-overlay');
  const input = document.getElementById('global-search-input');
  const results = document.getElementById('global-search-results');
  const closeBtn = document.getElementById('global-search-close');

  btn.addEventListener('click', () => {
    overlay.classList.remove('hidden');
    input.value = '';
    results.innerHTML = '<p class="empty-state" style="padding:32px 0">Search by player, team, set, year, or brand</p>';
    setTimeout(() => input.focus(), 100);
  });

  closeBtn.addEventListener('click', () => {
    overlay.classList.add('hidden');
  });

  let debounceTimer;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runGlobalSearch(input.value.trim()), 200);
  });

  results.addEventListener('click', (e) => {
    const item = e.target.closest('.global-search-item');
    if (item) {
      overlay.classList.add('hidden');
      window.dispatchEvent(new CustomEvent('show-card-detail', { detail: { id: item.dataset.id } }));
    }
  });
}

async function runGlobalSearch(query) {
  const results = document.getElementById('global-search-results');

  if (!query || query.length < 2) {
    results.innerHTML = '<p class="empty-state" style="padding:32px 0">Search by player, team, set, year, or brand</p>';
    return;
  }

  let all;
  try {
    all = await db.getAllCards();
  } catch (err) {
    console.error('Search failed:', err);
    return;
  }
  const q = query.toLowerCase();
  const matches = all.filter(c => {
    const searchable = [c.player, c.team, c.brand, c.setName, c.year, c.parallel, c.cardNumber, c.ebayTitle, c.notes, c.sport]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return searchable.includes(q);
  }).slice(0, 30);

  if (matches.length === 0) {
    results.innerHTML = `<p class="empty-state" style="padding:32px 0">No cards match "${escapeHtml(query)}"</p>`;
    return;
  }

  results.innerHTML = matches.map(card => `
    <div class="global-search-item" data-id="${card.id}">
      ${card.imageThumbnail
        ? `<img src="${card.imageThumbnail}" alt="Card">`
        : '<div style="width:48px;height:48px;background:var(--gray-100);border-radius:4px;flex-shrink:0"></div>'}
      <div class="global-search-item-info">
        <div class="name">${escapeHtml(cardDisplayName(card))}</div>
        <div class="detail">${escapeHtml(cardDetailLine(card))}</div>
      </div>
      <span class="global-search-mode ${card.mode}">${card.mode === 'listing' ? 'Quick List' : 'Collect'}</span>
    </div>
  `).join('');
}

// ===== Pull to Refresh =====

function initPullToRefresh() {
  const views = [
    { id: 'view-scan', refresh: () => loadRecentScans() },
    { id: 'view-dashboard', refresh: () => refreshDashboard() },
    { id: 'view-listings', refresh: () => refreshListings() },
    { id: 'view-collection', refresh: () => refreshCollection() }
  ];

  views.forEach(({ id, refresh }) => {
    const view = document.getElementById(id);
    if (!view) return;
    const scrollable = view.querySelector('.view-content');
    if (!scrollable) return;

    let startY = 0;
    let pulling = false;
    let indicator = null;

    scrollable.addEventListener('touchstart', (e) => {
      if (scrollable.scrollTop === 0) {
        startY = e.touches[0].clientY;
        pulling = true;
      }
    }, { passive: true });

    scrollable.addEventListener('touchmove', (e) => {
      if (!pulling) return;
      const dy = e.touches[0].clientY - startY;
      if (dy > 30 && scrollable.scrollTop === 0) {
        if (!indicator) {
          indicator = document.createElement('div');
          indicator.className = 'pull-refresh-indicator';
          indicator.textContent = 'Release to refresh';
          scrollable.prepend(indicator);
        }
        const progress = Math.min(dy / 100, 1);
        indicator.style.opacity = progress;
        indicator.style.height = Math.min(dy * 0.4, 40) + 'px';
      }
    }, { passive: true });

    scrollable.addEventListener('touchend', async () => {
      if (indicator) {
        indicator.textContent = 'Refreshing...';
        try { await refresh(); } catch {}
        indicator.remove();
        indicator = null;
      }
      pulling = false;
    }, { passive: true });
  });
}

// ===== Full-Screen Image Viewer =====

const imageViewer = {
  images: [],
  currentIndex: 0,

  open(images, startIndex = 0) {
    this.images = images.filter(Boolean);
    this.currentIndex = startIndex;
    if (this.images.length === 0) return;

    const overlay = document.getElementById('image-viewer');
    overlay.classList.remove('hidden');
    this.render();
    document.body.style.overflow = 'hidden';
  },

  close() {
    document.getElementById('image-viewer').classList.add('hidden');
    document.body.style.overflow = '';
    this.images = [];
  },

  prev() {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      this.render();
    }
  },

  next() {
    if (this.currentIndex < this.images.length - 1) {
      this.currentIndex++;
      this.render();
    }
  },

  render() {
    const img = document.getElementById('image-viewer-img');
    const counter = document.getElementById('image-viewer-counter');
    const prevBtn = document.getElementById('image-viewer-prev');
    const nextBtn = document.getElementById('image-viewer-next');

    img.src = this.images[this.currentIndex];
    counter.textContent = this.images.length > 1
      ? `${this.currentIndex + 1} / ${this.images.length}`
      : '';
    prevBtn.disabled = this.currentIndex === 0;
    nextBtn.disabled = this.currentIndex >= this.images.length - 1;

    // Hide nav if only one image
    const nav = document.querySelector('.image-viewer-nav');
    nav.style.display = this.images.length > 1 ? 'flex' : 'none';
  }
};

// Wire up image viewer controls
document.getElementById('image-viewer-close').addEventListener('click', () => imageViewer.close());
document.getElementById('image-viewer-prev').addEventListener('click', () => imageViewer.prev());
document.getElementById('image-viewer-next').addEventListener('click', () => imageViewer.next());
document.getElementById('image-viewer').addEventListener('click', (e) => {
  if (e.target.id === 'image-viewer' || e.target.id === 'image-viewer-body') {
    imageViewer.close();
  }
});

// Keyboard support
document.addEventListener('keydown', (e) => {
  if (document.getElementById('image-viewer').classList.contains('hidden')) return;
  if (e.key === 'Escape') imageViewer.close();
  if (e.key === 'ArrowLeft') imageViewer.prev();
  if (e.key === 'ArrowRight') imageViewer.next();
});

// Swipe support for image viewer
(function() {
  let touchStartX = 0;
  const viewer = document.getElementById('image-viewer');

  viewer.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
  }, { passive: true });

  viewer.addEventListener('touchend', (e) => {
    const diff = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(diff) > 60) {
      if (diff > 0) imageViewer.prev();
      else imageViewer.next();
    }
  }, { passive: true });
})();

// Expose globally so detail view can use it
window.openImageViewer = (images, startIndex) => imageViewer.open(images, startIndex);

// ===== Scan Queue (gallery upload + multi-card identify) =====

async function handleGalleryUpload(e) {
  const files = Array.from(e.target.files);
  if (!files.length) return;
  e.target.value = '';

  showLoading(`Processing ${files.length} photo${files.length > 1 ? 's' : ''}...`);

  for (const file of files) {
    try {
      const photo = await processPhoto(file);
      // Auto-enhance for batch uploads (non-interactive)
      const scanResult = await autoEnhance(photo.fullBase64);
      if (scanResult.enhanced) {
        photo.fullBase64 = scanResult.fullBase64;
        photo.imageBlob = scanResult.imageBlob;
      }
      scanQueue.push({ photo, backPhoto: null, status: 'pending', card: null, error: null });
    } catch {
      scanQueue.push({ photo: null, backPhoto: null, status: 'error', card: null, error: 'Failed to process photo' });
    }
  }

  hideLoading();
  document.getElementById('scan-queue-section').classList.remove('hidden');
  renderScanQueue();
  updateIdentifyAllButton();
  toast(`${files.length} photo${files.length > 1 ? 's' : ''} added`, 'success');
}

function renderScanQueue() {
  const container = document.getElementById('scan-queue');
  if (!container) return;

  if (scanQueue.length === 0) {
    container.innerHTML = '';
    document.getElementById('scan-queue-section').classList.add('hidden');
    return;
  }

  container.innerHTML = scanQueue.map((item, i) => {
    let statusHtml = '';
    let statusClass = '';
    if (item.status === 'pending') {
      statusHtml = 'Ready';
    } else if (item.status === 'identifying') {
      statusHtml = 'Identifying...';
    } else if (item.status === 'done') {
      statusHtml = item.card ? escapeHtml(item.card.player || 'Done') : 'Done';
      statusClass = 'identified';
    } else if (item.status === 'error') {
      statusHtml = item.error || 'Error';
      statusClass = 'error';
    }

    const thumb = item.photo ? item.photo.thumbnailBase64 : '';
    const hasBack = item.backPhoto ? ' +back' : '';
    return `
      <div class="batch-queue-item">
        ${thumb ? `<img src="${thumb}" alt="Card ${i + 1}">` : '<div style="width:48px;height:48px;background:var(--gray-100);border-radius:4px"></div>'}
        <span class="batch-queue-status ${statusClass}">Card ${i + 1}${hasBack} &middot; ${statusHtml}</span>
        ${item.status === 'pending' ? `<button class="btn btn-danger btn-sm batch-remove-btn" data-index="${i}" style="padding:4px 8px;font-size:11px">&times;</button>` : ''}
      </div>
    `;
  }).join('');

  container.querySelectorAll('.batch-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      scanQueue.splice(parseInt(btn.dataset.index), 1);
      renderScanQueue();
      updateIdentifyAllButton();
    });
  });
}

function updateIdentifyAllButton() {
  const btn = document.getElementById('btn-identify-all');
  if (!btn) return;
  const pendingCount = scanQueue.filter(q => q.status === 'pending').length;
  btn.disabled = pendingCount === 0;
  btn.textContent = pendingCount > 0 ? `Identify All (${pendingCount})` : 'Identify All';
}

async function handleIdentifyAll() {
  const pending = scanQueue.filter(q => q.status === 'pending');
  if (pending.length === 0) {
    toast('No cards ready to identify.', 'info');
    return;
  }

  // Check API key
  let apiKey = await db.getSetting('apiKey');
  if (!apiKey) {
    try { apiKey = localStorage.getItem('cw_apiKey'); } catch {}
  }
  if (!apiKey) {
    toast('API key required. Add your Claude API key in Settings first.', 'error', 4000);
    return;
  }

  const btn = document.getElementById('btn-identify-all');
  btn.disabled = true;
  btn.textContent = `Scanning 0/${pending.length}...`;

  try {
    const defaults = await getDefaults();
    let processed = 0;

    for (const item of pending) {
      if (!item.photo) continue;

      item.status = 'identifying';
      btn.textContent = `Scanning ${processed + 1}/${pending.length}...`;
      renderScanQueue();

      try {
        const backBase64 = item.backPhoto ? item.backPhoto.apiBase64 : null;
        const aiData = await identifyCard(item.photo.apiBase64, backBase64,
          (status) => { btn.textContent = status; });

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
          imageThumbnail: item.photo.thumbnailBase64,
          imageBackBlob: item.backPhoto ? item.backPhoto.imageBlob : null,
          imageBackThumb: item.backPhoto ? item.backPhoto.thumbnailBase64 : null
        });

        // Parallel validation notification for batch
        if (aiData._parallelNeedsReview) {
          toast(`${aiData.player || 'Card'}: "${aiData._parallelNeedsReview}" isn't a known ${aiData.setName || ''} parallel`, 'warning', 5000);
          delete aiData._parallelNeedsReview;
        }

        card.ebayTitle = generateEbayTitle(card);
        await db.saveCard(card);
        autoFetchSoldPrices(card);

        item.card = card;
        item.status = 'done';
        processed++;
      } catch (err) {
        item.status = 'error';
        item.error = err.message || 'AI identification failed';
      }

      renderScanQueue();
    }

    if (processed > 0) {
      toast(`${processed} card${processed > 1 ? 's' : ''} identified and saved`, 'success');
      await refreshListings();
      await refreshCollection();
      await loadRecentScans();
    } else {
      toast('All cards failed to identify. Check your API key and try again.', 'error');
    }
  } catch (err) {
    toast('Identify failed: ' + (err.message || 'Unknown error'), 'error');
  }

  updateIdentifyAllButton();
}

