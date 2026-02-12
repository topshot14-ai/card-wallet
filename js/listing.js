// Listing queue management and eBay CSV export

import * as db from './db.js';
import { toast, confirm, showView, $ } from './ui.js';
import { cardDisplayName, cardDetailLine } from './card-model.js';

let listings = [];
let selectedIds = new Set();

export async function initListings() {
  await refreshListings();

  // Event listeners
  $('#btn-export-csv').addEventListener('click', exportCSV);
  $('#listings-select-all').addEventListener('click', toggleSelectAll);
  $('#btn-delete-selected').addEventListener('click', deleteSelected);
}

export async function refreshListings() {
  listings = await db.getCardsByMode('listing');
  listings.sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded));
  selectedIds.clear();
  render();
}

function render() {
  const container = $('#listings-list');
  const countBadge = $('#listings-count');
  const deleteBtn = $('#btn-delete-selected');
  const selectAll = $('#listings-select-all');

  countBadge.textContent = listings.length;

  if (listings.length === 0) {
    container.innerHTML = '<p class="empty-state">No listings yet. Scan cards in "List It" mode to add them here.</p>';
    deleteBtn.classList.add('hidden');
    selectAll.checked = false;
    return;
  }

  container.innerHTML = listings.map(card => `
    <div class="listing-item" data-id="${card.id}">
      <input type="checkbox" class="listing-checkbox" data-id="${card.id}" ${selectedIds.has(card.id) ? 'checked' : ''}>
      ${card.imageThumbnail
        ? `<img src="${card.imageThumbnail}" alt="Card">`
        : '<div class="no-image-placeholder">No img</div>'}
      <div class="listing-info">
        <div class="title">${escapeHtml(card.ebayTitle || cardDisplayName(card))}</div>
        <div class="meta">${escapeHtml(cardDetailLine(card))}</div>
      </div>
      <div class="listing-price">${card.startPrice ? '$' + Number(card.startPrice).toFixed(2) : ''}</div>
      <div class="listing-actions">
        <button class="listing-action-btn listing-view-btn" data-id="${card.id}" title="View">&#128065;</button>
        <button class="listing-action-btn listing-delete-btn" data-id="${card.id}" title="Delete">&#128465;</button>
      </div>
    </div>
  `).join('');

  // Checkbox listeners
  container.querySelectorAll('.listing-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      const id = cb.dataset.id;
      if (cb.checked) {
        selectedIds.add(id);
      } else {
        selectedIds.delete(id);
      }
      updateDeleteBtn();
    });
  });

  // View buttons
  container.querySelectorAll('.listing-view-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent('show-card-detail', { detail: { id: btn.dataset.id } }));
    });
  });

  // Delete buttons
  container.querySelectorAll('.listing-delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const confirmed = await confirm('Delete Card', 'Remove this listing?');
      if (confirmed) {
        await db.deleteCard(btn.dataset.id);
        await refreshListings();
        toast('Listing removed', 'success');
      }
    });
  });

  updateDeleteBtn();
}

function toggleSelectAll() {
  const selectAll = $('#listings-select-all');
  if (selectAll.checked) {
    listings.forEach(l => selectedIds.add(l.id));
  } else {
    selectedIds.clear();
  }
  render();
}

function updateDeleteBtn() {
  const deleteBtn = $('#btn-delete-selected');
  if (selectedIds.size > 0) {
    deleteBtn.classList.remove('hidden');
    deleteBtn.textContent = `Delete Selected (${selectedIds.size})`;
  } else {
    deleteBtn.classList.add('hidden');
  }
}

async function deleteSelected() {
  const confirmed = await confirm('Delete Selected', `Remove ${selectedIds.size} listing(s)?`);
  if (confirmed) {
    await db.deleteCards([...selectedIds]);
    await refreshListings();
    toast(`${selectedIds.size} listing(s) removed`, 'success');
  }
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

  // Download
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `card-listings-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);

  toast(`Exported ${cardsToExport.length} listing(s)`, 'success');
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
