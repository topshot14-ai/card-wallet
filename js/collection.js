// Collection grid, list, binder views — search, filter, sort

import * as db from './db.js';
import { cardDisplayName, cardDetailLine } from './card-model.js';
import { $, $$, escapeHtml } from './ui.js';

let allCards = [];
let filteredCards = [];
let currentFilter = 'all';
let currentSort = 'dateAdded-desc';
let searchQuery = '';
let currentViewMode = localStorage.getItem('cw_collectionView') || 'grid';
let binderPage = 0;
const COLLECTION_PAGE_SIZE = 50;
const BINDER_SLOTS = 9; // 3x3 grid per page
let collectionShown = COLLECTION_PAGE_SIZE;

// Restore saved sort preference
try {
  const savedSort = localStorage.getItem('cw_collectionSort');
  if (savedSort) currentSort = savedSort;
} catch {}

export async function initCollection() {
  // Search
  $('#collection-search').addEventListener('input', (e) => {
    searchQuery = e.target.value.trim().toLowerCase();
    applyFilters();
  });

  // Filter pills
  const filterPillsEl = $('#filter-pills');
  filterPillsEl.addEventListener('click', (e) => {
    const pill = e.target.closest('.pill');
    if (!pill) return;
    filterPillsEl.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    currentFilter = pill.dataset.filter;
    applyFilters();
  });

  // Sort
  $('#collection-sort').addEventListener('change', (e) => {
    currentSort = e.target.value;
    try { localStorage.setItem('cw_collectionSort', currentSort); } catch {}
    applyFilters();
  });

  // Restore saved sort in dropdown
  const sortEl = $('#collection-sort');
  if (sortEl) sortEl.value = currentSort;

  // View mode toggle
  $$('.view-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.view-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentViewMode = btn.dataset.mode;
      try { localStorage.setItem('cw_collectionView', currentViewMode); } catch {}
      binderPage = 0;
      collectionShown = COLLECTION_PAGE_SIZE;
      render();
    });
  });

  // Restore saved view mode button state
  $$('.view-mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === currentViewMode);
  });

  // Event delegation on grid/list/binder
  $('#collection-grid').addEventListener('click', (e) => {
    const tile = e.target.closest('.card-tile') || e.target.closest('.collection-list-item') || e.target.closest('.binder-slot[data-id]');
    if (tile && tile.dataset.id) {
      window.dispatchEvent(new CustomEvent('show-card-detail', { detail: { id: tile.dataset.id } }));
    }

    // Binder page nav
    const navBtn = e.target.closest('.binder-nav-prev, .binder-nav-next');
    if (navBtn) {
      if (navBtn.classList.contains('binder-nav-prev') && binderPage > 0) {
        binderPage--;
        render();
      } else if (navBtn.classList.contains('binder-nav-next')) {
        const totalPages = Math.ceil(filteredCards.length / BINDER_SLOTS);
        if (binderPage < totalPages - 1) {
          binderPage++;
          render();
        }
      }
    }

    // Load more
    const loadMore = e.target.closest('#btn-collection-load-more');
    if (loadMore) {
      collectionShown += COLLECTION_PAGE_SIZE;
      render();
    }
  });

  await refreshCollection();
}

export async function refreshCollection() {
  // Include collection cards + listing-mode cards that are NOT active on eBay
  const collectionCards = await db.getCardsByMode('collection');
  const listingCards = await db.getCardsByMode('listing');
  const nonActiveListings = listingCards.filter(c => c.status !== 'listed' || !c.ebayListingId);
  allCards = [...collectionCards, ...nonActiveListings];
  $('#collection-count').textContent = allCards.length;

  // Calculate and show collection value
  const totalValue = allCards.reduce((sum, c) => sum + getCardValue(c), 0);
  const valueEl = $('#collection-value');
  if (valueEl) {
    valueEl.textContent = totalValue > 0 ? `$${totalValue.toFixed(0)}` : '';
  }

  collectionShown = COLLECTION_PAGE_SIZE;
  binderPage = 0;
  applyFilters();
}

function getCardValue(card) {
  if (card.estimatedValueLow && card.estimatedValueHigh) {
    return (card.estimatedValueLow + card.estimatedValueHigh) / 2;
  }
  if (card.estimatedValueLow) return card.estimatedValueLow;
  if (card.estimatedValueHigh) return card.estimatedValueHigh;
  return 0;
}

function applyFilters() {
  binderPage = 0;
  filteredCards = [...allCards];

  // Filter by sport
  if (currentFilter !== 'all') {
    filteredCards = filteredCards.filter(c => c.sport === currentFilter);
  }

  // Search
  if (searchQuery) {
    filteredCards = filteredCards.filter(c => {
      const searchable = [c.player, c.team, c.brand, c.setName, c.year, c.parallel, c.cardNumber, c.notes]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return searchable.includes(searchQuery);
    });
  }

  // Sort
  const [field, dir] = currentSort.split('-');
  filteredCards.sort((a, b) => {
    let aVal, bVal;

    if (field === 'value') {
      aVal = getCardValue(a);
      bVal = getCardValue(b);
    } else if (field === 'dateAdded') {
      aVal = new Date(a[field] || 0).getTime();
      bVal = new Date(b[field] || 0).getTime();
    } else {
      aVal = String(a[field] || '').toLowerCase();
      bVal = String(b[field] || '').toLowerCase();
    }

    if (aVal < bVal) return dir === 'asc' ? -1 : 1;
    if (aVal > bVal) return dir === 'asc' ? 1 : -1;
    return 0;
  });

  render();
}

