// eBay Listings Tracker — shows live data for cards listed on eBay

import * as db from './db.js';
import { toast, $, escapeHtml } from './ui.js';
import { cardDisplayName, cardDetailLine } from './card-model.js';

let allCards = [];       // all cards with an ebayListingId
let filteredCards = [];  // after applying status filter
let liveData = new Map(); // ebayListingId → eBay Browse API data
let autoRefreshTimer = null;
let countdownTimer = null;
let lastFetchedAt = null;
let currentSort = 'ending-asc';
let currentFilter = 'active';

// Restore saved preferences
try {
  const savedSort = localStorage.getItem('cw_listingsSort');
  if (savedSort) currentSort = savedSort;
  const savedFilter = localStorage.getItem('cw_listingsFilter');
  if (savedFilter) currentFilter = savedFilter;
} catch {}

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

  // Sort dropdown
  const sortEl = $('#listings-sort');
  if (sortEl) {
    sortEl.value = currentSort;
    sortEl.addEventListener('change', (e) => {
      currentSort = e.target.value;
      try { localStorage.setItem('cw_listingsSort', currentSort); } catch {}
      applyFilterAndRender();
    });
  }

  // Filter pills
  const pillsContainer = $('#listings-filter-pills');
  if (pillsContainer) {
    // Set initial active pill
    pillsContainer.querySelectorAll('.pill').forEach(p => {
      p.classList.toggle('active', p.dataset.filter === currentFilter);
    });
    pillsContainer.addEventListener('click', (e) => {
      const pill = e.target.closest('.pill');
      if (!pill) return;
      currentFilter = pill.dataset.filter;
      try { localStorage.setItem('cw_listingsFilter', currentFilter); } catch {}
      pillsContainer.querySelectorAll('.pill').forEach(p => p.classList.toggle('active', p.dataset.filter === currentFilter));
      applyFilterAndRender();
    });
  }

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
  allCards = await db.getAllListingHistory();

  applyFilterAndRender();

  // Fetch live data for active listings
  const activeCards = allCards.filter(c => c.status === 'listed');
  if (activeCards.length > 0) {
    await fetchLiveData(activeCards);
  }
}

function applyFilterAndRender() {
  if (currentFilter === 'all') {
    filteredCards = [...allCards];
  } else if (currentFilter === 'active') {
    filteredCards = allCards.filter(c => c.status === 'listed');
  } else if (currentFilter === 'sold') {
    filteredCards = allCards.filter(c => c.status === 'sold');
  } else if (currentFilter === 'unsold') {
    filteredCards = allCards.filter(c => c.status === 'unsold');
  }

  // Update pill counts
  updatePillCounts();
  render();
}

function updatePillCounts() {
  const counts = { active: 0, sold: 0, unsold: 0, all: allCards.length };
  for (const c of allCards) {
    if (c.status === 'listed') counts.active++;
    else if (c.status === 'sold') counts.sold++;
    else if (c.status === 'unsold') counts.unsold++;
  }
  const pillsContainer = $('#listings-filter-pills');
  if (!pillsContainer) return;
  pillsContainer.querySelectorAll('.pill').forEach(p => {
    const f = p.dataset.filter;
    const count = counts[f] ?? 0;
    const labels = { active: 'Active', sold: 'Sold', unsold: 'Unsold', all: 'All' };
    p.textContent = `${labels[f]} (${count})`;
  });
}

