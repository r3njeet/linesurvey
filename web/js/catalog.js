// Shared definitions used by the web app AND the Cloudflare Worker (for validation).
import { POLES, LINES33, HIERARCHY as MASTER_HIERARCHY } from './masters.js';

export const V33 = '33 kV', V11 = '11 kV', LT = 'LT';

// Irregularity types. `variants` = voltage levels the user must pick from (one or more).
export const IRREGULARITIES = [
  { code: 'TILTED_POLE',       label: 'Tilted Pole' },
  { code: 'DILAPIDATED_POLE',  label: 'Dilapidated Pole' },
  { code: 'RUSTED_POLE',       label: 'Rusted Pole' },
  { code: 'BROKEN_POLE',       label: 'Broken Pole' },
  { code: 'SAGGED_LINE',       label: 'Sagged Line',                      variants: [V33, V11, LT] },
  { code: 'HOUSE_UNDER_LINE',  label: 'House/Construction Under Line',    variants: [V33, V11, LT] },
  { code: 'LONG_SPAN',         label: 'Long Span Line' },
  { code: 'LOW_CLEARANCE',     label: 'Low Ground Clearance',             variants: [V33, V11, LT] },
  { code: 'CROSSING',          label: 'Road/Canal/River Crossing' },
  { code: 'GI_WIRE_LINE',      label: 'GI Wire Line',                     variants: [V11, LT] },
  { code: 'MANY_JOINTS',       label: 'Too Many Joints In Span',          variants: [V33, V11, LT] },
  { code: 'DAMAGE_AB_CABLE',   label: 'Damage AB Cable' },
  { code: 'DAMAGE_PIN_INS',    label: 'Damage Pin Insulator',             variants: [V33, V11] },
  { code: 'DAMAGE_DISC',       label: 'Damage Disc',                      variants: [V33, V11] },
  { code: 'OTHER',             label: 'Other',                            needsText: true },
];

export const irregularityName = (it) =>
  it.code === 'OTHER' ? `Other: ${it.text || ''}`.trim()
  : it.voltage ? `${labelOf(it.code)} (${it.voltage})` : labelOf(it.code);

export const labelOf = (code) => (IRREGULARITIES.find(i => i.code === code) || { label: code }).label;

// Flat list of every countable "finding" key, used by the dashboard.
export const FINDING_KEYS = IRREGULARITIES.flatMap(i =>
  i.variants ? i.variants.map(v => ({ code: i.code, voltage: v, name: `${i.label} (${v})` }))
             : [{ code: i.code, voltage: null, name: i.label }]);

// Material catalogue: { id, cat, item, unit }
export const MATERIALS = [
  ...POLES.map(p => ({ id: `POLE_${p.type}_${p.length}`, cat: 'Pole', item: p.label, unit: 'Nos' })),
  { id: 'COND_WEASEL', cat: 'Conductor', item: 'ACSR Weasel', unit: 'm' },
  { id: 'COND_RABBIT', cat: 'Conductor', item: 'ACSR Rabbit', unit: 'm' },
  { id: 'COND_DOG',    cat: 'Conductor', item: 'ACSR Dog',    unit: 'm' },
  { id: 'PIN_33',  cat: 'Pin Insulator',  item: 'Pin Insulator 33 kV',  unit: 'Nos' },
  { id: 'PIN_11',  cat: 'Pin Insulator',  item: 'Pin Insulator 11 kV',  unit: 'Nos' },
  { id: 'DISC_33', cat: 'Disc Insulator', item: 'Disc Insulator 33 kV', unit: 'Nos' },
  { id: 'DISC_11', cat: 'Disc Insulator', item: 'Disc Insulator 11 kV', unit: 'Nos' },
  { id: 'VCA_33', cat: 'V Cross Arm', item: 'V Cross Arm 33 kV', unit: 'Nos' },
  { id: 'VCA_11', cat: 'V Cross Arm', item: 'V Cross Arm 11 kV', unit: 'Nos' },
  { id: 'ABC_1X16',  cat: 'LT AB Cable', item: 'LT AB Cable 1X16 sqmm',  unit: 'm' },
  { id: 'ABC_3X50',  cat: 'LT AB Cable', item: 'LT AB Cable 3X50 sqmm',  unit: 'm' },
  { id: 'ABC_3X95',  cat: 'LT AB Cable', item: 'LT AB Cable 3X95 sqmm',  unit: 'm' },
  { id: 'ABC_3X120', cat: 'LT AB Cable', item: 'LT AB Cable 3X120 sqmm', unit: 'm' },
];
export const MATERIAL_CATS = [...new Set(MATERIALS.map(m => m.cat))];
export const materialById = (id) => MATERIALS.find(m => m.id === id);

