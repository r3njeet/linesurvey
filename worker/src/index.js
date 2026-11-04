/**
 * Line Survey API — Cloudflare Worker backed by an R2 bucket.
 *
 * R2 layout
 *   photos/<YYYY-MM>/<surveyId>/<n>.jpg   geotagged photographs
 *   surveys/<surveyId>.json               one JSON record per survey (source of truth)
 *   index/surveys.json                    array of all records (fast listing for dashboard/report)
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
import { validateSurvey, MIN_PHOTOS, MAX_PHOTOS } from '../../web/js/catalog.js';

const INDEX_KEY = 'index/surveys.json';
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

  if (p === '/api/photo' && m === 'GET') {
    const key = url.searchParams.get('key') || '';
    if (!/^photos\/[0-9]{4}-[0-9]{2}\/[A-Za-z0-9-]+\/[0-9]+\.jpg$/.test(key)) throw httpError(400, 'Bad photo key');
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

  if (p === '/api/admin/rebuild-index' && m === 'POST') {
    if (role !== 'admin') throw httpError(403, 'Only admin can do this');
    const list = await buildIndexFromRecords(env);
    await env.BUCKET.put(INDEX_KEY, JSON.stringify(list), { httpMetadata: { contentType: 'application/json' } });
    return json({ ok: true, count: list.length });
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
    createdAt: now.toISOString(),
    capturedAt: str(s.capturedAt, 40) || now.toISOString(),
    surveyor: { name: str(s.surveyor?.name, 100) },
    subdivision: s.subdivision, substation: s.substation, feeder: s.feeder,
    irregularities: s.irregularities.map(i => ({ code: i.code, voltage: i.voltage || null, text: i.text ? str(i.text, 300) : undefined })),
    photos,
    gps: { lat: num(s.gps.lat), lng: num(s.gps.lng), acc: num(s.gps.acc) },
    location: str(s.location, 500), landmark: str(s.landmark, 500),
    remarks: str(s.remarks, 1000),
    materialRequired: !!s.materialRequired,
    materials: s.materialRequired ? s.materials.map(m => ({ id: m.id, qty: Math.round(m.qty * 100) / 100 })) : [],
  };
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
  const keys = [`surveys/${id}.json`, ...(rec.photos || []).map(p => p.key)];
  await env.BUCKET.delete(keys);
  return json({ ok: true, deleted: id });
}

/* ---------------- index helpers ---------------- */
async function updateIndex(env, mutate) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const obj = await env.BUCKET.get(INDEX_KEY);
    const list = obj ? await obj.json() : await buildIndexFromRecords(env);
    const next = mutate(list);
    const opts = { httpMetadata: { contentType: 'application/json' } };
    if (obj) opts.onlyIf = { etagMatches: obj.etag };
    const res = await env.BUCKET.put(INDEX_KEY, JSON.stringify(next), opts);
    if (res) return next;                       // null => someone else wrote first; retry
    await new Promise(r => setTimeout(r, 40 + Math.random() * 120 * (attempt + 1)));
  }
  throw httpError(503, 'Server busy, please retry');
}

async function buildIndexFromRecords(env) {
  const list = [];
  let cursor;
  do {
    const page = await env.BUCKET.list({ prefix: 'surveys/', cursor, limit: 1000 });
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
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
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
