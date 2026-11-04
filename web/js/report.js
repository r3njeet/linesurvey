import { CONFIG } from './config.js';
import { MATERIALS, materialById, irregularityName } from './catalog.js';
import { $, $$, esc, toast, fmtDateTime, fmtDate, fmtLatLng, fmtNum, shortName, downloadBlob, blobToJpegDataURL, dayKey } from './util.js';
import { listSurveys, getPhotoBlob, deleteSurvey, role, bus } from './api.js';
import { filterBarHTML, wireFilterBar, applyFilters } from './filters.js';
import { displayName } from './survey.js';

let root, getF, all = [], view = [], selected = new Set(), limit = 100, busy = false;

export function initReport(el) {
  root = el;
  root.innerHTML = `
    <div class="view-head"><h1>Reports</h1><span id="rp-meta" class="muted"></span>
      <button class="btn small ghost" id="rp-refresh">Refresh</button></div>
    ${filterBarHTML('rp', { extra: true })}
    <div class="rp-tools card">
      <label class="chk"><input type="checkbox" id="rp-all"><span>Select all <b id="rp-count">0</b> shown</span></label>
      <span class="spacer"></span>
      <span class="muted" id="rp-sel">0 selected</span>
      <button class="btn" id="rp-csv">Export Excel (CSV)</button>
      <button class="btn primary" id="rp-pdf" disabled>Download PDF</button>
    </div>
    <div id="rp-list" class="rp-list"><div class="empty">Loading…</div></div>
    <dialog id="rp-dlg" class="dlg"></dialog>`;
  getF = wireFilterBar('rp', () => { limit = 100; render(); });
  $('#rp-refresh').onclick = () => load(true);
  $('#rp-all').onchange = (e) => { view.forEach(s => (e.target.checked ? selected.add(s.id) : selected.delete(s.id))); render(); };
  $('#rp-pdf').onclick = () => makePDF(all.filter(s => selected.has(s.id)));
  $('#rp-csv').onclick = exportCSV;
  $('#rp-list').addEventListener('click', onListClick);
  $('#rp-list').addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-sel]'); if (!cb) return;
    cb.checked ? selected.add(cb.dataset.sel) : selected.delete(cb.dataset.sel);
    updateSel();
  });
  bus.addEventListener('data', () => { if (!root.hidden) load(true); });
}

export async function showReport() { await load(false); }

async function load(fresh) {
  try {
    const r = await listSurveys({ fresh });
    all = [...r.surveys].sort((a, b) => (b.seq || 0) - (a.seq || 0));
    $('#rp-meta').textContent = r.offline ? `Offline copy · ${fmtDate(r.at)}` : '';
    const ids = new Set(all.map(s => s.id));
    selected = new Set([...selected].filter(id => ids.has(id)));
    render();
  } catch (err) {
    $('#rp-list').innerHTML = `<div class="empty err">${esc(err.message)}</div>`;
  }
}

function render() {
  view = applyFilters(all, getF(), irregularityName);
  $('#rp-count').textContent = view.length;
  if (!view.length) { $('#rp-list').innerHTML = `<div class="empty">${all.length ? 'No surveys match the filters.' : 'No surveys submitted yet.'}</div>`; updateSel(); return; }
  $('#rp-list').innerHTML = view.slice(0, limit).map(s => `
    <article class="rp-item ${selected.has(s.id) ? 'sel' : ''}">
      <label class="rp-cb"><input type="checkbox" data-sel="${s.id}" ${selected.has(s.id) ? 'checked' : ''} aria-label="Select ${esc(s.ref)}"></label>
      <div class="rp-main" data-open="${s.id}">
        <div class="rp-top"><b>${esc(s.ref || s.id)}</b><span class="muted">${fmtDateTime(s.capturedAt || s.createdAt)}</span>
          ${s.materialRequired ? '<span class="pill mat">Material</span>' : ''}</div>
        <div class="rp-sub">${esc(shortName(s.feeder))} feeder · ${esc(shortName(s.substation))} · ${esc(s.subdivision)}</div>
        <div class="rp-irr">${s.irregularities.map(i => `<span class="pill">${esc(irregularityName(i))}</span>`).join('')}</div>
        <div class="rp-loc muted">${esc(s.location)} — ${esc(s.landmark)}</div>
      </div>
      <button class="btn small" data-pdf="${s.id}" title="Single-page PDF">PDF</button>
    </article>`).join('') +
    (view.length > limit ? `<button class="btn ghost block" id="rp-more">Show more (${view.length - limit} remaining)</button>` : '');
  const more = $('#rp-more'); if (more) more.onclick = () => { limit += 200; render(); };
  updateSel();
}

