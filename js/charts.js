// Shared Canvas-based chart utilities for Dashboard and Comps

/**
 * Set up a canvas for retina/HiDPI displays.
 * Returns the 2D context with correct scaling applied.
 */
export function setupCanvas(canvas, w, h) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return ctx;
}

/** Detect dark mode from document data-theme attribute */
function isDark() {
  return document.documentElement.getAttribute('data-theme') === 'dark';
}

/** Get theme-aware colors */
function getColors() {
  const dark = isDark();
  return {
    text: dark ? '#e5e7eb' : '#374151',
    textSecondary: dark ? '#9ca3af' : '#6b7280',
    gridLine: dark ? '#374151' : '#e5e7eb',
    bg: dark ? '#1f2937' : '#ffffff',
    primary: dark ? '#3b82f6' : '#2563eb',
    primaryLight: dark ? 'rgba(59,130,246,0.15)' : 'rgba(37,99,235,0.1)',
    success: dark ? '#22c55e' : '#16a34a',
    successLight: dark ? 'rgba(34,197,94,0.15)' : 'rgba(22,163,74,0.1)',
    danger: dark ? '#ef4444' : '#dc2626',
    dangerLight: dark ? 'rgba(239,68,68,0.15)' : 'rgba(220,38,38,0.1)',
  };
}

/**
 * Draw a line chart with gradient fill, dots, gridlines, and Y-axis labels.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Object} options
 * @param {Array<{x: number|string, y: number}>} options.data - data points
 * @param {string} [options.color] - line color override
 * @param {string} [options.fillColor] - gradient fill color override
 * @param {boolean} [options.showDots=true] - show data point dots
 * @param {boolean} [options.showGrid=true] - show horizontal gridlines
 * @param {boolean} [options.showLabels=true] - show Y-axis labels
 * @param {boolean} [options.showXLabels=false] - show X-axis labels
 * @param {string[]} [options.xLabels] - custom X-axis labels
 * @param {number} [options.yMin] - force minimum Y
 * @param {number} [options.yMax] - force maximum Y
 * @param {string} [options.prefix='$'] - value prefix for labels
 * @param {number} [options.width] - canvas width
 * @param {number} [options.height] - canvas height
 */
