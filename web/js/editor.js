// Admin corrections: fix the line, irregularities, location text or material of a survey, or the line / start / end location of a stretch.
// Photos, GPS fixes, times and the surveyor are never changed.
import { HIERARCHY, LINES33 } from './masters.js';
import { irregularitiesFor, MATERIALS, MATERIAL_CATS, lineVoltageOf, subdivisionOfSubstation } from './catalog.js';
import { $, $$, esc, optionList, toast } from './util.js';
import { patchSurvey, patchStretch } from './api.js';
import { displayName } from './survey.js';

function dialog() {
  let d = $('#ed-dlg');
  if (!d) { d = document.createElement('dialog'); d.id = 'ed-dlg'; d.className = 'dlg'; document.body.appendChild(d); }
  return d;
}

const lineHTML = () => `
  <div class="seg" role="radiogroup" aria-label="Line type">
    <label><input type="radio" name="ed-lt" value="11 kV"><span>11 kV line</span></label>
    <label><input type="radio" name="ed-lt" value="33 kV"><span>33 kV line</span></label>
  </div>
  <div id="ed-11" class="grid3" hidden>
    <label class="fld">Subdivision<select id="ed-sd">${optionList(Object.keys(HIERARCHY), 'Select subdivision')}</select></label>
    <label class="fld">Substation<select id="ed-ss" disabled>${optionList([], 'Select substation')}</select></label>
    <label class="fld">Feeder<select id="ed-fd" disabled>${optionList([], 'Select feeder')}</select></label>
  </div>
  <div id="ed-33" class="grid3" hidden>
    <label class="fld">Primary Substation<select id="ed-ps">${optionList(Object.keys(LINES33), 'Select primary substation')}</select></label>
    <label class="fld">33 kV Line<select id="ed-l33" disabled>${optionList([], 'Select 33 kV line')}</select></label>
    <label class="fld">Section<select id="ed-sec" disabled>${optionList([], 'Select section')}</select></label>
    <label class="fld">Substation<select id="ed-ss33" disabled>${optionList([], 'Select substation')}</select></label>
    <label class="fld">Subdivision <span class="opt">(filled automatically)</span><input id="ed-sd33" readonly tabindex="-1"></label>
  </div>`;

/** Wires the cascading line selects inside the dialog, preset from `rec`. Returns { type(), get() }. */
function wireLine(dlg, rec, onType) {
  const q = (id) => $(`#ed-${id}`, dlg);
  const fire = (el, val) => { el.value = val; if (el.value === val) el.dispatchEvent(new Event('change')); return el.value === val; };
  const sd = q('sd'), ss = q('ss'), fd = q('fd'), ps = q('ps'), l33 = q('l33'), sec = q('sec'), ss33 = q('ss33'), sd33 = q('sd33');
  const type = () => (($('input[name=ed-lt]:checked', dlg)) || {}).value || '';
  const show = () => { q('11').hidden = type() !== '11 kV'; q('33').hidden = type() !== '33 kV'; };

  sd.onchange = () => { ss.innerHTML = optionList(sd.value ? Object.keys(HIERARCHY[sd.value]) : [], 'Select substation', displayName); ss.disabled = !sd.value; fd.innerHTML = optionList([], 'Select feeder'); fd.disabled = true; };
  ss.onchange = () => { fd.innerHTML = optionList(ss.value ? HIERARCHY[sd.value][ss.value] : [], 'Select feeder', displayName); fd.disabled = !ss.value; };
  ps.onchange = () => { l33.innerHTML = optionList(ps.value ? Object.keys(LINES33[ps.value]) : [], 'Select 33 kV line'); l33.disabled = !ps.value; l33.dispatchEvent(new Event('change')); };
  l33.onchange = () => { sec.innerHTML = optionList(l33.value ? Object.keys(LINES33[ps.value][l33.value]) : [], 'Select section'); sec.disabled = !l33.value; sec.dispatchEvent(new Event('change')); };
  sec.onchange = () => {
    const subs = sec.value ? LINES33[ps.value][l33.value][sec.value] : [];
    ss33.innerHTML = optionList(subs, 'Select substation', displayName); ss33.disabled = !sec.value;
    if (subs.length === 1) ss33.value = subs[0];
    ss33.dispatchEvent(new Event('change'));
  };
  ss33.onchange = () => { sd33.value = ss33.value ? subdivisionOfSubstation(ss33.value) : ''; };
  $$('input[name=ed-lt]', dlg).forEach(r => r.addEventListener('change', () => { show(); onType && onType(); }));

  if (lineVoltageOf(rec) === '33 kV') {
    if (fire(ps, rec.primarySubstation) && fire(l33, rec.line33) && fire(sec, rec.section)) fire(ss33, rec.substation);
  } else if (fire(sd, rec.subdivision) && fire(ss, rec.substation)) fire(fd, rec.feeder);
  $(`input[name=ed-lt][value="${lineVoltageOf(rec)}"]`, dlg).checked = true;
  show();
  return {
    type,
    get: () => (type() === '33 kV'
      ? { lineVoltage: '33 kV', primarySubstation: ps.value, line33: l33.value, section: sec.value, substation: ss33.value, subdivision: sd33.value, feeder: '' }
      : { lineVoltage: '11 kV', subdivision: sd.value, substation: ss.value, feeder: fd.value }),
  };
}

