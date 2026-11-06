/*
 * Image handling for the admin panel: client-side compression (canvas → WebP, JPEG fallback) and
 * Firebase Storage uploads. Storage rules accept only JPEG/PNG/WebP under 5 MB, from staff with an upload role,
 * at   products/{productId}/{file}   and   site/{kind}/{file}.
 *
 *   const img = await uploadProductImage(productId, file, { onProgress: (pct) => … });
 *   //  → { id, url, thumb, w, h, path, thumbPath, size, alt: '' }      (store this object in products/{id}.images[])
 *
 *   const { url, path } = await uploadSiteImage('banners', file, { maxSide: 1920 });
 *   await deleteStoragePath(path);                                         // best effort, never throws
 *
 *   const files = await pickFiles({ accept: 'image/*', multiple: true });  // opens the native file chooser
 *
 * Every function throws AppError (bilingual message) for bad type / size so pages can just toastError(explainError(e)).
 */
import { storageApi } from '../../core/firebase.js';
import { LIMITS } from '../../shared/constants.js';
import { shortId } from '../../shared/id.js';
import { AppError } from '../../core/errors.js';
import { t } from '../../core/i18n.js';

export const SITE_KINDS = Object.freeze(['banners', 'categories', 'brands', 'logo', 'pages', 'misc']);
const MAX_INPUT_BYTES = 25 * 1024 * 1024;           // refuse absurd originals before decoding them
const CACHE = 'public,max-age=31536000,immutable';  // file names are unique per upload, so they never change

/* ───────────────────────── decode / encode ───────────────────────── */

function loadViaImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight, close() {} }); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new AppError('storage/type', t('err.storage.type'))); };
    img.src = url;
  });
}

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close && bmp.close() };
    } catch { /* fall through to <img> */ }
  }
  return loadViaImg(file);
}

function toBlob(canvas, mime, quality) {
  return new Promise((resolve) => {
    if (canvas.convertToBlob) { canvas.convertToBlob({ type: mime, quality }).then(resolve, () => resolve(null)); return; }
    canvas.toBlob((b) => resolve(b), mime, quality);
  });
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

export function checkFile(file) {
  if (!file || !LIMITS.IMAGE_TYPES.includes(file.type)) throw new AppError('storage/type', t('err.storage.type'));
  if (file.size > MAX_INPUT_BYTES) throw new AppError('storage/size', t('err.storage.size'));
}

/**
 * Resize so the longest side is at most `maxSide` and encode as WebP (JPEG when WebP encoding is unavailable).
 * Retries with smaller dimensions / lower quality until the result fits the 5 MB storage limit.
 * @returns {Promise<{blob: Blob, width: number, height: number, mime: string, ext: string}>}
 */
export async function compressImage(file, { maxSide = 1600, quality = 0.82, mime = 'image/webp' } = {}) {
  checkFile(file);
  const dec = await decode(file);
  try {
    let side = maxSide; let q = quality;
    for (let attempt = 0; attempt < 4; attempt++) {
      const scale = Math.min(1, side / Math.max(dec.width, dec.height));
      const w = Math.max(1, Math.round(dec.width * scale)); const h = Math.max(1, Math.round(dec.height * scale));
      const canvas = makeCanvas(w, h);
      const ctx = canvas.getContext('2d');
      let outMime = mime;
      let blob = null;
      if (outMime === 'image/webp') {
        ctx.drawImage(dec.source, 0, 0, w, h);
        blob = await toBlob(canvas, 'image/webp', q);
        if (!blob || blob.type !== 'image/webp') outMime = 'image/jpeg';     // browser could not encode WebP
      }
      if (outMime !== 'image/webp') {
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);                     // JPEG has no alpha
        ctx.drawImage(dec.source, 0, 0, w, h);
        blob = await toBlob(canvas, 'image/jpeg', q);
      }
      if (!blob) throw new AppError('storage/type', t('err.storage.type'));
      if (blob.size < LIMITS.MAX_IMAGE_BYTES) return { blob, width: w, height: h, mime: blob.type, ext: blob.type === 'image/webp' ? 'webp' : 'jpg' };
      side = Math.round(side * 0.8); q = Math.max(0.5, q - 0.12);
    }
    throw new AppError('storage/size', t('err.storage.size'));
  } finally { dec.close(); }
}

