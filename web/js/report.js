import { CONFIG } from './config.js';
import { MATERIALS, materialById, irregularityName, lineVoltageOf, linePath, lineTitle } from './catalog.js';
import { $, $$, esc, toast, fmtDateTime, fmtDate, fmtLatLng, fmtNum, shortName, downloadBlob, blobToJpegDataURL, dayKey, stampPhoto } from './util.js';
import { listSurveys, listStretches, deleteStretch, getPhotoBlob, deleteSurvey, queueRectify, unrectify, getSettings, role, bus } from './api.js';
import { filterBarHTML, wireFilterBar, applyFilters, filterStretches } from './filters.js';
import { editSurvey, editStretch } from './editor.js';
import { buildStretchPDF, stretchKm, surveysOf } from './pdf-stretch.js';
import { displayName } from './survey.js';
import { NAVY, AMBER, INK, GREY, LINE, TINT, sectionTitle, pdfSafe, textBlock } from './pdfutil.js';

let root, getF, all = [], view = [], selected = new Set(), limit = 100, busy = false;
let stretches = [], stretchMap = new Map();

export function initReport(el) {
  root = el;
  root.innerHTML = `
    <div class="view-head"><h1>Reports</h1><span id="rp-meta" class="muted"></span>
      <button class="btn small ghost" id="rp-refresh">Refresh</button></div>
    <details class="card" id="rp-st"><summary><b>Survey stretches</b> <span class="muted" id="rp-st-n"></span></summary>
      <div id="rp-st-list" class="st-list"></div></details>
    ${filterBarHTML('rp', { extra: true })}
    <div class="rp-tools card">
      <label class="chk"><input type="checkbox" id="rp-all"><span>Select all <b id="rp-count">0</b> shown</span></label>
      <span class="spacer"></span>
      <span class="muted" id="rp-sel">0 selected</span>
      <button class="btn" id="rp-mat">Material summary</button>
      <button class="btn" id="rp-xlsx">Excel (.xlsx)</button>
      <button class="btn ghost" id="rp-csv" title="Plain CSV file">CSV</button>
      <button class="btn primary" id="rp-pdf" disabled>Download PDF</button>
    </div>
    <div id="rp-list" class="rp-list"><div class="empty">Loading…</div></div>
    <dialog id="rp-dlg" class="dlg"></dialog>`;
  getF = wireFilterBar('rp', () => { limit = 100; render(); renderStretches(); });
  $('#rp-refresh').onclick = () => load(true);
  $('#rp-all').onchange = (e) => { view.forEach(s => (e.target.checked ? selected.add(s.id) : selected.delete(s.id))); render(); };
  $('#rp-pdf').onclick = () => makePDF(all.filter(s => selected.has(s.id)));
  $('#rp-csv').onclick = exportCSV;
  $('#rp-xlsx').onclick = exportXLSX;
  $('#rp-mat').onclick = openMaterialSummary;
  $('#rp-list').addEventListener('click', onListClick);
  $('#rp-st-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-delst]'); if (!b) return;
    if (!confirm('Delete this survey stretch record? Surveys recorded in it are kept.')) return;
    try { await deleteStretch(b.dataset.delst); toast('Stretch deleted', 'ok'); } catch (err) { toast(err.message, 'err'); }
  });
  $('#rp-st-list').addEventListener('click', (e) => {
    const pdf = e.target.closest('[data-stpdf]'), ed = e.target.closest('[data-edst]');
    if (pdf) makeStretchPDFs(pdf.dataset.stpdf === '*' ? stretchView : stretches.filter(x => x.id === pdf.dataset.stpdf));
    if (ed) editStretch(stretchMap.get(ed.dataset.edst), () => {});
  });
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
    stretches = await listStretches({ fresh });
    stretchMap = new Map(stretches.map(x => [x.id, x]));
    all = [...r.surveys].sort((a, b) => (b.seq || 0) - (a.seq || 0));
    $('#rp-meta').textContent = r.offline ? `Offline copy · ${fmtDate(r.at)}` : '';
    const ids = new Set(all.map(s => s.id));
    selected = new Set([...selected].filter(id => ids.has(id)));
    renderStretches();
    render();
  } catch (err) {
    $('#rp-list').innerHTML = `<div class="empty err">${esc(err.message)}</div>`;
  }
}

