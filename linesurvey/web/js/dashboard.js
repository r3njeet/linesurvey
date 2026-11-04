import { HIERARCHY } from './masters.js';
import { IRREGULARITIES, MATERIALS, MATERIAL_CATS, irregularityName } from './catalog.js';
import { $, esc, fmtNum, dayKey, fmtDate, shortName } from './util.js';
import { listSurveys, bus } from './api.js';
import { filterBarHTML, wireFilterBar, applyFilters } from './filters.js';

let root, getF, all = [], map, layer, meta = {};

export function initDashboard(el) {
  root = el;
  root.innerHTML = `
    <div class="view-head"><h1>Dashboard</h1><span id="db-meta" class="muted"></span>
      <button class="btn small ghost" id="db-refresh">Refresh</button></div>
    ${filterBarHTML('db')}
    <div id="db-body"><div class="empty">Loading…</div></div>`;
  getF = wireFilterBar('db', render);
  $('#db-refresh').onclick = () => load(true);
  bus.addEventListener('data', () => { if (!root.hidden) load(true); });
}

export async function showDashboard() { await load(false); }

async function load(fresh) {
  try {
    const r = await listSurveys({ fresh });
    all = r.surveys; meta = r;
    render();
  } catch (err) {
    $('#db-body').innerHTML = `<div class="empty err">${esc(err.message)}</div>`;
  }
}

function render() {
  const f = getF();
  const list = applyFilters(all, f, irregularityName);
  $('#db-meta').textContent = meta.offline ? `Offline copy · ${fmtDate(meta.at)}` : '';
  if (!all.length) { $('#db-body').innerHTML = `<div class="empty">No surveys submitted yet.</div>`; return; }

  // ---- aggregates
  const today = dayKey(new Date().toISOString());
  const findings = list.reduce((n, s) => n + s.irregularities.length, 0);
  const withMat = list.filter(s => s.materialRequired).length;
  const todayN = list.filter(s => dayKey(s.capturedAt || s.createdAt) === today).length;

  // feeders in scope
  const scopeFeeders = [];
  for (const [sd, sss] of Object.entries(HIERARCHY)) {
    if (f.sd && sd !== f.sd) continue;
    for (const [ss, fds] of Object.entries(sss)) {
      if (f.ss && ss !== f.ss) continue;
      for (const fd of fds) if (!f.fd || fd === f.fd) scopeFeeders.push({ sd, ss, fd });
    }
  }
  const coveredFeeders = new Set(list.map(s => s.feeder));
  const covered = scopeFeeders.filter(x => coveredFeeders.has(x.fd)).length;

  // irregularity counts
  const byType = IRREGULARITIES.map(d => {
    const items = list.flatMap(s => s.irregularities.filter(i => i.code === d.code));
    const byV = {};
    for (const i of items) if (i.voltage) byV[i.voltage] = (byV[i.voltage] || 0) + 1;
    return { d, n: items.length, byV };
  }).sort((a, b) => b.n - a.n);
  const maxType = Math.max(1, ...byType.map(x => x.n));

  // materials
  const mat = MATERIALS.map(m => {
    let qty = 0, locs = 0;
    for (const s of list) {
      const x = (s.materials || []).find(y => y.id === m.id);
      if (x) { qty += x.qty; locs++; }
    }
    return { ...m, qty, locs };
  });

  // daily trend (last 30 days in range)
  const days = {};
  for (const s of list) { const k = dayKey(s.capturedAt || s.createdAt); days[k] = (days[k] || 0) + 1; }
  const keys = Object.keys(days).sort();
  const span = [];
  if (keys.length) {
    const endD = new Date((f.to || (keys.at(-1) > today ? keys.at(-1) : today)) + 'T12:00:00');
    const back = (n) => { const d = new Date(endD); d.setDate(d.getDate() - n); return d; };
    let startD = new Date((f.from && f.from > keys[0] ? f.from : keys[0]) + 'T12:00:00');
    if (startD < back(29)) startD = back(29);   // show at most 30 days
    if (startD > back(6)) startD = back(6);     // and at least 7
    for (const d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
      const k = dayKey(d.toISOString());
      span.push({ k, n: days[k] || 0 });
    }
  }
  const maxDay = Math.max(1, ...span.map(x => x.n));

  // by substation
  const ssRows = {};
  for (const x of scopeFeeders) {
    const key = x.sd + '|' + x.ss;
    ssRows[key] ||= { sd: x.sd, ss: x.ss, feeders: 0, covered: 0, surveys: 0, findings: 0, mat: 0 };
    ssRows[key].feeders++;
    if (coveredFeeders.has(x.fd)) ssRows[key].covered++;
  }
  for (const s of list) {
    const r = ssRows[s.subdivision + '|' + s.substation]; if (!r) continue;
    r.surveys++; r.findings += s.irregularities.length; if (s.materialRequired) r.mat++;
  }
  const ssList = Object.values(ssRows).sort((a, b) => a.sd.localeCompare(b.sd) || b.surveys - a.surveys);

  // surveyors
  const surv = {};
  for (const s of list) { const n = s.surveyor?.name || '—'; surv[n] = (surv[n] || 0) + 1; }
  const survList = Object.entries(surv).sort((a, b) => b[1] - a[1]).slice(0, 10);

  $('#db-body').innerHTML = `
    <div class="kpis">
      ${kpi('Surveys', list.length, todayN ? `+${todayN} today` : 'none today')}
      ${kpi('Irregularities found', findings, list.length ? `${(findings / list.length).toFixed(1)} per survey` : '')}
      ${kpi('Locations needing material', withMat, list.length ? `${Math.round(withMat * 100 / list.length)}% of surveys` : '')}
      ${kpi('Feeders covered', `${covered}<small>/${scopeFeeders.length}</small>`, `${scopeFeeders.length ? Math.round(covered * 100 / scopeFeeders.length) : 0}% coverage`, covered / Math.max(1, scopeFeeders.length))}
    </div>

    <div class="dgrid">
      <section class="card">
        <h3>Findings by irregularity</h3>
        <div class="hbars">${byType.map(x => `
          <div class="hbar" title="${esc(x.d.label)}: ${x.n}">
            <span class="hb-l">${esc(x.d.label)}${Object.keys(x.byV).length ? `<small>${Object.entries(x.byV).map(([v, n]) => `${esc(v)}: ${n}`).join(' · ')}</small>` : ''}</span>
            <span class="hb-t"><span class="hb-f" style="width:${(x.n / maxType * 100).toFixed(1)}%"></span></span>
            <span class="hb-v">${x.n}</span>
          </div>`).join('')}</div>
      </section>

      <section class="card">
        <h3>Material required <small class="muted">${withMat} location${withMat === 1 ? '' : 's'}</small></h3>
        <table class="tbl mat-tbl"><thead><tr><th>Item</th><th class="r">Quantity</th><th class="r">Locations</th></tr></thead>
        <tbody>${MATERIAL_CATS.map(cat => `
          <tr class="grp"><td colspan="3">${esc(cat)}</td></tr>
          ${mat.filter(m => m.cat === cat).map(m => `<tr class="${m.qty ? '' : 'zero'}"><td>${esc(m.cat === 'Pole' ? m.item : m.item.replace(cat + ' ', ''))}</td>
            <td class="r num">${fmtNum(m.qty)} <small>${m.unit === 'm' ? 'm' : 'nos'}</small></td><td class="r num">${m.locs || ''}</td></tr>`).join('')}`).join('')}
        </tbody></table>
      </section>

      <section class="card wide">
        <h3>Daily survey progress</h3>
        ${span.length ? `<div class="vbars" role="img" aria-label="Surveys per day">${span.map(x => `
          <div class="vb" tabindex="0"><span class="vb-tip">${fmtDate(x.k + 'T12:00:00')}: ${x.n} survey${x.n === 1 ? '' : 's'}</span>
            <span class="vb-f" style="height:${(x.n / maxDay * 100).toFixed(1)}%"></span>
            <span class="vb-x">${x.k.slice(8)}</span></div>`).join('')}</div>
          <div class="axis-note muted">Day of month · peak ${maxDay} surveys/day</div>` : '<div class="empty">No data in range</div>'}
      </section>

      <section class="card wide">
        <h3>Progress by substation</h3>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Subdivision</th><th>Substation</th><th>Feeder coverage</th><th class="r">Surveys</th><th class="r">Findings</th><th class="r">Need material</th></tr></thead>
        <tbody>${ssList.map(r => `<tr class="${r.surveys ? '' : 'zero'}"><td>${esc(r.sd)}</td><td>${esc(shortName(r.ss))}</td>
          <td><div class="prog"><span style="width:${(r.covered / r.feeders * 100).toFixed(0)}%"></span></div><small>${r.covered}/${r.feeders}</small></td>
          <td class="r num">${r.surveys}</td><td class="r num">${r.findings}</td><td class="r num">${r.mat}</td></tr>`).join('')}</tbody></table></div>
      </section>

      <section class="card wide">
        <h3>Survey locations</h3>
        <div id="db-map" class="map"></div>
      </section>

      <section class="card">
        <h3>Surveyors</h3>
        <table class="tbl"><thead><tr><th>Name</th><th class="r">Surveys</th></tr></thead>
        <tbody>${survList.map(([n, c]) => `<tr><td>${esc(n)}</td><td class="r num">${c}</td></tr>`).join('')}</tbody></table>
      </section>
    </div>`;

  drawMap(list);
}

