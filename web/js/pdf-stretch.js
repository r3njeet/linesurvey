// One-page (more only if there are many findings) PDF report of a survey stretch:
// line, start / end point, a plan of the surveyed points, every finding, and the material still needed.
import { CONFIG } from './config.js';
import { MATERIALS, materialById, irregularityName, lineVoltageOf } from './catalog.js';
import { fmtDateTime, fmtDate, fmtNum, fmtLatLng, distanceM } from './util.js';
import { displayName } from './survey.js';
import { NAVY, AMBER, INK, GREY, LINE, TINT, sectionTitle, pdfSafe, textBlock } from './pdfutil.js';

const W = 210, H = 297, M = 12, CW = W - 2 * M;

export const stretchKm = (x) => (x.end ? distanceM(x.start.gps, x.end.gps) / 1000 : null);

function duration(x) {
  if (!x.end) return 'still open';
  const min = Math.max(0, Math.round((new Date(x.end.at) - new Date(x.start.at)) / 60000));
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

/** Surveys of a stretch in the order they were recorded. */
export const surveysOf = (x, all) => all.filter(s => s.stretchId === x.id).sort((a, b) => String(a.capturedAt || a.createdAt).localeCompare(String(b.capturedAt || b.createdAt)));

/** Builds a jsPDF document with one section (starting on a new page) per stretch. */
export function buildStretchPDF(stretches, allSurveys) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  stretches.forEach((x, i) => {
    if (i) doc.addPage();
    drawStretch(doc, x, surveysOf(x, allSurveys));
  });
  // footers last, so "Page x of N" knows N
  const n = doc.getNumberOfPages();
  for (let p = 1; p <= n; p++) {
    doc.setPage(p);
    doc.setDrawColor(...LINE); doc.line(M, H - 11.5, W - M, H - 11.5);
    doc.setFontSize(7.5); doc.setTextColor(...GREY); doc.setFont('helvetica', 'normal');
    doc.text(`Generated ${fmtDateTime(new Date().toISOString())}`, M, H - 8);
    doc.text(`Page ${p} of ${n}`, W - M, H - 8, { align: 'right' });
  }
  return doc;
}

