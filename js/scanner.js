// Card edge detection + perspective correction using OpenCV.js
// Lazy-loads OpenCV from CDN on first use, cached by service worker

const OPENCV_CDN = 'https://cdn.jsdelivr.net/npm/opencv.js@1.2.1/opencv.js';
const CARD_RATIO = 5 / 7; // Standard trading card aspect ratio
const PADDING_RATIO = 0.08; // White border = 8% of card dimension
const MIN_AREA_RATIO = 0.10; // Card must be at least 10% of image area
const MAX_AREA_RATIO = 0.95; // Reject contours covering >95% of image (image boundary)

let cvReady = false;
let cvLoading = null;

// ===== OpenCV Lazy Loader =====

function loadOpenCV() {
  if (cvReady) return Promise.resolve();
  if (cvLoading) return cvLoading;

  cvLoading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = OPENCV_CDN;
    script.async = true;

    // OpenCV.js calls cv.onRuntimeInitialized when WASM is ready
    const checkReady = () => {
      if (typeof cv !== 'undefined') {
        if (cv.Mat) {
          cvReady = true;
          resolve();
        } else {
          cv.onRuntimeInitialized = () => {
            cvReady = true;
            resolve();
          };
        }
      }
    };

    script.onload = () => {
      // Give it a moment to initialize
      setTimeout(checkReady, 100);
      // Also set up polling in case onRuntimeInitialized is needed
      const poll = setInterval(() => {
        if (cvReady) { clearInterval(poll); return; }
        if (typeof cv !== 'undefined' && cv.Mat) {
          cvReady = true;
          clearInterval(poll);
          resolve();
        }
      }, 200);
      // Timeout after 30s
      setTimeout(() => {
        clearInterval(poll);
        if (!cvReady) reject(new Error('OpenCV init timeout'));
      }, 30000);
    };

    script.onerror = () => reject(new Error('Failed to load OpenCV'));
    document.head.appendChild(script);
  });

  cvLoading.catch(() => { cvLoading = null; });
  return cvLoading;
}

// ===== Edge Detection =====

function detectCardEdges(canvas) {
  const origW = canvas.width;
  const origH = canvas.height;

  // Downscale for detection — reduces noise from wood grain, card artwork, etc.
  // The card becomes the dominant feature at low resolution.
  const DETECT_SIZE = 500;
  const scale = Math.min(DETECT_SIZE / origW, DETECT_SIZE / origH, 1);
  const dw = Math.round(origW * scale);
  const dh = Math.round(origH * scale);

  const small = new cv.Mat();
  const src = cv.imread(canvas);
  cv.resize(src, small, new cv.Size(dw, dh));
  src.delete();

  const imgArea = dw * dh;

  // Try multiple detection strategies on the downscaled image
  const strategies = [
    () => detectWithOtsu(small, dw, dh, imgArea),
    () => detectWithSaturation(small, dw, dh, imgArea),
    () => detectWithCanny(small, dw, dh, imgArea),
  ];

  let result = null;
  for (const strategy of strategies) {
    result = strategy();
    if (result) break;
  }

  small.delete();

  if (!result) return null;

  // Quality check: reject detections that don't look like a card
  if (!isCardShaped(result, dw, dh)) return null;

  // Scale corners back to original image coordinates
  return result.map(c => ({
    x: Math.round(c.x / scale),
    y: Math.round(c.y / scale)
  }));
}

/**
 * Validate that detected corners form a card-shaped quad.
 * Rejects: wrong aspect ratio, too large, corners hugging image edges.
 */