const pointText = (p) => (p ? `${p.location} (${fmtLatLng(p.gps)})` : 'Not yet ended');
const mapLink = (g) => `<a href="https://www.google.com/maps?q=${g.lat},${g.lng}" target="_blank" rel="noopener">${fmtLatLng(g)}</a>`;

let stretchView = [];
function renderStretches() {
  const counts = {};
  all.forEach(s => { if (s.stretchId) counts[s.stretchId] = (counts[s.stretchId] || 0) + 1; });
  stretchView = filterStretches([...stretches].sort((a, b) => (b.seq || 0) - (a.seq || 0)), getF());
  const open = stretchView.filter(x => !x.end).length;
  $('#rp-st-n').textContent = stretches.length ? `(${stretchView.length}${open ? `, ${open} open` : ''})` : '(none yet)';
  const adm = role() === 'admin';
  $('#rp-st-list').innerHTML = (stretchView.length ? `<div class="st-top"><button class="btn small" data-stpdf="*">PDF of all ${stretchView.length} listed</button></div>` : '') + stretchView.map(x => {
    const hrs = (Date.now() - new Date(x.start.at)) / 3600000, km = stretchKm(x);
    return `
    <div class="st-item"><div class="st-main">
      <b>${esc(x.ref)}</b> <b class="lv lv${lineVoltageOf(x) === '33 kV' ? '33' : '11'}">${lineVoltageOf(x)}</b> ${esc(lineTitle(x))}
      ${x.end ? '' : `<span class="pill mat">Open${hrs > 24 ? ' · ' + (hrs >= 48 ? Math.floor(hrs / 24) + ' days' : Math.round(hrs) + ' h') : ''}</span>`}<br>
      <span class="muted">${esc(x.surveyor?.name)} · ${counts[x.id] || 0} survey${counts[x.id] === 1 ? '' : 's'} · ${fmtDateTime(x.start.at)}${km != null ? ` · ≈ ${km < 1 ? Math.round(km * 1000) + ' m' : km.toFixed(1) + ' km'}` : ''}</span><br>
      <b>Start:</b> ${esc(x.start.location)} · ${mapLink(x.start.gps)}<br>
      <b>End:</b> ${x.end ? `${esc(x.end.location)} · ${mapLink(x.end.gps)}` : '<span class="muted">not yet entered</span>'}
    </div><div class="st-actions"><button class="btn small" data-stpdf="${x.id}">PDF</button>
      ${adm ? `<button class="btn small" data-edst="${x.id}">Edit</button><button class="btn small danger" data-delst="${x.id}">Delete</button>` : ''}</div></div>`; }).join('')
    || '<div class="empty">No survey stretches match.</div>';
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
          ${s.materialRequired && !s.rectified ? '<span class="pill mat">Material</span>' : ''}
          ${s.rectified ? '<span class="pill ok">Rectified</span>' : ''}</div>
        <div class="rp-sub"><b class="lv lv${lineVoltageOf(s) === '33 kV' ? '33' : '11'}">${lineVoltageOf(s)}</b> ${esc(linePath(s))}</div>
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
        <dt>Line</dt><dd>${lineVoltageOf(s)}</dd>
        ${lineVoltageOf(s) === '33 kV' ? `
        <dt>Primary S/S</dt><dd>${esc(s.primarySubstation)}</dd>
        <dt>33 kV Line</dt><dd>${esc(s.line33)}</dd>
        <dt>Section</dt><dd>${esc(s.section)}</dd>
        <dt>Substation</dt><dd>${esc(displayName(s.substation))}</dd>
        <dt>Subdivision</dt><dd>${esc(s.subdivision)}</dd>` : `
        <dt>Subdivision</dt><dd>${esc(s.subdivision)}</dd>
        <dt>Substation</dt><dd>${esc(displayName(s.substation))}</dd>
        <dt>Feeder</dt><dd>${esc(displayName(s.feeder))}</dd>`}
        ${stretchMap.get(s.stretchId) ? (() => { const x = stretchMap.get(s.stretchId); return `
        <dt>Stretch</dt><dd>${esc(x.ref)}</dd>
        <dt>Start point</dt><dd>${esc(x.start.location)} · ${mapLink(x.start.gps)}</dd>
        <dt>End point</dt><dd>${x.end ? `${esc(x.end.location)} · ${mapLink(x.end.gps)}` : 'Not yet ended'}</dd>`; })() : ''}
        <dt>Status</dt><dd>${s.rectified ? `<b class="good">Rectified</b> on ${fmtDateTime(s.rectified.at)} by ${esc(s.rectified.by?.name)}` : '<b>Open</b>'}${s.editedAt ? ` <span class="muted">· corrected by admin ${fmtDate(s.editedAt)}</span>` : ''}</dd>
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
      ${s.rectified ? `<h3>Rectified</h3>${s.rectified.note ? `<p>${esc(s.rectified.note)}</p>` : ''}
        <div class="dlg-photos">${(s.rectified.photos || []).map((p, i) => `<figure><div class="ph-load" data-key="${esc(p.key)}">Loading…</div><figcaption>After #${i + 1} · ${fmtDateTime(p.takenAt)}</figcaption></figure>`).join('')}</div>` : ''}
    </div>
    <div class="dlg-foot">
      ${role() === 'admin' ? `<button class="btn danger" data-del>Delete</button><button class="btn" data-edit>Edit</button>${s.rectified ? '<button class="btn" data-reopen>Re-open</button>' : ''}` : ''}
      <span class="spacer"></span>
      ${s.rectified ? '' : '<button class="btn" data-fix>Mark rectified</button>'}
      <button class="btn primary" data-pdf1>Download PDF</button>
    </div>`;
  dlg.showModal();
  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  dlg.querySelector('[data-pdf1]').onclick = () => makePDF([s]);
  const fix = dlg.querySelector('[data-fix]'); if (fix) fix.onclick = () => openRectify(s, dlg);
  const edit = dlg.querySelector('[data-edit]'); if (edit) edit.onclick = () => editSurvey(s, () => dlg.close());
  const reopen = dlg.querySelector('[data-reopen]');
  if (reopen) reopen.onclick = async () => {
    if (!confirm(`Re-open ${s.ref}? The "after" photographs of the rectification will be deleted.`)) return;
    try { await unrectify(s.id); dlg.close(); toast('Survey re-opened', 'ok'); } catch (err) { toast(err.message, 'err'); }
  };
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

/* ---------------- tables for CSV / Excel ---------------- */
const pickRows = () => view.filter(s => !selected.size || selected.has(s.id));

function surveyAOA(rows) {
  const head = ['Ref', 'Survey ID', 'Captured At', 'Submitted At', 'Line Type', 'Primary Substation', '33 kV Line', 'Section', 'Subdivision', 'Substation', 'Feeder', 'Irregularities',
    'Location', 'Landmark', 'Remarks', 'Latitude', 'Longitude', 'GPS Accuracy (m)', 'Surveyor', 'Status', 'Rectified At', 'Rectified By', 'Rectification Note', 'Material Required',
    ...MATERIALS.map(m => `${m.item} (${m.unit === 'm' ? 'm' : 'Nos'})`), 'Photos', 'Google Maps',
    'Stretch Ref', 'Stretch Start Location', 'Stretch Start Lat', 'Stretch Start Lng', 'Stretch End Location', 'Stretch End Lat', 'Stretch End Lng'];
  return [head, ...rows.map(s => {
    const q = Object.fromEntries((s.materials || []).map(m => [m.id, m.qty]));
    const x = stretchMap.get(s.stretchId);
    return [s.ref, s.id, fmtDateTime(s.capturedAt), fmtDateTime(s.createdAt), lineVoltageOf(s), s.primarySubstation || '', s.line33 || '', s.section || '', s.subdivision, s.substation, s.feeder,
      s.irregularities.map(irregularityName).join('; '), s.location, s.landmark, s.remarks || '',
      s.gps?.lat, s.gps?.lng, Math.round(s.gps?.acc || 0), s.surveyor?.name,
      s.rectified ? 'Rectified' : 'Open', s.rectified ? fmtDateTime(s.rectified.at) : '', s.rectified?.by?.name || '', s.rectified?.note || '',
      s.materialRequired ? 'Yes' : 'No',
      ...MATERIALS.map(m => q[m.id] || ''), s.photos.length, `https://www.google.com/maps?q=${s.gps?.lat},${s.gps?.lng}`,
      x?.ref || '', x?.start.location || '', x?.start.gps.lat ?? '', x?.start.gps.lng ?? '', x?.end?.location || '', x?.end?.gps.lat ?? '', x?.end?.gps.lng ?? ''];
  })];
}