/* ───────────────────────── Storage ───────────────────────── */

/** Upload a Blob. Resolves { url, path, size }. onProgress receives 0..100. */
export async function uploadBlob(path, blob, { onProgress, cacheControl = CACHE } = {}) {
  const { storage, ref, uploadBytesResumable, getDownloadURL } = await storageApi();
  const r = ref(storage, path);
  const task = uploadBytesResumable(r, blob, { contentType: blob.type, cacheControl });
  await new Promise((resolve, reject) => {
    task.on('state_changed',
      (snap) => { if (onProgress && snap.totalBytes) onProgress(Math.round((snap.bytesTransferred / snap.totalBytes) * 100)); },
      reject, resolve);
  });
  return { url: await getDownloadURL(r), path, size: blob.size };
}

/** Best-effort delete (missing files and permission problems are ignored). */
export async function deleteStoragePath(path) {
  if (!path) return false;
  try { const { storage, ref, deleteObject } = await storageApi(); await deleteObject(ref(storage, path)); return true; } catch { return false; }
}

/**
 * Product gallery image: a 1600 px "large" and a 480 px "thumb", both WebP.
 * @returns {Promise<{id,url,thumb,alt,w,h,size,path,thumbPath}>}
 */
export async function uploadProductImage(productId, file, { onProgress } = {}) {
  if (!productId) throw new AppError('storage/path', 'productId is required');
  const id = shortId(8);
  const large = await compressImage(file, { maxSide: 1600, quality: 0.82 });
  const thumb = await compressImage(file, { maxSide: 480, quality: 0.78 });
  const base = `products/${productId}/${id}`;
  const parts = [0, 0];
  const report = () => { if (onProgress) onProgress(Math.round((parts[0] * 0.8 + parts[1] * 0.2))); };
  const [a, b] = await Promise.all([
    uploadBlob(`${base}-large.${large.ext}`, large.blob, { onProgress: (p) => { parts[0] = p; report(); } }),
    uploadBlob(`${base}-thumb.${thumb.ext}`, thumb.blob, { onProgress: (p) => { parts[1] = p; report(); } }),
  ]);
  return { id, url: a.url, thumb: b.url, alt: '', w: large.width, h: large.height, size: a.size, path: a.path, thumbPath: b.path };
}

/** Delete both files of a gallery image object produced by uploadProductImage (legacy images without paths are skipped). */
export async function deleteProductImage(img) {
  if (!img) return;
  await Promise.all([deleteStoragePath(img.path), deleteStoragePath(img.thumbPath)]);
}

/** Banner / category / brand / logo image under site/{kind}/. */
export async function uploadSiteImage(kind, file, { maxSide = 1920, quality = 0.84, onProgress } = {}) {
  if (!SITE_KINDS.includes(kind)) throw new AppError('storage/path', `Unknown image kind: ${kind}`);
  const img = await compressImage(file, { maxSide, quality });
  const path = `site/${kind}/${shortId(10)}.${img.ext}`;
  const res = await uploadBlob(path, img.blob, { onProgress });
  return { url: res.url, path, w: img.width, h: img.height, size: res.size };
}

/* ───────────────────────── file chooser ───────────────────────── */

/** Open the native file chooser. Resolves with an array of Files ([] if the user cancelled, where the browser reports it). */
export function pickFiles({ accept = 'image/jpeg,image/png,image/webp', multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept; input.multiple = multiple;
    input.style.display = 'none';
    const done = (files) => { input.remove(); resolve(files); };
    input.addEventListener('change', () => done([...(input.files || [])]));
    input.addEventListener('cancel', () => done([]));
    document.body.appendChild(input);
    input.click();
  });
}
