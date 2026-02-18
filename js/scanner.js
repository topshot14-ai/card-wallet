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
  const imgW = canvas.width;
  const imgH = canvas.height;
  const imgArea = imgW * imgH;

  // Try multiple detection strategies, return first success
  const strategies = [
    () => detectWithOtsu(canvas, imgW, imgH, imgArea),
    () => detectWithAdaptive(canvas, imgW, imgH, imgArea),
    () => detectWithCanny(canvas, imgW, imgH, imgArea),
  ];

  for (const strategy of strategies) {
    const result = strategy();
    if (result) return result;
  }

  return null;
}

/**
 * Strategy 1: Otsu threshold — best when card and background have different brightness.
 * Automatically finds the optimal threshold to separate them.
 */
function detectWithOtsu(canvas, imgW, imgH, imgArea) {
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  const binary = new cv.Mat();
  const hierarchy = new cv.Mat();
  const contours = new cv.MatVector();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

    // Clean up the binary mask — fill small holes, smooth edges
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
    cv.morphologyEx(binary, binary, cv.MORPH_CLOSE, kernel);
    cv.morphologyEx(binary, binary, cv.MORPH_OPEN, kernel);
    kernel.delete();

    // Try both normal and inverted (card could be lighter or darker than bg)
    let result = findBestQuad(binary, contours, hierarchy, imgW, imgH, imgArea);
    if (!result) {
      cv.bitwise_not(binary, binary);
      contours.delete();
      hierarchy.delete();
      const contours2 = new cv.MatVector();
      const hierarchy2 = new cv.Mat();
      result = findBestQuad(binary, contours2, hierarchy2, imgW, imgH, imgArea);
      contours2.delete();
      hierarchy2.delete();
    }
    return result;
  } finally {
    src.delete();
    gray.delete();
    binary.delete();
    hierarchy.delete();
    contours.delete();
  }
}

/**
 * Strategy 2: Adaptive threshold with large block size — handles uneven lighting.
 */
function detectWithAdaptive(canvas, imgW, imgH, imgArea) {
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  const binary = new cv.Mat();
  const hierarchy = new cv.Mat();
  const contours = new cv.MatVector();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);

    // Large block size to focus on the card-level brightness change, not card details
    const blockSize = Math.round(Math.min(imgW, imgH) * 0.15) | 1; // ensure odd
    cv.adaptiveThreshold(gray, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, Math.max(blockSize, 51), 5);

    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
    cv.morphologyEx(binary, binary, cv.MORPH_CLOSE, kernel);
    cv.morphologyEx(binary, binary, cv.MORPH_OPEN, kernel);
    kernel.delete();

    let result = findBestQuad(binary, contours, hierarchy, imgW, imgH, imgArea);
    if (!result) {
      cv.bitwise_not(binary, binary);
      contours.delete();
      hierarchy.delete();
      const contours2 = new cv.MatVector();
      const hierarchy2 = new cv.Mat();
      result = findBestQuad(binary, contours2, hierarchy2, imgW, imgH, imgArea);
      contours2.delete();
      hierarchy2.delete();
    }
    return result;
  } finally {
    src.delete();
    gray.delete();
    binary.delete();
    hierarchy.delete();
    contours.delete();
  }
}

/**
 * Strategy 3: Canny edge detection — fallback for tricky lighting.
 */
function detectWithCanny(canvas, imgW, imgH, imgArea) {
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  const edges = new cv.Mat();
  const hierarchy = new cv.Mat();
  const contours = new cv.MatVector();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    cv.Canny(gray, edges, 30, 100);

    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
    cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);
    kernel.delete();

    return findBestQuad(edges, contours, hierarchy, imgW, imgH, imgArea);
  } finally {
    src.delete();
    gray.delete();
    edges.delete();
    hierarchy.delete();
    contours.delete();
  }
}

/**
 * Shared: find the best 4-corner contour in a binary image.
 * Tries multiple epsilon values for approxPolyDP to be more tolerant.
 */
function findBestQuad(binary, contours, hierarchy, imgW, imgH, imgArea) {
  cv.findContours(binary, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

  const margin = Math.min(imgW, imgH) * 0.02;
  let bestPts = null;
  let bestArea = 0;

  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    const area = cv.contourArea(contour);

    if (area < imgArea * MIN_AREA_RATIO) continue;
    if (area > imgArea * MAX_AREA_RATIO) continue;

    const peri = cv.arcLength(contour, true);

    // Try multiple epsilon values — noisy contours need more smoothing
    for (const eps of [0.02, 0.03, 0.04, 0.05]) {
      const approx = new cv.Mat();
      cv.approxPolyDP(contour, approx, eps * peri, true);

      if (approx.rows === 4 && cv.isContourConvex(approx) && area > bestArea) {
        // Reject if bounding box spans nearly the full image
        const rect = cv.boundingRect(approx);
        if (rect.width > imgW * 0.95 && rect.height > imgH * 0.95) {
          approx.delete();
          continue;
        }

        // Reject if 3+ corners hug the image boundary
        let edgeCorners = 0;
        for (let j = 0; j < 4; j++) {
          const px = approx.data32S[j * 2];
          const py = approx.data32S[j * 2 + 1];
          if (px < margin || px > imgW - margin || py < margin || py > imgH - margin) {
            edgeCorners++;
          }
        }
        if (edgeCorners >= 3) {
          approx.delete();
          continue;
        }

        // Extract points
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

  return bestPts ? orderCorners(bestPts) : null;
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

function applyPerspectiveCorrection(srcCanvas, corners) {
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