function stretchAOA(list) {
  const counts = {};
  all.forEach(s => { if (s.stretchId) counts[s.stretchId] = (counts[s.stretchId] || 0) + 1; });
  const head = ['Ref', 'Line Type', 'Line / Feeder', 'Primary Substation', 'Section', 'Subdivision', 'Substation', 'Surveyor', 'Status', 'Surveys',
    'Started At', 'Start Location', 'Start Lat', 'Start Lng', 'Ended At', 'End Location', 'End Lat', 'End Lng', 'Approx. Distance (km)'];
  return [head, ...list.map(x => [x.ref, lineVoltageOf(x), lineTitle(x), x.primarySubstation || '', x.section || '', x.subdivision, x.substation, x.surveyor?.name, x.end ? 'Completed' : 'Open', counts[x.id] || 0,
    fmtDateTime(x.start.at), x.start.location, x.start.gps.lat, x.start.gps.lng, x.end ? fmtDateTime(x.end.at) : '', x.end?.location || '', x.end?.gps.lat ?? '', x.end?.gps.lng ?? '',
    stretchKm(x) == null ? '' : Math.round(stretchKm(x) * 100) / 100])];
}

function exportCSV() {
  if (!view.length) { toast('Nothing to export', 'err'); return; }
  const rows = pickRows();
  const csv = surveyAOA(rows).map(r => r.map(v => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }).join(',')).join('\r\n');
  downloadBlob(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }), `Line_Survey_${dayKey(new Date().toISOString())}_${rows.length}.csv`);
  toast(`Exported ${rows.length} survey${rows.length > 1 ? 's' : ''}${selected.size ? ' (selected)' : ''}`, 'ok');
}

