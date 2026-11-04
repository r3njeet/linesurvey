import { HIERARCHY } from './masters.js';
import { IRREGULARITIES, MATERIALS, MATERIAL_CATS, MIN_PHOTOS, MAX_PHOTOS, validateSurvey } from './catalog.js';
import { $, $$, esc, toast, uid, stampPhoto, fmtDateTime, optionList, shortName } from './util.js';
import { getSettings, queueSurvey, outboxItems, discardOutbox, bus, sync } from './api.js';

const LAST_SEL = 'ls.lastSelection';
let root, st, lastFix = null, gpsState = 'idle', watchId = null;

export const displayName = (v) => {
  const i = String(v).indexOf('_');
  return i > 0 ? `${v.slice(0, i)} — ${v.slice(i + 1)}` : v;
};

function freshState() {
  return { id: uid(), irregs: new Map(), photos: [], matReq: null, qty: {}, startedAt: new Date().toISOString() };
}

export function initSurvey(el) {
  root = el;
  st = freshState();
  root.innerHTML = template();
  wire();
  restoreSelection();
  startGPS();
  renderOutbox();
  bus.addEventListener('outbox', renderOutbox);
  window.addEventListener('beforeunload', (e) => { if (st.photos.length) { e.preventDefault(); e.returnValue = ''; } });
}

function template() {
  const irr = IRREGULARITIES.map(d => `
    <div class="irr" data-code="${d.code}">
      <label class="irr-head"><input type="checkbox" class="irr-cb"><span class="box" aria-hidden="true"></span><span>${esc(d.label)}</span>
        ${d.variants ? `<em class="tag">${d.variants.join(' / ')}</em>` : ''}</label>
      ${d.variants ? `<div class="irr-sub" hidden><span class="sub-lbl">Line:</span>${d.variants.map(v =>
        `<label class="chip"><input type="checkbox" value="${esc(v)}"><span>${esc(v)}</span></label>`).join('')}</div>` : ''}
      ${d.needsText ? `<div class="irr-sub" hidden><input type="text" class="irr-text" maxlength="300" placeholder="Describe the irregularity"></div>` : ''}
    </div>`).join('');

  const mats = MATERIAL_CATS.map(cat => `
    <fieldset class="mat-group"><legend>${esc(cat)}</legend>
      ${MATERIALS.filter(m => m.cat === cat).map(m => `
        <div class="mat-row" data-id="${m.id}">
          <span class="mat-name">${esc(m.cat === 'Pole' ? m.item : m.item.replace(cat + ' ', ''))}</span>
          <div class="stepper">
            <button type="button" class="step-btn" data-d="-1" aria-label="Decrease">−</button>
            <input type="number" inputmode="decimal" min="0" step="${m.unit === 'm' ? '1' : '1'}" placeholder="0" aria-label="${esc(m.item)} quantity">
            <button type="button" class="step-btn" data-d="1" aria-label="Increase">+</button>
          </div>
          <span class="unit">${m.unit === 'm' ? 'metre' : 'nos'}</span>
        </div>`).join('')}
    </fieldset>`).join('');

  return `
  <div id="sv-outbox"></div>
  <form id="sv-form" novalidate autocomplete="off">
    <section class="card step" id="st-1">
      <h2><span class="num">1</span>Line details</h2>
      <div class="grid3">
        <label class="fld">Subdivision<select id="sv-sd" required>${optionList(Object.keys(HIERARCHY), 'Select subdivision')}</select></label>
        <label class="fld">Substation<select id="sv-ss" required disabled><option value="">Select substation</option></select></label>
        <label class="fld">Feeder<select id="sv-fd" required disabled><option value="">Select feeder</option></select></label>
      </div>
    </section>

    <section class="card step" id="st-2">
      <h2><span class="num">2</span>Irregularities found <small id="irr-count"></small></h2>
      <p class="hint">Tick every problem seen at this pole / span. For line problems choose the voltage level.</p>
      <div class="irr-list">${irr}</div>
    </section>

    <section class="card step" id="st-3">
      <h2><span class="num">3</span>Photographs <small id="ph-count">0 / min ${MIN_PHOTOS}</small></h2>
      <div class="gps-line"><span id="sv-gps" class="gps idle">GPS: starting…</span></div>
      <p class="lock-msg" id="ph-lock">Select Subdivision, Substation and Feeder before taking photographs.</p>
      <div class="photo-grid" id="ph-grid"></div>
      <input type="file" id="sv-cam" accept="image/*" capture="environment" hidden>
    </section>

    <section class="card step" id="st-4">
      <h2><span class="num">4</span>Location &amp; landmark</h2>
      <label class="fld"><span>Location <b class="req">*</b></span><textarea id="sv-loc" rows="2" maxlength="500" placeholder="Village / mohalla / pole no. / span between poles"></textarea></label>
      <label class="fld"><span>Landmark <b class="req">*</b></span><input type="text" id="sv-lmk" maxlength="500" placeholder="e.g. Near Shiv Mandir, opposite primary school"></label>
      <label class="fld"><span>Remarks <span class="opt">(optional)</span></span><input type="text" id="sv-rmk" maxlength="1000"></label>
    </section>

    <section class="card step" id="st-5">
      <h2><span class="num">5</span>Material required to rectify?</h2>
      <div class="seg" role="radiogroup">
        <label><input type="radio" name="matreq" value="yes"><span>Yes</span></label>
        <label><input type="radio" name="matreq" value="no"><span>No</span></label>
      </div>
      <div id="mat-box" hidden>
        <p class="hint">Enter quantity against each item needed (poles &amp; insulators in numbers, conductor &amp; cable in metres).</p>
        <div class="mat-grid">${mats}</div>
      </div>
    </section>

    <div id="sv-errors" class="errors" hidden></div>
    <div class="submit-bar">
      <button type="button" class="btn ghost" id="sv-reset">Clear</button>
      <button type="submit" class="btn primary big" id="sv-submit">Submit survey</button>
    </div>
  </form>`;
}