function updateSel() {
  const n = selected.size;
  $('#rp-sel').textContent = `${n} selected`;
  $('#rp-pdf').disabled = !n || busy;
  if (!busy) $('#rp-pdf').textContent = n > 1 ? `Download PDF (${n} surveys)` : 'Download PDF';
  $('#rp-all').checked = view.length > 0 && view.every(s => selected.has(s.id));
  $$('.rp-item', root).forEach(a => a.classList.toggle('sel', selected.has($('input', a).dataset.sel)));
}

function onListClick(e) {
  const pdf = e.target.closest('[data-pdf]');
  if (pdf) { makePDF([all.find(s => s.id === pdf.dataset.pdf)]); return; }
  const open = e.target.closest('[data-open]');
  if (open) openDetail(all.find(s => s.id === open.dataset.open));
}

/* ---------------- detail dialog ---------------- */
async function openDetail(s) {
  const dlg = $('#rp-dlg');
  const mats = (s.materials || []).map(m => ({ ...materialById(m.id), qty: m.qty }));
  dlg.innerHTML = `
    <div class="dlg-head"><h2>${esc(s.ref)}</h2><button class="btn small ghost" data-close aria-label="Close">✕</button></div>
    <div class="dlg-body">
      <dl class="kv">
        <dt>Subdivision</dt><dd>${esc(s.subdivision)}</dd>
        <dt>Substation</dt><dd>${esc(displayName(s.substation))}</dd>
        <dt>Feeder</dt><dd>${esc(displayName(s.feeder))}</dd>
        <dt>Captured</dt><dd>${fmtDateTime(s.capturedAt)}</dd>
        <dt>Location</dt><dd>${esc(s.location)}</dd>
        <dt>Landmark</dt><dd>${esc(s.landmark)}</dd>
        <dt>GPS</dt><dd><a href="https://www.google.com/maps?q=${s.gps.lat},${s.gps.lng}" target="_blank" rel="noopener">${fmtLatLng(s.gps)}</a> ±${Math.round(s.gps.acc || 0)} m</dd>
        <dt>Surveyor</dt><dd>${esc(s.surveyor?.name)}</dd>
        ${s.remarks ? `<dt>Remarks</dt><dd>${esc(s.remarks)}</dd>` : ''}
      </dl>
      <h3>Irregularities</h3>
      <div class="rp-irr">${s.irregularities.map(i => `<span class="pill">${esc(irregularityName(i))}</span>`).join('')}</div>
      <h3>Photographs</h3>
      <div class="dlg-photos">${s.photos.map((p, i) => `<figure><div class="ph-load" data-key="${esc(p.key)}">Loading…</div><figcaption>#${i + 1} · ${fmtLatLng(p)} · ${fmtDateTime(p.takenAt)}</figcaption></figure>`).join('')}</div>
      <h3>Material required: ${s.materialRequired ? 'Yes' : 'No'}</h3>
      ${mats.length ? `<table class="tbl"><tbody>${mats.map(m => `<tr><td>${esc(m.item)}</td><td class="r num">${fmtNum(m.qty)} ${m.unit === 'm' ? 'm' : 'nos'}</td></tr>`).join('')}</tbody></table>` : ''}
    </div>
    <div class="dlg-foot">
      ${role() === 'admin' ? `<button class="btn danger" data-del>Delete</button>` : ''}
      <span class="spacer"></span>
      <button class="btn primary" data-pdf1>Download PDF</button>
    </div>`;
  dlg.showModal();
  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  dlg.querySelector('[data-pdf1]').onclick = () => makePDF([s]);
  const del = dlg.querySelector('[data-del]');
  if (del) del.onclick = async () => {
    if (!confirm(`Delete survey ${s.ref} and its photographs permanently?`)) return;
    try { await deleteSurvey(s.id); selected.delete(s.id); dlg.close(); toast('Survey deleted', 'ok'); }
    catch (err) { toast(err.message, 'err'); }
  };
  for (const ph of $$('.ph-load', dlg)) {
    getPhotoBlob(ph.dataset.key).then(b => {
      const img = new Image(); img.src = URL.createObjectURL(b); img.alt = 'Survey photograph';
      ph.replaceWith(img);
    }).catch(() => { ph.textContent = 'Photo unavailable'; });
  }
}

/* ---------------- CSV ---------------- */
function exportCSV() {
  if (!view.length) { toast('Nothing to export', 'err'); return; }
  const rows = view.filter(s => !selected.size || selected.has(s.id));
  const head = ['Ref', 'Survey ID', 'Captured At', 'Submitted At', 'Subdivision', 'Substation', 'Feeder', 'Irregularities',
    'Location', 'Landmark', 'Remarks', 'Latitude', 'Longitude', 'GPS Accuracy (m)', 'Surveyor', 'Material Required',
    ...MATERIALS.map(m => `${m.item} (${m.unit === 'm' ? 'm' : 'Nos'})`), 'Photos', 'Google Maps'];
  const lines = [head, ...rows.map(s => {
    const q = Object.fromEntries((s.materials || []).map(m => [m.id, m.qty]));
    return [s.ref, s.id, fmtDateTime(s.capturedAt), fmtDateTime(s.createdAt), s.subdivision, s.substation, s.feeder,
      s.irregularities.map(irregularityName).join('; '), s.location, s.landmark, s.remarks || '',
      s.gps?.lat, s.gps?.lng, Math.round(s.gps?.acc || 0), s.surveyor?.name, s.materialRequired ? 'Yes' : 'No',
      ...MATERIALS.map(m => q[m.id] || ''), s.photos.length, `https://www.google.com/maps?q=${s.gps?.lat},${s.gps?.lng}`];
  })];
  const csv = lines.map(r => r.map(v => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }).join(',')).join('\r\n');
  downloadBlob(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), `Line_Survey_${dayKey(new Date().toISOString())}_${rows.length}.csv`);
  toast(`Exported ${rows.length} survey${rows.length > 1 ? 's' : ''}${selected.size ? ' (selected)' : ''}`, 'ok');
}

