// Shareable card image generation for social media

import { cardDisplayName } from './card-model.js';

const TEMPLATES = {
  clean: { bg: '#ffffff', text: '#1f2937', secondary: '#6b7280', accent: '#2563eb' },
  dark:  { bg: '#0f172a', text: '#f1f5f9', secondary: '#94a3b8', accent: '#3b82f6' },
  minimal: { bg: '#f1f5f9', text: '#334155', secondary: '#64748b', accent: '#6366f1' },
};

/**
 * Generate a branded 1080x1080 share image for a card.
 * @param {Object} card - card object
 * @param {string} template - 'clean', 'dark', or 'minimal'
 * @returns {Promise<Blob>} PNG blob
 */
export async function generateShareImage(card, template = 'clean') {
  const t = TEMPLATES[template] || TEMPLATES.clean;
  const size = 1080;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = t.bg;
  ctx.fillRect(0, 0, size, size);

  // Card image (left side with drop shadow)
  const imgX = 60, imgY = 120, imgW = 440, imgH = 620;

  if (card.imageBlob) {
    try {
      const img = await loadImage(card.imageBlob);
      // Drop shadow
      ctx.shadowColor = 'rgba(0,0,0,0.25)';
      ctx.shadowBlur = 30;
      ctx.shadowOffsetX = 8;
      ctx.shadowOffsetY = 8;

      // Draw with rounded corners
      ctx.save();
      roundRect(ctx, imgX, imgY, imgW, imgH, 16);
      ctx.clip();
      const scale = Math.max(imgW / img.width, imgH / img.height);
      const sw = img.width * scale;
      const sh = img.height * scale;
      ctx.drawImage(img, imgX + (imgW - sw) / 2, imgY + (imgH - sh) / 2, sw, sh);
      ctx.restore();
      ctx.shadowColor = 'transparent';
    } catch {
      // Draw placeholder
      ctx.fillStyle = t.secondary + '33';
      roundRect(ctx, imgX, imgY, imgW, imgH, 16);
      ctx.fill();
    }
  } else {
    ctx.fillStyle = t.secondary + '33';
    ctx.beginPath();
    roundRect(ctx, imgX, imgY, imgW, imgH, 16);
    ctx.fill();
  }

  // Text area (right side)
  const textX = 560;
  let textY = 160;

  // Player name
  ctx.fillStyle = t.text;
  ctx.font = '700 48px -apple-system, BlinkMacSystemFont, sans-serif';
  const name = card.player || cardDisplayName(card);
  const nameLines = wrapText(ctx, name, size - textX - 60);
  for (const line of nameLines) {
    ctx.fillText(line, textX, textY);
    textY += 56;
  }

  textY += 12;

  // Team
  if (card.team) {
    ctx.fillStyle = t.accent;
    ctx.font = '600 28px -apple-system, sans-serif';
    ctx.fillText(card.team, textX, textY);
    textY += 44;
  }

  // Divider
  textY += 8;
  ctx.fillStyle = t.secondary + '44';
  ctx.fillRect(textX, textY, size - textX - 60, 2);
  textY += 28;

  // Card details
  ctx.font = '400 24px -apple-system, sans-serif';
  ctx.fillStyle = t.secondary;

  const details = [];
  if (card.year && card.brand) details.push(`${card.year} ${card.brand}`);
  if (card.setName) details.push(card.setName);
  if (card.subset && card.subset.toLowerCase() !== 'base') details.push(card.subset);
  if (card.parallel) details.push(card.parallel);
  if (card.cardNumber) details.push(`#${card.cardNumber}`);
  if (card.serialNumber) details.push(card.serialNumber);

  for (const detail of details) {
    ctx.fillText(detail, textX, textY);
    textY += 36;
  }

  // Grade
  if (card.graded === 'Yes' && card.gradeCompany) {
    textY += 16;
    ctx.fillStyle = t.accent;
    ctx.font = '700 32px -apple-system, sans-serif';
    ctx.fillText(`${card.gradeCompany} ${card.gradeValue}`, textX, textY);
    textY += 48;
  }

  // AI Grade
  if (card.aiGradeData && card.aiGradeData.overallGrade) {
    textY += 8;
    ctx.fillStyle = t.secondary;
    ctx.font = '500 22px -apple-system, sans-serif';
    ctx.fillText(`AI Grade: ${card.aiGradeData.overallGrade}`, textX, textY);
    textY += 36;
  }

  // Value
  if (card.compData && card.compData.avg) {
    textY += 16;
    ctx.fillStyle = '#16a34a';
    ctx.font = '700 36px -apple-system, sans-serif';
    ctx.fillText(`$${Number(card.compData.avg).toFixed(2)}`, textX, textY);
    ctx.fillStyle = t.secondary;
    ctx.font = '400 20px -apple-system, sans-serif';
    ctx.fillText(' avg sold', textX + ctx.measureText(`$${Number(card.compData.avg).toFixed(2)}`).width + 8, textY);
    textY += 48;
  }

  // Watermark
  ctx.fillStyle = t.secondary + '88';
  ctx.font = '500 20px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Card Wallet', size / 2, size - 40);
  ctx.textAlign = 'left';

  return new Promise(resolve => {
    canvas.toBlob(blob => resolve(blob), 'image/png');
  });
}

/**
 * Share a card with template selection.
 * @param {Object} card - card object
 * @param {Function} showModal - modal display function
 */
export async function shareCard(card, showModal) {
  // Template picker
  const template = await showModal(
    'Share Card',
    'Choose a style for your card image:',
    [
      { label: 'Clean (White)', value: 'clean', class: 'btn-primary' },
      { label: 'Dark (Navy)', value: 'dark', class: 'btn-secondary' },
      { label: 'Minimal (Gray)', value: 'minimal', class: 'btn-secondary' },
    ]
  );

  if (!template) return;

  const blob = await generateShareImage(card, template);
  const file = new File([blob], `card-wallet-${card.player || 'card'}.png`, { type: 'image/png' });

  // Try native share with file
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        title: cardDisplayName(card),
        files: [file],
      });
      return;
    } catch {
      // User cancelled or share failed, fall through to download
    }
  }

  // Fallback: download PNG
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// --- Helpers ---

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
}

function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [text];
}