function isCardShaped(corners, imgW, imgH) {
  // Check aspect ratio — card is 5:7 (0.714) or 7:5 (1.4)
  const widthTop = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
  const widthBottom = Math.hypot(corners[2].x - corners[3].x, corners[2].y - corners[3].y);
  const heightLeft = Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y);
  const heightRight = Math.hypot(corners[2].x - corners[1].x, corners[2].y - corners[1].y);
  const avgW = (widthTop + widthBottom) / 2;
  const avgH = (heightLeft + heightRight) / 2;
  const ratio = Math.min(avgW, avgH) / Math.max(avgW, avgH);

  // Card ratio is ~0.714; accept 0.5 to 0.9 (generous range for perspective distortion)
  if (ratio < 0.45 || ratio > 0.92) return false;

  // Check area — reject if quad covers >80% of image
  const quadArea = avgW * avgH;
  const imgArea = imgW * imgH;
  if (quadArea / imgArea > 0.80) return false;

  // Check edge proximity — reject if 3+ corners are near image edges
  const margin = Math.min(imgW, imgH) * 0.05;
  let edgeCorners = 0;
  for (const c of corners) {
    if (c.x < margin || c.x > imgW - margin || c.y < margin || c.y > imgH - margin) {
      edgeCorners++;
    }
  }
  if (edgeCorners >= 3) return false;

  return true;
}

/**
 * Strategy 1: Otsu threshold — best when card and background differ in brightness.
 */
function detectWithOtsu(src, imgW, imgH, imgArea) {
  const gray = new cv.Mat();
  const binary = new cv.Mat();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    // Bilateral filter preserves edges while smoothing textures like wood grain
    const filtered = new cv.Mat();
    cv.bilateralFilter(gray, filtered, 9, 75, 75);
    cv.threshold(filtered, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    filtered.delete();

    // Heavy morphological cleanup at this small resolution
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    cv.morphologyEx(binary, binary, cv.MORPH_CLOSE, kernel);
    cv.morphologyEx(binary, binary, cv.MORPH_OPEN, kernel);
    kernel.delete();

    // Try normal and inverted
    let result = findCardRect(binary, imgW, imgH, imgArea);
    if (!result) {
      cv.bitwise_not(binary, binary);
      result = findCardRect(binary, imgW, imgH, imgArea);
    }
    return result;
  } finally {
    gray.delete();
    binary.delete();
  }
}

/**
 * Strategy 2: HSV saturation — cards are typically less saturated than wood/fabric surfaces.
 */
function detectWithSaturation(src, imgW, imgH, imgArea) {
  const hsv = new cv.Mat();
  const channels = new cv.MatVector();
  const binary = new cv.Mat();

  try {
    cv.cvtColor(src, hsv, cv.COLOR_RGBA2RGB);
    const rgb = hsv.clone();
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    rgb.delete();
    cv.split(hsv, channels);
    const saturation = channels.get(1);

    // Threshold on saturation — card (low saturation) vs colored surface (high saturation)
    cv.threshold(saturation, binary, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

    // Large closing kernel bridges the gap across colored card borders
    // (at 500px detection size, a card border is ~10-20px wide)
    const closeKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15));
    cv.morphologyEx(binary, binary, cv.MORPH_CLOSE, closeKernel);
    closeKernel.delete();
    const openKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    cv.morphologyEx(binary, binary, cv.MORPH_OPEN, openKernel);
    openKernel.delete();

    let result = findCardRect(binary, imgW, imgH, imgArea);
    if (!result) {
      cv.bitwise_not(binary, binary);
      result = findCardRect(binary, imgW, imgH, imgArea);
    }
    return result;
  } finally {
    hsv.delete();
    channels.delete();
    binary.delete();
  }
}

/**
 * Strategy 3: Canny edge detection — fallback.
 */
function detectWithCanny(src, imgW, imgH, imgArea) {
  const gray = new cv.Mat();
  const edges = new cv.Mat();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    cv.Canny(gray, edges, 30, 100);

    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);
    kernel.delete();

    return findCardRect(edges, imgW, imgH, imgArea);
  } finally {
    gray.delete();
    edges.delete();
  }
}

/**
 * Find the best card-shaped contour in a binary image.
 * Uses two approaches:
 *  1. approxPolyDP to find clean 4-corner contours
 *  2. minAreaRect on the largest valid contour as fallback
 */
