// PDF drawing helpers shared by the survey page (report.js) and the stretch page (pdf-stretch.js).
export const NAVY = [18, 53, 91], AMBER = [242, 169, 0], INK = [20, 27, 38], GREY = [96, 106, 120], LINE = [212, 218, 226], TINT = [244, 246, 249];

export function sectionTitle(doc, x, y, text) {
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(...NAVY);
  doc.text(text, x, y);
}

/* ---- text helpers: jsPDF core fonts only cover Latin-1, so Hindi/other scripts are rasterised ---- */
export const pdfSafe = (t) => String(t ?? '').replace(/[\u2013\u2014]/g, '-').replace(/[\u2018\u2019]/g, "'")
  .replace(/[\u201C\u201D]/g, '"').replace(/\u2026/g, '...').replace(/\u00A0/g, ' ');
const PX_PER_MM = 9;

/** Returns { n: lineCount, draw(x, baselineY) } using vector text when possible, otherwise a crisp bitmap. */
export function textBlock(doc, text, widthMm, pt, lineH, bold = false) {
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
