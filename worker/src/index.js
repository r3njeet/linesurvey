/**
 * Line Survey API — Cloudflare Worker backed by an R2 bucket.
 *
 * R2 layout
 *   photos/<YYYY-MM>/<surveyId>/<n>.jpg   geotagged photographs
 *   surveys/<surveyId>.json               one JSON record per survey (source of truth)
 *   index/surveys.json                    array of all records (fast listing for dashboard/report)
 *   stretches/<stretchId>.json            a survey stretch: line + start point (+ end point once finished)
 *   index/stretches.json                  array of all stretches
 *
 * The index is updated with optimistic concurrency (R2 conditional put on ETag),
 * so simultaneous submissions from many surveyors never overwrite each other.
 *
 * Secrets / vars (see wrangler.toml & README):
 *   (no key)         anyone with the link can submit surveys AND view dashboard / reports / photos
 *   ADMIN_KEY        admin key: the only one allowed to DELETE surveys or rebuild the index
 *   SURVEY_KEY       no longer needed (kept only for backward compatibility)
 *   ALLOWED_ORIGINS  comma separated origins allowed by CORS, or "*"
 */
import { HIERARCHY } from '../../web/js/masters.js';
import { validateSurvey, validateStretch, mergeSurveyEdit, mergeStretchEdit, MIN_PHOTOS, MAX_PHOTOS } from '../../web/js/catalog.js';

const MAX_FIX_PHOTOS = 3;

const INDEX_KEY = 'index/surveys.json';
// Two kinds of records share the same storage pattern: one JSON file per record + one combined index.
const KINDS = {
  surveys:   { prefix: 'surveys/',   index: INDEX_KEY },
  stretches: { prefix: 'stretches/', index: 'index/stretches.json' },
};
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(request, env);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (err) {
      const status = err.status || 500;
      return json({ ok: false, error: err.message || 'Server error' }, status, cors);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '');
  const m = request.method;

  if (p === '/api/health') return json({ ok: true, time: new Date().toISOString() });

  const role = authRole(request, url, env);

  const given = request.headers.get('X-Access-Key') || url.searchParams.get('k') || '';
  if (given && !role) throw httpError(401, 'Invalid access key');   // a wrong key is always an error

  // Open to everyone with the link: submit, list, view photos.
  if (p === '/api/auth' && m === 'GET') return json({ ok: true, role: role || 'public' });
  if (p === '/api/surveys' && m === 'POST') return submitSurvey(request, env);

  if (p === '/api/surveys' && m === 'GET') {
    const obj = await env.BUCKET.get(INDEX_KEY);
    const list = obj ? await obj.json() : await buildIndexFromRecords(env);
    return json({ ok: true, surveys: list }, 200, { 'Cache-Control': 'no-store' });
  }

  if (p === '/api/stretches' && m === 'POST') return saveStretch(request, env);
  if (p === '/api/stretches' && m === 'GET') {
    const obj = await env.BUCKET.get(KINDS.stretches.index);
    const list = obj ? await obj.json() : await buildIndexFromRecords(env, 'stretches');
    return json({ ok: true, stretches: list }, 200, { 'Cache-Control': 'no-store' });
  }
  const delSt = p.match(/^\/api\/stretches\/([A-Za-z0-9-]{8,64})$/);
  if (delSt && m === 'DELETE') {
    if (role !== 'admin') throw httpError(403, 'Only admin can do this');
    return deleteStretch(delSt[1], env);
  }
  if (delSt && m === 'PATCH') {
    if (role !== 'admin') throw httpError(403, 'Only admin can do this');
    return patchStretch(delSt[1], request, env);
  }

  if (p === '/api/photo' && m === 'GET') {
    const key = url.searchParams.get('key') || '';
    if (!/^photos\/[0-9]{4}-[0-9]{2}\/[A-Za-z0-9-]+\/(fix-)?[0-9]+\.jpg$/.test(key)) throw httpError(400, 'Bad photo key');
    const obj = await env.BUCKET.get(key);
    if (!obj) throw httpError(404, 'Photo not found');
    return new Response(obj.body, {
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable', ETag: obj.httpEtag },
    });
  }

  const del = p.match(/^\/api\/surveys\/([A-Za-z0-9-]{8,64})$/);
  if (del && m === 'DELETE') {
    if (role !== 'admin') throw httpError(403, 'Only admin can do this');
    return deleteSurvey(del[1], env);
  }
  if (del && m === 'PATCH') {                                   // admin corrects an entry
    if (role !== 'admin') throw httpError(403, 'Only admin can do this');
    return patchSurvey(del[1], request, env);
  }
  const rect = p.match(/^\/api\/surveys\/([A-Za-z0-9-]{8,64})\/rectify$/);
  if (rect && m === 'POST') return rectifySurvey(rect[1], request, env);   // anyone can report a fix
  if (rect && m === 'DELETE') {                                            // admin re-opens it
    if (role !== 'admin') throw httpError(403, 'Only admin can do this');
    return unrectifySurvey(rect[1], env);
  }

  if (p === '/api/admin/rebuild-index' && m === 'POST') {
    if (role !== 'admin') throw httpError(403, 'Only admin can do this');
    const out = {};
    for (const kind of Object.keys(KINDS)) {
      const list = await buildIndexFromRecords(env, kind);
      await env.BUCKET.put(KINDS[kind].index, JSON.stringify(list), { httpMetadata: { contentType: 'application/json' } });
      out[kind] = list.length;
    }
    return json({ ok: true, count: out.surveys, ...out });
  }

  throw httpError(404, 'Not found');
}