function kpi(label, value, sub, frac) {
  return `<div class="kpi"><span class="kpi-l">${esc(label)}</span><span class="kpi-v">${value}</span>
    ${frac != null ? `<div class="prog"><span style="width:${Math.round(frac * 100)}%"></span></div>` : ''}
    <span class="kpi-s">${esc(sub)}</span></div>`;
}

function drawMap(list) {
  const el = $('#db-map');
  if (!window.L) { el.innerHTML = '<div class="empty">Map unavailable offline</div>'; return; }
  if (map) { map.remove(); map = null; }
  map = L.map(el, { scrollWheelZoom: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
  layer = L.featureGroup().addTo(map);
  for (const s of list) {
    if (!s.gps || s.gps.lat == null) continue;
    L.circleMarker([s.gps.lat, s.gps.lng], {
      radius: 7, weight: 2, color: '#fff', fillOpacity: 0.95,
      fillColor: s.materialRequired ? '#c2410c' : '#1d4ed8',
    }).bindPopup(`<b>${esc(s.ref || '')}</b><br>${esc(shortName(s.feeder))} feeder<br>${s.irregularities.map(i => esc(irregularityName(i))).join('<br>')}<br><i>${esc(s.landmark)}</i>`).addTo(layer);
  }
  if (layer.getLayers().length) map.fitBounds(layer.getBounds().pad(0.2), { maxZoom: 15 });
  else map.setView([27.95, 80.4], 9);
  const legend = L.control({ position: 'bottomleft' });
  legend.onAdd = () => { const d = L.DomUtil.create('div', 'map-legend'); d.innerHTML = '<span><i style="background:#c2410c"></i>Material required</span><span><i style="background:#1d4ed8"></i>No material</span>'; return d; };
  legend.addTo(map);
  setTimeout(() => map.invalidateSize(), 50);
}