/* ---------------- PDF ---------------- */
async function makePDF(surveys) {
  if (busy || !surveys.length) return;
  if (!window.jspdf) { toast('PDF library not loaded — connect to the internet once and reload', 'err', 6000); return; }
  if (surveys.length > 150 && !confirm(`Generate a PDF with ${surveys.length} pages? This may take a while on a phone.`)) return;
  busy = true;
  const btn = $('#rp-pdf');
  const prog = (i) => { btn.disabled = true; btn.textContent = `Preparing ${i}/${surveys.length}…`; };
  try {
    surveys = [...surveys].sort((a, b) => (a.seq || 0) - (b.seq || 0));
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
    for (let i = 0; i < surveys.length; i++) {
      prog(i + 1);
      if (i) doc.addPage();
      await drawPage(doc, surveys[i], i + 1, surveys.length);
    }
    const s0 = surveys[0];
    const name = surveys.length === 1
      ? `${s0.ref}_${shortName(s0.feeder).replace(/[^A-Za-z0-9]+/g, '_')}.pdf`
      : `Line_Survey_Report_${surveys.length}_surveys_${dayKey(new Date().toISOString())}.pdf`;
    downloadBlob(doc.output('blob'), name);
    toast('PDF downloaded', 'ok');
  } catch (err) {
    console.error(err);
    toast('PDF failed: ' + err.message, 'err', 6000);
  } finally {
    busy = false;
    updateSel();
  }
}