/* ---------------- submit ---------------- */
async function submitSurvey(request, env) {
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.includes('multipart/form-data')) throw httpError(415, 'Expected multipart/form-data');
  const form = await request.formData();
  let s;
  try { s = JSON.parse(form.get('data')); } catch { throw httpError(400, 'Invalid JSON in "data"'); }

  const photos = [];
  for (let i = 0; i < MAX_PHOTOS; i++) {
    const f = form.get(`photo_${i}`);
    if (f && typeof f === 'object') photos.push(f);
  }
  const errors = validateSurvey(s, HIERARCHY);
  if (photos.length < MIN_PHOTOS) errors.push(`At least ${MIN_PHOTOS} photographs are required`);
  if (!Array.isArray(s.photos) || s.photos.length !== photos.length) errors.push('Photo metadata mismatch');
  for (const f of photos) {
    if (f.size > MAX_PHOTO_BYTES) errors.push('A photo is larger than 6 MB');
    if (f.type && !/^image\/jpe?g$/.test(f.type)) errors.push('Photos must be JPEG');
  }
  if (errors.length) return json({ ok: false, error: errors.join('; '), errors }, 422);

  // Idempotency: offline devices may retry the same submission.
  const existing = await env.BUCKET.get(`surveys/${s.id}.json`);
  if (existing) return json({ ok: true, duplicate: true, survey: await existing.json() });

  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  const photoMeta = [];
  for (let i = 0; i < photos.length; i++) {
    const key = `photos/${month}/${s.id}/${i + 1}.jpg`;
    await env.BUCKET.put(key, photos[i].stream(), {
      httpMetadata: { contentType: 'image/jpeg' },
      customMetadata: { survey: s.id, lat: String(s.photos[i]?.lat ?? ''), lng: String(s.photos[i]?.lng ?? '') },
    });
    const pm = s.photos[i] || {};
    photoMeta.push({ key, lat: num(pm.lat), lng: num(pm.lng), acc: num(pm.acc), takenAt: str(pm.takenAt, 40) });
  }

  const record = sanitize(s, photoMeta, now);
  // Update the index first (assigns sequential survey number), then write the record.
  await updateIndex(env, (list) => {
    const dup = list.find(r => r.id === record.id);
    if (dup) { record.seq = dup.seq; return list; }
    record.seq = list.reduce((mx, r) => Math.max(mx, r.seq || 0), 0) + 1;
    record.ref = 'LS-' + String(record.seq).padStart(5, '0');
    list.push(record);
    return list;
  });
  await env.BUCKET.put(`surveys/${record.id}.json`, JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } });
  return json({ ok: true, survey: record }, 201);
}

