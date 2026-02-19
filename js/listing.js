// Active eBay Listings Tracker — shows live data for cards listed on eBay

import * as db from './db.js';
import { toast, $, escapeHtml } from './ui.js';
import { cardDisplayName, cardDetailLine } from './card-model.js';

let activeCards = [];
let liveData = new Map(); // ebayListingId → eBay Browse API data
let autoRefreshTimer = null;
let countdownTimer = null;
let lastFetchedAt = null;

export async function initListings() {
  // Run one-time migration from listing queue to collection
  await db.migrateListingQueueToCollection();

  // Wire refresh button
  const refreshBtn = $('#btn-refresh-listings');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => refreshListings());
  }

  // Event delegation on listings container
  const container = $('#listings-list');
  container.addEventListener('click', (e) => {
    // View on eBay link
    const ebayLink = e.target.closest('.listing-ebay-link');
    if (ebayLink) return; // let the <a> handle it

    // Click on listing card → open card detail
    const card = e.target.closest('.active-listing-card');
    if (card && card.dataset.id) {
      window.dispatchEvent(new CustomEvent('show-card-detail', { detail: { id: card.dataset.id } }));
    }
  });

  // Start/stop auto-refresh when listings tab becomes active/inactive
  window.addEventListener('view-changed', (e) => {
    if (e.detail?.view === 'view-listings') {
      startAutoRefresh();
    } else {
      stopAutoRefresh();
    }
  });

  await refreshListings();
}

export async function refreshListings() {
  activeCards = await db.getActiveListings();

  render();

  // Fetch live data if we have active listings
  if (activeCards.length > 0) {
    await fetchLiveData();
  }
}