async function fetchLiveData(activeCards) {
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
      const card = allCards.find(c => c.ebayListingId === endedId);
      if (card) {
        card.status = 'unsold';
        card.mode = 'collection';
        card.lastModified = new Date().toISOString();
        await db.saveCard(card);
      }
    }

    if (endedIds.length > 0) {
      toast(`${endedIds.length} listing${endedIds.length > 1 ? 's' : ''} ended — moved to collection`, 'info');
      window.dispatchEvent(new CustomEvent('refresh-collection'));
    }

    applyFilterAndRender();
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
    const activeCards = allCards.filter(c => c.status === 'listed');
    if (activeCards.length > 0) {
      fetchLiveData(activeCards);
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

function sortListings() {
  filteredCards.sort((a, b) => {
    const liveA = liveData.get(a.ebayListingId);
    const liveB = liveData.get(b.ebayListingId);

    switch (currentSort) {
      case 'ending-asc':
      case 'ending-desc': {
        const endA = liveA?.itemEndDate ? new Date(liveA.itemEndDate).getTime() : Infinity;
        const endB = liveB?.itemEndDate ? new Date(liveB.itemEndDate).getTime() : Infinity;
        return currentSort === 'ending-asc' ? endA - endB : endB - endA;
      }
      case 'price-asc':
      case 'price-desc': {
        const priceA = Number(liveA?.currentBidPrice?.value ?? liveA?.price?.value ?? a.soldPrice ?? a.startPrice ?? 0);
        const priceB = Number(liveB?.currentBidPrice?.value ?? liveB?.price?.value ?? b.soldPrice ?? b.startPrice ?? 0);
        return currentSort === 'price-asc' ? priceA - priceB : priceB - priceA;
      }
      case 'bids-desc': {
        const bidsA = liveA?.bidCount || 0;
        const bidsB = liveB?.bidCount || 0;
        return bidsB - bidsA;
      }
      case 'dateAdded-desc': {
        const dA = a.dateAdded ? new Date(a.dateAdded).getTime() : 0;
        const dB = b.dateAdded ? new Date(b.dateAdded).getTime() : 0;
        return dB - dA;
      }
      case 'player-asc':
        return (a.player || '').localeCompare(b.player || '');
      default:
        return 0;
    }
  });
}

function render() {
  const container = $('#listings-list');

  renderRefreshStatus();
  sortListings();

  const emptyMessages = {
    active: { icon: '&#128179;', title: 'No active listings', desc: 'Use Quick List mode to list cards on eBay.' },
    sold: { icon: '&#128176;', title: 'No sold listings', desc: 'Sold items will appear here once marked as sold.' },
    unsold: { icon: '&#128230;', title: 'No unsold listings', desc: 'Ended listings that didn\'t sell will appear here.' },
    all: { icon: '&#128179;', title: 'No listings yet', desc: 'Use Quick List mode to list cards on eBay.' },
  };

  if (filteredCards.length === 0) {
    const msg = emptyMessages[currentFilter] || emptyMessages.all;
    container.innerHTML = `<div class="empty-state-rich">
      <div class="empty-state-icon">${msg.icon}</div>
      <div class="empty-state-title">${msg.title}</div>
      <div class="empty-state-desc">${msg.desc}</div>
    </div>`;
    return;
  }

  container.innerHTML = filteredCards.map(card => {
    const live = liveData.get(card.ebayListingId);
    const isAuction = live ? live.buyingOptions?.includes('AUCTION') : false;
    const isBuyNow = live ? live.buyingOptions?.includes('FIXED_PRICE') : false;
    const isActive = card.status === 'listed';

    // Price display
    let priceHtml = '';
    if (card.status === 'sold' && card.soldPrice) {
      priceHtml = `<span class="listing-live-price sold-price">$${Number(card.soldPrice).toFixed(2)}</span>`;
    } else if (live) {
      if (isAuction && live.currentBidPrice) {
        priceHtml = `<span class="listing-live-price bid-price">$${Number(live.currentBidPrice.value).toFixed(2)}</span>`;
      } else if (live?.price) {
        priceHtml = `<span class="listing-live-price">$${Number(live.price.value).toFixed(2)}</span>`;
      }
    } else if (card.startPrice) {
      priceHtml = `<span class="listing-live-price local">$${Number(card.startPrice).toFixed(2)}</span>`;
    }

    // Status badge
    let statusBadge = '';
    if (card.status === 'sold') {
      statusBadge = '<span class="listing-status-badge sold">Sold</span>';
    } else if (card.status === 'unsold') {
      statusBadge = '<span class="listing-status-badge unsold">Unsold</span>';
    }

    // Format badge (only for active)
    let formatBadge = '';
    if (isActive && live) {
      if (isAuction) {
        formatBadge = '<span class="listing-format-badge auction">Auction</span>';
      } else if (isBuyNow) {
        formatBadge = '<span class="listing-format-badge fixed">Buy It Now</span>';
      }
    }

    // Bid count (only for active auctions)
    const bidCount = live?.bidCount || 0;
    const bidHtml = isActive && isAuction ? `<span class="listing-bid-count">${bidCount} bid${bidCount !== 1 ? 's' : ''}</span>` : '';

    // Countdown (only for active)
    let countdownHtml = '';
    if (isActive && live?.itemEndDate) {
      const end = new Date(live.itemEndDate);
      const diff = end - new Date();
      const urgentClass = diff < 3600000 ? ' urgent' : '';
      countdownHtml = `<span class="listing-countdown${urgentClass}" data-end="${live.itemEndDate}">${formatCountdown(Math.max(0, diff))}</span>`;
    }

    // Ended date for sold/unsold
    let endedDateHtml = '';
    if (!isActive && card.lastModified) {
      const d = new Date(card.lastModified);
      endedDateHtml = `<span class="listing-ended-date">${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>`;
    }

    // Avg sold price from comp data
    const avgSold = card.compData?.avg;
    const avgHtml = avgSold ? `<span class="listing-avg-sold">Avg sold: $${Number(avgSold).toFixed(2)}</span>` : '';

    // eBay link
    const ebayUrl = card.ebayListingUrl || (live?.itemWebUrl) || `https://www.ebay.com/itm/${card.ebayListingId}`;

    return `
      <div class="active-listing-card${!isActive ? ' ended' : ''}" data-id="${card.id}">
        <div class="active-listing-thumb">
          ${card.imageThumbnail
            ? `<img src="${card.imageThumbnail}" alt="Card" loading="lazy">`
            : '<div class="no-image-placeholder">No img</div>'}
        </div>
        <div class="active-listing-info">
          <div class="active-listing-title">${escapeHtml(card.ebayTitle || cardDisplayName(card))}</div>
          <div class="active-listing-meta">${escapeHtml(cardDetailLine(card))}</div>
          <div class="active-listing-badges">
            ${statusBadge}${formatBadge}${bidHtml}${countdownHtml}${endedDateHtml}
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
