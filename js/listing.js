// Listing queue management and eBay CSV export

import * as db from './db.js';
import { toast, confirm, showView, $, escapeHtml } from './ui.js';
import { cardDisplayName, cardDetailLine } from './card-model.js';
import { listCardOnEbay } from './ebay-listing.js';
// Note: db.softDeleteCard and db.softDeleteCards accessed via db.* namespace

let listings = [];
let selectedIds = new Set();
let statusFilter = 'all'; // 'all', 'pending', 'listed', 'sold', 'unsold'
let listingsSearchQuery = '';
const LISTINGS_PAGE_SIZE = 50;
let listingsShown = LISTINGS_PAGE_SIZE;

export async function initListings() {
  await refreshListings();

  // Static event listeners (once)
  $('#btn-export-csv').addEventListener('click', exportCSV);
  $('#listings-select-all').addEventListener('click', toggleSelectAll);
  $('#btn-delete-selected').addEventListener('click', deleteSelected);
  $('#btn-move-to-collection').addEventListener('click', moveSelectedToCollection);

  // Search input
  const searchInput = document.getElementById('listings-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      listingsSearchQuery = e.target.value.trim().toLowerCase();
      render();
    });
  }

  // Status filter pills — event delegation
  const filterContainer = $('#listings-status-filters');
  if (filterContainer) {
    filterContainer.addEventListener('click', (e) => {
      const pill = e.target.closest('.pill');
      if (!pill) return;
      filterContainer.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      statusFilter = pill.dataset.status;
      render();
    });
  }

  // Swipe to delete (mobile)
  initSwipeToDelete();

  // Event delegation on listings container
  const container = $('#listings-list');
  container.addEventListener('change', (e) => {
    const cb = e.target.closest('.listing-checkbox');
    if (!cb) return;
    e.stopPropagation();
    const id = cb.dataset.id;
    if (cb.checked) {
      selectedIds.add(id);
    } else {
      selectedIds.delete(id);
    }
    updateBulkButtons();
  });

  container.addEventListener('click', async (e) => {
    // List It button — launch eBay listing flow
    const ebayBtn = e.target.closest('.listing-ebay-btn');
    if (ebayBtn) {
      e.stopPropagation();
      const card = listings.find(c => c.id === ebayBtn.dataset.id);
      if (card) {
        await listCardOnEbay(card);
        await refreshListings();
      }
      return;
    }

    // Move to Collection button
    const moveBtn = e.target.closest('.listing-move-btn');
    if (moveBtn) {
      e.stopPropagation();
      const card = listings.find(c => c.id === moveBtn.dataset.id);
      if (card) {
        card.mode = 'collection';
        card.lastModified = new Date().toISOString();
        await db.saveCard(card);
        toast('Card moved to collection', 'success');
        await refreshListings();
        window.dispatchEvent(new CustomEvent('refresh-collection'));
      }
      return;
    }

    // Delete Card button (soft delete → trash)
    const delBtn = e.target.closest('.listing-delete-btn');
    if (delBtn) {
      e.stopPropagation();
      if (window.confirm('Are you sure you want to delete this card?')) {
        await db.softDeleteCard(delBtn.dataset.id);
        await refreshListings();
        toast('Card deleted', 'success');
      }
      return;
    }

    // Inline price edit — click on price to edit
    const priceEl = e.target.closest('.listing-price');
    if (priceEl && !priceEl.querySelector('input')) {
      e.stopPropagation();
      startInlineEdit(priceEl);
      return;
    }

    // Click on listing row — open card detail
    const item = e.target.closest('.listing-item');
    if (item && !e.target.closest('.listing-checkbox')) {
      window.dispatchEvent(new CustomEvent('show-card-detail', { detail: { id: item.dataset.id } }));
    }
  });
}

export async function refreshListings() {
  listings = await db.getCardsByMode('listing');
  listings.sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded));
  selectedIds.clear();
  listingsShown = LISTINGS_PAGE_SIZE;
  render();
}

