// Dashboard — seller-focused metrics, P&L, sold history, recent activity, charts

import * as db from './db.js';
import { formatDate, $, escapeHtml } from './ui.js';
import { cardDisplayName } from './card-model.js';
import { drawLineChart, drawBarChart, drawDonutChart, SPORT_COLORS } from './charts.js';

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

/** Save today's portfolio snapshot if not already recorded */
async function recordPortfolioSnapshot(all) {
  const today = new Date().toISOString().split('T')[0];
  let history = [];
  try {
    history = (await db.getSetting('portfolioHistory')) || [];
  } catch { history = []; }

  // Skip if already recorded today
  if (history.length > 0 && history[history.length - 1].date === today) return history;

  // Calculate portfolio value using comp avg or estimated value
  const totalValue = all.reduce((sum, c) => {
    if (c.status === 'sold') return sum;
    if (c.compData && c.compData.avg) return sum + Number(c.compData.avg);
    if (c.estimatedValueLow && c.estimatedValueHigh) return sum + (Number(c.estimatedValueLow) + Number(c.estimatedValueHigh)) / 2;
    return sum;
  }, 0);

  const totalInvested = all.reduce((sum, c) => sum + (c.purchasePrice || 0), 0);
  const count = all.filter(c => c.status !== 'sold').length;

  history.push({ date: today, value: totalValue, count, invested: totalInvested });

  // Cap at 365 entries
  if (history.length > 365) history = history.slice(-365);

  try { await db.setSetting('portfolioHistory', history); } catch {}
  return history;
}

/** Compute monthly P&L from sold cards */
function computeMonthlyPnl(sold) {
  const months = {};
  for (const c of sold) {
    const date = new Date(c.lastModified || c.dateAdded);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    if (!months[key]) months[key] = 0;
    months[key] += (c.soldPrice || 0) - (c.purchasePrice || 0);
  }
  // Sort by month and take last 12
  return Object.entries(months)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12)
    .map(([key, value]) => ({
      label: key.split('-')[1] + '/' + key.split('-')[0].slice(2),
      value
    }));
}

