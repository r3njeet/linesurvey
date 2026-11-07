import { t } from './i18n.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Feeder / substation names in the master carry a code suffix: "RAMPUR_39227292034RMR" */
export const shortName = (s) => String(s || '').split('_')[0];

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${pad(d.getDate())}-${MON[d.getMonth()]}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fmtDate(iso) { return fmtDateTime(iso).slice(0, 11); }
export const dayKey = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const fmtNum = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
export const fmtLatLng = (g) => g && g.lat != null ? `${g.lat.toFixed(6)}, ${g.lng.toFixed(6)}` : '—';

export function uid() {
  const t = Date.now().toString(36);
  const r = (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2)).slice(0, 10);
  return `${t}-${r}`;
}

let toastTimer;
export function toast(msg, type = 'info', ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), ms);
}

export function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Could not read image'));
    img.src = src;
  });
}

/**
 * Resize a camera photo and burn a geo-stamp into its lower band.
 * Returns { blob, width, height }.
 */
export async function stampPhoto(file, lines, maxSide = 1600, quality = 0.82) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const fs = Math.max(12, Math.round(w / 42));
    const lh = Math.round(fs * 1.35);
    const bandH = lh * lines.length + fs;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, h - bandH, w, bandH);
    ctx.fillStyle = '#fff';
    ctx.font = `600 ${fs}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    ctx.textBaseline = 'top';
    lines.forEach((ln, i) => ctx.fillText(ln, Math.round(fs * 0.6), h - bandH + Math.round(fs / 2) + i * lh, w - fs));
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', quality));
    return { blob, width: w, height: h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Downscale any image blob to a JPEG data URL (used for PDF embedding). */
export async function blobToJpegDataURL(blob, maxSide = 1000, quality = 0.8) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return { dataURL: c.toDataURL('image/jpeg', quality), width: c.width, height: c.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

export function optionList(values, placeholder, labelFn = (v) => v) {
  return `<option value="" data-i18n="${esc(placeholder)}">${esc(t(placeholder))}</option>` +
    values.map(v => `<option value="${esc(v)}">${esc(labelFn(v))}</option>`).join('');
}

/** Distance in metres between two {lat, lng} points. */
export function distanceM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
