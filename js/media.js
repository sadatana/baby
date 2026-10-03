// 写真の保存（IndexedDB）と縮小・圧縮。ブラウザ専用
import { exifDate } from './growth.js';

const DB_NAME = 'baby-media';
const STORE = 'files';
const FULL_MAX = 2048; // 長辺（px）
const THUMB_MAX = 400;

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export function putFile(id, full, thumb) {
  return tx('readwrite', (s) => s.put({ id, full, thumb }));
}

export function getFile(id) {
  return tx('readonly', (s) => s.get(id));
}

export async function deleteFile(id) {
  revoke(id);
  await tx('readwrite', (s) => s.delete(id));
}

export async function clearFiles() {
  for (const id of [...urlCache.keys()]) revoke(id);
  await tx('readwrite', (s) => s.clear());
}

// 表示用の URL（object URL）をキャッシュして返す
const urlCache = new Map(); // id -> { thumb, full }
function revoke(id) {
  const c = urlCache.get(id);
  if (c?.thumb) URL.revokeObjectURL(c.thumb);
  if (c?.full) URL.revokeObjectURL(c.full);
  urlCache.delete(id);
}

export async function fileUrl(id, size = 'thumb') {
  const cached = urlCache.get(id)?.[size];
  if (cached) return cached;
  const rec = await getFile(id);
  if (!rec?.[size]) return null;
  const url = URL.createObjectURL(rec[size]);
  urlCache.set(id, { ...urlCache.get(id), [size]: url });
  return url;
}

// 画面内の <img data-media-id> に画像を読み込む
export function hydrateImages(root) {
  root.querySelectorAll('img[data-media-id]:not([src])').forEach(async (img) => {
    const url = await fileUrl(img.dataset.mediaId, img.dataset.size || 'thumb').catch(() => null);
    if (url) img.src = url;
    else img.closest('.photo')?.classList.add('missing');
  });
}

async function decode(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // HEIC など createImageBitmap が対応していない形式は下の方法で試す
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function resize(src, max, quality) {
  const w = src.width;
  const h = src.height;
  const scale = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve({ blob: b, width: canvas.width, height: canvas.height })
      : reject(new Error('encode failed'))), 'image/jpeg', quality);
  });
}

// 選ばれた画像ファイルを縮小して保存し、写真の情報を返す
export async function importImage(file, id) {
  const [src, head] = await Promise.all([decode(file), file.slice(0, 128 * 1024).arrayBuffer()]);
  const full = await resize(src, FULL_MAX, 0.85);
  const thumb = await resize(src, THUMB_MAX, 0.8);
  src.close?.();
  await putFile(id, full.blob, thumb.blob);
  return { width: full.width, height: full.height, takenAt: exifDate(head), bytes: full.blob.size };
}

// ブラウザがストレージを自動削除しにくくなるよう依頼する（対応ブラウザのみ）
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    // 非対応
  }
}

export async function storageEstimate() {
  try {
    return await navigator.storage?.estimate?.();
  } catch {
    return null;
  }
}