async function fetchLiveData() {
  const workerUrl = await db.getSetting('ebayWorkerUrl');
  if (!workerUrl) return;

  const ids = activeCards.map(c => c.ebayListingId).filter(Boolean);
  if (ids.length === 0) return;

  try {
    const resp = await fetch(`${workerUrl}/active-listings?ids=${ids.join(',')}`);
    if (!resp.ok) {
      console.error('[Listings] Failed to fetch live data:', resp.status);
      return;
    }

    const data = await resp.json();
    lastFetchedAt = data.fetchedAt ? new Date(data.fetchedAt) : new Date();

    // Update live data map and handle ended listings
    const endedIds = [];
    for (const listing of (data.listings || [])) {
      if (listing.error && listing.status === 404) {
        endedIds.push(listing.legacyItemId);
        continue;
      }
      if (!listing.error && listing.legacyItemId) {
        liveData.set(listing.legacyItemId, listing);
      }
    }

    // Move ended listings to collection as unsold
    for (const endedId of endedIds) {
      const card = activeCards.find(c => c.ebayListingId === endedId);
      if (card) {
        card.status = 'unsold';
        card.mode = 'collection';
        card.lastModified = new Date().toISOString();
        await db.saveCard(card);
      }
    }

    if (endedIds.length > 0) {
      activeCards = activeCards.filter(c => !endedIds.includes(c.ebayListingId));
      toast(`${endedIds.length} listing${endedIds.length > 1 ? 's' : ''} ended — moved to collection`, 'info');
      window.dispatchEvent(new CustomEvent('refresh-collection'));
    }

    render();
    startCountdownTimers();
  } catch (err) {
    console.error('[Listings] Fetch error:', err);
    // Show offline state
    renderRefreshStatus(true);
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  autoRefreshTimer = setInterval(() => {
    if (activeCards.length > 0) {
      fetchLiveData();
    }
  }, 5 * 60 * 1000); // 5 minutes
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  stopCountdownTimers();
}

function startCountdownTimers() {
  stopCountdownTimers();
  countdownTimer = setInterval(() => {
    document.querySelectorAll('.listing-countdown[data-end]').forEach(el => {
      const end = new Date(el.dataset.end);
      const now = new Date();
      const diff = end - now;

      if (diff <= 0) {
        el.textContent = 'Ended';
        el.classList.add('ended');
        return;
      }

      el.textContent = formatCountdown(diff);
      el.classList.toggle('urgent', diff < 3600000); // under 1 hour
    });
  }, 1000);
}

function stopCountdownTimers() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function formatCountdown(ms) {
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function renderRefreshStatus(offline = false) {
  const statusEl = $('#listings-last-refreshed');
  if (!statusEl) return;

  if (offline) {
    statusEl.textContent = 'Offline — showing local data';
    statusEl.classList.add('offline');
    return;
  }

  statusEl.classList.remove('offline');
  if (lastFetchedAt) {
    const time = lastFetchedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    statusEl.textContent = `Last refreshed: ${time}`;
  }
}

function render() {
  const container = $('#listings-list');

  renderRefreshStatus();

  if (activeCards.length === 0) {
    container.innerHTML = `<div class="empty-state-rich">
      <div class="empty-state-icon">&#128179;</div>
      <div class="empty-state-title">No active listings</div>
      <div class="empty-state-desc">Use Quick List mode to list cards on eBay.</div>
    </div>`;
    return;
  }

  container.innerHTML = activeCards.map(card => {
    const live = liveData.get(card.ebayListingId);
    const isAuction = live ? live.buyingOptions?.includes('AUCTION') : false;
    const isBuyNow = live ? live.buyingOptions?.includes('FIXED_PRICE') : false;

    // Price display
    let priceHtml = '';
    if (live) {
      if (isAuction && live.currentBidPrice) {
        priceHtml = `<span class="listing-live-price bid-price">$${Number(live.currentBidPrice.value).toFixed(2)}</span>`;
      } else if (live?.price) {
        priceHtml = `<span class="listing-live-price">$${Number(live.price.value).toFixed(2)}</span>`;
      }
    } else if (card.startPrice) {
      priceHtml = `<span class="listing-live-price local">$${Number(card.startPrice).toFixed(2)}</span>`;
    }

    // Format badge
    let formatBadge = '';
    if (live) {
      if (isAuction) {
        formatBadge = '<span class="listing-format-badge auction">Auction</span>';
      } else if (isBuyNow) {
        formatBadge = '<span class="listing-format-badge fixed">Buy It Now</span>';
      }
    }

    // Bid count
    const bidCount = live?.bidCount || 0;
    const bidHtml = isAuction ? `<span class="listing-bid-count">${bidCount} bid${bidCount !== 1 ? 's' : ''}</span>` : '';

    // Countdown
    let countdownHtml = '';
    if (live?.itemEndDate) {
      const end = new Date(live.itemEndDate);
      const diff = end - new Date();
      const urgentClass = diff < 3600000 ? ' urgent' : '';
      countdownHtml = `<span class="listing-countdown${urgentClass}" data-end="${live.itemEndDate}">${formatCountdown(Math.max(0, diff))}</span>`;
    }

    // Avg sold price from comp data
    const avgSold = card.compData?.avg;
    const avgHtml = avgSold ? `<span class="listing-avg-sold">Avg sold: $${Number(avgSold).toFixed(2)}</span>` : '';

    // eBay link
    const ebayUrl = card.ebayListingUrl || (live?.itemWebUrl) || `https://www.ebay.com/itm/${card.ebayListingId}`;

    return `
      <div class="active-listing-card" data-id="${card.id}">
        <div class="active-listing-thumb">
          ${card.imageThumbnail
            ? `<img src="${card.imageThumbnail}" alt="Card" loading="lazy">`
            : '<div class="no-image-placeholder">No img</div>'}
        </div>
        <div class="active-listing-info">
          <div class="active-listing-title">${escapeHtml(card.ebayTitle || cardDisplayName(card))}</div>
          <div class="active-listing-meta">${escapeHtml(cardDetailLine(card))}</div>
          <div class="active-listing-badges">
            ${formatBadge}${bidHtml}${countdownHtml}
          </div>
        </div>
        <div class="active-listing-price-col">
          ${priceHtml}
          ${avgHtml}
          <a href="${escapeHtml(ebayUrl)}" target="_blank" rel="noopener" class="listing-ebay-link" title="View on eBay">&#x1F517;</a>
        </div>
      </div>
    `;
  }).join('');
}
