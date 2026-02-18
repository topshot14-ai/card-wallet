// Claude Vision API call for card identification

import { getSetting } from './db.js';
import { stripDataUri } from './camera.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const FALLBACK_MODEL = 'claude-sonnet-4-6';
const HAIKU_MODEL_PREFIX = 'claude-haiku';

const SYSTEM_PROMPT = `You are an elite sports trading card identification expert with perfect vision. You have encyclopedic knowledge of every major card release from the 1950s to present day across all sports. Your identifications are used for pricing and listing, so accuracy is critical.

## Your Approach
1. FIRST, read ALL visible text on every image — every word, number, logo, and fine print
2. THEN, reason step-by-step about what the card is
3. FINALLY, output structured JSON

## How to Identify Each Field

**sport**: Determine from the player, team, or sport logo visible on the card.

**year**: The PRODUCT RELEASE year, not the season. Look for:
- Copyright year in fine print on the back (e.g., "© 2023 Panini" means 2023 product)
- The year printed near the brand/set name
- Do NOT use the season year (a "2023-24" season card may be a 2023 or 2024 product)

**brand**: Read it from the card. Common brands: Topps, Panini, Upper Deck, Bowman, Donruss, Fleer, Leaf. Look for brand logos on front and back.

**setName**: READ this from printed text — do NOT guess from appearance. Look for:
- The set name printed on the card front (often in a logo/banner)
- The back of the card where it says the full product name (e.g., "2023 Panini Prizm Draft Picks")
- CRITICAL: Prizm, Select, Optic, Mosaic, and Spectra all have similar prismatic/shiny designs but are DIFFERENT products. Read the name, don't guess.

**subset**: Look for insert set names printed on the front (e.g., "Rookie Sensations", "Kaboom!", "Downtown"). If no insert name is present, use "Base".

**parallel**: Identify the parallel using BOTH printed text AND visual inspection of the card's OUTER BORDER color:
- First check for text on the front face (e.g., "SILVER", "BLUE SHIMMER", "GOLD VINYL") or on the back near the card number
- If no parallel name is printed, look at the card's OUTER BORDER color — this is the wide colored frame around the entire card. IGNORE inner frame lines, holographic reflections, and prismatic patterns — only the outermost border color matters. Common parallels:
  - Donruss Optic: purple outer border = Purple Shock, blue outer border = Blue Velocity/Hyper Blue, red = Red, green = Green, orange = Orange
  - Prizm/Select/Mosaic: purple = Purple, blue = Blue, green = Green, red = Red, gold/yellow = Gold, pink = Pink
  - Topps Chrome: green = Green Refractor, blue = Blue Refractor, gold = Gold Refractor, purple = Purple Refractor
- A COLOR ANALYSIS measurement may also be provided as a hint, but if it disagrees with what you clearly see, trust your eyes — holographic cards can skew automated color readings
- If neither text nor a distinct color is present, use empty string

**cardNumber**: Usually found on the card back. Look for a number preceded by "#" or "No." (e.g., "#123" or "No. 45"). Sometimes on the front in a corner.

**player**: Read the player name printed on the card front. Use the full name as printed.

**team**: Read from the card or infer from the player's uniform/logo.

**attributes**: Only include what is explicitly indicated:
- RC: Only if "RC", "Rookie Card", or the RC logo is printed on the card
- Auto: Only if there is a visible autograph (on-card or sticker)
- Patch/Mem: Only if there is a visible jersey/memorabilia swatch
- SP/SSP: Only if short print designation is visible
- Numbered: Only if serial numbering is visible (e.g., /99)

**serialNumber**: Look for numbering like "045/099" or "23/50" — include the slash format (e.g., "/99"). If not serial numbered, use empty string.

**graded/gradeCompany/gradeValue**: Only if the card is in a grading slab (PSA, BGS, SGC, CGC). Read the grade from the label.

## Output Format
Output ONLY the JSON object — no commentary, no code fences.

{
  "sport": "",
  "year": "",
  "brand": "",
  "setName": "",
  "subset": "",
  "parallel": "",
  "cardNumber": "",
  "player": "",
  "team": "",
  "attributes": [],
  "serialNumber": "",
  "graded": "",
  "gradeCompany": "",
  "gradeValue": ""
}

## Critical Rules
- When uncertain about ANY field, use an empty string or empty array — never guess
- Read printed text as your PRIMARY source; visual appearance is only secondary confirmation
- The back of the card is your most reliable source for year, brand, set name, and card number`;