function band(doc, x, small) {
  doc.setFillColor(...NAVY); doc.rect(0, 0, W, small ? 14 : 24, 'F');
  doc.setFillColor(...AMBER); doc.rect(0, small ? 14 : 24, W, 1.2, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(small ? 10 : 14);
  doc.text(small ? `SURVEY STRETCH ${pdfSafe(x.ref)} (continued)` : 'SURVEY STRETCH REPORT', M, small ? 9 : 11);
  if (!small) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
    doc.text(pdfSafe(CONFIG.ORG_NAME), M, 17.5);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
    doc.text(pdfSafe(x.ref), W - M, 11, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
    doc.text(fmtDate(x.start.at), W - M, 17.5, { align: 'right' });
  }
}

function drawStretch(doc, x, surveys) {
  band(doc, x, false);
  let y = 30;
  const half = CW / 2;
  const cell = (cx, cy, w, label, value) => {
    const tb = textBlock(doc, value || '-', w - 4, 9.2, 4);
    const h = Math.max(10, 6.5 + tb.n * 4);
    return { h, draw: (hh) => {
      doc.setDrawColor(...LINE); doc.rect(cx, cy, w, hh);
      doc.setFontSize(6.8); doc.setTextColor(...GREY); doc.setFont('helvetica', 'bold');
      doc.text(label.toUpperCase(), cx + 2, cy + 3.6);
      tb.draw(cx + 2, cy + 7.8);
    } };
  };
  const row2 = (l1, v1, l2, v2) => {
    const a = cell(M, y, half, l1, v1), b = cell(M + half, y, half, l2, v2);
    const h = Math.max(a.h, b.h); a.draw(h); b.draw(h); y += h;
  };
  if (lineVoltageOf(x) === '33 kV') {
    row2('Primary Substation', x.primarySubstation, '33 kV Line', x.line33);
    row2('Section', x.section, 'Substation', displayName(x.substation));
    row2('Subdivision', x.subdivision, 'Surveyed by', x.surveyor?.name);
  } else {
    row2('Subdivision', x.subdivision, 'Substation', displayName(x.substation));
    row2('Feeder', displayName(x.feeder), 'Surveyed by', x.surveyor?.name);
  }
  const pt = (p) => (p ? `${p.location}\n${fmtLatLng(p.gps)}  ±${Math.round(p.gps.acc || 0)} m  |  ${fmtDateTime(p.at)}` : 'Not yet ended');
  const y0 = y;
  row2('Start point', pt(x.start), 'End point', pt(x.end));
  doc.link(M, y0, half, y - y0, { url: `https://www.google.com/maps?q=${x.start.gps.lat},${x.start.gps.lng}` });
  if (x.end) doc.link(M + half, y0, half, y - y0, { url: `https://www.google.com/maps?q=${x.end.gps.lat},${x.end.gps.lng}` });
  const km = stretchKm(x);
  row2('Status / time taken', `${x.end ? 'Completed' : 'Open'}  |  ${duration(x)}`,
    'Start to end (straight line)', km == null ? '-' : `${km < 1 ? Math.round(km * 1000) + ' m' : km.toFixed(2) + ' km'} (approx.)`);

  // plan of surveyed points
  y += 5;
  sectionTitle(doc, M, y, `PLAN OF SURVEYED POINTS (${surveys.length} SURVEY${surveys.length === 1 ? '' : 'S'})`); y += 2;
  const planH = 58;
  const img = planImage(x, surveys, CW, planH);
  doc.addImage(img, 'PNG', M, y, CW, planH, undefined, 'FAST');
  y += planH + 1;
  doc.setFontSize(6.8); doc.setTextColor(...GREY); doc.setFont('helvetica', 'normal');
  doc.text('S = start, E = end, numbers = findings in the table below. Dashed line joins points in the order recorded; it is not the line route.', M, y + 2.5);
  y += 7;

  // findings table
  const cols = [{ k: '#', w: 8 }, { k: 'Survey', w: 24 }, { k: 'Irregularities', w: 56 }, { k: 'Location / landmark', w: 62 }, { k: 'Material', w: 16 }, { k: 'Status', w: 20 }];
  const tableHead = () => {
    doc.setFillColor(...NAVY); doc.rect(M, y, CW, 6, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7.6); doc.setTextColor(255, 255, 255);
    let cx = M; cols.forEach(c => { doc.text(c.k, cx + 1.5, y + 4.1); cx += c.w; });
    y += 6;
  };
  sectionTitle(doc, M, y, `FINDINGS (${surveys.length})`); y += 2.5;
  tableHead();
  const limitY = H - 16;
  if (!surveys.length) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...GREY);
    doc.text('No survey was recorded in this stretch.', M + 2, y + 5); y += 9;
  }
  surveys.forEach((s, i) => {
    const irr = textBlock(doc, s.irregularities.map(irregularityName).join('; '), cols[2].w - 3, 7.8, 3.5);
    const loc = textBlock(doc, `${s.location} - ${s.landmark}`, cols[3].w - 3, 7.8, 3.5);
    const ref = textBlock(doc, `${s.ref || ''}\n${fmtDateTime(s.capturedAt || s.createdAt)}`, cols[1].w - 2, 7.4, 3.3);
    const h = Math.max(irr.n * 3.5, loc.n * 3.5, ref.n * 3.3, 5) + 2.6;
    if (y + h > limitY) { doc.addPage(); band(doc, x, true); y = 20; tableHead(); }
    if (i % 2) { doc.setFillColor(...TINT); doc.rect(M, y, CW, h, 'F'); }
    let cx = M;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...INK);
    doc.text(String(i + 1), cx + 1.5, y + 4); cx += cols[0].w;
    ref.draw(cx + 1, y + 3.7); cx += cols[1].w;
    irr.draw(cx + 1.5, y + 3.7); cx += cols[2].w;
    loc.draw(cx + 1.5, y + 3.7); cx += cols[3].w;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    doc.text(s.materialRequired ? 'Yes' : 'No', cx + 1.5, y + 4); cx += cols[4].w;
    if (s.rectified) { doc.setTextColor(23, 128, 61); doc.setFont('helvetica', 'bold'); }
    doc.text(s.rectified ? 'Rectified' : 'Open', cx + 1.5, y + 4);
    doc.setDrawColor(...LINE); doc.line(M, y + h, M + CW, y + h);
    y += h;
  });

  // material still needed (locations not yet rectified)
  const totals = new Map();
  surveys.filter(s => s.materialRequired && !s.rectified).forEach(s => (s.materials || []).forEach(m => totals.set(m.id, (totals.get(m.id) || 0) + m.qty)));
  const rows = MATERIALS.filter(m => totals.has(m.id)).map(m => ({ item: m.item, unit: m.unit === 'm' ? 'm' : 'Nos', qty: totals.get(m.id) }));
  const matCols = rows.length > 6 ? 2 : 1, perCol = Math.ceil(rows.length / matCols);
  const matH = 9 + (rows.length ? 6 + perCol * 5.4 : 5);
  if (y + 6 + matH > limitY) { doc.addPage(); band(doc, x, true); y = 20; }
  y += 6;
  sectionTitle(doc, M, y, 'MATERIAL STILL REQUIRED IN THIS STRETCH (LOCATIONS NOT YET RECTIFIED)'); y += 3;
  if (!rows.length) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...GREY);
    doc.text('No material is required.', M + 1, y + 4);
  } else {
    const tw = matCols === 2 ? (CW - 4) / 2 : CW;
    for (let c = 0; c < matCols; c++) {
      const bx = M + c * (tw + 4);
      let ty = y;
      doc.setFillColor(...NAVY); doc.rect(bx, ty, tw, 6, 'F');
      doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(255, 255, 255);
      doc.text('Material', bx + 2, ty + 4.1); doc.text('Quantity', bx + tw - 2, ty + 4.1, { align: 'right' });
      ty += 6;
      const part = rows.slice(c * perCol, (c + 1) * perCol);
      part.forEach((r, k) => {
        if (k % 2) { doc.setFillColor(...TINT); doc.rect(bx, ty, tw, 5.4, 'F'); }
        doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(...INK);
        doc.text(pdfSafe(r.item), bx + 2, ty + 3.8);
        doc.setFont('helvetica', 'bold');
        doc.text(`${fmtNum(r.qty)} ${r.unit}`, bx + tw - 2, ty + 3.8, { align: 'right' });
        ty += 5.4;
      });
      doc.setDrawColor(...LINE); doc.rect(bx, y, tw, 6 + part.length * 5.4);
    }
  }
}

