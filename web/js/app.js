import { CONFIG } from './config.js';
import { $, $$, esc, toast } from './util.js';
import { t, getLang, setLang, applyLang } from './i18n.js';
import { getSettings, saveSettings, isDemo, checkAuth, sync, pendingCount, bus } from './api.js';
import { initSurvey } from './survey.js';
import { initDashboard, showDashboard } from './dashboard.js';
import { initReport, showReport } from './report.js';

const VIEWS = { survey: null, dashboard: showDashboard, report: showReport };

function init() {
  document.title = CONFIG.APP_TITLE;
  $('#app-title').textContent = CONFIG.APP_TITLE;
  initSurvey($('#view-survey'));
  initDashboard($('#view-dashboard'));
  initReport($('#view-report'));

  $$('[data-tab]').forEach(b => b.addEventListener('click', () => (location.hash = b.dataset.tab)));
  window.addEventListener('hashchange', route);
  route();

  $('#btn-settings').onclick = openSettings;
  const langBtn = $('#btn-lang');
  const paintLang = () => { langBtn.textContent = getLang() === 'hi' ? 'EN' : 'हिं'; applyLang(); updatePill(); };
  langBtn.onclick = () => setLang(getLang() === 'hi' ? 'en' : 'hi');
  window.addEventListener('langchange', paintLang);
  paintLang();
  $('#sync-pill').onclick = () => sync();
  bus.addEventListener('outbox', updatePill);
  bus.addEventListener('sync', (e) => {
    updatePill(e.detail);
    if (e.detail.state === 'done' && e.detail.uploaded) toast(`${e.detail.uploaded} survey${e.detail.uploaded > 1 ? 's' : ''} uploaded`, 'ok');
    if (e.detail.state === 'done' && e.detail.error && e.detail.error !== 'Offline' && !e.detail.uploaded) toast('Upload failed: ' + e.detail.error, 'err', 5000);
  });
  window.addEventListener('online', () => { updatePill(); sync(); });
  window.addEventListener('offline', updatePill);
  setInterval(async () => { if ((await pendingCount()) && navigator.onLine) sync(); }, 60000);
  updatePill();
  sync();

  const s = getSettings();
  if (!s.name) openSettings(true);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

function route() {
  const tab = (location.hash || '#survey').slice(1);
  const t = VIEWS.hasOwnProperty(tab) ? tab : 'survey';
  for (const k of Object.keys(VIEWS)) $(`#view-${k}`).hidden = k !== t;
  $$('[data-tab]').forEach(b => b.setAttribute('aria-current', b.dataset.tab === t ? 'page' : 'false'));
  if (VIEWS[t]) VIEWS[t]();
  window.scrollTo(0, 0);
}

let syncing = false;
async function updatePill(detail) {
  if (detail?.state) syncing = detail.state === 'start';
  const n = await pendingCount();
  const p = $('#sync-pill');
  let cls = 'ok', txt = t('Synced');
  if (isDemo()) { cls = 'demo'; txt = t('Demo mode'); }
  else if (syncing) { cls = 'busy'; txt = t('Uploading…'); }
  else if (!navigator.onLine) { cls = 'off'; txt = n ? t('Offline · {n} pending', { n }) : t('Offline'); }
  else if (n) { cls = 'warn'; txt = t('{n} pending', { n }); }
  p.className = `pill-status ${cls}`;
  p.textContent = txt;
}

function openSettings(firstRun = false) {
  const s = getSettings();
  const dlg = $('#settings-dlg');
  dlg.innerHTML = `
    <form method="dialog" id="set-form">
      <div class="dlg-head"><h2>${esc(t(firstRun ? 'Welcome — enter your name' : 'Settings'))}</h2>
        ${firstRun ? '' : '<button type="button" class="btn small ghost" data-close aria-label="Close">✕</button>'}</div>
      <div class="dlg-body">
        <label class="fld"><span>${esc(t('Surveyor name'))} <b class="req">*</b></span><input id="set-name" required maxlength="100" value="${esc(s.name || '')}" autocomplete="name"></label>
        <label class="fld" ${CONFIG.API_BASE ? 'hidden' : ''}><span>Server URL <span class="opt">(Cloudflare Worker)</span></span>
          <input id="set-api" type="url" placeholder="${esc(CONFIG.API_BASE || 'https://line-survey-api.<account>.workers.dev')}" value="${esc(s.apiBase || '')}"></label>
        <label class="fld"><span>${esc(t('Admin key'))} <span class="opt">(only needed to delete or edit surveys — leave empty otherwise)</span></span><input id="set-key" type="password" value="${esc(s.key || '')}" autocomplete="off"></label>
        <p class="hint" id="set-mode">${(s.apiBase || CONFIG.API_BASE) ? '' : 'No server configured — the app runs in <b>Demo mode</b> and keeps surveys only on this device.'}</p>
        <p class="hint" id="set-msg"></p>
      </div>
      <div class="dlg-foot">
        <button type="button" class="btn" id="set-test">${esc(t('Test connection'))}</button><span class="spacer"></span>
        <button type="submit" class="btn primary">${esc(t('Save'))}</button>
      </div>
    </form>`;
  dlg.showModal();
  const close = dlg.querySelector('[data-close]'); if (close) close.onclick = () => dlg.close();
  if (firstRun) dlg.addEventListener('cancel', (e) => e.preventDefault(), { once: true });
  const vals = () => ({ name: $('#set-name').value.trim(), apiBase: $('#set-api').value.trim(), key: $('#set-key').value.trim() });
  const test = async () => {
    const v = vals(); const base = v.apiBase || CONFIG.API_BASE;
    if (!base) return 'admin';
    $('#set-msg').textContent = 'Checking…';
    const r = await checkAuth(base, v.key);
    $('#set-msg').innerHTML = `<span class="good">Connected ✓ — role: <b>${esc(r)}</b></span>`;
    return r;
  };
  $('#set-test').onclick = () => test().catch(err => ($('#set-msg').innerHTML = `<span class="bad">${esc(err.message)}</span>`));
  $('#set-form').onsubmit = async (e) => {
    e.preventDefault();
    const v = vals();
    if (!v.name) { $('#set-msg').innerHTML = '<span class="bad">Enter surveyor name</span>'; return; }
    let r = s.role;
    try { r = await test(); }
    catch (err) {
      if (!err.network) { $('#set-msg').innerHTML = `<span class="bad">${esc(err.message)}</span>`; return; }
      // offline: allow saving, verify later
    }
    saveSettings({ ...v, role: r });
    dlg.close();
    toast('Settings saved', 'ok');
    updatePill();
    sync();
    route();
  };
}

init();