function findCardRect(binary, imgW, imgH, imgArea) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  try {
    cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let bestPts = null;
    let bestArea = 0;
    let bestContourForRect = null;
    let bestContourArea = 0;

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);

      if (area < imgArea * MIN_AREA_RATIO) continue;
      if (area > imgArea * MAX_AREA_RATIO) continue;

      // Reject if bounding box spans nearly the full image
      const bbox = cv.boundingRect(contour);
      if (bbox.width > imgW * 0.95 && bbox.height > imgH * 0.95) continue;

      // Track largest valid contour for minAreaRect fallback
      if (area > bestContourArea) {
        bestContourArea = area;
        bestContourForRect = contour;
      }

      // Try approxPolyDP with multiple epsilon values
      const peri = cv.arcLength(contour, true);
      for (const eps of [0.02, 0.03, 0.04, 0.05]) {
        const approx = new cv.Mat();
        cv.approxPolyDP(contour, approx, eps * peri, true);

        if (approx.rows === 4 && cv.isContourConvex(approx) && area > bestArea) {
          const pts = [];
          for (let j = 0; j < 4; j++) {
            pts.push({
              x: approx.data32S[j * 2],
              y: approx.data32S[j * 2 + 1]
            });
          }
          bestArea = area;
          bestPts = pts;
        }
        approx.delete();
      }
    }

    // If approxPolyDP found a good quad, use it
    if (bestPts) return orderCorners(bestPts);

    // Fallback: use minAreaRect on the largest valid contour
    // This fits the tightest possible rotated rectangle around ANY blob shape
    if (bestContourForRect) {
      const rotRect = cv.minAreaRect(bestContourForRect);
      const vertices = cv.RotatedRect.points(rotRect);
      const pts = vertices.map(v => ({ x: Math.round(v.x), y: Math.round(v.y) }));

      // Clamp to image bounds
      for (const p of pts) {
        p.x = Math.max(0, Math.min(imgW - 1, p.x));
        p.y = Math.max(0, Math.min(imgH - 1, p.y));
      }

      return orderCorners(pts);
    }

    return null;
  } finally {
    contours.delete();
    hierarchy.delete();
  }
}

function orderCorners(pts) {
  // Sort by sum (x+y): smallest = top-left, largest = bottom-right
  // Sort by diff (y-x): smallest = top-right, largest = bottom-left
  const sorted = [...pts];

  const sums = sorted.map(p => p.x + p.y);
  const diffs = sorted.map(p => p.y - p.x);

  const tl = sorted[sums.indexOf(Math.min(...sums))];
  const br = sorted[sums.indexOf(Math.max(...sums))];
  const tr = sorted[diffs.indexOf(Math.min(...diffs))];
  const bl = sorted[diffs.indexOf(Math.max(...diffs))];

  return [tl, tr, br, bl];
}

// ===== Perspective Correction =====

/**
 * Expand detected corners outward from centroid by a small margin.
 * Ensures card corners aren't clipped by edge detection landing slightly inside the card.
 */
function expandCorners(corners, expansionPct, maxW, maxH) {
  // Calculate centroid
  const cx = corners.reduce((sum, c) => sum + c.x, 0) / 4;
  const cy = corners.reduce((sum, c) => sum + c.y, 0) / 4;

  return corners.map(c => {
    const dx = c.x - cx;
    const dy = c.y - cy;
    return {
      x: Math.max(0, Math.min(maxW - 1, Math.round(c.x + dx * expansionPct))),
      y: Math.max(0, Math.min(maxH - 1, Math.round(c.y + dy * expansionPct)))
    };
  });
}