function wire() {
  const sd = $('#sv-sd'), ss = $('#sv-ss'), fd = $('#sv-fd');
  sd.addEventListener('change', () => {
    const subs = sd.value ? Object.keys(HIERARCHY[sd.value]) : [];
    ss.innerHTML = optionList(subs, 'Select substation', displayName);
    ss.disabled = !sd.value;
    fd.innerHTML = optionList([], 'Select feeder'); fd.disabled = true;
    selectionChanged();
  });
  ss.addEventListener('change', () => {
    const f = ss.value ? HIERARCHY[sd.value][ss.value] : [];
    fd.innerHTML = optionList(f, 'Select feeder', displayName);
    fd.disabled = !ss.value;
    selectionChanged();
  });
  fd.addEventListener('change', selectionChanged);

  // irregularities
  $$('.irr', root).forEach(box => {
    const code = box.dataset.code;
    const cb = $('.irr-cb', box), sub = $('.irr-sub', box);
    cb.addEventListener('change', () => {
      if (cb.checked) st.irregs.set(code, { voltages: new Set(), text: '' });
      else st.irregs.delete(code);
      box.classList.toggle('on', cb.checked);
      if (sub) sub.hidden = !cb.checked;
      if (!cb.checked && sub) $$('input', sub).forEach(i => { i.type === 'checkbox' ? (i.checked = false) : (i.value = ''); });
      if (cb.checked && sub) { const t = $('.irr-text', sub); if (t) t.focus(); }
      $('#irr-count').textContent = st.irregs.size ? `${st.irregs.size} selected` : '';
    });
    if (sub) {
      $$('input[type=checkbox]', sub).forEach(c => c.addEventListener('change', () => {
        const s = st.irregs.get(code); if (!s) return;
        c.checked ? s.voltages.add(c.value) : s.voltages.delete(c.value);
      }));
      const t = $('.irr-text', sub);
      if (t) t.addEventListener('input', () => { const s = st.irregs.get(code); if (s) s.text = t.value; });
    }
  });

  // photos
  $('#sv-cam').addEventListener('change', onPhoto);
  $('#ph-grid').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      const i = +rm.dataset.rm;
      URL.revokeObjectURL(st.photos[i].url);
      st.photos.splice(i, 1);
      renderPhotos();
      return;
    }
    if (e.target.closest('#ph-add')) {
      if (!$('#sv-fd').value) { toast('Select Subdivision, Substation and Feeder first', 'err'); return; }
      $('#sv-cam').click();
    }
  });

  // materials
  $$('input[name=matreq]').forEach(r => r.addEventListener('change', () => {
    st.matReq = r.value === 'yes';
    $('#mat-box').hidden = !st.matReq;
  }));
  $('#mat-box').addEventListener('click', (e) => {
    const b = e.target.closest('.step-btn'); if (!b) return;
    const inp = $('input', b.parentElement);
    inp.value = Math.max(0, (parseFloat(inp.value) || 0) + Number(b.dataset.d)) || '';
  });

  $('#sv-form').addEventListener('submit', onSubmit);
  $('#sv-reset').addEventListener('click', () => {
    if (confirmLoss()) resetForm();
  });
  renderPhotos();
}