/** The Excel library is large, so it is only fetched the first time someone exports. */
let xlsxLoading = null;
function ensureXLSX() {
  if (window.XLSX) return Promise.resolve(true);
  xlsxLoading ||= new Promise((res) => {
    const el = document.createElement('script');
    el.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    el.onload = () => res(!!window.XLSX);
    el.onerror = () => { xlsxLoading = null; res(false); };
    document.head.appendChild(el);
  });
  return xlsxLoading;
}

function sheetOf(aoa, widths) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = aoa[0].map((h, i) => ({ wch: widths?.[i] || Math.min(42, Math.max(10, String(h).length + 2, ...aoa.slice(1, 80).map(r => String(r[i] ?? '').length + 1))) }));
  if (aoa.length > 1) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: aoa[0].length - 1 } }) };
  return ws;
}

/** Real .xlsx: Surveys, Stretches, Material summary (pending locations, by line) and Material total. */
async function exportXLSX() {
  if (!view.length) { toast('Nothing to export', 'err'); return; }
  toast('Preparing Excel file…', 'info', 8000);
  if (!(await ensureXLSX())) { toast('Could not load the Excel library (needs internet once). Saving CSV instead.', 'err', 6000); exportCSV(); return; }
  const rows = pickRows();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheetOf(surveyAOA(rows)), 'Surveys');
  XLSX.utils.book_append_sheet(wb, sheetOf(stretchAOA(stretchView.length ? stretchView : stretches)), 'Stretches');
  const sum = materialTables(rows.filter(s => !s.rectified), 'line');
  XLSX.utils.book_append_sheet(wb, sheetOf(sum.matrix), 'Material by line');
  XLSX.utils.book_append_sheet(wb, sheetOf(sum.total), 'Material total');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  downloadBlob(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `Line_Survey_${dayKey(new Date().toISOString())}_${rows.length}.xlsx`);
  toast(`Exported ${rows.length} survey${rows.length > 1 ? 's' : ''}${selected.size ? ' (selected)' : ''} to Excel. Material sheets count only locations not yet rectified.`, 'ok', 5000);
}

/* ---------------- material summary (procurement) ---------------- */
const GROUPS = {
  line: { label: 'Line / feeder', key: s => (lineVoltageOf(s) === '33 kV' ? `33 kV · ${s.line33}` : `11 kV · ${shortName(s.feeder)} feeder`) },
  substation: { label: 'Substation', key: s => shortName(s.substation) },
  subdivision: { label: 'Subdivision', key: s => s.subdivision },
};

