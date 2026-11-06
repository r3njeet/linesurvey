// ─── Deployment configuration ────────────────────────────────────────────────
// API_BASE: URL of your Cloudflare Worker, e.g. "https://line-survey-api.<account>.workers.dev".
// Leave it empty to run in DEMO mode (everything is stored only on this device).
// Each user can also override it from the ⚙ Settings screen.
export const CONFIG = {
  API_BASE: '',
  APP_TITLE: 'Line Survey',
  ORG_NAME: 'Electricity Distribution — Line Patrol Survey',
};
