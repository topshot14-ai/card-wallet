// Claude Vision API call for card identification

import { getSetting } from './db.js';
import { stripDataUri } from './camera.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const FALLBACK_MODEL = 'claude-sonnet-4-6';
const HAIKU_MODEL_PREFIX = 'claude-haiku';

/**
 * Blocklist of parallel names that are WRONG for a given set.
 * Only catches known cross-set terminology confusion — never rejects
 * legitimate parallels we just forgot to list.
 * Keys are normalized set name fragments (lowercase, longest first).
 * Values are arrays of wrong parallel names (case-insensitive).
 */
const PARALLEL_BLOCKLIST = {
  // Optic uses Holo/Shock/Velocity — NOT Prizm/Refractor terminology
  'donruss optic': [
    'Silver Prizm', 'Refractor', 'Green Refractor', 'Blue Refractor',
    'Gold Refractor', 'Purple Refractor', 'Red Refractor', 'Pink Refractor',
    'X-Fractor', 'Prizm', 'Ice', 'Wave', 'Pulsar',
  ],
  // Prizm uses Silver/Prizm — NOT Shock/Velocity/Holo/Refractor terminology
  'prizm': [
    'Purple Shock', 'Blue Velocity', 'Hyper Blue', 'Holo',
    'Refractor', 'Green Refractor', 'Blue Refractor', 'Gold Refractor',
    'X-Fractor',
  ],
  // Select uses Silver/Prizm — NOT Shock/Velocity/Holo/Refractor terminology
  'select': [
    'Purple Shock', 'Blue Velocity', 'Hyper Blue', 'Holo',
    'Refractor', 'Green Refractor', 'Blue Refractor', 'Gold Refractor',
    'X-Fractor',
  ],
  // Mosaic uses Silver/Prizm — NOT Shock/Velocity/Holo/Refractor terminology
  'mosaic': [
    'Purple Shock', 'Blue Velocity', 'Hyper Blue', 'Holo',
    'Refractor', 'Green Refractor', 'Blue Refractor', 'Gold Refractor',
    'X-Fractor',
  ],
  // Chrome uses Refractor — NOT Prizm/Shock/Velocity/Holo terminology
  'chrome': [
    'Silver Prizm', 'Prizm', 'Purple Shock', 'Blue Velocity', 'Hyper Blue',
    'Holo', 'Silver Holo', 'Genesis', 'Mosaic',
  ],
  // Bowman Chrome uses Refractor — NOT Prizm/Shock/Holo terminology
  'bowman chrome': [
    'Silver Prizm', 'Prizm', 'Purple Shock', 'Blue Velocity', 'Holo',
  ],
};

/**
 * Check if a parallel is known-wrong for the given set.
 * Returns { blocked, setFound } where:
 *   blocked = true if this parallel is definitely wrong for this set
 *   setFound = true if the set was found in the blocklist
 */
function validateParallel(setName, parallel) {
  if (!parallel || !parallel.trim()) return { blocked: false, setFound: false };
  if (!setName || !setName.trim()) return { blocked: false, setFound: false };

  const setLower = setName.toLowerCase();
  const parallelLower = parallel.toLowerCase().trim();

  // Find matching set (try longest keys first for specificity)
  let matchedKey = null;
  const sortedKeys = Object.keys(PARALLEL_BLOCKLIST).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    if (setLower.includes(key)) {
      matchedKey = key;
      break;
    }
  }

  if (!matchedKey) return { blocked: false, setFound: false };

  const blockedParallels = PARALLEL_BLOCKLIST[matchedKey];
  const isBlocked = blockedParallels.some(p => p.toLowerCase() === parallelLower);
  return { blocked: isBlocked, setFound: true };
}

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
- The back of the card is your most reliable source for year, brand, set name, and card number
- IMPORTANT: Parallel names are SET-SPECIFIC. Do NOT mix terminology between sets:
  - Donruss Optic uses: Holo, Purple Shock, Blue Velocity, Hyper Blue (NOT "Silver Prizm", "Refractor")
  - Prizm/Select/Mosaic use: Silver, Silver Prizm, Blue, Purple (NOT "Holo", "Purple Shock", "Refractor")
  - Topps Chrome/Bowman Chrome use: Refractor, Green Refractor, etc. (NOT "Holo", "Prizm", "Silver")
  - If unsure which parallel name to use for a set, use an empty string`;

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

  // Always use Sonnet for card identification — Haiku misidentifies parallels
  // too often. One Sonnet call is faster than Haiku + Sonnet fallback.
  const model = FALLBACK_MODEL;

  return await callVisionAPI(apiKey, model, frontBase64, backBase64);
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
    ? `Identify this sports trading card using both images above.