function sanitize(s, photos, now) {
  return {
    id: s.id,
    ...(s.stretchId ? { stretchId: s.stretchId } : {}),
    createdAt: now.toISOString(),
    capturedAt: str(s.capturedAt, 40) || now.toISOString(),
    surveyor: { name: str(s.surveyor?.name, 100) },
    lineVoltage: s.lineVoltage === '33 kV' ? '33 kV' : '11 kV',
    subdivision: s.subdivision, substation: s.substation,
    feeder: s.lineVoltage === '33 kV' ? '' : s.feeder,
    ...(s.lineVoltage === '33 kV' ? { primarySubstation: s.primarySubstation, line33: s.line33, section: s.section } : {}),
    irregularities: s.irregularities.map(i => ({ code: i.code, voltage: i.voltage || null, text: i.text ? str(i.text, 300) : undefined })),
    photos,
    gps: { lat: num(s.gps.lat), lng: num(s.gps.lng), acc: num(s.gps.acc) },
    location: str(s.location, 500), landmark: str(s.landmark, 500),
    remarks: str(s.remarks, 1000),
    materialRequired: !!s.materialRequired,
    materials: s.materialRequired ? s.materials.map(m => ({ id: m.id, qty: Math.round(m.qty * 100) / 100 })) : [],
  };
}

/* ---------------- survey stretches ---------------- */
/**
 * Create-or-update. The client sends the whole record, first when the stretch is started (no end point)
 * and again when it is ended. The start point is fixed by the first save; the end point is accepted once.
 */
async function saveStretch(request, env) {
  let s;
  try { s = await request.json(); } catch { throw httpError(400, 'Invalid JSON'); }
  const errors = validateStretch(s, HIERARCHY);
  if (errors.length) return json({ ok: false, error: errors.join('; '), errors }, 422);

  const now = new Date();
  let saved, created = false;
  await updateIndex(env, (list) => {
    const i = list.findIndex(r => r.id === s.id);
    if (i >= 0) {
      const old = list[i];
      if (!old.end && s.end) old.end = cleanPoint(s.end, now);          // finish an open stretch
      saved = old;
      return list;
    }
    created = true;
    const seq = list.reduce((mx, r) => Math.max(mx, r.seq || 0), 0) + 1;
    saved = {
      id: s.id, seq, ref: 'ST-' + String(seq).padStart(5, '0'),
      createdAt: now.toISOString(),
      surveyor: { name: str(s.surveyor?.name, 100) },
      lineVoltage: s.lineVoltage === '33 kV' ? '33 kV' : '11 kV',
      subdivision: s.subdivision, substation: s.substation,
      feeder: s.lineVoltage === '33 kV' ? '' : s.feeder,
      ...(s.lineVoltage === '33 kV' ? { primarySubstation: s.primarySubstation, line33: s.line33, section: s.section } : {}),
      start: cleanPoint(s.start, now),
      end: s.end ? cleanPoint(s.end, now) : null,
    };
    list.push(saved);
    return list;
  }, 'stretches');
  await env.BUCKET.put(`stretches/${saved.id}.json`, JSON.stringify(saved), { httpMetadata: { contentType: 'application/json' } });
  return json({ ok: true, stretch: saved }, created ? 201 : 200);
}

function cleanPoint(p, now) {
  return {
    location: str(p.location, 500),
    gps: { lat: num(p.gps.lat), lng: num(p.gps.lng), acc: num(p.gps.acc) },
    at: str(p.at, 40) || now.toISOString(),
  };
}

async function deleteStretch(id, env) {
  let found = false;
  await updateIndex(env, (list) => { found = list.some(r => r.id === id); return list.filter(r => r.id !== id); }, 'stretches');
  if (!found) throw httpError(404, 'Stretch not found');
  await env.BUCKET.delete(`stretches/${id}.json`);
  return json({ ok: true, deleted: id });
}