const NAVY = [18, 53, 91], AMBER = [242, 169, 0], INK = [20, 27, 38], GREY = [96, 106, 120], LINE = [212, 218, 226], TINT = [244, 246, 249];

async function drawPage(doc, s, pageNo, pageCount) {
  const W = 210, H = 297, M = 12, CW = W - 2 * M;
  doc.setLineWidth(0.25);

  // Header band
  doc.setFillColor(...NAVY); doc.rect(0, 0, W, 24, 'F');
  doc.setFillColor(...AMBER); doc.rect(0, 24, W, 1.2, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
  doc.text('ELECTRIC LINE SURVEY REPORT', M, 11);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
  doc.text(pdfSafe(CONFIG.ORG_NAME), M, 17.5);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
  doc.text(pdfSafe(s.ref), W - M, 11, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
  doc.text(fmtDateTime(s.capturedAt || s.createdAt), W - M, 17.5, { align: 'right' });

  // Info grid
  let y = 30;
  const half = CW / 2;
  const cell = (x, yy, w, label, value, minH = 10) => {
    const tb = textBlock(doc, value || '-', w - 4, 9.5, 4.1);
    const h = Math.max(minH, 6.5 + tb.n * 4.1);
    return { h, draw: (hh) => {
      doc.setDrawColor(...LINE); doc.rect(x, yy, w, hh);
      doc.setFontSize(6.8); doc.setTextColor(...GREY); doc.setFont('helvetica', 'bold');
      doc.text(label.toUpperCase(), x + 2, yy + 3.6);
      tb.draw(x + 2, yy + 7.8);
    } };
  };
  const row2 = (l1, v1, l2, v2) => {
    const a = cell(M, y, half, l1, v1), b = cell(M + half, y, half, l2, v2);
    const h = Math.max(a.h, b.h); a.draw(h); b.draw(h); y += h;
  };
  const row1 = (l, v) => { const a = cell(M, y, CW, l, v); a.draw(a.h); y += a.h; };
  row2('Subdivision', s.subdivision, 'Substation', displayName(s.substation));
  row2('Feeder', displayName(s.feeder), 'Surveyed by', s.surveyor?.name);
  row1('Location', s.location);
  row2('Landmark', s.landmark, 'GPS (lat, long)', `${fmtLatLng(s.gps)}  ±${Math.round(s.gps?.acc || 0)} m`);
  // map link over GPS cell
  doc.link(M + half, y - 10, half, 10, { url: `https://www.google.com/maps?q=${s.gps?.lat},${s.gps?.lng}` });

  // Irregularities
  y += 5;
  const irr = s.irregularities.map(irregularityName);
  sectionTitle(doc, M, y, `IRREGULARITIES FOUND (${irr.length})`); y += 3;
  const colW = CW / 2;
  const irrLines = irr.map(t => textBlock(doc, t, colW - 8, 9.5, 4.1));
  const rowsN = Math.ceil(irr.length / 2);
  let iy = y + 2;
  const irrH = [];
  for (let r = 0; r < rowsN; r++) irrH.push(Math.max(...[irrLines[r * 2], irrLines[r * 2 + 1]].filter(Boolean).map(l => l.n)) * 4.1 + 1.6);
  const irrBoxH = irrH.reduce((a, b) => a + b, 0) + 3;
  doc.setFillColor(255, 248, 230); doc.setDrawColor(240, 214, 150); doc.rect(M, y, CW, irrBoxH, 'FD');
  for (let r = 0; r < rowsN; r++) {
    for (let c = 0; c < 2; c++) {
      const L = irrLines[r * 2 + c]; if (!L) continue;
      const x = M + c * colW + 3;
      doc.setFillColor(...AMBER); doc.circle(x + 1, iy + 2.3, 1, 'F');
      L.draw(x + 4, iy + 3.3);
    }
    iy += irrH[r];
  }
  y += irrBoxH + 5;

  // Pre-measure material + remarks block so photos can take what's left
  const mats = s.materialRequired ? (s.materials || []).map(m => ({ ...materialById(m.id), qty: m.qty })).filter(m => m.item) : [];
  const matCols = mats.length > 5 ? 2 : 1;
  const matRows = Math.ceil(mats.length / matCols);
  const matH = 7 + (mats.length ? 6 + matRows * 5.6 : 0);
  const rmk = s.remarks ? textBlock(doc, s.remarks, CW - 4, 9, 4) : null;
  const rmkH = rmk ? 8 + rmk.n * 4 : 0;
  const footerY = H - 8;
  const photoTop = y + 3;
  const photoBottom = footerY - 6 - matH - rmkH;

  // Photos
  sectionTitle(doc, M, y, `PHOTOGRAPHS (${s.photos.length})`);
  const n = s.photos.length;
  const cols = n <= 4 ? 2 : 3, rows = Math.ceil(n / cols), gap = 3, capH = 4.2;
  const cellW = (CW - (cols - 1) * gap) / cols;
  const cellH = Math.max(30, (photoBottom - photoTop - (rows - 1) * gap) / rows);
  const imgs = await Promise.all(s.photos.map(p => getPhotoBlob(p.key).then(b => blobToJpegDataURL(b, 1100, 0.78)).catch(() => null)));
  imgs.forEach((im, i) => {
    const cx = M + (i % cols) * (cellW + gap), cy = photoTop + Math.floor(i / cols) * (cellH + gap);
    const boxH = cellH - capH;
    doc.setFillColor(...TINT); doc.rect(cx, cy, cellW, boxH, 'F');
    if (im) {
      const r = Math.min(cellW / im.width, boxH / im.height);
      const w = im.width * r, h = im.height * r;
      doc.addImage(im.dataURL, 'JPEG', cx + (cellW - w) / 2, cy + (boxH - h) / 2, w, h, undefined, 'FAST');
    } else {
      doc.setFontSize(9); doc.setTextColor(...GREY); doc.text('Photo unavailable', cx + cellW / 2, cy + boxH / 2, { align: 'center' });
    }
    const p = s.photos[i];
    doc.setTextColor(...GREY); doc.setFont('helvetica', 'normal');
    const cap = cols > 2 ? `Photo ${i + 1} | ${fmtLatLng(p)} ±${Math.round(p.acc || 0)} m`
      : `Photo ${i + 1} | ${fmtLatLng(p)} · ±${Math.round(p.acc || 0)} m · ${fmtDateTime(p.takenAt)}`;
    doc.setFontSize(cols > 2 ? 6.3 : 7);
    doc.text(doc.splitTextToSize(cap, cellW)[0], cx, cy + boxH + 3.2);
  });
  y = photoTop + rows * cellH + (rows - 1) * gap + 4;

  // Material
  sectionTitle(doc, M, y, `MATERIAL REQUIRED: ${s.materialRequired ? 'YES' : 'NO'}`);
  y += 3;
  if (mats.length) {
    const tw = matCols === 2 ? (CW - 4) / 2 : CW;
    for (let c = 0; c < matCols; c++) {
      const x = M + c * (tw + 4);
      let ty = y;
      doc.setFillColor(...NAVY); doc.rect(x, ty, tw, 6, 'F');
      doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(255, 255, 255);
      doc.text('Material', x + 2, ty + 4.1); doc.text('Quantity', x + tw - 2, ty + 4.1, { align: 'right' });
      ty += 6;
      mats.slice(c * matRows, (c + 1) * matRows).forEach((m, k) => {
        if (k % 2) { doc.setFillColor(...TINT); doc.rect(x, ty, tw, 5.6, 'F'); }
        doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(...INK);
        doc.text(pdfSafe(m.item), x + 2, ty + 3.9);
        doc.setFont('helvetica', 'bold');
        doc.text(`${fmtNum(m.qty)} ${m.unit === 'm' ? 'm' : 'Nos'}`, x + tw - 2, ty + 3.9, { align: 'right' });
        ty += 5.6;
      });
      doc.setDrawColor(...LINE); doc.rect(x, y, tw, 6 + Math.min(matRows, mats.length - c * matRows) * 5.6);
    }
    y += 6 + matRows * 5.6 + 2;
  } else {
    y += 1;
  }

  if (rmk) {
    y += 3;
    sectionTitle(doc, M, y, 'REMARKS'); y += 4;
    rmk.draw(M + 1, y + 1);
  }

  // Footer
  doc.setDrawColor(...LINE); doc.line(M, footerY - 3.5, W - M, footerY - 3.5);
  doc.setFontSize(7.5); doc.setTextColor(...GREY); doc.setFont('helvetica', 'normal');
  doc.text(`Survey ID ${s.id}  |  Submitted ${fmtDateTime(s.createdAt)}  |  Generated ${fmtDateTime(new Date().toISOString())}`, M, footerY);
  doc.text(`Page ${pageNo} of ${pageCount}`, W - M, footerY, { align: 'right' });
}

function sectionTitle(doc, x, y, text) {
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(...NAVY);
  doc.text(text, x, y);
}

/* ---- text helpers: jsPDF core fonts only cover Latin-1, so Hindi/other scripts are rasterised ---- */
const pdfSafe = (t) => String(t ?? '').replace(/[\u2013\u2014]/g, '-').replace(/[\u2018\u2019]/g, "'")
  .replace(/[\u201C\u201D]/g, '"').replace(/\u2026/g, '...').replace(/\u00A0/g, ' ');
const PX_PER_MM = 9;

/** Returns { n: lineCount, draw(x, baselineY) } using vector text when possible, otherwise a crisp bitmap. */
function textBlock(doc, text, widthMm, pt, lineH, bold = false) {
  const t = pdfSafe(text);
  if (!/[^\x00-\xFF]/.test(t)) {
    doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(pt);
    const lines = doc.splitTextToSize(t, widthMm);
    return { n: lines.length, draw: (x, y) => {
      doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(pt); doc.setTextColor(...INK);
      doc.text(lines, x, y, { lineHeightFactor: lineH / (pt * 0.3528) });
    } };
  }
  const fontPx = pt * 0.3528 * PX_PER_MM;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = `${bold ? 700 : 400} ${fontPx}px "Noto Sans Devanagari", "Nirmala UI", Mangal, system-ui, sans-serif`;
  ctx.font = font;
  const maxPx = widthMm * PX_PER_MM, lines = [];
  for (const para of t.split(/\n/)) {
    let cur = '';
    for (const w of para.split(/\s+/)) {
      const tryL = cur ? cur + ' ' + w : w;
      if (ctx.measureText(tryL).width > maxPx && cur) { lines.push(cur); cur = w; } else cur = tryL;
    }
    lines.push(cur);
  }
  const lhPx = lineH * PX_PER_MM;
  c.width = Math.ceil(maxPx); c.height = Math.ceil(lines.length * lhPx + fontPx * 0.4);
  ctx.font = font; ctx.fillStyle = `rgb(${INK.join(',')})`; ctx.textBaseline = 'alphabetic';
  lines.forEach((l, i) => ctx.fillText(l, 0, fontPx * 0.95 + i * lhPx));
  const url = c.toDataURL('image/png');
  return { n: lines.length, draw: (x, y) => {
    doc.addImage(url, 'PNG', x, y - pt * 0.3528 * 0.95, c.width / PX_PER_MM, c.height / PX_PER_MM, undefined, 'FAST');
  } };
}
