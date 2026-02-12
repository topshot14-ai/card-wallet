// Listing queue management and eBay CSV export

import * as db from './db.js';
import { toast, confirm, showView, $ } from './ui.js';
import { cardDisplayName, cardDetailLine } from './card-model.js';

let listings = [];
let selectedIds = new Set();
let statusFilter = 'all'; // 'all', 'pending', 'listed', 'sold', 'unsold'

export async function initListings() {
  await refreshListings();

  // Static event listeners (once)
  $('#btn-export-csv').addEventListener('click', exportCSV);
  $('#listings-select-all').addEventListener('click', toggleSelectAll);
  $('#btn-delete-selected').addEventListener('click', deleteSelected);
  $('#btn-move-to-collection').addEventListener('click', moveSelectedToCollection);

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
    // View button
    const viewBtn = e.target.closest('.listing-view-btn');
    if (viewBtn) {
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent('show-card-detail', { detail: { id: viewBtn.dataset.id } }));
      return;
    }

    // Delete button
    const delBtn = e.target.closest('.listing-delete-btn');
    if (delBtn) {
      e.stopPropagation();
      const confirmed = await confirm('Delete Card', 'Remove this listing?');
      if (confirmed) {
        await db.deleteCard(delBtn.dataset.id);
        await refreshListings();
        toast('Listing removed', 'success');
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
  });
}

export async function refreshListings() {
  listings = await db.getCardsByMode('listing');
  listings.sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded));
  selectedIds.clear();
  render();
}

function getFilteredListings() {
  if (statusFilter === 'all') return listings;
  return listings.filter(c => c.status === statusFilter);
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
    const msg = listings.length === 0
      ? 'No listings yet. Scan cards in "List It" mode to add them here.'
      : 'No listings match this filter.';
    container.innerHTML = `<p class="empty-state">${msg}</p>`;
    selectAll.checked = false;
    updateBulkButtons();
    return;
  }

  container.innerHTML = filtered.map(card => {
    const statusBadge = getStatusBadge(card.status);
    return `
    <div class="listing-item" data-id="${card.id}">
      <input type="checkbox" class="listing-checkbox" data-id="${card.id}" ${selectedIds.has(card.id) ? 'checked' : ''}>
      ${card.imageThumbnail
        ? `<img src="${card.imageThumbnail}" alt="Card">`
        : '<div class="no-image-placeholder">No img</div>'}
      <div class="listing-info">
        <div class="title">${escapeHtml(card.ebayTitle || cardDisplayName(card))}</div>
        <div class="meta">${escapeHtml(cardDetailLine(card))}${statusBadge}</div>
      </div>
      <div class="listing-price" data-id="${card.id}" title="Tap to edit">${card.startPrice ? '$' + Number(card.startPrice).toFixed(2) : ''}</div>
      <div class="listing-actions">
        <button class="listing-action-btn listing-view-btn" data-id="${card.id}" title="View">&#128065;</button>
        <button class="listing-action-btn listing-delete-btn" data-id="${card.id}" title="Delete">&#128465;</button>
      </div>
    </div>
  `;
  }).join('');

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
  const confirmed = await confirm('Delete Selected', `Remove ${selectedIds.size} listing(s)?`);
  if (confirmed) {
    const count = selectedIds.size;
    await db.deleteCards([...selectedIds]);
    await refreshListings();
    toast(`${count} listing(s) removed`, 'success');
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

  const save = async () => {
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
      priceEl.textContent = '$' + Number(currentPrice).toFixed(2);
    }
  });
}

// ===== eBay CSV Export =====

function exportCSV() {
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
  cardsToExport.forEach(async (card) => {
    if (card.status === 'pending') {
      card.status = 'exported';
      card.lastModified = new Date().toISOString();
      await db.saveCard(card);
    }
  });

  // Download
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `card-listings-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);

  toast(`Exported ${cardsToExport.length} listing(s)`, 'success');
  refreshListings();
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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