/* ---------------- line type (11 kV feeder survey or 33 kV line survey) ---------------- */
export const LINE_TYPES = ['11 kV', '33 kV'];
/** Surveys saved before the 33 kV option existed have no lineVoltage: they are 11 kV. */
export const lineVoltageOf = (s) => (s && s.lineVoltage === '33 kV' ? '33 kV' : '11 kV');
const shortOf = (v) => String(v || '').split('_')[0];
/** Substation names are unique across subdivisions; returns the owning subdivision or ''. */
export function subdivisionOfSubstation(ss, H = MASTER_HIERARCHY) {
  for (const [sd, subs] of Object.entries(H)) if (subs[ss]) return sd;
  return '';
}
/** Short title of the surveyed line: "RAMPUR feeder" or "33 KV BARBAR". */
export const lineTitle = (s) => (lineVoltageOf(s) === '33 kV' ? (s.line33 || '33 kV line') : `${shortOf(s.feeder)} feeder`);
/** One-line location path used in lists. */
export const linePath = (s) => (lineVoltageOf(s) === '33 kV'
  ? `${s.primarySubstation} › ${s.line33} › ${s.section}`
  : `${shortOf(s.feeder)} feeder · ${shortOf(s.substation)} · ${s.subdivision}`);

export const MIN_PHOTOS = 2;
export const MAX_PHOTOS = 6;

/** Validate a survey record. Returns an array of error strings (empty = OK). */
export function validateSurvey(s, HIERARCHY, LINES = LINES33) {
  const e = [];
  const str = (v, max = 500) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  if (!s || typeof s !== 'object') return ['Invalid payload'];
  if (!/^[A-Za-z0-9-]{8,64}$/.test(s.id || '')) e.push('Invalid survey id');
  if (s.lineVoltage !== undefined && !LINE_TYPES.includes(s.lineVoltage)) e.push('Choose 11 kV or 33 kV line');
  else if (lineVoltageOf(s) === '33 kV') {
    const secs = LINES[s.primarySubstation]?.[s.line33];
    if (!LINES[s.primarySubstation]) e.push('Select a valid Primary Substation');
    else if (!secs) e.push('Select a valid 33 kV Line');
    else if (!secs[s.section]) e.push('Select a valid Section');
    else if (!secs[s.section].includes(s.substation)) e.push('Select a valid Substation');
    else if (HIERARCHY[s.subdivision]?.[s.substation] === undefined) e.push('Subdivision does not match the Substation');
  } else if (!HIERARCHY[s.subdivision]) e.push('Select a valid Subdivision');
  else if (!HIERARCHY[s.subdivision][s.substation]) e.push('Select a valid Substation');
  else if (!HIERARCHY[s.subdivision][s.substation].includes(s.feeder)) e.push('Select a valid Feeder');
  if (!Array.isArray(s.irregularities) || !s.irregularities.length) e.push('Select at least one irregularity');
  else for (const it of s.irregularities) {
    const def = IRREGULARITIES.find(d => d.code === it.code);
    if (!def) { e.push(`Unknown irregularity ${it.code}`); continue; }
    if (def.variants && !def.variants.includes(it.voltage)) e.push(`Choose voltage for ${def.label}`);
    if (def.needsText && !str(it.text, 300)) e.push('Describe the "Other" irregularity');
  }
  if (!str(s.location)) e.push('Location is required');
  if (!str(s.landmark)) e.push('Landmark is required');
  if (!s.gps || typeof s.gps.lat !== 'number' || typeof s.gps.lng !== 'number') e.push('GPS location missing');
  if (typeof s.materialRequired !== 'boolean') e.push('Choose whether material is required');
  if (s.materialRequired) {
    const items = Array.isArray(s.materials) ? s.materials : [];
    if (!items.length) e.push('Enter quantity for at least one material');
    for (const m of items) {
      if (!materialById(m.id)) e.push(`Unknown material ${m.id}`);
      if (!(typeof m.qty === 'number' && m.qty > 0 && m.qty < 100000)) e.push(`Invalid quantity for ${m.id}`);
    }
  }
  if (!s.surveyor || !str(s.surveyor.name, 100)) e.push('Surveyor name missing (open Settings)');
  return e;
}
