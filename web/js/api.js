import { CONFIG } from './config.js';
import { idb } from './db.js';
import { HIERARCHY } from './masters.js';
import { validateSurvey, validateStretch, mergeSurveyEdit, mergeStretchEdit } from './catalog.js';

export const bus = new EventTarget();
const stretchBox = idb.coll('stretchbox'), localSt = idb.coll('localst'), rectBox = idb.coll('rectbox');
const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

/* ---------------- settings ---------------- */
const LS_KEY = 'ls.settings';
export function getSettings() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
}
export function saveSettings(s) {
  localStorage.setItem(LS_KEY, JSON.stringify({ ...getSettings(), ...s }));
  photoCache.clear();
  emit('settings');
}
export const apiBase = () => (getSettings().apiBase || CONFIG.API_BASE || '').trim().replace(/\/+$/, '');
export const isDemo = () => !apiBase();
export const role = () => (isDemo() ? 'admin' : getSettings().role || 'public');

async function req(path, opts = {}, base = apiBase(), key = getSettings().key) {
  let res;
  try {
    res = await fetch(base + path, { ...opts, headers: { 'X-Access-Key': key || '', ...(opts.headers || {}) } });
  } catch {
    const e = new Error('Network error — check internet connection'); e.network = true; throw e;
  }
  const ct = res.headers.get('Content-Type') || '';
  const body = ct.includes('json') ? await res.json() : null;
  if (!res.ok) { const e = new Error(body?.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return body ?? res;
}

/** Test a server URL + key. Returns role ("surveyor" | "admin"). */
export async function checkAuth(base, key) {
  const b = (base || '').trim().replace(/\/+$/, '');
  const r = await req('/api/auth', {}, b, key);
  return r.role;
}

/* ---------------- outbox & sync ---------------- */
export async function queueSurvey(record, photoBlobs) {
  await idb.put('outbox', { id: record.id, record, photos: photoBlobs, queuedAt: new Date().toISOString() });
  emit('outbox');
  sync();
}
export const outboxItems = () => idb.all('outbox');

/** Survey stretches (start / end points) are tiny JSON records: the latest state is queued and re-sent until the server has it. */
export async function queueStretch(record) {
  await stretchBox.put(record.id, { id: record.id, record, queuedAt: new Date().toISOString() });
  emit('outbox');
  sync();
}
export const pendingCount = async () => (await idb.count('outbox')) + (await stretchBox.count()) + (await rectBox.count());

/** "Fixed on site": note + after-photos for a survey. Queued like surveys, so it also works without network. */
export async function queueRectify(surveyId, data, photoBlobs) {
  await rectBox.put(surveyId, { id: surveyId, data, photos: photoBlobs, queuedAt: new Date().toISOString() });
  emit('outbox');
  sync();
}

let syncing = false;
export async function sync() {
  if (syncing) return;
  syncing = true;
  emit('sync', { state: 'start' });
  let uploaded = 0, uploadedSt = 0, uploadedFix = 0, lastError = null;
  try {
    // stretches first, so a survey never reaches the server before the stretch it belongs to
    for (const st of await stretchBox.all()) {
      try {
        if (isDemo()) await saveLocalStretch(st.record);
        else {
          if (!navigator.onLine) { lastError = 'Offline'; break; }
          await req('/api/stretches', { method: 'POST', body: JSON.stringify(st.record), headers: { 'Content-Type': 'application/json' } });
        }
        await stretchBox.del(st.id);
        uploadedSt++;
      } catch (err) {
        lastError = err.message;
        if (err.status === 422) { await stretchBox.del(st.id); continue; }   // can never be accepted
        break;
      }
    }
    const items = lastError ? [] : (await idb.all('outbox')).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    for (const it of items) {
      try {
        if (isDemo()) await saveLocal(it);
        else {
          if (!navigator.onLine) { lastError = 'Offline'; break; }
          const fd = new FormData();
          fd.append('data', JSON.stringify(it.record));
          it.photos.forEach((b, i) => fd.append(`photo_${i}`, b, `photo_${i + 1}.jpg`));
          await req('/api/surveys', { method: 'POST', body: fd });
        }
        await idb.del('outbox', it.id);
        uploaded++;
      } catch (err) {
        lastError = err.message;
        if (err.status === 422) { it.error = err.message; await idb.put('outbox', it); continue; }
        break; // network / auth problem — retry later
      }
    }
    // after surveys, so the survey a fix belongs to is already on the server
    if (!lastError) for (const it of await rectBox.all()) {
      try {
        if (isDemo()) await rectifyLocal(it);
        else {
          if (!navigator.onLine) { lastError = 'Offline'; break; }
          const fd = new FormData();
          fd.append('data', JSON.stringify(it.data));
          it.photos.forEach((b, i) => fd.append(`photo_${i}`, b, `fix_${i + 1}.jpg`));
          await req(`/api/surveys/${encodeURIComponent(it.id)}/rectify`, { method: 'POST', body: fd });
        }
        await rectBox.del(it.id);
        uploadedFix++;
      } catch (err) {
        lastError = err.message;
        if (err.status === 422 || err.status === 404) { await rectBox.del(it.id); continue; }   // can never be accepted (or survey was deleted)
        break;
      }
    }
  } finally {
    syncing = false;
    emit('outbox');
    emit('sync', { state: 'done', uploaded, error: lastError });
    if (uploaded || uploadedSt || uploadedFix) emit('data');
  }
}
export async function discardOutbox(id) { await idb.del('outbox', id); emit('outbox'); }

/* ---------------- demo (on-device) storage ---------------- */
async function saveLocal(it) {
  const list = await idb.all('local');
  if (list.some(r => r.id === it.id)) return;
  const seq = list.reduce((m, r) => Math.max(m, r.seq || 0), 0) + 1;
  const rec = structuredClone(it.record);
  rec.createdAt = new Date().toISOString();
  rec.seq = seq;
  rec.ref = 'LS-' + String(seq).padStart(5, '0');
  rec.photos = rec.photos.map((p, i) => ({ ...p, key: `demo/${rec.id}/${i + 1}.jpg` }));
  for (let i = 0; i < it.photos.length; i++) await idb.put('blobs', it.photos[i], rec.photos[i].key);
  await idb.put('local', rec);
}

async function rectifyLocal(it) {
  const rec = await idb.get('local', it.id);
  if (!rec || rec.rectified) return;
  const photos = [];
  for (let i = 0; i < it.photos.length; i++) {
    const key = `demo/${it.id}/fix-${i + 1}.jpg`;
    await idb.put('blobs', it.photos[i], key);
    photos.push({ ...(it.data.photos?.[i] || {}), key });
  }
  rec.rectified = { at: it.data.at, by: it.data.by, note: it.data.note || '', photos };
  await idb.put('local', rec);
}

/* ---------------- admin corrections ---------------- */
function failIfInvalid(errors) { if (errors.length) { const e = new Error(errors.join('; ')); e.status = 422; throw e; } }
export async function patchSurvey(id, body) {
  if (isDemo()) {
    const old = await idb.get('local', id); if (!old) throw new Error('Survey not found');
    const next = mergeSurveyEdit(old, body); failIfInvalid(validateSurvey(next, HIERARCHY));
    await idb.put('local', { ...next, editedAt: new Date().toISOString() });
  } else {
    await req('/api/surveys/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  }
  emit('data');
}
export async function patchStretch(id, body) {
  if (isDemo()) {
    const old = await localSt.get(id); if (!old) throw new Error('Stretch not found');
    const next = mergeStretchEdit(old, body); failIfInvalid(validateStretch(next, HIERARCHY));
    await localSt.put(id, { ...next, editedAt: new Date().toISOString() });
  } else {
    await req('/api/stretches/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  }
  emit('data');
}
/** Admin: the work was not really done, open the survey again. */
export async function unrectify(id) {
  if (isDemo()) {
    const rec = await idb.get('local', id);
    for (const p of rec?.rectified?.photos || []) await idb.del('blobs', p.key);
    if (rec) { delete rec.rectified; await idb.put('local', rec); }
  } else {
    await req(`/api/surveys/${encodeURIComponent(id)}/rectify`, { method: 'DELETE' });
  }
  emit('data');
}

async function saveLocalStretch(rec) {
  const old = await localSt.get(rec.id);
  if (old) { if (!old.end && rec.end) { old.end = rec.end; await localSt.put(old.id, old); } return; }
  const list = await localSt.all();
  const seq = list.reduce((m, r) => Math.max(m, r.seq || 0), 0) + 1;
  await localSt.put(rec.id, { ...structuredClone(rec), createdAt: new Date().toISOString(), seq, ref: 'ST-' + String(seq).padStart(5, '0') });
}

/* ---------------- read ---------------- */
let cachedList = null;
export async function listSurveys({ fresh = false } = {}) {
  if (cachedList && !fresh) return cachedList;
  if (isDemo()) {
    cachedList = { surveys: (await idb.all('local')).sort((a, b) => a.seq - b.seq), offline: false };
    return cachedList;
  }
  try {
    const r = await req('/api/surveys');
    cachedList = { surveys: r.surveys, offline: false, at: new Date().toISOString() };
    idb.put('kv', cachedList, 'surveys').catch(() => {});
  } catch (err) {
    if (err.status === 401) throw err;
    const c = await idb.get('kv', 'surveys');
    if (!c) throw err;
    cachedList = { ...c, offline: true };
  }
  return cachedList;
}
bus.addEventListener('data', () => { cachedList = null; cachedStretches = null; });
bus.addEventListener('settings', () => { cachedList = null; cachedStretches = null; });

let cachedStretches = null;
/** All survey stretches. Never throws: reports still work (without start / end points) if this fails. */
export async function listStretches({ fresh = false } = {}) {
  if (cachedStretches && !fresh) return cachedStretches;
  try {
    if (isDemo()) cachedStretches = (await localSt.all()).sort((a, b) => a.seq - b.seq);
    else {
      cachedStretches = (await req('/api/stretches')).stretches;
      idb.put('kv', cachedStretches, 'stretches').catch(() => {});
    }
  } catch {
    cachedStretches = (await idb.get('kv', 'stretches').catch(() => null)) || [];
  }
  return cachedStretches;
}
export async function deleteStretch(id) {
  if (isDemo()) await localSt.del(id);
  else await req('/api/stretches/' + encodeURIComponent(id), { method: 'DELETE' });
  emit('data');
}

const photoCache = new Map();
export async function getPhotoBlob(key) {
  if (photoCache.has(key)) return photoCache.get(key);
  const p = (async () => {
    if (key.startsWith('demo/')) {
      const b = await idb.get('blobs', key);
      if (!b) throw new Error('Photo not found on this device');
      return b;
    }
    const res = await req('/api/photo?key=' + encodeURIComponent(key));
    return res.blob();
  })();
  photoCache.set(key, p);
  p.catch(() => photoCache.delete(key));
  return p;
}

export async function deleteSurvey(id) {
  if (isDemo()) {
    const rec = await idb.get('local', id);
    for (const p of [...(rec?.photos || []), ...(rec?.rectified?.photos || [])]) await idb.del('blobs', p.key);
    await idb.del('local', id);
  } else {
    await req('/api/surveys/' + encodeURIComponent(id), { method: 'DELETE' });
  }
  emit('data');
}