/** Canvas plan of the stretch: start, findings (numbered, in recorded order) and end on a scaled grid; returns a PNG data URL. */
function planImage(x, surveys, wMm, hMm) {
  const PX = 8, w = Math.round(wMm * PX), h = Math.round(hMm * PX);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#f4f6f9'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#d4dae2'; g.lineWidth = 2; g.strokeRect(1, 1, w - 2, h - 2);

  const pts = [{ k: 'S', p: x.start.gps }, ...surveys.map((s, i) => ({ k: String(i + 1), p: s.gps })).filter(o => o.p && o.p.lat != null), ...(x.end ? [{ k: 'E', p: x.end.gps }] : [])];
  const lat0 = pts.reduce((a, o) => a + o.p.lat, 0) / pts.length;
  const mx = Math.cos(lat0 * Math.PI / 180) * 111320, my = 110574;           // metres per degree
  const xs = pts.map(o => o.p.lng * mx), ys = pts.map(o => o.p.lat * my);
  let minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const minSpan = 60;                                                          // never zoom in closer than 60 m
  if (maxX - minX < minSpan) { const m = (minX + maxX) / 2; minX = m - minSpan / 2; maxX = m + minSpan / 2; }
  if (maxY - minY < minSpan) { const m = (minY + maxY) / 2; minY = m - minSpan / 2; maxY = m + minSpan / 2; }
  const padX = 70, padY = 55;
  const k = Math.min((w - 2 * padX) / (maxX - minX), (h - 2 * padY) / (maxY - minY));   // px per metre
  const ox = (w - (maxX - minX) * k) / 2, oy = (h - (maxY - minY) * k) / 2;
  const X = (i) => ox + (xs[i] - minX) * k, Y = (i) => h - (oy + (ys[i] - minY) * k);

  // path in recorded order
  g.setLineDash([14, 10]); g.strokeStyle = '#8a95a5'; g.lineWidth = 3; g.beginPath();
  pts.forEach((o, i) => (i ? g.lineTo(X(i), Y(i)) : g.moveTo(X(i), Y(i)))); g.stroke(); g.setLineDash([]);

  // markers
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const marker = (i, color, r, fs) => {
    g.fillStyle = '#fff'; g.beginPath(); g.arc(X(i), Y(i), r + 3, 0, 7); g.fill();
    g.fillStyle = color; g.beginPath(); g.arc(X(i), Y(i), r, 0, 7); g.fill();
    g.fillStyle = '#fff'; g.font = `700 ${fs}px sans-serif`; g.fillText(pts[i].k, X(i), Y(i) + 1);
  };
  pts.forEach((o, i) => { if (o.k !== 'S' && o.k !== 'E') marker(i, '#c47f00', 17, 19); });
  pts.forEach((o, i) => { if (o.k === 'S') marker(i, '#17803d', 22, 24); if (o.k === 'E') marker(i, '#b42318', 22, 24); });

  // scale bar
  const nice = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
  const target = (w * 0.22) / k;
  const len = nice.filter(v => v <= target).pop() || 10;
  const bx = 24, by = h - 26;
  g.strokeStyle = '#141b26'; g.lineWidth = 4; g.beginPath(); g.moveTo(bx, by); g.lineTo(bx + len * k, by); g.moveTo(bx, by - 8); g.lineTo(bx, by + 8); g.moveTo(bx + len * k, by - 8); g.lineTo(bx + len * k, by + 8); g.stroke();
  g.fillStyle = '#141b26'; g.font = '600 19px sans-serif'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.fillText(len >= 1000 ? `${len / 1000} km` : `${len} m`, bx, by - 14);
  // north arrow
  g.textAlign = 'center'; g.font = '700 22px sans-serif';
  g.fillText('N', w - 34, 34);
  g.beginPath(); g.moveTo(w - 34, 42); g.lineTo(w - 44, 74); g.lineTo(w - 34, 66); g.lineTo(w - 24, 74); g.closePath(); g.fill();
  return c.toDataURL('image/png');
}