function confirmLoss() {
  return !(st.photos.length || st.irregs.size) || window.confirm('Clear this survey? Photos and entries will be lost.');
}

function selectionChanged() {
  const v = { sd: $('#sv-sd').value, ss: $('#sv-ss').value, fd: $('#sv-fd').value };
  localStorage.setItem(LAST_SEL, JSON.stringify(v));
  renderPhotos();
}

function restoreSelection() {
  let v; try { v = JSON.parse(localStorage.getItem(LAST_SEL)); } catch { v = null; }
  if (!v || !HIERARCHY[v.sd]) return;
  const sd = $('#sv-sd'), ss = $('#sv-ss'), fd = $('#sv-fd');
  sd.value = v.sd; sd.dispatchEvent(new Event('change'));
  if (HIERARCHY[v.sd][v.ss]) {
    ss.value = v.ss; ss.dispatchEvent(new Event('change'));
    if (HIERARCHY[v.sd][v.ss].includes(v.fd)) { fd.value = v.fd; fd.dispatchEvent(new Event('change')); }
  }
}

/* ---------------- GPS ---------------- */
function startGPS() {
  if (!('geolocation' in navigator)) { setGps('err', 'GPS not supported on this device'); return; }
  setGps('wait', 'GPS: acquiring location…');
  watchId = navigator.geolocation.watchPosition(
    (p) => { lastFix = toFix(p); setGps(lastFix.acc <= 30 ? 'ok' : 'weak', `GPS ±${Math.round(lastFix.acc)} m · ${lastFix.lat.toFixed(5)}, ${lastFix.lng.toFixed(5)}`); },
    (err) => setGps('err', err.code === 1 ? 'Location permission denied — allow location for this site' : 'GPS: no signal, move to open sky'),
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
}
const toFix = (p) => ({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, t: p.timestamp || Date.now() });
function setGps(state, text) {
  gpsState = state;
  const g = $('#sv-gps'); if (!g) return;
  g.className = `gps ${state}`; g.textContent = text;
}
function getFix() {
  if (lastFix && Date.now() - lastFix.t < 60000) return Promise.resolve(lastFix);
  return new Promise((res, rej) => navigator.geolocation.getCurrentPosition(
    (p) => { lastFix = toFix(p); res(lastFix); },
    (e) => rej(new Error(e.code === 1 ? 'Location permission denied. Allow location access and retry.' : 'Could not get GPS location. Move to open sky and retry.')),
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 }));
}

/* ---------------- photos ---------------- */
async function onPhoto(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (st.photos.length >= MAX_PHOTOS) { toast(`Maximum ${MAX_PHOTOS} photographs`, 'err'); return; }
  const tile = $('#ph-add'); tile.classList.add('busy'); tile.querySelector('span').textContent = 'Getting GPS…';
  try {
    const fix = await getFix();
    const s = getSettings();
    const now = new Date();
    const lines = [
      `${shortName($('#sv-fd').value)} feeder | ${shortName($('#sv-ss').value)} S/S`,
      `Lat ${fix.lat.toFixed(6)}  Lng ${fix.lng.toFixed(6)}  ±${Math.round(fix.acc)} m`,
      `${fmtDateTime(now.toISOString())}${s.name ? '  |  ' + s.name : ''}`,
    ];
    const { blob } = await stampPhoto(file, lines);
    st.photos.push({ blob, url: URL.createObjectURL(blob), lat: fix.lat, lng: fix.lng, acc: fix.acc, takenAt: now.toISOString() });
    renderPhotos();
  } catch (err) {
    toast(err.message, 'err', 5000);
    renderPhotos();
  }
}

function renderPhotos() {
  const locked = !$('#sv-fd')?.value;
  $('#ph-lock').hidden = !locked;
  const n = st.photos.length;
  $('#ph-count').textContent = `${n} / min ${MIN_PHOTOS}`;
  $('#ph-count').className = n >= MIN_PHOTOS ? 'good' : '';
  $('#ph-grid').innerHTML = st.photos.map((p, i) => `
    <figure class="ph"><img src="${p.url}" alt="Photo ${i + 1}">
      <figcaption>#${i + 1} · ±${Math.round(p.acc)} m</figcaption>
      <button type="button" class="ph-rm" data-rm="${i}" aria-label="Remove photo ${i + 1}">×</button></figure>`).join('') +
    (n < MAX_PHOTOS ? `<button type="button" class="ph add ${locked ? 'locked' : ''}" id="ph-add">
      <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path fill="currentColor" d="M9 3 7.2 5H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>
      <span>${n ? 'Take another' : 'Take photo'}</span></button>` : '');
}