function getFilteredListings() {
  let filtered = listings;
  if (statusFilter !== 'all') {
    filtered = filtered.filter(c => c.status === statusFilter);
  }
  if (listingsSearchQuery) {
    filtered = filtered.filter(c => {
      const searchable = [c.player, c.team, c.brand, c.setName, c.year, c.parallel, c.cardNumber, c.ebayTitle, c.notes]
        .filter(Boolean).join(' ').toLowerCase();
      return searchable.includes(listingsSearchQuery);
    });
  }
  return filtered;
}

function render() {
  const container = $('#listings-list');
  const countBadge = $('#listings-count');
  const selectAll = $('#listings-select-all');

  const filtered = getFilteredListings();
  countBadge.textContent = listings.length;

  // Update filter counts
  updateFilterCounts();

  if (filtered.length === 0) {
    if (listings.length === 0) {
      container.innerHTML = `<div class="empty-state-rich">
        <div class="empty-state-icon">&#128179;</div>
        <div class="empty-state-title">No listings yet</div>
        <div class="empty-state-desc">Scan cards in "List It" mode to start building your listing queue.</div>
      </div>`;
    } else {
      container.innerHTML = `<p class="empty-state">No listings match this filter.</p>`;
    }
    selectAll.checked = false;
    updateBulkButtons();
    return;
  }

  const visible = filtered.slice(0, listingsShown);

  container.innerHTML = visible.map(card => {
    const statusBadge = getStatusBadge(card.status);
    return `
    <div class="listing-item" data-id="${card.id}">
      <input type="checkbox" class="listing-checkbox" data-id="${card.id}" ${selectedIds.has(card.id) ? 'checked' : ''}>
      ${card.imageThumbnail
        ? `<img src="${card.imageThumbnail}" alt="Card" loading="lazy">`
        : '<div class="no-image-placeholder">No img</div>'}
      <div class="listing-info">
        <div class="title">${escapeHtml(card.ebayTitle || cardDisplayName(card))}</div>
        <div class="meta">${escapeHtml(cardDetailLine(card))}${statusBadge}</div>
      </div>
      <div class="listing-price" data-id="${card.id}" title="Tap to edit">${card.startPrice ? '$' + Number(card.startPrice).toFixed(2) : ''}</div>
      <div class="listing-actions">
        ${card.status !== 'listed' && card.status !== 'sold' ? `<button class="listing-text-btn listing-ebay-btn" data-id="${card.id}">List It</button>` : ''}
        <button class="listing-text-btn listing-move-btn" data-id="${card.id}">Move to Collection</button>
        <button class="listing-text-btn listing-delete-btn" data-id="${card.id}">Delete Card</button>
      </div>
    </div>
  `;
  }).join('');

  // Load more button
  if (filtered.length > listingsShown) {
    const remaining = filtered.length - listingsShown;
    container.innerHTML += `<div class="load-more-sentinel"><button class="btn btn-secondary btn-sm" id="btn-listings-load-more">Show More (${remaining} remaining)</button></div>`;
    document.getElementById('btn-listings-load-more').addEventListener('click', () => {
      listingsShown += LISTINGS_PAGE_SIZE;
      render();
    });
  }

  updateBulkButtons();
}

function getStatusBadge(status) {
  const badges = {
    pending: '',
    listed: ' <span class="status-badge status-listed">Listed</span>',
    sold: ' <span class="status-badge status-sold">Sold</span>',
    unsold: ' <span class="status-badge status-unsold">Unsold</span>',
    exported: ' <span class="status-badge status-exported">Exported</span>',
  };
  return badges[status] || '';
}