function shell(dlg, title, body, saveLabel = 'Save changes') {
  dlg.innerHTML = `
    <form method="dialog" id="ed-form">
      <div class="dlg-head"><h2>${esc(title)}</h2><button type="button" class="btn small ghost" data-close aria-label="Close">✕</button></div>
      <div class="dlg-body">${body}<div id="ed-err" class="errors" hidden></div></div>
      <div class="dlg-foot"><span class="spacer"></span><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">${esc(saveLabel)}</button></div>
    </form>`;
  $$('[data-close]', dlg).forEach(b => (b.onclick = () => dlg.close()));
}
const showErr = (dlg, msg) => { const e = $('#ed-err', dlg); e.hidden = false; e.textContent = msg; e.scrollIntoView({ block: 'nearest' }); };

/* ---------------- survey ---------------- */
export function editSurvey(rec, onSaved) {
  const dlg = dialog();
  const sel = new Map();   // code -> { voltages, text } (one record row per voltage is merged back into one entry)
  for (const i of rec.irregularities) {
    if (!sel.has(i.code)) sel.set(i.code, { voltages: new Set(), text: i.text || '' });
    if (i.voltage) sel.get(i.code).voltages.add(i.voltage);
  }
  let matReq = !!rec.materialRequired;
  const qty = Object.fromEntries((rec.materials || []).map(m => [m.id, m.qty]));

  const mats = MATERIAL_CATS.map(cat => `<fieldset class="mat-group"><legend>${esc(cat)}</legend>
    ${MATERIALS.filter(m => m.cat === cat).map(m => `<div class="mat-row" data-id="${m.id}"><span class="mat-name">${esc(m.item)}</span>
      <div class="stepper"><input type="number" min="0" step="1" inputmode="decimal" value="${qty[m.id] || ''}" placeholder="0" aria-label="${esc(m.item)}"></div>
      <span class="unit">${m.unit === 'm' ? 'metre' : 'nos'}</span></div>`).join('')}</fieldset>`).join('');

  shell(dlg, `Edit ${rec.ref || 'survey'}`, `
    <h3>Line</h3>${lineHTML()}
    <h3>Irregularities</h3><div id="ed-irr" class="ed-irr-list"></div>
    <h3>Location</h3>
    <label class="fld">Location<textarea id="ed-loc" rows="2" maxlength="500">${esc(rec.location)}</textarea></label>
    <label class="fld">Landmark<input id="ed-lmk" maxlength="500" value="${esc(rec.landmark)}"></label>
    <label class="fld">Remarks<input id="ed-rmk" maxlength="1000" value="${esc(rec.remarks || '')}"></label>
    <h3>Material required?</h3>
    <div class="seg"><label><input type="radio" name="ed-mr" value="yes" ${matReq ? 'checked' : ''}><span>Yes</span></label>
      <label><input type="radio" name="ed-mr" value="no" ${!matReq ? 'checked' : ''}><span>No</span></label></div>
    <div id="ed-mat" ${matReq ? '' : 'hidden'}><div class="mat-grid">${mats}</div></div>`);

  const line = wireLine(dlg, rec, renderIrr);
  function renderIrr() {
    const list = irregularitiesFor(line.type() || lineVoltageOf(rec));
    for (const code of [...sel.keys()]) if (!list.some(d => d.code === code)) sel.delete(code);
    $('#ed-irr', dlg).innerHTML = list.map(d => {
      const on = sel.get(d.code);
      return `<div class="ed-irr" data-code="${d.code}">
        <label class="chk"><input type="checkbox" class="ed-cb" ${on ? 'checked' : ''}><span>${esc(d.label)}</span></label>
        ${d.variants ? `<span class="ed-vars" ${on ? '' : 'hidden'}>${d.variants.map(v => `<label class="chip"><input type="checkbox" value="${esc(v)}" ${on?.voltages.has(v) ? 'checked' : ''}><span>${esc(v)}</span></label>`).join('')}</span>` : ''}
        ${d.needsText ? `<input type="text" class="ed-text" maxlength="300" placeholder="Describe the irregularity" value="${esc(on?.text || '')}" ${on ? '' : 'hidden'}>` : ''}</div>`;
    }).join('');
  }
  renderIrr();
  $('#ed-irr', dlg).addEventListener('change', (e) => {
    const row = e.target.closest('.ed-irr'); if (!row) return;
    const code = row.dataset.code;
    if (e.target.classList.contains('ed-cb')) {
      if (e.target.checked) sel.set(code, { voltages: new Set(), text: '' }); else sel.delete(code);
      const v = $('.ed-vars', row), tx = $('.ed-text', row);
      if (v) { v.hidden = !e.target.checked; $$('input', v).forEach(i => (i.checked = false)); }
      if (tx) { tx.hidden = !e.target.checked; tx.value = ''; }
    } else if (e.target.closest('.ed-vars') && sel.get(code)) {
      const s = sel.get(code); e.target.checked ? s.voltages.add(e.target.value) : s.voltages.delete(e.target.value);
    }
  });
  $('#ed-irr', dlg).addEventListener('input', (e) => { const row = e.target.closest('.ed-irr'); if (row && e.target.classList.contains('ed-text') && sel.get(row.dataset.code)) sel.get(row.dataset.code).text = e.target.value; });
  $$('input[name=ed-mr]', dlg).forEach(r => r.addEventListener('change', () => { matReq = r.value === 'yes'; $('#ed-mat', dlg).hidden = !matReq; }));

  $('#ed-form', dlg).onsubmit = async (e) => {
    e.preventDefault();
    const irregularities = [];
    for (const [code, v] of sel) {
      const def = irregularitiesFor(line.type()).find(d => d.code === code) || {};
      if (def.variants) { if (!v.voltages.size) irregularities.push({ code, voltage: null }); else def.variants.filter(x => v.voltages.has(x)).forEach(x => irregularities.push({ code, voltage: x })); }
      else if (def.needsText) irregularities.push({ code, text: v.text.trim() });
      else irregularities.push({ code });
    }
    const materials = [];
    if (matReq) $$('.mat-row', dlg).forEach(r => { const q = parseFloat($('input', r).value); if (q > 0) materials.push({ id: r.dataset.id, qty: q }); });
    const body = { ...line.get(), irregularities, location: $('#ed-loc', dlg).value.trim(), landmark: $('#ed-lmk', dlg).value.trim(), remarks: $('#ed-rmk', dlg).value.trim(), materialRequired: matReq, materials };
    const btn = $('button[type=submit]', dlg); btn.disabled = true;
    try { await patchSurvey(rec.id, body); dlg.close(); toast('Survey updated', 'ok'); onSaved && onSaved(); }
    catch (err) { showErr(dlg, err.message); }
    finally { btn.disabled = false; }
  };
  dlg.showModal();
}