/* ---------------- admin corrections ---------------- */
/** Replace one record in both its own file and the combined index. */
async function replaceRecord(env, kind, rec) {
  await updateIndex(env, (list) => list.map(r => (r.id === rec.id ? rec : r)), kind);
  await env.BUCKET.put(`${KINDS[kind].prefix}${rec.id}.json`, JSON.stringify(rec), { httpMetadata: { contentType: 'application/json' } });
}
async function readRecord(env, kind, id) {
  const obj = await env.BUCKET.get(`${KINDS[kind].prefix}${id}.json`);
  if (!obj) throw httpError(404, kind === 'surveys' ? 'Survey not found' : 'Stretch not found');
  return obj.json();
}
async function bodyJson(request) { try { return await request.json(); } catch { throw httpError(400, 'Invalid JSON'); } }

/** Admin: fix the line, irregularities, location / landmark / remarks or materials of a survey. Photos, GPS and surveyor stay. */
async function patchSurvey(id, request, env) {
  const body = await bodyJson(request);
  const old = await readRecord(env, 'surveys', id);
  const next = mergeSurveyEdit(old, body);
  const errors = validateSurvey(next, HIERARCHY);
  if (errors.length) return json({ ok: false, error: errors.join('; '), errors }, 422);
  const rec = {
    ...sanitize(next, old.photos, new Date(old.createdAt)),
    seq: old.seq, ref: old.ref,
    ...(old.rectified ? { rectified: old.rectified } : {}),
    editedAt: new Date().toISOString(),
  };
  await replaceRecord(env, 'surveys', rec);
  return json({ ok: true, survey: rec });
}

/** Admin: fix the line and the typed start / end location of a stretch (GPS and times stay). */
async function patchStretch(id, request, env) {
  const body = await bodyJson(request);
  const old = await readRecord(env, 'stretches', id);
  const next = mergeStretchEdit(old, body);
  const errors = validateStretch(next, HIERARCHY);
  if (errors.length) return json({ ok: false, error: errors.join('; '), errors }, 422);
  const lv33 = next.lineVoltage === '33 kV';
  const rec = {
    id: old.id, seq: old.seq, ref: old.ref, createdAt: old.createdAt, surveyor: old.surveyor,
    lineVoltage: lv33 ? '33 kV' : '11 kV',
    subdivision: next.subdivision, substation: next.substation, feeder: lv33 ? '' : next.feeder,
    ...(lv33 ? { primarySubstation: next.primarySubstation, line33: next.line33, section: next.section } : {}),
    start: cleanPoint(next.start, new Date(old.createdAt)),
    end: next.end ? cleanPoint(next.end, new Date(old.createdAt)) : null,
    editedAt: new Date().toISOString(),
  };
  await replaceRecord(env, 'stretches', rec);
  return json({ ok: true, stretch: rec });
}

/* ---------------- rectification ("fixed on site") ---------------- */
async function rectifySurvey(id, request, env) {
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.includes('multipart/form-data')) throw httpError(415, 'Expected multipart/form-data');
  const form = await request.formData();
  let d;
  try { d = JSON.parse(form.get('data')); } catch { throw httpError(400, 'Invalid JSON in "data"'); }
  const photos = [];
  for (let i = 0; i < MAX_FIX_PHOTOS; i++) { const f = form.get(`photo_${i}`); if (f && typeof f === 'object') photos.push(f); }
  const errors = [];
  if (!str(d.by?.name, 100)) errors.push('Name missing (open Settings)');
  if (!photos.length) errors.push('Add at least one photograph of the completed work');
  if (d.note != null && typeof d.note !== 'string') errors.push('Invalid note');
  for (const f of photos) {
    if (f.size > MAX_PHOTO_BYTES) errors.push('A photo is larger than 6 MB');
    if (f.type && !/^image\/jpe?g$/.test(f.type)) errors.push('Photos must be JPEG');
  }
  if (errors.length) return json({ ok: false, error: errors.join('; '), errors }, 422);

  const old = await readRecord(env, 'surveys', id);
  if (old.rectified) return json({ ok: true, duplicate: true, survey: old });   // retry of an upload that already worked
  const month = String(old.createdAt).slice(0, 7);
  const meta = [];
  for (let i = 0; i < photos.length; i++) {
    const key = `photos/${month}/${id}/fix-${i + 1}.jpg`;
    await env.BUCKET.put(key, photos[i].stream(), { httpMetadata: { contentType: 'image/jpeg' }, customMetadata: { survey: id, kind: 'rectification' } });
    const pm = d.photos?.[i] || {};
    meta.push({ key, lat: num(pm.lat), lng: num(pm.lng), acc: num(pm.acc), takenAt: str(pm.takenAt, 40) });
  }
  const rec = { ...old, rectified: {
    at: str(d.at, 40) || new Date().toISOString(),
    by: { name: str(d.by.name, 100) },
    note: str(d.note, 500),
    photos: meta,
  } };
  await replaceRecord(env, 'surveys', rec);
  return json({ ok: true, survey: rec }, 201);
}