/** Check if AI result is low-confidence (missing critical fields) */
function isLowConfidence(cardData) {
  if (!cardData.player || !cardData.player.trim()) return true;
  // If player is present but both brand and setName are missing, still suspicious
  if ((!cardData.brand || !cardData.brand.trim()) && (!cardData.setName || !cardData.setName.trim())) return true;
  return false;
}

/**
 * Identify a card from front (required) and back (optional) images.
 * When using Haiku, auto-falls back to Sonnet if the result looks incomplete.
 * @param {string} frontBase64 - data URI for front image
 * @param {string|null} backBase64 - data URI for back image (optional)
 * @param {function|null} onStatusChange - callback for status updates (e.g. "Retrying with Sonnet...")
 */
export async function identifyCard(frontBase64, backBase64 = null, onStatusChange = null) {
  let apiKey = await getSetting('apiKey');
  // Fall back to localStorage if IndexedDB lost the key
  if (!apiKey) {
    try { apiKey = localStorage.getItem('cw_apiKey'); } catch {}
  }
  if (!apiKey) {
    throw new Error('API key not set. Please add your Claude API key in Settings.');
  }

  const model = await getSetting('model') || 'claude-haiku-4-5-20251001';

  const cardData = await callVisionAPI(apiKey, model, frontBase64, backBase64);

  // Auto-fallback: if using Haiku and result looks incomplete OR back was provided,
  // retry with Sonnet. When the user scans both sides, accuracy matters — Haiku
  // often misreads the copyright year and set name from back text.
  const shouldFallback = model.startsWith(HAIKU_MODEL_PREFIX) &&
    (isLowConfidence(cardData) || backBase64);
  if (shouldFallback) {
    if (onStatusChange) onStatusChange('Verifying with Sonnet for accuracy...');
    try {
      const fallbackData = await callVisionAPI(apiKey, FALLBACK_MODEL, frontBase64, backBase64);
      fallbackData._fallback = true;
      return fallbackData;
    } catch {
      // If fallback fails, return the original Haiku result
      return cardData;
    }
  }

  return cardData;
}

