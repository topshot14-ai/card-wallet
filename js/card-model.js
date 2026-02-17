// Card validation, eBay title generation, search query building

/** Generate a UUID that works over plain HTTP (crypto.randomUUID needs HTTPS). */
function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for non-secure contexts (http:// on mobile)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Create a new card object with defaults.
 */
export function createCard(data = {}) {
  return {
    id: data.id || uuid(),
    mode: data.mode || 'listing',        // 'listing' or 'collection'
    status: data.status || 'pending',     // 'pending', 'listed', 'sold', 'unsold', 'exported'
    sport: data.sport || '',
    year: data.year || '',
    brand: data.brand || '',
    setName: data.setName || '',
    subset: data.subset || '',
    parallel: data.parallel || '',
    cardNumber: data.cardNumber || '',
    player: data.player || '',
    team: data.team || '',
    attributes: data.attributes || [],
    serialNumber: data.serialNumber || '',
    graded: data.graded || 'No',
    gradeCompany: data.gradeCompany || '',
    gradeValue: data.gradeValue || '',
    condition: data.condition || 'Near Mint or Better',
    ebayTitle: data.ebayTitle || '',
    startPrice: data.startPrice ?? 0.99,
    compData: data.compData || {},
    compLookedUpAt: data.compLookedUpAt ?? null, // ISO timestamp of last comp lookup
    imageBlob: data.imageBlob || null,        // front full image (base64 data URI)
    imageThumbnail: data.imageThumbnail || null, // front thumbnail
    imageBackBlob: data.imageBackBlob || null,   // back full image
    imageBackThumb: data.imageBackThumb || null,  // back thumbnail
    dateAdded: data.dateAdded || new Date().toISOString(),
    lastModified: data.lastModified || new Date().toISOString(),
    estimatedValueLow: data.estimatedValueLow ?? null,
    estimatedValueHigh: data.estimatedValueHigh ?? null,
    purchasePrice: data.purchasePrice ?? null,
    ebayListingId: data.ebayListingId || null,
    ebayListingUrl: data.ebayListingUrl || null,
    soldPrice: data.soldPrice ?? null,
    shippingCarrier: data.shippingCarrier || '',
    trackingNumber: data.trackingNumber || '',
    shippingStatus: data.shippingStatus || 'not_shipped', // 'not_shipped', 'shipped', 'delivered'
    notes: data.notes || ''
  };
}

/**
 * Generate an eBay title (80 char max).
 * Priority: Year > Brand > Set > Player > Card# > Parallel > Attributes > Serial#
 */
export function generateEbayTitle(card) {
  const parts = [];

  if (card.year) parts.push(card.year);
  if (card.brand) parts.push(card.brand);
  if (card.setName) parts.push(card.setName);
  if (card.subset && card.subset.toLowerCase() !== 'base') parts.push(card.subset);
  if (card.player) parts.push(card.player);
  if (card.cardNumber) parts.push(`#${card.cardNumber}`);
  if (card.parallel) parts.push(card.parallel);

  // Add attributes
  if (card.attributes && card.attributes.length > 0) {
    parts.push(...card.attributes);
  }

  if (card.serialNumber) parts.push(card.serialNumber);

  // Grading info
  if (card.graded === 'Yes' && card.gradeCompany) {
    parts.push(`${card.gradeCompany} ${card.gradeValue}`);
  }

  // Build title respecting 80 char limit
  let title = '';
  for (const part of parts) {
    const candidate = title ? `${title} ${part}` : part;
    if (candidate.length <= 80) {
      title = candidate;
    } else {
      break;
    }
  }

  return title;
}

/**
 * Build a search query for 130point comp lookup.
 */
export function buildSearchQuery(card) {
  const parts = [];

  if (card.year) parts.push(card.year);
  if (card.player) parts.push(card.player);
  if (card.brand) parts.push(card.brand);
  if (card.setName) parts.push(card.setName);
  if (card.parallel) parts.push(card.parallel);

  // Negative keywords to exclude bulk listings
  const negatives = ['-lot', '-break', '-case', '-box'];

  return [...parts, ...negatives].join(' ');
}

/**
 * Get a display name for a card (used in lists).
 */
export function cardDisplayName(card) {
  if (card.player) {
    const parts = [card.year, card.brand, card.player].filter(Boolean);
    return parts.join(' ');
  }
  return card.ebayTitle || 'Unknown Card';
}

/**
 * Get a short detail line for a card.
 */
export function cardDetailLine(card) {
  const parts = [card.setName, card.parallel, card.cardNumber ? `#${card.cardNumber}` : ''].filter(Boolean);
  return parts.join(' - ') || card.sport || '';
}