function applyPerspectiveCorrection(srcCanvas, corners) {
  // Adaptive expansion based on how much of the image the detected quad covers.
  // Small quad = likely found inner artwork boundary, need larger expansion to reach card edge.
  // Large quad = close to card edge already or detection failed, expand less or not at all.
  const imgArea = srcCanvas.width * srcCanvas.height;
  const quadArea = Math.abs(
    (corners[0].x * corners[1].y - corners[1].x * corners[0].y) +
    (corners[1].x * corners[2].y - corners[2].x * corners[1].y) +
    (corners[2].x * corners[3].y - corners[3].x * corners[2].y) +
    (corners[3].x * corners[0].y - corners[0].x * corners[3].y)
  ) / 2;
  const coverageRatio = quadArea / imgArea;
  let expansionPct = 0;
  if (coverageRatio < 0.55) {
    expansionPct = 0.06; // Small in frame — likely found inner boundary, expand aggressively
  } else if (coverageRatio < 0.80) {
    expansionPct = 0.03; // Medium — minor adjustment
  }
  // >80% coverage: skip expansion, detection probably failed
  if (expansionPct > 0) {
    corners = expandCorners(corners, expansionPct, srcCanvas.width, srcCanvas.height);
  }

  const src = cv.imread(srcCanvas);

  // Calculate output dimensions from corners
  const widthTop = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
  const widthBottom = Math.hypot(corners[2].x - corners[3].x, corners[2].y - corners[3].y);
  const heightLeft = Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y);
  const heightRight = Math.hypot(corners[2].x - corners[1].x, corners[2].y - corners[1].y);

  let outW = Math.round(Math.max(widthTop, widthBottom));
  let outH = Math.round(Math.max(heightLeft, heightRight));

  // Snap to 5:7 card ratio if close
  const detectedRatio = outW / outH;
  if (Math.abs(detectedRatio - CARD_RATIO) < 0.15) {
    if (outW > outH) {
      outW = Math.round(outH * CARD_RATIO);
    } else {
      outH = Math.round(outW / CARD_RATIO);
    }
  }

  // Source points
  const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    corners[0].x, corners[0].y,
    corners[1].x, corners[1].y,
    corners[2].x, corners[2].y,
    corners[3].x, corners[3].y
  ]);

  // Destination points (card fills the rect)
  const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    outW, 0,
    outW, outH,
    0, outH
  ]);

  const M = cv.getPerspectiveTransform(srcPts, dstPts);
  const warped = new cv.Mat();
  cv.warpPerspective(src, warped, M, new cv.Size(outW, outH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));

  // Place on white canvas with proportional padding (8% of card size)
  const pad = Math.round(Math.max(outW, outH) * PADDING_RATIO);
  const finalW = outW + pad * 2;
  const finalH = outH + pad * 2;
  const result = new cv.Mat(finalH, finalW, cv.CV_8UC4, new cv.Scalar(255, 255, 255, 255));

  const roi = result.roi(new cv.Rect(pad, pad, outW, outH));
  warped.copyTo(roi);
  roi.delete();

  // Write to canvas
  const outCanvas = document.createElement('canvas');
  outCanvas.width = finalW;
  outCanvas.height = finalH;
  cv.imshow(outCanvas, result);

  // Cleanup
  src.delete();
  srcPts.delete();
  dstPts.delete();
  M.delete();
  warped.delete();
  result.delete();

  return outCanvas;
}

// ===== Scanner UI =====

let currentCorners = null;
let currentScale = 1;
let handles = [];
let activeHandle = null;