/** Material needed per group; `rows` = surveys to count. Returns arrays for Excel plus the structure for the screen table. */
function materialTables(rows, by) {
  const needing = rows.filter(s => s.materialRequired && (s.materials || []).length);
  const used = MATERIALS.filter(m => needing.some(s => s.materials.some(x => x.id === m.id)));
  const groups = new Map();
  for (const s of needing) {
    const k = GROUPS[by].key(s);
    const g = groups.get(k) || { n: 0, q: {} };
    g.n++; (s.materials || []).forEach(m => (g.q[m.id] = (g.q[m.id] || 0) + m.qty));
    groups.set(k, g);
  }
  const list = [...groups].sort((a, b) => a[0].localeCompare(b[0]));
  const totals = Object.fromEntries(used.map(m => [m.id, list.reduce((n, [, g]) => n + (g.q[m.id] || 0), 0)]));
  const locs = Object.fromEntries(used.map(m => [m.id, needing.filter(s => s.materials.some(x => x.id === m.id)).length]));
  const r2 = (n) => Math.round(n * 100) / 100;
  const matrix = [[GROUPS[by].label, 'Locations needing material', ...used.map(m => `${m.item} (${m.unit === 'm' ? 'm' : 'Nos'})`)],
    ...list.map(([k, g]) => [k, g.n, ...used.map(m => (g.q[m.id] ? r2(g.q[m.id]) : ''))]),
    ['TOTAL', needing.length, ...used.map(m => r2(totals[m.id]))]];
  const total = [['Item', 'Unit', 'Total quantity', 'Locations'], ...used.map(m => [m.item, m.unit === 'm' ? 'm' : 'Nos', r2(totals[m.id]), locs[m.id]])];
  return { list, used, totals, needing, matrix, total };
}

