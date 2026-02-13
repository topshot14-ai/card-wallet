// Dashboard — P&L, portfolio value, recent activity, best/worst flips

import * as db from './db.js';
import { formatDate, $ } from './ui.js';
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
  const listings = all.filter(c => c.mode === 'listing');
  const collection = all.filter(c => c.mode === 'collection');
  const sold = listings.filter(c => c.status === 'sold');
  const pending = listings.filter(c => c.status === 'pending' || c.status === 'exported' || c.status === 'listed');

  // Calculate stats
  const totalCards = all.length;
  const totalInvested = all.reduce((sum, c) => sum + (c.purchasePrice || 0), 0);
  const totalRevenue = sold.reduce((sum, c) => sum + (c.soldPrice || c.startPrice || 0), 0);
  const netProfit = totalRevenue - sold.reduce((sum, c) => sum + (c.purchasePrice || 0), 0);

  // Portfolio value (estimated value of unsold cards)
  const portfolioValue = all
    .filter(c => c.status !== 'sold')
    .reduce((sum, c) => {
      if (c.estimatedValueLow && c.estimatedValueHigh) {
        return sum + (c.estimatedValueLow + c.estimatedValueHigh) / 2;
      }
      if (c.estimatedValueLow) return sum + c.estimatedValueLow;
      if (c.startPrice && c.mode === 'listing') return sum + c.startPrice;
      return sum;
    }, 0);

  // Pending listing value
  const pendingValue = pending.reduce((sum, c) => sum + (c.startPrice || 0), 0);

  // Best and worst flips (sold cards with purchase price)
  const flips = sold
    .filter(c => c.purchasePrice && c.soldPrice)
    .map(c => ({ ...c, profit: (c.soldPrice || 0) - c.purchasePrice }))
    .sort((a, b) => b.profit - a.profit);

  const bestFlips = flips.slice(0, 3);
  const worstFlips = flips.length > 0 ? flips.slice(-3).reverse() : [];

  // Recent activity (last 10 cards by lastModified)
  const recent = [...all]
    .sort((a, b) => new Date(b.lastModified || b.dateAdded) - new Date(a.lastModified || a.dateAdded))
    .slice(0, 8);

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
        <div class="dash-metric-value">$${portfolioValue.toFixed(0)}</div>
        <div class="dash-metric-label">Portfolio Value</div>
      </div>
      <div class="dash-metric">
        <div class="dash-metric-value">${sold.length}</div>
        <div class="dash-metric-label">Cards Sold</div>
      </div>
      <div class="dash-metric">
        <div class="dash-metric-value ${netProfit >= 0 ? 'profit-positive' : 'profit-negative'}">
          ${netProfit >= 0 ? '+' : ''}$${netProfit.toFixed(2)}
        </div>
        <div class="dash-metric-label">Net Profit</div>
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
          <span>Pending Listings (${pending.length})</span>
          <span>$${pendingValue.toFixed(2)}</span>
        </div>
        <div class="dash-pl-row dash-pl-total ${netProfit >= 0 ? 'profit-positive' : 'profit-negative'}">
          <span>Net Profit</span>
          <span>${netProfit >= 0 ? '+' : ''}$${netProfit.toFixed(2)}</span>
        </div>
      </div>
    </div>

    ${bestFlips.length > 0 ? `
    <!-- Best Flips -->
    <div class="dash-section">
      <h3>Best Flips</h3>
      <div class="dash-flip-list">
        ${bestFlips.map(c => `
          <div class="dash-flip-item" data-card-id="${c.id}">
            <span class="dash-flip-name">${escapeHtml(cardDisplayName(c))}</span>
            <span class="dash-flip-profit profit-positive">+$${c.profit.toFixed(2)}</span>
          </div>
        `).join('')}
      </div>
    </div>
    ` : ''}

    ${worstFlips.length > 0 && worstFlips.some(c => c.profit < 0) ? `
    <!-- Worst Flips -->
    <div class="dash-section">
      <h3>Worst Flips</h3>
      <div class="dash-flip-list">
        ${worstFlips.filter(c => c.profit < 0).map(c => `
          <div class="dash-flip-item" data-card-id="${c.id}">
            <span class="dash-flip-name">${escapeHtml(cardDisplayName(c))}</span>
            <span class="dash-flip-profit profit-negative">-$${Math.abs(c.profit).toFixed(2)}</span>
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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
