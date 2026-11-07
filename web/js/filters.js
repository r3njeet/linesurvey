// Shared filter bar used by Dashboard and Report tabs.
import { HIERARCHY } from './masters.js';
import { IRREGULARITIES, lineVoltageOf } from './catalog.js';
import { $, esc, optionList, dayKey } from './util.js';
import { displayName } from './survey.js';

export function filterBarHTML(prefix, { extra = false } = {}) {
  return `<div class="filters" id="${prefix}-filters">
    <label class="fld sm">Line<select data-f="lv"><option value="">All</option><option value="11 kV">11 kV</option><option value="33 kV">33 kV</option></select></label>
    <label class="fld sm">Subdivision<select data-f="sd">${optionList(Object.keys(HIERARCHY), 'All')}</select></label>
    <label class="fld sm">Substation<select data-f="ss"><option value="">All</option></select></label>
    <label class="fld sm">Feeder<select data-f="fd"><option value="">All</option></select></label>
    <label class="fld sm">From<input type="date" data-f="from"></label>
    <label class="fld sm">To<input type="date" data-f="to"></label>
    ${extra ? `
    <label class="fld sm">Irregularity<select data-f="irr">${optionList(IRREGULARITIES.map(i => i.code), 'All', c => IRREGULARITIES.find(i => i.code === c).label)}</select></label>
    <label class="fld sm">Material<select data-f="mat"><option value="">All</option><option value="yes">Required</option><option value="no">Not required</option></select></label>
    <label class="fld sm">Status<select data-f="st"><option value="">All</option><option value="open">Open</option><option value="done">Rectified</option></select></label>
    <label class="fld sm grow">Search<input type="search" data-f="q" placeholder="Ref, location, landmark, surveyor…"></label>` : ''}
  </div>`;
}

export function wireFilterBar(prefix, onChange) {
  const bar = $(`#${prefix}-filters`);
  const g = (k) => bar.querySelector(`[data-f="${k}"]`);
  g('sd').addEventListener('change', () => {
    const sd = g('sd').value;
    g('ss').innerHTML = optionList(sd ? Object.keys(HIERARCHY[sd]) : allSubstations(), 'All', displayName);
    g('fd').innerHTML = optionList([], 'All');
    onChange();
  });
  g('ss').addEventListener('change', () => {
    const sd = g('sd').value, ss = g('ss').value;
    const f = ss ? (sd ? HIERARCHY[sd][ss] : Object.values(HIERARCHY).flatMap(x => x[ss] || [])) : [];
    g('fd').innerHTML = optionList(f, 'All', displayName);
    onChange();
  });
  g('ss').innerHTML = optionList(allSubstations(), 'All', displayName);
  bar.addEventListener('change', (e) => { if (!['sd', 'ss'].includes(e.target.dataset.f)) onChange(); });
  bar.addEventListener('input', (e) => { if (e.target.dataset.f === 'q') onChange(); });
  return () => {
    const v = {};
    bar.querySelectorAll('[data-f]').forEach(i => (v[i.dataset.f] = i.value.trim()));
    return v;
  };
}

const allSubstations = () => [...new Set(Object.values(HIERARCHY).flatMap(Object.keys))].sort();

export function applyFilters(list, f, nameFn) {
  const q = (f.q || '').toLowerCase();
  return list.filter(s => {
    if (f.sd && s.subdivision !== f.sd) return false;
    if (f.ss && s.substation !== f.ss) return false;
    if (f.lv && lineVoltageOf(s) !== f.lv) return false;
    if (f.fd && s.feeder !== f.fd) return false;
    const d = dayKey(s.capturedAt || s.createdAt);
    if (f.from && d < f.from) return false;
    if (f.to && d > f.to) return false;
    if (f.irr && !s.irregularities.some(i => i.code === f.irr)) return false;
    if (f.mat === 'yes' && !s.materialRequired) return false;
    if (f.mat === 'no' && s.materialRequired) return false;
    if (f.st === 'open' && s.rectified) return false;
    if (f.st === 'done' && !s.rectified) return false;
    if (q) {
      const hay = [s.ref, s.location, s.landmark, s.remarks, s.surveyor?.name, s.feeder, s.substation, s.primarySubstation, s.line33, s.section,
        ...s.irregularities.map(nameFn)].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}


/** Same line / date filters for stretches (they have no irregularities, material or status). */
export function filterStretches(list, f) {
  return list.filter(x => {
    if (f.sd && x.subdivision !== f.sd) return false;
    if (f.ss && x.substation !== f.ss) return false;
    if (f.lv && lineVoltageOf(x) !== f.lv) return false;
    if (f.fd && x.feeder !== f.fd) return false;
    const d = dayKey(x.start.at);
    if (f.from && d < f.from) return false;
    if (f.to && d > f.to) return false;
    return true;
  });
}