/* ---------------- stretch ---------------- */
export function editStretch(rec, onSaved) {
  const dlg = dialog();
  shell(dlg, `Edit ${rec.ref || 'stretch'}`, `
    <h3>Line</h3>${lineHTML()}
    <h3>Points</h3>
    <label class="fld">Start point<textarea id="ed-start" rows="2" maxlength="500">${esc(rec.start.location)}</textarea></label>
    ${rec.end ? `<label class="fld">End point<textarea id="ed-end" rows="2" maxlength="500">${esc(rec.end.location)}</textarea></label>` : '<p class="hint">The end point has not been entered yet.</p>'}
    <p class="hint">GPS positions and times cannot be changed.</p>`);
  const line = wireLine(dlg, rec);
  $('#ed-form', dlg).onsubmit = async (e) => {
    e.preventDefault();
    const body = { ...line.get(), startLocation: $('#ed-start', dlg).value.trim(), ...(rec.end ? { endLocation: $('#ed-end', dlg).value.trim() } : {}) };
    const btn = $('button[type=submit]', dlg); btn.disabled = true;
    try { await patchStretch(rec.id, body); dlg.close(); toast('Stretch updated', 'ok'); onSaved && onSaved(); }
    catch (err) { showErr(dlg, err.message); }
    finally { btn.disabled = false; }
  };
  dlg.showModal();
}