function openMaterialSummary() {
  const dlg = $('#rp-dlg');
  let by = 'line', openOnly = true;
  const draw = () => {
    const base = pickRows();
    const rows = openOnly ? base.filter(s => !s.rectified) : base;
    const T = materialTables(rows, by);
    dlg.innerHTML = `
      <div class="dlg-head"><h2>Material summary</h2><button class="btn small ghost" data-close aria-label="Close">✕</button></div>
      <div class="dlg-body">
        <div class="ms-ctl">
          <label class="fld sm">Group by<select id="ms-by">${Object.entries(GROUPS).map(([k, g]) => `<option value="${k}" ${k === by ? 'selected' : ''}>${esc(g.label)}</option>`).join('')}</select></label>
          <label class="chk"><input type="checkbox" id="ms-open" ${openOnly ? 'checked' : ''}><span>Only locations not yet rectified</span></label>
        </div>
        <p class="hint">Based on ${rows.length} survey${rows.length === 1 ? '' : 's'} ${selected.size ? '(the rows you selected)' : '(current Report filters)'}; ${T.needing.length} need material.</p>
        ${T.needing.length ? `
        <h3>Total to procure</h3>
        <table class="tbl"><thead><tr><th>Item</th><th class="r">Quantity</th><th class="r">Locations</th></tr></thead><tbody>
          ${T.total.slice(1).map(r => `<tr><td>${esc(r[0])}</td><td class="r num">${fmtNum(r[2])} ${r[1]}</td><td class="r num">${r[3]}</td></tr>`).join('')}</tbody></table>
        <h3>By ${esc(GROUPS[by].label.toLowerCase())}</h3>
        <div class="tbl-wrap"><table class="tbl ms-tbl"><thead><tr><th>${esc(GROUPS[by].label)}</th><th class="r">Loc.</th>${T.used.map(m => `<th class="r">${esc(m.item)}<br><small>${m.unit === 'm' ? 'm' : 'Nos'}</small></th>`).join('')}</tr></thead>
        <tbody>${T.list.map(([k, g]) => `<tr><td>${esc(k)}</td><td class="r num">${g.n}</td>${T.used.map(m => `<td class="r num">${g.q[m.id] ? fmtNum(g.q[m.id]) : ''}</td>`).join('')}</tr>`).join('')}
        <tr class="grp"><td>Total</td><td class="r num">${T.needing.length}</td>${T.used.map(m => `<td class="r num">${fmtNum(T.totals[m.id])}</td>`).join('')}</tr></tbody></table></div>`
        : '<div class="empty">No material is required for these surveys.</div>'}
      </div>
      <div class="dlg-foot"><span class="spacer"></span>
        <button class="btn primary" id="ms-xlsx" ${T.needing.length ? '' : 'disabled'}>Download Excel</button></div>`;
    dlg.querySelector('[data-close]').onclick = () => dlg.close();
    $('#ms-by', dlg).onchange = (e) => { by = e.target.value; draw(); };
    $('#ms-open', dlg).onchange = (e) => { openOnly = e.target.checked; draw(); };
    $('#ms-xlsx', dlg).onclick = async () => {
      if (!(await ensureXLSX())) { toast('Could not load the Excel library (needs internet once)', 'err', 5000); return; }
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, sheetOf(T.matrix), `By ${GROUPS[by].label.split(' ')[0]}`.slice(0, 31));
      XLSX.utils.book_append_sheet(wb, sheetOf(T.total), 'Total');
      downloadBlob(new Blob([XLSX.write(wb, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
        `Material_Summary_${by}_${dayKey(new Date().toISOString())}.xlsx`);
    };
  };
  draw();
  dlg.showModal();
}

/* ---------------- rectification: "fixed on site" ---------------- */
function openRectify(s, parentDlg) {
  let d = $('#fx-dlg');
  if (!d) { d = document.createElement('dialog'); d.id = 'fx-dlg'; d.className = 'dlg'; document.body.appendChild(d); }
  const photos = [];   // { blob, url, meta }
  d.innerHTML = `
    <form method="dialog" id="fx-form">
      <div class="dlg-head"><h2>Mark ${esc(s.ref)} as rectified</h2><button type="button" class="btn small ghost" data-close aria-label="Close">✕</button></div>
      <div class="dlg-body">
        <p class="hint">${esc(linePath(s))}<br>${esc(s.location)} · ${esc(s.landmark)}</p>
        <p class="hint">Take 1 to 3 photographs of the completed work (GPS and time are stamped on them).</p>
        <div class="photo-grid" id="fx-grid"></div>
        <input type="file" id="fx-cam" accept="image/*" capture="environment" hidden>
        <label class="fld">Note <span class="opt">(optional)</span><textarea id="fx-note" rows="2" maxlength="500" placeholder="e.g. Pole replaced, 2 pin insulators changed"></textarea></label>
        <div id="fx-err" class="errors" hidden></div>
      </div>
      <div class="dlg-foot"><span class="spacer"></span><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary" id="fx-save" disabled>Save</button></div>
    </form>`;
  const grid = $('#fx-grid', d), cam = $('#fx-cam', d), save = $('#fx-save', d);
  const paint = () => {
    grid.innerHTML = photos.map((p, i) => `<figure class="ph"><img src="${p.url}" alt="After photo ${i + 1}"><figcaption>#${i + 1}${p.meta.acc != null ? ` · ±${Math.round(p.meta.acc)} m` : ''}</figcaption>
      <button type="button" class="ph-rm" data-rm="${i}" aria-label="Remove photo ${i + 1}">×</button></figure>`).join('') +
      (photos.length < 3 ? `<button type="button" class="ph add" id="fx-add"><span>${photos.length ? 'Take another' : 'Take photo'}</span></button>` : '');
    save.disabled = !photos.length;
  };
  paint();
  grid.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { URL.revokeObjectURL(photos[+rm.dataset.rm].url); photos.splice(+rm.dataset.rm, 1); paint(); }
    else if (e.target.closest('#fx-add')) cam.click();
  });
  const getPos = () => new Promise(res => (navigator.geolocation
    ? navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }), () => res(null), { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 })
    : res(null)));
  cam.onchange = async () => {
    const f = cam.files[0]; cam.value = ''; if (!f || photos.length >= 3) return;
    const add = $('#fx-add', d); if (add) { add.disabled = true; add.firstElementChild.textContent = 'Getting GPS…'; }
    const pos = await getPos(), now = new Date();
    const lines = [`RECTIFIED | ${s.ref} | ${lineTitle(s)}`,
      pos ? `Lat ${pos.lat.toFixed(6)}  Lng ${pos.lng.toFixed(6)}  ±${Math.round(pos.acc)} m` : 'GPS not available',
      `${fmtDateTime(now.toISOString())}  |  ${getSettings().name || ''}`];
    try {
      const { blob } = await stampPhoto(f, lines);
      photos.push({ blob, url: URL.createObjectURL(blob), meta: { lat: pos?.lat ?? null, lng: pos?.lng ?? null, acc: pos?.acc ?? null, takenAt: now.toISOString() } });
    } catch (err) { toast(err.message, 'err'); }
    paint();
  };
  $$('[data-close]', d).forEach(b => (b.onclick = () => { photos.forEach(p => URL.revokeObjectURL(p.url)); d.close(); }));
  $('#fx-form', d).onsubmit = async (e) => {
    e.preventDefault();
    const name = (getSettings().name || '').trim();
    if (!name) { const er = $('#fx-err', d); er.hidden = false; er.textContent = 'Enter your name in Settings first.'; return; }
    save.disabled = true;
    try {
      await queueRectify(s.id, { note: $('#fx-note', d).value.trim(), by: { name }, at: new Date().toISOString(), photos: photos.map(p => p.meta) }, photos.map(p => p.blob));
      toast(navigator.onLine ? 'Saved. Uploading…' : 'Saved offline. Will upload when online', 'ok');
      photos.forEach(p => URL.revokeObjectURL(p.url));
      d.close(); if (parentDlg) parentDlg.close();
    } catch (err) { const er = $('#fx-err', d); er.hidden = false; er.textContent = err.message; save.disabled = false; }
  };
  d.showModal();
}