function showScannerOverlay(imgSrc, corners) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('scanner-overlay');
    const canvasWrap = document.getElementById('scanner-canvas-wrap');
    const canvas = document.getElementById('scanner-canvas');
    const linesCanvas = document.getElementById('scanner-lines');
    const controls = document.getElementById('scanner-controls');
    const loading = document.getElementById('scanner-loading');

    loading.classList.add('hidden');
    controls.classList.remove('hidden');

    const img = new Image();
    img.onload = () => {
      // Size canvas to fit viewport
      const maxW = window.innerWidth - 32;
      const maxH = window.innerHeight - 160;
      currentScale = Math.min(maxW / img.width, maxH / img.height, 1);
      const displayW = Math.round(img.width * currentScale);
      const displayH = Math.round(img.height * currentScale);

      canvas.width = displayW;
      canvas.height = displayH;
      linesCanvas.width = displayW;
      linesCanvas.height = displayH;
      canvasWrap.style.width = displayW + 'px';
      canvasWrap.style.height = displayH + 'px';

      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, displayW, displayH);

      // Scale corners to display coordinates
      currentCorners = corners.map(c => ({
        x: c.x * currentScale,
        y: c.y * currentScale
      }));

      renderHandles(canvasWrap);
      drawEdgeLines();
      overlay.classList.remove('hidden');
    };
    img.src = imgSrc;

    // Apply button
    const applyBtn = document.getElementById('scanner-apply');
    const origBtn = document.getElementById('scanner-use-original');

    const cleanup = () => {
      applyBtn.removeEventListener('click', onApply);
      origBtn.removeEventListener('click', onOriginal);
      removeHandles();
      overlay.classList.add('hidden');
    };

    const onApply = () => {
      // Convert display corners back to image coordinates
      const imgCorners = currentCorners.map(c => ({
        x: Math.round(c.x / currentScale),
        y: Math.round(c.y / currentScale)
      }));
      cleanup();
      resolve({ apply: true, corners: imgCorners });
    };

    const onOriginal = () => {
      cleanup();
      resolve({ apply: false });
    };

    applyBtn.addEventListener('click', onApply);
    origBtn.addEventListener('click', onOriginal);
  });
}

function renderHandles(container) {
  removeHandles();
  handles = [];

  currentCorners.forEach((corner, i) => {
    const handle = document.createElement('div');
    handle.className = 'scanner-handle';
    handle.style.left = (corner.x - 14) + 'px';
    handle.style.top = (corner.y - 14) + 'px';
    handle.dataset.index = i;

    setupHandleDrag(handle, container);
    container.appendChild(handle);
    handles.push(handle);
  });
}

function removeHandles() {
  handles.forEach(h => h.remove());
  handles = [];
}

function setupHandleDrag(handle, container) {
  let startX, startY, startLeft, startTop;
  const canvas = document.getElementById('scanner-canvas');

  const onStart = (clientX, clientY) => {
    activeHandle = handle;
    handle.classList.add('active');
    const rect = container.getBoundingClientRect();
    startX = clientX;
    startY = clientY;
    startLeft = parseFloat(handle.style.left);
    startTop = parseFloat(handle.style.top);
  };

  const onMove = (clientX, clientY) => {
    if (activeHandle !== handle) return;
    const dx = clientX - startX;
    const dy = clientY - startY;
    let newLeft = startLeft + dx;
    let newTop = startTop + dy;

    // Clamp to canvas bounds
    newLeft = Math.max(-14, Math.min(canvas.width - 14, newLeft));
    newTop = Math.max(-14, Math.min(canvas.height - 14, newTop));

    handle.style.left = newLeft + 'px';
    handle.style.top = newTop + 'px';

    // Update corner position
    const idx = parseInt(handle.dataset.index);
    currentCorners[idx] = { x: newLeft + 14, y: newTop + 14 };
    drawEdgeLines();
  };

  const onEnd = () => {
    if (activeHandle === handle) {
      handle.classList.remove('active');
      activeHandle = null;
    }
  };

  // Touch events
  handle.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const t = e.touches[0];
    onStart(t.clientX, t.clientY);
  });

  document.addEventListener('touchmove', (e) => {
    if (activeHandle !== handle) return;
    const t = e.touches[0];
    onMove(t.clientX, t.clientY);
  }, { passive: true });

  document.addEventListener('touchend', onEnd);

  // Mouse events
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    onStart(e.clientX, e.clientY);
  });

  document.addEventListener('mousemove', (e) => {
    if (activeHandle !== handle) return;
    onMove(e.clientX, e.clientY);
  });

  document.addEventListener('mouseup', onEnd);
}