/** Get sport breakdown counts */
function getSportBreakdown(all) {
  const counts = {};
  for (const c of all) {
    const sport = c.sport || 'Other';
    counts[sport] = (counts[sport] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({
      label,
      value,
      color: SPORT_COLORS[label] || SPORT_COLORS.Other
    }));
}

/** Get top cards by value */
function getTopCards(all) {
  return all
    .filter(c => c.status !== 'sold')
    .map(c => {
      let value = 0;
      if (c.compData && c.compData.avg) value = Number(c.compData.avg);
      else if (c.estimatedValueLow && c.estimatedValueHigh) value = (Number(c.estimatedValueLow) + Number(c.estimatedValueHigh)) / 2;
      return { ...c, _value: value };
    })
    .filter(c => c._value > 0)
    .sort((a, b) => b._value - a._value)
    .slice(0, 5);
}

/** Compute performance metrics */
function computePerformanceMetrics(sold, all) {
  const soldCount = sold.length;
  const totalInvested = sold.reduce((sum, c) => sum + (c.purchasePrice || 0), 0);
  const totalRevenue = sold.reduce((sum, c) => sum + (c.soldPrice || 0), 0);
  const netProfit = totalRevenue - totalInvested;
  const roi = totalInvested > 0 ? (netProfit / totalInvested) * 100 : 0;
  const avgProfit = soldCount > 0 ? netProfit / soldCount : 0;

  // Best and worst performers
  const withProfit = sold.map(c => ({
    ...c,
    _profit: (c.soldPrice || 0) - (c.purchasePrice || 0)
  }));
  const best = withProfit.sort((a, b) => b._profit - a._profit)[0] || null;
  const worst = withProfit.sort((a, b) => a._profit - b._profit)[0] || null;

  return { roi, avgProfit, best, worst, soldCount, netProfit };
}

export async function refreshDashboard() {
  const all = await db.getAllCards();
  const collection = all.filter(c => c.mode === 'collection');
  const activeListings = await db.getActiveListings();
  const sold = all.filter(c => c.status === 'sold');

  // Record portfolio snapshot
  const portfolioHistory = await recordPortfolioSnapshot(all);

  // Calculate stats
  const totalCards = all.length;
  const totalInvested = all.reduce((sum, c) => sum + (c.purchasePrice || 0), 0);
  const totalRevenue = sold.reduce((sum, c) => sum + (c.soldPrice || 0), 0);
  const activeListingValue = activeListings.reduce((sum, c) => sum + (c.startPrice || 0), 0);
  const netProfit = totalRevenue - sold.reduce((sum, c) => sum + (c.purchasePrice || 0), 0);

  // Compute new data
  const monthlyPnl = computeMonthlyPnl(sold);
  const sportBreakdown = getSportBreakdown(all);
  const topCards = getTopCards(all);
  const perf = computePerformanceMetrics(sold, all);

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

    <!-- Portfolio Value Chart -->
    ${portfolioHistory.length >= 2 ? `
    <div class="dash-section">
      <h3>Portfolio Value</h3>
      <canvas id="dash-portfolio-chart"></canvas>
    </div>
    ` : ''}

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

    <!-- Monthly P&L Chart -->
    ${monthlyPnl.length >= 2 ? `
    <div class="dash-section">
      <h3>Monthly P&L</h3>
      <canvas id="dash-pnl-chart"></canvas>
    </div>
    ` : ''}

    <!-- Performance Metrics -->
    ${perf.soldCount > 0 ? `
    <div class="dash-section">
      <h3>Performance</h3>
      <div class="dash-perf-grid">
        <div class="dash-perf-item">
          <div class="dash-perf-value ${perf.roi >= 0 ? 'profit-positive' : 'profit-negative'}">${perf.roi >= 0 ? '+' : ''}${perf.roi.toFixed(1)}%</div>
          <div class="dash-perf-label">ROI</div>
        </div>
        <div class="dash-perf-item">
          <div class="dash-perf-value ${perf.avgProfit >= 0 ? 'profit-positive' : 'profit-negative'}">${perf.avgProfit >= 0 ? '+' : ''}$${perf.avgProfit.toFixed(2)}</div>
          <div class="dash-perf-label">Avg Profit/Card</div>
        </div>
        ${perf.best ? `
        <div class="dash-perf-item">
          <div class="dash-perf-value profit-positive">+$${perf.best._profit.toFixed(2)}</div>
          <div class="dash-perf-label" title="${escapeHtml(cardDisplayName(perf.best))}">Best: ${escapeHtml(cardDisplayName(perf.best)).substring(0, 20)}</div>
        </div>
        ` : ''}
        ${perf.worst && perf.worst._profit < 0 ? `
        <div class="dash-perf-item">
          <div class="dash-perf-value profit-negative">$${perf.worst._profit.toFixed(2)}</div>
          <div class="dash-perf-label" title="${escapeHtml(cardDisplayName(perf.worst))}">Worst: ${escapeHtml(cardDisplayName(perf.worst)).substring(0, 20)}</div>
        </div>
        ` : ''}
      </div>
    </div>
    ` : ''}

    <!-- Sport Breakdown -->
    ${sportBreakdown.length > 1 ? `
    <div class="dash-section">
      <h3>Collection by Sport</h3>
      <canvas id="dash-sport-chart"></canvas>
    </div>
    ` : ''}

    <!-- Top Cards -->
    ${topCards.length > 0 ? `
    <div class="dash-section">
      <h3>Top Cards by Value</h3>
      <div class="dash-top-list">
        ${topCards.map((c, i) => `
          <div class="dash-top-item" data-card-id="${c.id}">
            <span class="dash-top-rank">${i + 1}</span>
            ${c.imageThumbnail ? `<img src="${c.imageThumbnail}" alt="Card" class="dash-top-thumb">` : '<div class="dash-top-thumb-placeholder"></div>'}
            <div class="dash-top-info">
              <div class="dash-top-name">${escapeHtml(cardDisplayName(c))}</div>
              <div class="dash-top-detail">${escapeHtml(c.setName || '')} ${c.parallel ? '- ' + escapeHtml(c.parallel) : ''}</div>
            </div>
            <span class="dash-top-value">$${c._value.toFixed(2)}</span>
          </div>
        `).join('')}
      </div>
    </div>
    ` : ''}

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

  // Render charts after DOM is ready
  requestAnimationFrame(() => {
    renderPortfolioChart(portfolioHistory);
    renderPnlChart(monthlyPnl);
    renderSportBreakdown(sportBreakdown);
  });
}

function renderPortfolioChart(history) {
  const canvas = document.getElementById('dash-portfolio-chart');
  if (!canvas || history.length < 2) return;

  const data = history.map(h => ({ x: h.date, y: h.value }));
  const xLabels = history.map(h => {
    const d = new Date(h.date);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  });

  drawLineChart(canvas, {
    data,
    showXLabels: true,
    xLabels,
    color: '#16a34a',
    fillColor: 'rgba(22,163,74,0.1)',
    height: 180,
  });
}

function renderPnlChart(monthlyPnl) {
  const canvas = document.getElementById('dash-pnl-chart');
  if (!canvas || monthlyPnl.length < 2) return;

  drawBarChart(canvas, {
    data: monthlyPnl,
    height: 160,
  });
}

function renderSportBreakdown(segments) {
  const canvas = document.getElementById('dash-sport-chart');
  if (!canvas || segments.length < 2) return;

  const total = segments.reduce((s, seg) => s + seg.value, 0);
  drawDonutChart(canvas, segments, `${total}`, {
    height: 180,
    showLegend: true,
  });
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