/* ---------------- stretch PDF ---------------- */
function makeStretchPDFs(list) {
  if (!list.length) return;
  if (!window.jspdf) { toast('PDF library not loaded. Connect to the internet once and reload', 'err', 6000); return; }
  try {
    const doc = buildStretchPDF(list, all);
    const name = list.length === 1
      ? `${list[0].ref}_${lineTitle(list[0]).replace(/[^A-Za-z0-9]+/g, '_')}.pdf`
      : `Stretch_Report_${list.length}_stretches_${dayKey(new Date().toISOString())}.pdf`;
    downloadBlob(doc.output('blob'), name);
    toast('PDF downloaded', 'ok');
  } catch (err) { console.error(err); toast('PDF failed: ' + err.message, 'err', 6000); }
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
      ? `${s0.ref}_${(lineVoltageOf(s0) === '33 kV' ? s0.line33 : shortName(s0.feeder)).replace(/[^A-Za-z0-9]+/g, '_')}.pdf`
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
  if (lineVoltageOf(s) === '33 kV') {
    row2('Primary Substation', s.primarySubstation, '33 kV Line', s.line33);
    row2('Section', s.section, 'Substation', displayName(s.substation));
    row2('Subdivision', s.subdivision, 'Surveyed by', s.surveyor?.name);
  } else {
    row2('Subdivision', s.subdivision, 'Substation', displayName(s.substation));
    row2('Feeder', displayName(s.feeder), 'Surveyed by', s.surveyor?.name);
  }
  row1('Location', s.location);
  row2('Landmark', s.landmark, 'GPS (lat, long)', `${fmtLatLng(s.gps)}  ±${Math.round(s.gps?.acc || 0)} m`);
  // map link over GPS cell
  doc.link(M + half, y - 10, half, 10, { url: `https://www.google.com/maps?q=${s.gps?.lat},${s.gps?.lng}` });
  const sx = stretchMap.get(s.stretchId);
  if (sx) {
    const startY = y;
    row2(`Stretch start point (${sx.ref})`, pointText(sx.start), 'Stretch end point', pointText(sx.end));
    doc.link(M, startY, half, y - startY, { url: `https://www.google.com/maps?q=${sx.start.gps.lat},${sx.start.gps.lng}` });
    if (sx.end) doc.link(M + half, startY, half, y - startY, { url: `https://www.google.com/maps?q=${sx.end.gps.lat},${sx.end.gps.lng}` });
  }

  if (s.rectified) row1('Rectified', `${fmtDateTime(s.rectified.at)} by ${s.rectified.by?.name || '-'}${s.rectified.note ? ' - ' + s.rectified.note : ''}`);

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