/** Core API call — used by identifyCard and its fallback */
async function callVisionAPI(apiKey, model, frontBase64, backBase64) {
  const frontContent = stripDataUri(frontBase64);

  // Analyze dominant colors in the card border to help identify parallels
  const colorInfo = await analyzeCardColors(frontBase64);

  const contentBlocks = [];

  // Front image with label
  contentBlocks.push({ type: 'text', text: 'FRONT OF CARD:' });
  contentBlocks.push({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: frontContent }
  });

  if (backBase64) {
    // Back image with label
    contentBlocks.push({ type: 'text', text: 'BACK OF CARD:' });
    contentBlocks.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: stripDataUri(backBase64) }
    });
  }

  let colorHint = '';
  if (colorInfo && colorInfo.confidence !== 'low') {
    // Include color analysis with confidence level
    const confNote = colorInfo.confidence === 'high'
      ? 'HIGH confidence — this measurement is reliable.'
      : 'MEDIUM confidence — verify against what you see.';
    colorHint = `\n\nCOLOR ANALYSIS (CIELAB) of the card border: The dominant color is ${colorInfo.name} (L*=${Math.round(colorInfo.lab.L)}, a*=${Math.round(colorInfo.lab.a)}, b*=${Math.round(colorInfo.lab.b)}). ${confNote}${colorInfo.isReflective ? ' Card appears holographic/prismatic.' : ''} Use this to determine the parallel. For Donruss Optic: purple = Purple Shock, blue = Blue Velocity/Hyper Blue. For Prizm/Select: purple = Purple, blue = Blue.`;
  } else if (colorInfo && colorInfo.confidence === 'low') {
    // Low confidence — just tell the AI to look carefully
    colorHint = `\n\nColor analysis was inconclusive${colorInfo.isReflective ? ' (holographic/prismatic surface detected)' : ''}. Carefully examine the card's OUTER BORDER color to determine the parallel. For Donruss Optic: purple border = Purple Shock, blue border = Blue Velocity/Hyper Blue. For Prizm/Select: purple = Purple, blue = Blue.`;
  }

  const promptText = backBase64
    ? `Identify this sports trading card using both images above.${colorHint}

Step-by-step:
1. FIRST, find the copyright line at the very BOTTOM of the BACK image. It looks like "2025 Panini – Donruss Optic Football © 2025 Panini America, Inc." — read the EXACT year and full product name from this line. This is your DEFINITIVE source for year, brand, and set name. Do NOT use any other year.
2. Read the card number from the back (e.g., "No. 225").
3. Read ALL text on the FRONT — player name, team, any set logo, parallel name, insert name, RC logo, serial numbering.
4. Cross-reference front and back to confirm the set name and parallel.
5. Use the COLOR ANALYSIS data above to determine the parallel — this is an objective measurement more reliable than visual color in a compressed photo.
6. Output ONLY the JSON.`
    : `Identify this sports trading card from the front image.${colorHint}

Step-by-step:
1. Read ALL visible text — player name, team, brand logo, set name/logo, card number (if on front), any parallel name printed on the card, RC designation, serial numbering.
2. Look for visual cues: brand logo style, card design elements, holographic/refractor patterns.
3. Use the COLOR ANALYSIS data above to determine the parallel — this is an objective measurement more reliable than visual color in a compressed photo.
4. Note: without the back, some fields (exact year, card number, set name) may be uncertain — use empty string rather than guessing.
5. Output ONLY the JSON.`;

  const MAX_RETRIES = 2;
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          temperature: 0,
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: [
                ...contentBlocks,
                { type: 'text', text: promptText }
              ]
            }
          ]
        })
      });

      if (!response.ok) {
        const errBody = await response.text();
        // Don't retry on auth errors or bad requests
        if (response.status === 401 || response.status === 403) {
          throw new Error('Invalid API key. Please check your key in Settings.');
        }
        if (response.status === 400) {
          throw new Error('Bad request — the image may be too large or in an unsupported format.');
        }
        if (response.status === 429) {
          throw new Error('Rate limited. Please wait a moment and try again.');
        }
        // Retry on server errors
        if (response.status >= 500 && attempt < MAX_RETRIES) {
          lastError = new Error(`Server error (${response.status}). Retrying...`);
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw new Error(`API error (${response.status}): ${errBody.substring(0, 200)}`);
      }

      const result = await response.json();
      const text = result.content[0].text;

      // Parse JSON from response (handle potential markdown wrapping)
      const cardData = parseCardJson(text);
      return cardData;

    } catch (err) {
      lastError = err;
      // Only retry on network/server errors
      if (attempt < MAX_RETRIES && (err.name === 'TypeError' || err.message.includes('Server error'))) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error('Failed to identify card after multiple attempts.');
}