/** Admin: the work was not really done: re-open the survey and remove the "after" photos. */
async function unrectifySurvey(id, env) {
  const old = await readRecord(env, 'surveys', id);
  if (!old.rectified) return json({ ok: true, survey: old });
  const keys = (old.rectified.photos || []).map(p => p.key);
  const rec = { ...old }; delete rec.rectified;
  await replaceRecord(env, 'surveys', rec);
  if (keys.length) await env.BUCKET.delete(keys);
  return json({ ok: true, survey: rec });
}

/* ---------------- delete ---------------- */
async function deleteSurvey(id, env) {
  const obj = await env.BUCKET.get(`surveys/${id}.json`);
  let rec = obj ? await obj.json() : null;
  await updateIndex(env, (list) => {
    if (!rec) rec = list.find(r => r.id === id);
    return list.filter(r => r.id !== id);
  });
  if (!rec) throw httpError(404, 'Survey not found');
  const keys = [`surveys/${id}.json`, ...(rec.photos || []).map(p => p.key), ...(rec.rectified?.photos || []).map(p => p.key)];
  await env.BUCKET.delete(keys);
  return json({ ok: true, deleted: id });
}

/* ---------------- index helpers ---------------- */
async function updateIndex(env, mutate, kind = 'surveys') {
  const key = KINDS[kind].index;
  for (let attempt = 0; attempt < 12; attempt++) {
    const obj = await env.BUCKET.get(key);
    const list = obj ? await obj.json() : await buildIndexFromRecords(env, kind);
    const next = mutate(list);
    const opts = { httpMetadata: { contentType: 'application/json' } };
    if (obj) opts.onlyIf = { etagMatches: obj.etag };
    const res = await env.BUCKET.put(key, JSON.stringify(next), opts);
    if (res) return next;                       // null => someone else wrote first; retry
    await new Promise(r => setTimeout(r, 40 + Math.random() * 120 * (attempt + 1)));
  }
  throw httpError(503, 'Server busy, please retry');
}

async function buildIndexFromRecords(env, kind = 'surveys') {
  const list = [];
  let cursor;
  do {
    const page = await env.BUCKET.list({ prefix: KINDS[kind].prefix, cursor, limit: 1000 });
    const recs = await Promise.all(page.objects.map(o => env.BUCKET.get(o.key).then(r => r && r.json())));
    list.push(...recs.filter(Boolean));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  list.sort((a, b) => (a.seq || 0) - (b.seq || 0) || a.createdAt.localeCompare(b.createdAt));
  return list;
}

/* ---------------- utils ---------------- */
function authRole(request, url, env) {
  const key = request.headers.get('X-Access-Key') || url.searchParams.get('k') || '';
  if (!key) return null;
  if (env.ADMIN_KEY && safeEq(key, env.ADMIN_KEY)) return 'admin';
  if (env.SURVEY_KEY && safeEq(key, env.SURVEY_KEY)) return 'surveyor';
  return null;
}
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
  const allow = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Access-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
