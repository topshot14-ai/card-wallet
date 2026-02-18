// Dashboard — seller-focused metrics, P&L, sold history, recent activity

import * as db from './db.js';
import { formatDate, $, escapeHtml } from './ui.js';
import { cardDisplayName } from './card-model.js';

export async function initDashboard() {
  // Event delegation for card clicks in dashboard
  const content = document.getElementById('dashboard-content');
  if (content) {
    content.addEventListener('click', (e) => {
      const item = e.target.closest('[data-card-id]');
      if (item) {
        window.dispatchEvent(new CustomEvent('show-card-detail', { detail: { id: item.dataset.cardId } }));
      }
    });
  }
}

export async function refreshDashboard() {
  const all = await db.getAllCards();
  const collection = all.filter(c => c.mode === 'collection');
  const activeListings = await db.getActiveListings();
  const sold = all.filter(c => c.status === 'sold');

  // Calculate stats
  const totalCards = all.length;
  const totalInvested = all.reduce((sum, c) => sum + (c.purchasePrice || 0), 0);
  const totalRevenue = sold.reduce((sum, c) => sum + (c.soldPrice || 0), 0);
  const activeListingValue = activeListings.reduce((sum, c) => sum + (c.startPrice || 0), 0);
  const netProfit = totalRevenue - sold.reduce((sum, c) => sum + (c.purchasePrice || 0), 0);

  // Sold history (newest first, max 10)
  const soldHistory = [...sold]
    .sort((a, b) => new Date(b.lastModified || b.dateAdded) - new Date(a.lastModified || a.dateAdded))
    .slice(0, 10)
    .map(c => ({ ...c, profit: (c.soldPrice || 0) - (c.purchasePrice || 0) }));

  // Recent activity (last 8 cards by lastModified)
  const recent = [...all]
    .sort((a, b) => new Date(b.lastModified || b.dateAdded) - new Date(a.lastModified || a.dateAdded))
    .slice(0, 8);

  // Update tab badge counts
  updateTabBadges(activeListings.length, collection.length);

  // Render
  const content = document.getElementById('dashboard-content');
  if (!content) return;

  content.innerHTML = `
    <!-- Key Metrics -->
    <div class="dash-metrics">
      <div class="dash-metric">
        <div class="dash-metric-value">${totalCards}</div>
        <div class="dash-metric-label">Total Cards</div>
      </div>
      <div class="dash-metric">
        <div class="dash-metric-value">${activeListings.length}</div>
        <div class="dash-metric-label">Active Listings</div>
      </div>
      <div class="dash-metric">
        <div class="dash-metric-value">${sold.length}</div>
        <div class="dash-metric-label">Total Sold</div>
      </div>
      <div class="dash-metric">
        <div class="dash-metric-value">$${totalRevenue.toFixed(2)}</div>
        <div class="dash-metric-label">Total Revenue</div>
      </div>
    </div>

    <!-- P&L Summary -->
    <div class="dash-section">
      <h3>Profit & Loss</h3>
      <div class="dash-pl-rows">
        <div class="dash-pl-row">
          <span>Total Invested</span>
          <span>$${totalInvested.toFixed(2)}</span>
        </div>
        <div class="dash-pl-row">
          <span>Total Revenue (${sold.length} sales)</span>
          <span>$${totalRevenue.toFixed(2)}</span>
        </div>
        <div class="dash-pl-row">
          <span>Active Listing Value (${activeListings.length})</span>
          <span>$${activeListingValue.toFixed(2)}</span>
        </div>
        <div class="dash-pl-row dash-pl-total ${netProfit >= 0 ? 'profit-positive' : 'profit-negative'}">
          <span>Net Profit</span>
          <span>${netProfit >= 0 ? '+' : ''}$${netProfit.toFixed(2)}</span>
        </div>
      </div>
    </div>

    ${soldHistory.length > 0 ? `
    <!-- Sold History -->
    <div class="dash-section">
      <h3>Sold History</h3>
      <div class="dash-flip-list">
        ${soldHistory.map(c => `
          <div class="dash-flip-item" data-card-id="${c.id}">
            ${c.imageThumbnail ? `<img src="${c.imageThumbnail}" alt="Card" style="width:36px;height:36px;border-radius:6px;object-fit:cover;margin-right:8px">` : ''}
            <span class="dash-flip-name">${escapeHtml(cardDisplayName(c))}</span>
            <span style="margin-left:auto;display:flex;align-items:center;gap:8px">
              <span style="color:var(--text-secondary);font-size:0.85em">$${(c.soldPrice || 0).toFixed(2)}</span>
              <span class="dash-flip-profit ${c.profit >= 0 ? 'profit-positive' : 'profit-negative'}">${c.profit >= 0 ? '+' : ''}$${c.profit.toFixed(2)}</span>
            </span>
          </div>
        `).join('')}
      </div>
    </div>
    ` : ''}

    <!-- Recent Activity -->
    <div class="dash-section">
      <h3>Recent Activity</h3>
      ${recent.length > 0 ? `
        <div class="dash-recent-list">
          ${recent.map(c => `
            <div class="dash-recent-item" data-card-id="${c.id}">
              ${c.imageThumbnail ? `<img src="${c.imageThumbnail}" alt="Card">` : '<div class="dash-recent-placeholder"></div>'}
              <div class="dash-recent-info">
                <div class="dash-recent-name">${escapeHtml(cardDisplayName(c))}</div>
                <div class="dash-recent-meta">${c.mode === 'listing' ? 'Listing' : 'Collection'} &middot; ${formatDate(c.lastModified || c.dateAdded)}</div>
              </div>
            </div>
          `).join('')}
        </div>
      ` : `<div class="empty-state-rich" style="padding:20px 0">
        <div class="empty-state-icon">&#128247;</div>
        <div class="empty-state-title">No cards yet</div>
        <div class="empty-state-desc">Start scanning cards to see your activity here.</div>
      </div>`}
    </div>
  `;
}

function updateTabBadges(listingsCount, collectionCount) {
  // Update tab badges
  document.querySelectorAll('.tab').forEach(tab => {
    const existing = tab.querySelector('.tab-badge');
    if (existing) existing.remove();

    let count = 0;
    if (tab.dataset.view === 'listings' && listingsCount > 0) count = listingsCount;
    if (tab.dataset.view === 'collection' && collectionCount > 0) count = collectionCount;

    if (count > 0) {
      const badge = document.createElement('span');
      badge.className = 'tab-badge';
      badge.textContent = count > 99 ? '99+' : count;
      tab.appendChild(badge);
    }
  });
}