/** Parse JSON from AI response text, handling various formats */
function parseCardJson(text) {
  // Strip <thinking>...</thinking> block if present
  const stripped = text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();

  // Try direct JSON parse on stripped text first
  try {
    return normalizeCardData(JSON.parse(stripped));
  } catch {}

  // Try extracting from markdown code block
  const jsonMatch = stripped.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      return normalizeCardData(JSON.parse(jsonMatch[1].trim()));
    } catch {}
  }

  // Try finding JSON object in the stripped text
  const braceMatch = stripped.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return normalizeCardData(JSON.parse(braceMatch[0]));
    } catch {}
  }

  // Fallback: try on original text in case thinking tags were malformed
  const origBraceMatch = text.match(/\{[\s\S]*\}/);
  if (origBraceMatch) {
    try {
      return normalizeCardData(JSON.parse(origBraceMatch[0]));
    } catch {}
  }

  throw new Error('Could not parse card data from AI response. Please try again.');
}

/**
 * Analyze dominant colors in the card's border/frame region using CIELAB.
 *
 * CIELAB is perceptually uniform — blue and purple are cleanly separated
 * by the a* axis (blue has a* near 0, purple has a* > +15). This avoids
 * the HSV hue ambiguity that made purple/blue indistinguishable.
 *
 * Pipeline: downsample → convert to LAB → filter highlights/grays → median → classify
 *
 * Returns { name, confidence, lab: {L,a,b}, isReflective } or null.
 */
async function analyzeCardColors(base64DataUri) {
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = base64DataUri;
    });

    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const w = img.width;
    const h = img.height;

    // Sample a band from 5-25% inward from each edge. Skipping the outer 5%
    // avoids background pixels. The 5-25% range lands on the card border.
    const innerPct = 0.05;
    const outerPct = 0.25;
    const ix = Math.round(w * innerPct);
    const iy = Math.round(h * innerPct);
    const ox = Math.round(w * outerPct);
    const oy = Math.round(h * outerPct);

    // Downsample each border strip to ~20px wide for noise reduction.
    // Bilinear interpolation naturally averages out holographic streaks.
    const STRIP_SIZE = 20;
    const strips = [
      { x: ix, y: iy, w: w - ix * 2, h: oy - iy },         // top
      { x: ix, y: h - oy, w: w - ix * 2, h: oy - iy },     // bottom
      { x: ix, y: oy, w: ox - ix, h: h - oy * 2 },          // left
      { x: w - ox, y: oy, w: ox - ix, h: h - oy * 2 }       // right
    ];

    const labPixels = [];
    const brightnessValues = [];
    const tmpCanvas = document.createElement('canvas');
    const tmpCtx = tmpCanvas.getContext('2d');

    for (const s of strips) {
      if (s.w < 1 || s.h < 1) continue;
      // Downsample strip to STRIP_SIZE x STRIP_SIZE
      tmpCanvas.width = STRIP_SIZE;
      tmpCanvas.height = STRIP_SIZE;
      tmpCtx.drawImage(canvas, s.x, s.y, s.w, s.h, 0, 0, STRIP_SIZE, STRIP_SIZE);
      const data = tmpCtx.getImageData(0, 0, STRIP_SIZE, STRIP_SIZE).data;

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const lab = rgbToLab(r, g, b);
        const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);

        brightnessValues.push(lab.L);

        // Luminance gate: skip specular highlights (L>85) and deep shadows (L<20)
        // Chroma gate: skip grays/whites (C<12)
        if (lab.L >= 20 && lab.L <= 85 && chroma >= 12) {
          labPixels.push(lab);
        }
      }
    }

    if (labPixels.length < 20) return null; // Not enough chromatic pixels

    // Detect reflective surface (high brightness variance = shimmer/refractor)
    const meanL = brightnessValues.reduce((a, b) => a + b, 0) / brightnessValues.length;
    const variance = brightnessValues.reduce((a, b) => a + (b - meanL) ** 2, 0) / brightnessValues.length;
    const isReflective = Math.sqrt(variance) > 18;

    // Compute median LAB — robust against outlier reflections
    const median = medianLab(labPixels);

    // Classify against reference colors
    const { name, confidence } = classifyLabColor(median);

    return { name, confidence, lab: median, isReflective };
  } catch (err) {
    console.warn('[AI] Color analysis failed:', err.message);
    return null;
  }
}