/* ---------------- submit ---------------- */
function buildRecord() {
  const s = getSettings();
  const irregularities = [];
  for (const [code, v] of st.irregs) {
    const def = IRREGULARITIES.find(d => d.code === code);
    if (def.variants) {
      if (!v.voltages.size) irregularities.push({ code, voltage: null });
      else def.variants.filter(x => v.voltages.has(x)).forEach(x => irregularities.push({ code, voltage: x }));
    } else if (def.needsText) irregularities.push({ code, text: v.text.trim() });
    else irregularities.push({ code });
  }
  const materials = [];
  if (st.matReq) $$('.mat-row', root).forEach(r => {
    const q = parseFloat($('input', r).value);
    if (q > 0) materials.push({ id: r.dataset.id, qty: q });
  });
  const best = [...st.photos].sort((a, b) => a.acc - b.acc)[0];
  return {
    id: st.id,
    capturedAt: st.photos[0]?.takenAt || new Date().toISOString(),
    surveyor: { name: s.name || '' },
    subdivision: $('#sv-sd').value, substation: $('#sv-ss').value, feeder: $('#sv-fd').value,
    irregularities,
    photos: st.photos.map(p => ({ lat: p.lat, lng: p.lng, acc: p.acc, takenAt: p.takenAt })),
    gps: best ? { lat: best.lat, lng: best.lng, acc: best.acc } : null,
    location: $('#sv-loc').value.trim(), landmark: $('#sv-lmk').value.trim(), remarks: $('#sv-rmk').value.trim(),
    materialRequired: st.matReq,
    materials,
  };
}

async function onSubmit(e) {
  e.preventDefault();
  const rec = buildRecord();
  const errors = validateSurvey(rec, HIERARCHY).filter(x => x !== 'GPS location missing');
  if (st.photos.length < MIN_PHOTOS) errors.push(`Take at least ${MIN_PHOTOS} photographs`);
  if (rec.materialRequired === null) { errors.splice(errors.indexOf('Choose whether material is required'), 1); errors.push('Choose whether material is required (Yes / No)'); }
  const box = $('#sv-errors');
  if (errors.length) {
    box.hidden = false;
    box.innerHTML = `<strong>Please fix before submitting:</strong><ul>${errors.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  box.hidden = true;
  const btn = $('#sv-submit'); btn.disabled = true;
  try {
    await queueSurvey(rec, st.photos.map(p => p.blob));
    toast(navigator.onLine ? 'Survey saved — uploading…' : 'Saved offline — will upload when online', 'ok');
    resetForm();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    toast('Could not save: ' + err.message, 'err', 6000);
  } finally { btn.disabled = false; }
}

function resetForm() {
  st.photos.forEach(p => URL.revokeObjectURL(p.url));
  st = freshState();
  $$('.irr', root).forEach(b => { b.classList.remove('on'); $$('input', b).forEach(i => { i.type === 'checkbox' ? (i.checked = false) : (i.value = ''); }); $$('.irr-sub', b).forEach(s => (s.hidden = true)); });
  $('#irr-count').textContent = '';
  ['#sv-loc', '#sv-lmk', '#sv-rmk'].forEach(s => ($(s).value = ''));
  $$('input[name=matreq]').forEach(r => (r.checked = false));
  $$('.mat-row input').forEach(i => (i.value = ''));
  $('#mat-box').hidden = true;
  $('#sv-errors').hidden = true;
  renderPhotos();
}

/* ---------------- outbox banner ---------------- */
async function renderOutbox() {
  const items = await outboxItems();
  const el = $('#sv-outbox');
  if (!items.length) { el.innerHTML = ''; return; }
  const bad = items.filter(i => i.error);
  el.innerHTML = `<div class="banner warn">
      <span><strong>${items.length}</strong> survey${items.length > 1 ? 's' : ''} saved on this phone, waiting to upload.</span>
      <button type="button" class="btn small" id="ob-sync">Upload now</button>
    </div>
    ${bad.map(i => `<div class="banner err"><span>Rejected by server: ${esc(i.error)}</span>
      <button type="button" class="btn small" data-discard="${i.id}">Discard</button></div>`).join('')}`;
  $('#ob-sync').onclick = () => sync();
  $$('[data-discard]', el).forEach(b => (b.onclick = () => { if (confirm('Discard this survey permanently?')) discardOutbox(b.dataset.discard); }));
}
