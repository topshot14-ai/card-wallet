// Claude Vision API call for card identification

import { getSetting } from './db.js';
import { stripDataUri } from './camera.js';

const API_URL = 'https://api.anthropic.com/v1/messages';

const SYSTEM_PROMPT = `You are a sports trading card identification and valuation expert. Analyze the card image and return a JSON object with these fields:

{
  "sport": "Baseball|Basketball|Football|Hockey|Soccer|Other",
  "year": "four digit year the card was produced",
  "brand": "manufacturer name (Topps, Panini, Upper Deck, etc.)",
  "setName": "the specific set name (Chrome, Prizm, Select, etc.)",
  "subset": "insert set or subset name if applicable, or 'Base' for base cards",
  "parallel": "parallel or variation name if applicable (Refractor, Silver, Gold, etc.), empty string if base",
  "cardNumber": "the card number as printed on the card",
  "player": "full name of the player or subject on the card",
  "team": "team name",
  "attributes": ["array of attributes like RC, Auto, Patch, Mem, SP, SSP, etc."],
  "serialNumber": "serial numbering if visible (e.g., /99, /25), empty string if not numbered",
  "graded": "Yes or No",
  "gradeCompany": "PSA, BGS, SGC, CGC, or empty string",
  "gradeValue": "numeric grade value or empty string"
}

Important rules:
- Return ONLY valid JSON, no markdown formatting or extra text
- ALWAYS read text printed on the card before guessing. The back of the card typically prints the brand, set name, year, card number, and legal text. Use this printed information as your primary source — do NOT guess the set from visual appearance alone.
- For year, use the product release year, not the season year (e.g., 2023 Topps released in 2023). Check the copyright year on the back.
- For setName, read it from the card back or front. Many sets look similar visually (e.g., Prizm vs Select vs Optic) — rely on what is printed, not appearance.
- For parallel, READ the parallel name printed on the card (front or back) if present. Do NOT guess the parallel from color alone — many parallels look similar (e.g., Blue Velocity vs Purple Shock in Optic, or Silver vs Hyper in Prizm). The parallel name is often printed on the front or back of the card. If no parallel name is printed, describe what you see but note uncertainty.
- For attributes, include RC (Rookie Card) only if there is a clear RC designation on the card
- If you cannot determine a field, use an empty string or empty array
- Be as specific as possible about the set name and parallel
- For serial numbers, include the slash (e.g., "/99" not "99")`;

/**
 * Identify a card from front (required) and back (optional) images.
 * @param {string} frontBase64 - data URI for front image
 * @param {string|null} backBase64 - data URI for back image (optional)
 */
export async function identifyCard(frontBase64, backBase64 = null) {
  let apiKey = await getSetting('apiKey');
  // Fall back to localStorage if IndexedDB lost the key
  if (!apiKey) {
    try { apiKey = localStorage.getItem('cw_apiKey'); } catch {}
  }
  if (!apiKey) {
    throw new Error('API key not set. Please add your Claude API key in Settings.');
  }

  const model = await getSetting('model') || 'claude-sonnet-4-20250514';
  const frontContent = stripDataUri(frontBase64);

  const imageBlocks = [
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: frontContent }
    }
  ];

  if (backBase64) {
    imageBlocks.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: stripDataUri(backBase64) }
    });
  }

  const promptText = backBase64
    ? 'Here are the front and back of a sports trading card. IMPORTANT: Carefully read ALL text on the back of the card first — it typically prints the exact brand, set name, year, card number, and copyright info. Use that printed text as your primary source for identification rather than visual appearance. Return only JSON.'
    : 'Identify this sports trading card. Return only JSON.';

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
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: [
                ...imageBlocks,
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
  // Try direct JSON parse first
  try {
    return normalizeCardData(JSON.parse(text.trim()));
  } catch {}

  // Try extracting from markdown code block
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      return normalizeCardData(JSON.parse(jsonMatch[1].trim()));
    } catch {}
  }

  // Try finding JSON object in the text
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return normalizeCardData(JSON.parse(braceMatch[0]));
    } catch {}
  }

  throw new Error('Could not parse card data from AI response. Please try again.');
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