/** Compute median of LAB pixel array (robust to outliers) */
function medianLab(pixels) {
  const Ls = pixels.map(p => p.L).sort((a, b) => a - b);
  const as = pixels.map(p => p.a).sort((a, b) => a - b);
  const bs = pixels.map(p => p.b).sort((a, b) => a - b);
  const mid = Math.floor(pixels.length / 2);
  return { L: Ls[mid], a: as[mid], b: bs[mid] };
}

/** Convert sRGB (0-255) to CIELAB */
function rgbToLab(r, g, b) {
  // sRGB to linear
  let rl = r / 255, gl = g / 255, bl = b / 255;
  rl = rl <= 0.04045 ? rl / 12.92 : Math.pow((rl + 0.055) / 1.055, 2.4);
  gl = gl <= 0.04045 ? gl / 12.92 : Math.pow((gl + 0.055) / 1.055, 2.4);
  bl = bl <= 0.04045 ? bl / 12.92 : Math.pow((bl + 0.055) / 1.055, 2.4);

  // Linear RGB to XYZ (D65 illuminant)
  let x = 0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl;
  let y = 0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl;
  let z = 0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl;

  // XYZ to LAB
  const f = (t) => t > 0.008856 ? Math.cbrt(t) : (7.787 * t) + 16 / 116;
  const fx = f(x / 0.95047);
  const fy = f(y / 1.00000);
  const fz = f(z / 1.08883);

  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz)
  };
}

/**
 * Classify a LAB color against reference trading card parallel colors.
 * Uses Euclidean distance in LAB space (perceptually uniform).
 */
function classifyLabColor(lab) {
  // Reference LAB values for common card parallel colors
  const references = [
    { name: 'red',         L: 45, a: 55,  b: 30  },
    { name: 'orange',      L: 65, a: 35,  b: 55  },
    { name: 'gold/yellow', L: 80, a: 0,   b: 70  },
    { name: 'green',       L: 50, a: -40, b: 30  },
    { name: 'teal',        L: 50, a: -25, b: -10 },
    { name: 'blue',        L: 35, a: 5,   b: -45 },
    { name: 'purple',      L: 30, a: 30,  b: -40 },
    { name: 'pink/magenta',L: 55, a: 50,  b: -10 },
    { name: 'silver',      L: 70, a: 0,   b: -3  },
    { name: 'black',       L: 15, a: 0,   b: 0   },
  ];

  let bestName = 'unknown';
  let bestDist = Infinity;
  for (const ref of references) {
    const dist = Math.sqrt(
      (lab.L - ref.L) ** 2 +
      (lab.a - ref.a) ** 2 +
      (lab.b - ref.b) ** 2
    );
    if (dist < bestDist) {
      bestDist = dist;
      bestName = ref.name;
    }
  }

  const confidence = bestDist < 20 ? 'high' : bestDist < 35 ? 'medium' : 'low';
  return { name: bestName, confidence };
}

function normalizeCardData(cardData) {
  // Ensure attributes is always an array
  if (typeof cardData.attributes === 'string') {
    cardData.attributes = cardData.attributes ? cardData.attributes.split(',').map(a => a.trim()).filter(Boolean) : [];
  }
  if (!Array.isArray(cardData.attributes)) {
    cardData.attributes = [];
  }
  // Remove any AI-guessed estimates — we use real sold data instead
  delete cardData.estimatedValueLow;
  delete cardData.estimatedValueHigh;
  // Ensure string fields are strings
  for (const key of ['sport', 'year', 'brand', 'setName', 'subset', 'parallel', 'cardNumber', 'player', 'team', 'serialNumber', 'graded', 'gradeCompany', 'gradeValue']) {
    if (cardData[key] !== undefined && cardData[key] !== null) {
      cardData[key] = String(cardData[key]);
    }
  }
  return cardData;
}