export function drawLineChart(canvas, options = {}) {
  const {
    data = [],
    showDots = true,
    showGrid = true,
    showLabels = true,
    showXLabels = false,
    xLabels = null,
    prefix = '$',
    width = canvas.parentElement?.clientWidth || 300,
    height = 180,
  } = options;

  if (data.length < 2) return;

  const colors = getColors();
  const color = options.color || colors.primary;
  const fillColor = options.fillColor || colors.primaryLight;

  const ctx = setupCanvas(canvas, width, height);

  const padding = { top: 10, right: 12, bottom: showXLabels ? 28 : 10, left: showLabels ? 48 : 10 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const yValues = data.map(d => d.y);
  const rawMin = options.yMin !== undefined ? options.yMin : Math.min(...yValues);
  const rawMax = options.yMax !== undefined ? options.yMax : Math.max(...yValues);
  const yRange = rawMax - rawMin || 1;
  const yMin = rawMin - yRange * 0.05;
  const yMax = rawMax + yRange * 0.05;

  const toX = (i) => padding.left + (i / (data.length - 1)) * chartW;
  const toY = (v) => padding.top + chartH - ((v - yMin) / (yMax - yMin)) * chartH;

  // Gridlines
  if (showGrid) {
    ctx.strokeStyle = colors.gridLine;
    ctx.lineWidth = 0.5;
    const gridCount = 4;
    for (let i = 0; i <= gridCount; i++) {
      const y = padding.top + (i / gridCount) * chartH;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
    }
  }

  // Y-axis labels
  if (showLabels) {
    ctx.fillStyle = colors.textSecondary;
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const gridCount = 4;
    for (let i = 0; i <= gridCount; i++) {
      const val = yMax - (i / gridCount) * (yMax - yMin);
      const y = padding.top + (i / gridCount) * chartH;
      const label = val >= 1000 ? `${prefix}${(val / 1000).toFixed(1)}k` : `${prefix}${val.toFixed(val < 10 ? 2 : 0)}`;
      ctx.fillText(label, padding.left - 6, y);
    }
  }

  // X-axis labels
  if (showXLabels && xLabels) {
    ctx.fillStyle = colors.textSecondary;
    ctx.font = '9px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const maxLabels = Math.min(xLabels.length, 6);
    const step = Math.max(1, Math.floor(xLabels.length / maxLabels));
    for (let i = 0; i < xLabels.length; i += step) {
      ctx.fillText(xLabels[i], toX(i), height - padding.bottom + 6);
    }
  }

  // Gradient fill
  const gradient = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
  gradient.addColorStop(0, fillColor);
  gradient.addColorStop(1, 'transparent');

  ctx.beginPath();
  ctx.moveTo(toX(0), toY(data[0].y));
  for (let i = 1; i < data.length; i++) {
    ctx.lineTo(toX(i), toY(data[i].y));
  }
  ctx.lineTo(toX(data.length - 1), height - padding.bottom);
  ctx.lineTo(toX(0), height - padding.bottom);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(data[0].y));
  for (let i = 1; i < data.length; i++) {
    ctx.lineTo(toX(i), toY(data[i].y));
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Dots
  if (showDots && data.length <= 60) {
    for (let i = 0; i < data.length; i++) {
      ctx.beginPath();
      ctx.arc(toX(i), toY(data[i].y), 3, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = colors.bg;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

/**
 * Draw a bar chart with positive (green) / negative (red) bars.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Object} options
 * @param {Array<{label: string, value: number}>} options.data
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {string} [options.prefix='$']
 */
export function drawBarChart(canvas, options = {}) {
  const {
    data = [],
    prefix = '$',
    width = canvas.parentElement?.clientWidth || 300,
    height = 160,
  } = options;

  if (data.length === 0) return;

  const colors = getColors();
  const ctx = setupCanvas(canvas, width, height);

  const padding = { top: 10, right: 12, bottom: 28, left: 48 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const values = data.map(d => d.value);
  const maxVal = Math.max(...values.map(Math.abs), 1);

  const barWidth = Math.min(chartW / data.length * 0.7, 32);
  const barGap = (chartW - barWidth * data.length) / (data.length + 1);

  // Determine if we need a zero line (mixed positive/negative)
  const hasNeg = values.some(v => v < 0);
  const hasPos = values.some(v => v > 0);
  const zeroY = hasNeg && hasPos
    ? padding.top + chartH * (maxVal / (maxVal * 2))
    : hasNeg ? padding.top : padding.top + chartH;

  // Gridlines
  ctx.strokeStyle = colors.gridLine;
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (i / 4) * chartH;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
  }

  // Zero line
  if (hasNeg && hasPos) {
    ctx.strokeStyle = colors.textSecondary;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, zeroY);
    ctx.lineTo(width - padding.right, zeroY);
    ctx.stroke();
  }

  // Bars
  for (let i = 0; i < data.length; i++) {
    const val = data[i].value;
    const x = padding.left + barGap + i * (barWidth + barGap);
    const barH = (Math.abs(val) / maxVal) * (hasNeg && hasPos ? chartH / 2 : chartH);

    const isPos = val >= 0;
    ctx.fillStyle = isPos ? colors.success : colors.danger;

    if (isPos) {
      ctx.fillRect(x, zeroY - barH, barWidth, barH);
    } else {
      ctx.fillRect(x, zeroY, barWidth, barH);
    }

    // X labels
    ctx.fillStyle = colors.textSecondary;
    ctx.font = '9px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(data[i].label, x + barWidth / 2, height - padding.bottom + 6);
  }

  // Y-axis labels
  ctx.fillStyle = colors.textSecondary;
  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const y = padding.top + (i / ySteps) * chartH;
    const range = hasNeg && hasPos ? maxVal * 2 : maxVal;
    const val = hasNeg && hasPos ? maxVal - (i / ySteps) * range : maxVal - (i / ySteps) * range;
    const label = val >= 1000 ? `${prefix}${(val / 1000).toFixed(1)}k` : `${prefix}${val.toFixed(0)}`;
    ctx.fillText(label, padding.left - 6, y);
  }
}

/**
 * Draw a donut chart with hollow center and optional center text.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{label: string, value: number, color: string}>} segments
 * @param {string} [centerText] - text to display in the center
 * @param {Object} [opts]
 * @param {number} [opts.width]
 * @param {number} [opts.height]
 * @param {boolean} [opts.showLegend=true]
 */
export function drawDonutChart(canvas, segments, centerText = '', opts = {}) {
  const {
    width = canvas.parentElement?.clientWidth || 200,
    height = 200,
    showLegend = true,
  } = opts;

  if (!segments || segments.length === 0) return;

  const colors = getColors();
  const ctx = setupCanvas(canvas, width, height);

  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (total === 0) return;

  const legendWidth = showLegend ? 100 : 0;
  const chartSize = Math.min(width - legendWidth, height) - 20;
  const cx = (width - legendWidth) / 2;
  const cy = height / 2;
  const outerR = chartSize / 2;
  const innerR = outerR * 0.6;

  let startAngle = -Math.PI / 2;

  for (const seg of segments) {
    const sliceAngle = (seg.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, startAngle, startAngle + sliceAngle);
    ctx.arc(cx, cy, innerR, startAngle + sliceAngle, startAngle, true);
    ctx.closePath();
    ctx.fillStyle = seg.color;
    ctx.fill();
    startAngle += sliceAngle;
  }

  // Center text
  if (centerText) {
    ctx.fillStyle = colors.text;
    ctx.font = '600 16px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(centerText, cx, cy);
  }

  // Legend
  if (showLegend) {
    const legendX = width - legendWidth + 8;
    let legendY = Math.max(20, cy - segments.length * 10);
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    for (const seg of segments) {
      // Color dot
      ctx.beginPath();
      ctx.arc(legendX, legendY, 4, 0, Math.PI * 2);
      ctx.fillStyle = seg.color;
      ctx.fill();

      // Label
      ctx.fillStyle = colors.textSecondary;
      const pct = Math.round((seg.value / total) * 100);
      ctx.fillText(`${seg.label} (${pct}%)`, legendX + 10, legendY);
      legendY += 20;
    }
  }
}

/** Sport color palette */
export const SPORT_COLORS = {
  Baseball: '#c0392b',
  Basketball: '#e67e22',
  Football: '#27ae60',
  Hockey: '#2980b9',
  Soccer: '#8e44ad',
  Other: '#7f8c8d',
};