function updateFilterCounts() {
  const counts = { all: listings.length, pending: 0, listed: 0, sold: 0, unsold: 0 };
  for (const card of listings) {
    if (counts[card.status] !== undefined) counts[card.status]++;
  }
  const container = $('#listings-status-filters');
  if (!container) return;
  container.querySelectorAll('.pill').forEach(pill => {
    const status = pill.dataset.status;
    const count = counts[status];
    const label = pill.dataset.label || status;
    pill.textContent = count > 0 ? `${label} (${count})` : label;
  });
}

function toggleSelectAll() {
  const selectAll = $('#listings-select-all');
  const filtered = getFilteredListings();
  if (selectAll.checked) {
    filtered.forEach(l => selectedIds.add(l.id));
  } else {
    selectedIds.clear();
  }
  render();
}

function updateBulkButtons() {
  const deleteBtn = $('#btn-delete-selected');
  const moveBtn = $('#btn-move-to-collection');
  if (selectedIds.size > 0) {
    deleteBtn.classList.remove('hidden');
    deleteBtn.textContent = `Delete (${selectedIds.size})`;
    moveBtn.classList.remove('hidden');
  } else {
    deleteBtn.classList.add('hidden');
    moveBtn.classList.add('hidden');
  }
}

async function deleteSelected() {
  const confirmed = await confirm('Delete Selected', `Move ${selectedIds.size} listing(s) to trash?`);
  if (confirmed) {
    const count = selectedIds.size;
    await db.softDeleteCards([...selectedIds]);
    await refreshListings();
    toast(`${count} listing(s) moved to trash`, 'success');
  }
}

async function moveSelectedToCollection() {
  const count = selectedIds.size;
  for (const id of selectedIds) {
    const card = await db.getCard(id);
    if (card) {
      card.mode = 'collection';
      card.lastModified = new Date().toISOString();
      await db.saveCard(card);
    }
  }
  await refreshListings();
  toast(`${count} card(s) moved to collection`, 'success');
  window.dispatchEvent(new CustomEvent('refresh-collection'));
}

// ===== Inline Price Edit =====

function startInlineEdit(priceEl) {
  const cardId = priceEl.dataset.id;
  const card = listings.find(c => c.id === cardId);
  if (!card) return;

  const currentPrice = card.startPrice || 0.99;
  const input = document.createElement('input');
  input.type = 'number';
  input.step = '0.01';
  input.value = currentPrice;
  input.className = 'inline-price-input';
  input.min = '0.01';

  priceEl.textContent = '';
  priceEl.appendChild(input);
  input.focus();
  input.select();

  let cancelled = false;

  const save = async () => {
    if (cancelled) return;
    const newPrice = parseFloat(input.value) || currentPrice;
    card.startPrice = newPrice;
    card.lastModified = new Date().toISOString();
    await db.saveCard(card);
    priceEl.textContent = '$' + Number(newPrice).toFixed(2);
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') {
      cancelled = true;
      priceEl.textContent = '$' + Number(currentPrice).toFixed(2);
      input.blur();
    }
  });
}

// ===== eBay CSV Export =====

