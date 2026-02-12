// Collection grid, search, filter, sort

import * as db from './db.js';
import { cardDisplayName, cardDetailLine } from './card-model.js';
import { $, $$ } from './ui.js';

let allCards = [];
let filteredCards = [];
let currentFilter = 'all';
let currentSort = 'dateAdded-desc';
let searchQuery = '';

export async function initCollection() {
  // Search
  $('#collection-search').addEventListener('input', (e) => {
    searchQuery = e.target.value.trim().toLowerCase();
    applyFilters();
  });

  // Filter pills
  $('#filter-pills').addEventListener('click', (e) => {
    const pill = e.target.closest('.pill');
    if (!pill) return;
    $$('.pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    currentFilter = pill.dataset.filter;
    applyFilters();
  });

  // Sort
  $('#collection-sort').addEventListener('change', (e) => {
    currentSort = e.target.value;
    applyFilters();
  });

  await refreshCollection();
}

export async function refreshCollection() {
  allCards = await db.getCardsByMode('collection');
  $('#collection-count').textContent = allCards.length;
  applyFilters();
}

function applyFilters() {
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
    let aVal = a[field] || '';
    let bVal = b[field] || '';

    if (field === 'dateAdded') {
      aVal = new Date(aVal).getTime();
      bVal = new Date(bVal).getTime();
    } else {
      aVal = String(aVal).toLowerCase();
      bVal = String(bVal).toLowerCase();
    }

    if (aVal < bVal) return dir === 'asc' ? -1 : 1;
    if (aVal > bVal) return dir === 'asc' ? 1 : -1;
    return 0;
  });

  renderGrid();
}

function renderGrid() {
  const grid = $('#collection-grid');

  if (filteredCards.length === 0) {
    const msg = allCards.length === 0
      ? 'Your collection is empty. Scan cards in "Collect It" mode to add them here.'
      : 'No cards match your search.';
    grid.innerHTML = `<p class="empty-state" style="grid-column: 1/-1">${msg}</p>`;
    return;
  }

  grid.innerHTML = filteredCards.map(card => {
    let valueBadge = '';
    if (card.estimatedValueLow && card.estimatedValueHigh) {
      valueBadge = `<span class="card-tile-value">$${Number(card.estimatedValueLow).toFixed(0)}–$${Number(card.estimatedValueHigh).toFixed(0)}</span>`;
    } else if (card.estimatedValueLow) {
      valueBadge = `<span class="card-tile-value">~$${Number(card.estimatedValueLow).toFixed(0)}</span>`;
    }
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

  // Click handler for card detail
  grid.querySelectorAll('.card-tile').forEach(tile => {
    tile.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('show-card-detail', { detail: { id: tile.dataset.id } }));
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
