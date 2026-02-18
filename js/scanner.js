// Card edge detection + perspective correction using OpenCV.js
// Lazy-loads OpenCV from CDN on first use, cached by service worker

const OPENCV_CDN = 'https://cdn.jsdelivr.net/npm/opencv.js@1.2.1/opencv.js';
const CARD_RATIO = 5 / 7; // Standard trading card aspect ratio
const PADDING = 40; // White border padding in px
const MIN_AREA_RATIO = 0.10; // Card must be at least 10% of image area

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
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const hierarchy = new cv.Mat();
  const contours = new cv.MatVector();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(7, 7), 0);

    // Adaptive threshold for varying lighting
    const thresh = new cv.Mat();
    cv.adaptiveThreshold(blurred, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 11, 2);

    // Canny edge detection
    cv.Canny(blurred, edges, 50, 150);

    // Combine edges with threshold
    cv.bitwise_or(edges, thresh, edges);
    thresh.delete();

    // Dilate to connect broken edges
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(edges, edges, kernel);
    kernel.delete();

    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const imgArea = canvas.width * canvas.height;
    let bestContour = null;
    let bestArea = 0;

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);

      if (area < imgArea * MIN_AREA_RATIO) continue;

      const peri = cv.arcLength(contour, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(contour, approx, 0.02 * peri, true);

      if (approx.rows === 4 && cv.isContourConvex(approx) && area > bestArea) {
        bestArea = area;
        if (bestContour) bestContour.delete();
        bestContour = approx;
      } else {
        approx.delete();
      }
    }

    if (!bestContour) return null;

    // Extract corner points
    const pts = [];
    for (let i = 0; i < 4; i++) {
      pts.push({
        x: bestContour.data32S[i * 2],
        y: bestContour.data32S[i * 2 + 1]
      });
    }
    bestContour.delete();

    return orderCorners(pts);
  } finally {
    src.delete();
    gray.delete();
    blurred.delete();
    edges.delete();
    hierarchy.delete();
    contours.delete();
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

  // Place on white canvas with padding
  const finalW = outW + PADDING * 2;
  const finalH = outH + PADDING * 2;
  const result = new cv.Mat(finalH, finalW, cv.CV_8UC4, new cv.Scalar(255, 255, 255, 255));

  const roi = result.roi(new cv.Rect(PADDING, PADDING, outW, outH));
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