function render() {
  switch (currentViewMode) {
    case 'list': renderList(); break;
    case 'binder': renderBinder(); break;
    default: renderGrid(); break;
  }
}

function renderEmptyState() {
  if (allCards.length === 0) {
    return `<div class="empty-state-rich" style="grid-column:1/-1">
      <div class="empty-state-icon">&#127183;</div>
      <div class="empty-state-title">Your collection is empty</div>
      <div class="empty-state-desc">Scan cards in "Collect" mode to start building your collection.</div>
    </div>`;
  }
  return `<p class="empty-state" style="grid-column:1/-1">No cards match your search.</p>`;
}

function formatValue(card) {
  if (card.compData?.avg) {
    return `~$${Number(card.compData.avg).toFixed(0)}`;
  }
  if (card.estimatedValueLow && card.estimatedValueHigh) {
    return `$${Number(card.estimatedValueLow).toFixed(0)}-$${Number(card.estimatedValueHigh).toFixed(0)}`;
  }
  if (card.estimatedValueLow) {
    return `~$${Number(card.estimatedValueLow).toFixed(0)}`;
  }
  return '';
}

function renderGrid() {
  const container = $('#collection-grid');
  container.className = 'collection-grid';

  if (filteredCards.length === 0) {
    container.innerHTML = renderEmptyState();
    return;
  }

  const visible = filteredCards.slice(0, collectionShown);

  container.innerHTML = visible.map(card => {
    const valueStr = formatValue(card);
    const valueBadge = valueStr ? `<span class="card-tile-value">${valueStr}</span>` : '';
    return `
    <div class="card-tile" data-id="${card.id}">
      <div class="card-tile-image-wrap">
        ${card.imageThumbnail
          ? `<img src="${card.imageThumbnail}" alt="${escapeHtml(card.player || 'Card')}" loading="lazy">`
          : '<div class="no-image-placeholder">No Image</div>'}
        ${valueBadge}
      </div>
      <div class="card-tile-info">
        <div class="name">${escapeHtml(card.player || 'Unknown')}</div>
        <div class="detail">${escapeHtml(cardDetailLine(card))}</div>
      </div>
    </div>
  `;
  }).join('');

  appendLoadMore(container);
}

function renderList() {
  const container = $('#collection-grid');
  container.className = 'collection-list';

  if (filteredCards.length === 0) {
    container.innerHTML = renderEmptyState();
    return;
  }

  const visible = filteredCards.slice(0, collectionShown);

  container.innerHTML = visible.map(card => {
    const valueStr = formatValue(card);
    return `
    <div class="collection-list-item" data-id="${card.id}">
      ${card.imageThumbnail
        ? `<img src="${card.imageThumbnail}" alt="${escapeHtml(card.player || 'Card')}" loading="lazy">`
        : '<div style="width:48px;height:48px;background:var(--gray-100);border-radius:4px;flex-shrink:0"></div>'}
      <div class="collection-list-info">
        <div class="name">${escapeHtml(card.player || 'Unknown')}</div>
        <div class="detail">${escapeHtml(cardDetailLine(card))}</div>
      </div>
      ${valueStr ? `<span class="collection-list-value">${valueStr}</span>` : ''}
    </div>
  `;
  }).join('');

  appendLoadMore(container);
}

function renderBinder() {
  const container = $('#collection-grid');
  container.className = '';

  if (filteredCards.length === 0) {
    container.innerHTML = renderEmptyState();
    return;
  }

  const totalPages = Math.ceil(filteredCards.length / BINDER_SLOTS);
  const pageCards = filteredCards.slice(binderPage * BINDER_SLOTS, (binderPage + 1) * BINDER_SLOTS);

  // Fill remaining slots with empty placeholders
  const slots = [];
  for (let i = 0; i < BINDER_SLOTS; i++) {
    const card = pageCards[i];
    if (card) {
      slots.push(`
        <div class="binder-slot" data-id="${card.id}">
          ${card.imageThumbnail
            ? `<img src="${card.imageThumbnail}" alt="${escapeHtml(card.player || 'Card')}" loading="lazy">`
            : '<div class="binder-slot-empty">Empty</div>'}
          <div class="binder-slot-name">${escapeHtml(card.player || 'Unknown')}</div>
        </div>
      `);
    } else {
      slots.push(`
        <div class="binder-slot">
          <div class="binder-slot-empty"></div>
        </div>
      `);
    }
  }

  container.innerHTML = `
    <div class="collection-binder">
      ${slots.join('')}
    </div>
    ${totalPages > 1 ? `
    <div class="binder-page-nav">
      <button class="binder-nav-prev" ${binderPage === 0 ? 'disabled' : ''}>&#8592; Prev</button>
      <span>Page ${binderPage + 1} of ${totalPages}</span>
      <button class="binder-nav-next" ${binderPage >= totalPages - 1 ? 'disabled' : ''}>Next &#8594;</button>
    </div>
    ` : ''}
  `;
}

function appendLoadMore(container) {
  if (filteredCards.length > collectionShown) {
    const remaining = filteredCards.length - collectionShown;
    container.innerHTML += `<div class="load-more-sentinel" style="${currentViewMode === 'grid' ? 'grid-column:1/-1' : ''}"><button class="btn btn-secondary btn-sm" id="btn-collection-load-more">Show More (${remaining} remaining)</button></div>`;
  }
}