Step-by-step:
1. FIRST, find the copyright line at the very BOTTOM of the BACK image. It looks like "2025 Panini – Donruss Optic Football © 2025 Panini America, Inc." — read the EXACT year and full product name from this line. This is your DEFINITIVE source for year, brand, and set name. Do NOT use any other year.
2. Read the card number from the back (e.g., "No. 225").
3. Read ALL text on the FRONT — player name, team, any set logo, parallel name, insert name, RC logo, serial numbering.
4. Cross-reference front and back to confirm the set name and parallel.
5. For the PARALLEL: Look at the OUTERMOST border of the front of the card — the very edge of the card. Describe what color you see there. Does it have any warm/reddish undertone (suggesting purple/violet)? Or is it a cool, pure blue? Key difference: Purple Shock has a dark violet outer border with a subtle reddish tint. Blue Velocity has a brighter, cooler blue outer border with no reddish tint.${colorHint}
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
 * Uses edge-scanning: scans inward from each image edge, skips non-chromatic
 * pixels (white paper/gray desk), and samples only the FIRST chromatic pixels
 * found — which are the card's outermost border. This avoids contamination
 * from the card's inner frame, artwork, and holographic reflections.
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

    // Downsample to ~400px for fast processing while keeping border detail
    const ANALYZE_SIZE = 400;
    const scale = Math.min(ANALYZE_SIZE / img.width, ANALYZE_SIZE / img.height, 1);
    const sw = Math.round(img.width * scale);
    const sh = Math.round(img.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, sw, sh);

    const imageData = ctx.getImageData(0, 0, sw, sh);
    const data = imageData.data;

    // Helper: get LAB at (x, y)
    const getLabAt = (x, y) => {
      const idx = (y * sw + x) * 4;
      return rgbToLab(data[idx], data[idx + 1], data[idx + 2]);
    };

    const CHROMA_THRESH = 15;  // Minimum chroma to be "colored"
    const SAMPLE_DEPTH = 3;    // Pixels to sample after finding border edge
    const NUM_LINES = 14;      // Scan lines per edge
    const borderLabPixels = [];
    const brightnessValues = [];

    // Collect brightness for reflectivity detection (sample every 8th pixel)
    for (let i = 0; i < data.length; i += 32) {
      const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
      brightnessValues.push(lab.L);
    }

    // Scan from LEFT edge (rightward) at multiple Y positions
    for (let i = 0; i < NUM_LINES; i++) {
      const y = Math.round(sh * (0.12 + i * 0.76 / NUM_LINES));
      for (let x = 0; x < sw * 0.4; x++) {
        const lab = getLabAt(x, y);
        const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
        if (chroma > CHROMA_THRESH && lab.L > 10 && lab.L < 90) {
          for (let dx = 0; dx < SAMPLE_DEPTH && x + dx < sw; dx++) {
            borderLabPixels.push(getLabAt(x + dx, y));
          }
          break;
        }
      }
    }

    // Scan from RIGHT edge (leftward)
    for (let i = 0; i < NUM_LINES; i++) {
      const y = Math.round(sh * (0.12 + i * 0.76 / NUM_LINES));
      for (let x = sw - 1; x > sw * 0.6; x--) {
        const lab = getLabAt(x, y);
        const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
        if (chroma > CHROMA_THRESH && lab.L > 10 && lab.L < 90) {
          for (let dx = 0; dx < SAMPLE_DEPTH && x - dx >= 0; dx++) {
            borderLabPixels.push(getLabAt(x - dx, y));
          }
          break;
        }
      }
    }

    // Scan from TOP edge (downward)
    for (let i = 0; i < NUM_LINES; i++) {
      const x = Math.round(sw * (0.12 + i * 0.76 / NUM_LINES));
      for (let y = 0; y < sh * 0.4; y++) {
        const lab = getLabAt(x, y);
        const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
        if (chroma > CHROMA_THRESH && lab.L > 10 && lab.L < 90) {
          for (let dy = 0; dy < SAMPLE_DEPTH && y + dy < sh; dy++) {
            borderLabPixels.push(getLabAt(x, y + dy));
          }
          break;
        }
      }
    }

    // Scan from BOTTOM edge (upward)
    for (let i = 0; i < NUM_LINES; i++) {
      const x = Math.round(sw * (0.12 + i * 0.76 / NUM_LINES));
      for (let y = sh - 1; y > sh * 0.6; y--) {
        const lab = getLabAt(x, y);
        const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
        if (chroma > CHROMA_THRESH && lab.L > 10 && lab.L < 90) {
          for (let dy = 0; dy < SAMPLE_DEPTH && y - dy >= 0; dy++) {
            borderLabPixels.push(getLabAt(x, y - dy));
          }
          break;
        }
      }
    }

    if (borderLabPixels.length < 15) return null;

    // Detect reflective surface (high brightness variance = shimmer/refractor)
    const meanL = brightnessValues.reduce((a, b) => a + b, 0) / brightnessValues.length;
    const variance = brightnessValues.reduce((a, b) => a + (b - meanL) ** 2, 0) / brightnessValues.length;
    const isReflective = Math.sqrt(variance) > 18;

    // Compute median LAB — robust against outlier reflections
    const median = medianLab(borderLabPixels);

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
  // Reference LAB values for common card parallel colors.
  // Calibrated against real card photos. Key: blue has NEGATIVE a* (no red),
  // purple has POSITIVE a* (red mixed in). This is the primary discriminator.
  const references = [
    { name: 'red',         L: 45, a: 55,  b: 30  },
    { name: 'orange',      L: 65, a: 35,  b: 55  },
    { name: 'gold/yellow', L: 80, a: 0,   b: 70  },
    { name: 'green',       L: 50, a: -40, b: 30  },
    { name: 'teal',        L: 50, a: -25, b: -10 },
    { name: 'blue',        L: 40, a: -8,  b: -45 },
    { name: 'purple',      L: 25, a: 15,  b: -35 },
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

/**
 * AI Pre-Grading Analysis — analyze card photos for grading potential.
 * Uses the same Claude Vision API as identifyCard but with a specialized grading prompt.
 *
 * @param {string} frontBase64 - data URI for front image (required)
 * @param {string|null} backBase64 - data URI for back image (optional but recommended)
 * @returns {Object} grading results with scores per category, overall grade, recommendation
 */
export async function gradeCard(frontBase64, backBase64 = null) {
  let apiKey = await getSetting('apiKey');
  if (!apiKey) {
    try { apiKey = localStorage.getItem('cw_apiKey'); } catch {}
  }
  if (!apiKey) {
    throw new Error('API key not set. Please add your Claude API key in Settings.');
  }

  const frontContent = stripDataUri(frontBase64);
  const contentBlocks = [];

  contentBlocks.push({ type: 'text', text: 'FRONT OF CARD:' });
  contentBlocks.push({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: frontContent }
  });

  if (backBase64) {
    contentBlocks.push({ type: 'text', text: 'BACK OF CARD:' });
    contentBlocks.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: stripDataUri(backBase64) }
    });
  }

  const gradingPrompt = `You are an expert sports card grader with years of experience at PSA, BGS, and SGC. Analyze these card images and provide a detailed pre-grading assessment.

Evaluate the following categories on a 1-10 scale (matching PSA's grading scale where 10=Gem Mint, 9=Mint, 8=NM-MT, 7=NM):

## Categories to Evaluate

**Centering**: Examine the borders on all four sides.
- Measure left/right centering ratio (e.g., 50/50, 55/45, 60/40)
- Measure top/bottom centering ratio
- PSA allows 55/45 for a 10, 60/40 for a 9, 65/35 for an 8

**Corners**: Examine all 4 corners individually.
- Look for any whitening, wear, dings, or softness
- Note which corners (if any) show issues

**Edges**: Examine all 4 edges.
- Look for whitening, chipping, roughness, or any damage along each edge
- Note which edges (if any) show issues

**Surface**: Examine the entire card surface.
- Look for scratches, print defects, staining, wax residue, roller marks, focus issues
- Note any specific defects found

## Output Format
Output ONLY a JSON object — no commentary, no code fences:

{
  "centering": {
    "score": 8,
    "leftRight": "52/48",
    "topBottom": "55/45",
    "notes": "Slightly off-center to the left"
  },
  "corners": {
    "score": 9,
    "topLeft": "Sharp",
    "topRight": "Sharp",
    "bottomLeft": "Sharp",
    "bottomRight": "Minor softness",
    "notes": "Three corners are sharp, bottom-right shows very minor softness"
  },
  "edges": {
    "score": 9,
    "top": "Clean",
    "bottom": "Clean",
    "left": "Clean",
    "right": "Minor whitening",
    "notes": "Edges are clean with very minor whitening on right edge"
  },
  "surface": {
    "score": 9,
    "notes": "Clean surface with no visible scratches or print defects"
  },
  "overallGrade": 9,
  "confidence": "high",
  "recommendation": "This card is likely to grade PSA 9. Centering is the weakest category. Worth grading if raw value is significantly less than graded value.",
  "estimatedPSA": "PSA 9",
  "worthGrading": true
}

## Rules
- Be conservative — it's better to under-estimate than over-estimate
- If image quality is poor, lower your confidence level
- The overall grade should be weighted: Centering 10%, Corners 30%, Edges 30%, Surface 30%
- "worthGrading" should be true only if the card likely grades 8+ and is a card that benefits from grading
- Set confidence to "high", "medium", or "low" based on image quality and your certainty`;

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: FALLBACK_MODEL,
      max_tokens: 1024,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            ...contentBlocks,
            { type: 'text', text: gradingPrompt }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Invalid API key.');
    }
    if (response.status === 429) {
      throw new Error('Rate limited. Please wait a moment and try again.');
    }
    throw new Error(`API error (${response.status})`);
  }

  const result = await response.json();
  const text = result.content[0].text;

  // Parse JSON from response
  const stripped = text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
  let gradeData;

  try { gradeData = JSON.parse(stripped); } catch {
    const braceMatch = stripped.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try { gradeData = JSON.parse(braceMatch[0]); } catch {}
    }
  }

  if (!gradeData) {
    throw new Error('Could not parse grading data from AI response.');
  }

  gradeData.timestamp = new Date().toISOString();
  return gradeData;
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

  // Check parallel against set-specific blocklist (cross-set terminology)
  if (cardData.setName && cardData.parallel) {
    const result = validateParallel(cardData.setName, cardData.parallel);
    if (result.blocked) {
      // Known wrong parallel for this set — clear it and flag for user review
      cardData._parallelNeedsReview = cardData.parallel;
      cardData.parallel = '';
    }
  }

  return cardData;
}
