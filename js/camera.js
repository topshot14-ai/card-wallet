// Photo capture, resize, thumbnail generation, base64 export

const MAX_DIMENSION = 1568;
const THUMB_SIZE = 200;
const JPEG_QUALITY = 0.92;
const THUMB_QUALITY = 0.7;

/**
 * Process a File from the camera input.
 * Returns { fullBase64, thumbnailBase64, imageBlob, imageThumbnail }
 */
export async function processPhoto(file) {
  const img = await loadImage(file);
  const { canvas: fullCanvas } = resizeToFit(img, MAX_DIMENSION);
  const { canvas: thumbCanvas } = resizeToFit(img, THUMB_SIZE);

  const fullBase64 = fullCanvas.toDataURL('image/jpeg', JPEG_QUALITY);
  const thumbBase64 = thumbCanvas.toDataURL('image/jpeg', THUMB_QUALITY);

  const imageBlob = await canvasToBlob(fullCanvas, 'image/jpeg', JPEG_QUALITY);
  const thumbBlob = await canvasToBlob(thumbCanvas, 'image/jpeg', THUMB_QUALITY);

  // Convert blobs to base64 for IndexedDB storage
  const imageBlobBase64 = await blobToBase64(imageBlob);
  const thumbBlobBase64 = await blobToBase64(thumbBlob);

  return {
    fullBase64,          // data:image/jpeg;base64,... for API
    thumbnailBase64: thumbBase64, // for display
    imageBlob: imageBlobBase64,   // for IndexedDB
    imageThumbnail: thumbBlobBase64 // for IndexedDB
  };
}

/**
 * Get the base64 content (without data URI prefix) for the API call.
 */
export function stripDataUri(dataUri) {
  return dataUri.split(',')[1];
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      resolve(img);
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = URL.createObjectURL(file);
  });
}

function resizeToFit(img, maxDim) {
  let { width, height } = img;

  if (width > maxDim || height > maxDim) {
    if (width > height) {
      height = Math.round(height * (maxDim / width));
      width = maxDim;
    } else {
      width = Math.round(width * (maxDim / height));
      height = maxDim;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);

  return { canvas, width, height };
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, type, quality);
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to convert blob'));
    reader.readAsDataURL(blob);
  });
}