function drawEdgeLines() {
  const canvas = document.getElementById('scanner-lines');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!currentCorners || currentCorners.length !== 4) return;

  // Dark overlay outside the card quad
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Cut out the card area
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.moveTo(currentCorners[0].x, currentCorners[0].y);
  for (let i = 1; i < 4; i++) {
    ctx.lineTo(currentCorners[i].x, currentCorners[i].y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  // Dashed edge lines
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 4]);
  ctx.beginPath();
  ctx.moveTo(currentCorners[0].x, currentCorners[0].y);
  for (let i = 1; i < 4; i++) {
    ctx.lineTo(currentCorners[i].x, currentCorners[i].y);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
}

// ===== Public API =====

/**
 * Show interactive scanner overlay for a single photo.
 * Returns { enhanced: boolean, fullBase64?, imageBlob? }
 */
export async function showScanner(fullBase64) {
  try {
    // Show loading state
    const overlay = document.getElementById('scanner-overlay');
    const loading = document.getElementById('scanner-loading');
    const controls = document.getElementById('scanner-controls');

    overlay.classList.remove('hidden');
    loading.classList.remove('hidden');
    controls.classList.add('hidden');

    await loadOpenCV();

    // Draw image to temp canvas for OpenCV
    const tempCanvas = document.createElement('canvas');
    const img = await loadImageFromSrc(fullBase64);
    tempCanvas.width = img.width;
    tempCanvas.height = img.height;
    tempCanvas.getContext('2d').drawImage(img, 0, 0);

    const corners = detectCardEdges(tempCanvas);

    if (!corners) {
      // No card detected — skip scanner
      overlay.classList.add('hidden');
      return { enhanced: false };
    }

    // Show overlay with draggable corners
    const result = await showScannerOverlay(fullBase64, corners);

    if (!result.apply) {
      return { enhanced: false };
    }

    // Apply perspective correction
    const correctedCanvas = applyPerspectiveCorrection(tempCanvas, result.corners);
    const correctedBase64 = correctedCanvas.toDataURL('image/jpeg', 0.92);

    // Convert to blob for storage
    const blob = await new Promise(r => correctedCanvas.toBlob(r, 'image/jpeg', 0.92));
    const reader = new FileReader();
    const blobBase64 = await new Promise((resolve, reject) => {
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

    return {
      enhanced: true,
      fullBase64: correctedBase64,
      imageBlob: blobBase64
    };
  } catch (err) {
    console.warn('[Scanner] Failed, using original:', err.message);
    const overlay = document.getElementById('scanner-overlay');
    if (overlay) overlay.classList.add('hidden');
    return { enhanced: false };
  }
}

/**
 * Non-interactive auto-enhance for batch gallery uploads.
 * Returns { enhanced: boolean, fullBase64?, imageBlob? }
 */
export async function autoEnhance(fullBase64) {
  try {
    await loadOpenCV();

    const tempCanvas = document.createElement('canvas');
    const img = await loadImageFromSrc(fullBase64);
    tempCanvas.width = img.width;
    tempCanvas.height = img.height;
    tempCanvas.getContext('2d').drawImage(img, 0, 0);

    const corners = detectCardEdges(tempCanvas);

    if (!corners) {
      return { enhanced: false };
    }

    const correctedCanvas = applyPerspectiveCorrection(tempCanvas, corners);
    const correctedBase64 = correctedCanvas.toDataURL('image/jpeg', 0.92);

    const blob = await new Promise(r => correctedCanvas.toBlob(r, 'image/jpeg', 0.92));
    const reader = new FileReader();
    const blobBase64 = await new Promise((resolve, reject) => {
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

    return {
      enhanced: true,
      fullBase64: correctedBase64,
      imageBlob: blobBase64
    };
  } catch (err) {
    console.warn('[Scanner] Auto-enhance failed:', err.message);
    return { enhanced: false };
  }
}

// ===== Helpers =====

function loadImageFromSrc(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = src;
  });
}