async function exportCSV() {
  const cardsToExport = selectedIds.size > 0
    ? listings.filter(c => selectedIds.has(c.id))
    : listings;

  if (cardsToExport.length === 0) {
    toast('No listings to export', 'warning');
    return;
  }

  const headers = [
    'Action(SiteID=US|Country=US|Currency=USD|Version=1193)',
    'Category',
    'Title',
    'ConditionID',
    'C:Sport',
    'C:Player/Athlete',
    'C:Team',
    'C:Manufacturer',
    'C:Set',
    'C:Season',
    'C:Card Number',
    'C:Parallel/Variety',
    'C:Features',
    'C:Graded',
    'C:Professional Grader',
    'C:Grade',
    'Format',
    'StartPrice',
    'Duration',
    'Description'
  ];

  const rows = cardsToExport.map(card => {
    const conditionMap = {
      'Near Mint or Better': '4000',
      'Excellent': '5000',
      'Very Good': '6000',
      'Good': '7000',
      'Fair': '7000',
      'Poor': '7000'
    };

    const features = [];
    if (card.attributes) features.push(...card.attributes);
    if (card.subset && card.subset.toLowerCase() !== 'base') features.push(card.subset);

    return [
      'Draft',
      '261328',
      card.ebayTitle || '',
      card.graded === 'Yes' ? '2750' : (conditionMap[card.condition] || '4000'),
      card.sport || '',
      card.player || '',
      card.team || '',
      card.brand || '',
      card.setName || '',
      card.year || '',
      card.cardNumber || '',
      card.parallel || '',
      features.join(', '),
      card.graded === 'Yes' ? 'Yes' : 'No',
      card.gradeCompany || '',
      card.gradeValue || '',
      'Auction',
      card.startPrice || '0.99',
      '7',
      buildDescription(card)
    ];
  });

  const csvContent = [headers, ...rows]
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');

  // Mark exported cards
  for (const card of cardsToExport) {
    if (card.status === 'pending') {
      card.status = 'exported';
      card.lastModified = new Date().toISOString();
      await db.saveCard(card);
    }
  }

  // Download
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `card-listings-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);

  toast(`Exported ${cardsToExport.length} listing(s)`, 'success');
  await refreshListings();
}

function buildDescription(card) {
  const lines = [];
  lines.push(`${card.year || ''} ${card.brand || ''} ${card.setName || ''}`);
  if (card.player) lines.push(`Player: ${card.player}`);
  if (card.team) lines.push(`Team: ${card.team}`);
  if (card.cardNumber) lines.push(`Card #${card.cardNumber}`);
  if (card.parallel) lines.push(`Parallel: ${card.parallel}`);
  if (card.serialNumber) lines.push(`Serial: ${card.serialNumber}`);
  if (card.condition) lines.push(`Condition: ${card.condition}`);
  return lines.join(' | ');
}

// ===== Swipe to Delete =====

function initSwipeToDelete() {
  const container = $('#listings-list');
  let touchStartX = 0;
  let touchStartY = 0;
  let activeItem = null;
  let swiping = false;

  container.addEventListener('touchstart', (e) => {
    const item = e.target.closest('.listing-item');
    if (!item) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    activeItem = item;
    swiping = false;
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (!activeItem) return;
    const dx = e.touches[0].clientX - touchStartX;
    const dy = e.touches[0].clientY - touchStartY;

    // Only swipe horizontally
    if (!swiping && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
      swiping = true;
    }

    if (swiping && dx < 0) {
      const offset = Math.max(dx, -100);
      activeItem.style.transform = `translateX(${offset}px)`;
      activeItem.style.transition = 'none';

      // Show delete indicator
      if (!activeItem.querySelector('.swipe-delete-bg')) {
        const bg = document.createElement('div');
        bg.className = 'swipe-delete-bg';
        bg.innerHTML = '&#128465; Delete';
        activeItem.style.position = 'relative';
        activeItem.style.overflow = 'visible';
        activeItem.appendChild(bg);
      }
    }
  }, { passive: true });

  container.addEventListener('touchend', async (e) => {
    if (!activeItem) return;
    const dx = e.changedTouches[0].clientX - touchStartX;

    if (swiping && dx < -80) {
      // Swiped far enough — delete
      const id = activeItem.dataset.id;
      activeItem.style.transition = 'transform 0.2s, opacity 0.2s';
      activeItem.style.transform = 'translateX(-100%)';
      activeItem.style.opacity = '0';
      setTimeout(async () => {
        await db.softDeleteCard(id);
        await refreshListings();
        toast('Listing moved to trash', 'success');
      }, 200);
    } else if (swiping) {
      // Snap back
      activeItem.style.transition = 'transform 0.2s';
      activeItem.style.transform = '';
      const bg = activeItem.querySelector('.swipe-delete-bg');
      if (bg) bg.remove();
    }

    activeItem = null;
    swiping = false;
  }, { passive: true });
}

