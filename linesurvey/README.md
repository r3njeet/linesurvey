# Line Survey — 33 kV / 11 kV / LT line patrol app

A mobile-first web app (installable PWA) for surveying electric lines and recording irregularities with
geotagged photographs, material requirements, a progress dashboard, and one-page-per-survey PDF reports.

**Architecture: GitHub + Cloudflare R2**

```
 Phone / PC browser                GitHub                         Cloudflare
┌───────────────────┐   HTTPS   ┌──────────────────┐         ┌──────────────────────────────┐
│ Web app (PWA)     │◄──────────│ GitHub Pages      │         │ Worker  /api/*               │
│  Survey           │           │  (web/ folder)    │         │  • validates surveys          │
│  Dashboard        │──────────────────────────────────────►  │  • stores photos + records    │
│  Report (PDF/CSV) │  fetch + X-Access-Key                   │        │                     │
│  offline outbox   │           │ GitHub Actions ───┼─deploy─►│        ▼                     │
└───────────────────┘           └──────────────────┘         │  R2 bucket "line-survey"      │
                                                              │   photos/YYYY-MM/<id>/n.jpg   │
                                                              │   surveys/<id>.json           │
                                                              │   index/surveys.json          │
                                                              └──────────────────────────────┘
```

* **GitHub** holds the code, hosts the web app on **GitHub Pages**, and **GitHub Actions** deploys both the
  web app and the API automatically on every push to `main`.
* **Cloudflare R2** stores the photographs and survey records. A small **Cloudflare Worker** sits in front of
  R2 so your R2 credentials never reach the phones, and so every submission is validated server-side.

---

## Features

**Survey tab**
1. Select **Subdivision → Substation → Feeder** (from the `SUBSTATION` sheet). Photos are locked until all three are selected. The last selection is remembered, so a surveyor walking one feeder doesn't re-select it every time.
2. Tick the irregularities. Items that depend on line voltage ask for 33 kV / 11 kV / LT:
   Tilted, Dilapidated, Rusted, Broken Pole · Sagged Line {33/11/LT} · House/Construction Under Line {33/11/LT} · Long Span Line ·
   Low Ground Clearance {33/11/LT} · Road/Canal/River Crossing · GI Wire Line {11/LT} · Too Many Joints In Span {33/11/LT} ·
   Damage AB Cable · Damage Pin Insulator {33/11} · Damage Disc {33/11} · Other (free text).
3. Take **at least 2 photographs** (max 6) with the rear camera. **GPS is captured automatically** for every photo, and
   feeder, lat/long ±accuracy, date-time and surveyor name are burnt into the photo itself.
4. Enter **Location** and **Landmark** (Hindi is fine) plus optional remarks.
5. **Material required?** Yes/No. If Yes, enter quantities:
   Pole (PCC 8.5/9/11 m, STP 9/11/13 m from the `POLE` sheet) in Nos, Conductor ACSR Weasel/Rabbit/Dog in metres,
   Pin Insulator 33/11 kV in Nos, Disc Insulator 33/11 kV in Nos, LT AB Cable 1X16 / 3X50 / 3X95 / 3X120 sqmm in metres.
6. **Submit.** Each survey gets a running number (`LS-00001`, …). **No network? No problem.** The survey is saved on the phone
   and uploads automatically when the connection returns (the header shows "Offline · n pending").

**Dashboard tab:** survey count, irregularities found, locations needing material, feeder coverage (x/75);
findings by irregularity (with voltage split); total material required; daily progress; progress by substation;
map of survey points; surveyor-wise count. Everything can be filtered by subdivision, substation, feeder and date.

**Report tab:** filter by hierarchy, date, irregularity, material yes/no or free-text search. Then:
* **PDF** on any row gives a single-survey, single-page PDF.
* **Select several (or Select all)** and click **Download PDF** to get one PDF with one page per survey.
  Each page has the details, irregularities, all photographs with GPS captions, the material table and a clickable Google Maps link.
* **Export Excel (CSV)** gives one row per survey with one column per material item (selected rows only, or all rows if none are selected).
* Tap a survey to see its details and photos. Admins can **delete** a survey (its photos are removed from R2 as well).

---

## Setup (about 20 minutes, one time)

### 1. Put the code on GitHub
Create a new repository (private is fine) and push this folder to the `main` branch.

### 2. Cloudflare: R2 bucket + API token
1. Sign up or log in at <https://dash.cloudflare.com>, open **R2** and enable it (the free tier includes 10 GB of storage).
2. Create a bucket named **`line-survey`**. If you use a different name, change `bucket_name` in `worker/wrangler.toml`.
3. **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template**, and add the permission
   *Account → Workers R2 Storage → Edit*. Copy the token.
4. Copy your **Account ID** from the right sidebar of the Workers & Pages overview page.

### 3. GitHub repository secrets
**Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | token from step 2.3 |
| `CLOUDFLARE_ACCOUNT_ID` | account id from step 2.4 |
| `SURVEY_KEY` | access key for surveyors (make up a strong one, e.g. 16+ characters) |
| `ADMIN_KEY` | different, stronger key for supervisors (allows delete) |

### 4. Deploy the API
**Actions → "Deploy API (Cloudflare Worker + R2)" → Run workflow.** When it finishes, the log shows the Worker URL,
e.g. `https://line-survey-api.<your-subdomain>.workers.dev`. Check it by opening `<URL>/api/health`.

### 5. Deploy the web app
1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. **Settings → Secrets and variables → Actions → Variables → New variable** `API_BASE` = the Worker URL from step 4.
3. **Actions → "Deploy web app to GitHub Pages" → Run workflow.** The app will be live at `https://<user>.github.io/<repo>/`.
4. (Recommended) In `worker/wrangler.toml` set `ALLOWED_ORIGINS = "https://<user>.github.io"` and push, so only your app can call the API.

### 6. On each phone
Open the Pages URL in Chrome, then use **⋮ → Add to Home screen**. On first launch, enter the surveyor's name, mobile and the
**access key** (`SURVEY_KEY`, or `ADMIN_KEY` for supervisors), tap **Test connection**, then **Save**. Allow **Camera** and **Location** when asked.

> Without a server URL the app runs in **Demo mode**, which stores everything only on that device. It's handy for training.

---

## Updating master data (substations / feeders / poles)
Edit the Excel file (same sheet & column names), then run:
```bash
pip install openpyxl
python3 tools/xlsx_to_masters.py tools/Substation_And_Material.xlsx
git commit -am "Update masters" && git push
```
This regenerates `web/js/masters.js`. Both workflows re-run, so the app and the server-side validation stay in sync.

## Local development
```bash
cd worker && cp .dev.vars.example .dev.vars && npm install && npx wrangler dev   # API on :8787 with local R2
cd web && python3 -m http.server 8080                                              # app on :8080
```
Open <http://localhost:8080>, then in ⚙ Settings use server `http://127.0.0.1:8787` and key `admin123`.
(Geolocation and the camera need `localhost` or HTTPS.)

## API reference (Worker)
All endpoints except `/api/health` need header `X-Access-Key: <SURVEY_KEY|ADMIN_KEY>`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | liveness |
| GET | `/api/auth` | returns `{role: "surveyor" \| "admin"}` |
| GET | `/api/surveys` | all survey records (JSON) |
| POST | `/api/surveys` | multipart: `data` (JSON) + `photo_0…photo_5` (JPEG). Idempotent on survey `id` |
| GET | `/api/photo?key=photos/...jpg` | photo bytes |
| DELETE | `/api/surveys/:id` | admin: delete a survey and its photos |
| POST | `/api/admin/rebuild-index` | admin: rebuild `index/surveys.json` from `surveys/*.json` |

**Data safety:** every survey is stored as its own JSON file (`surveys/<id>.json`). The combined `index/surveys.json`, used for fast
dashboard loading, is updated with an R2 conditional write (ETag), so simultaneous submissions from many surveyors never overwrite
each other. It can be rebuilt at any time with the admin endpoint.

## Project layout
```
web/                    static PWA (GitHub Pages)
  index.html  sw.js  manifest.webmanifest  css/app.css  icons/
  js/config.js          API_BASE + titles
  js/masters.js         generated from Excel (SUBSTATION + POLE sheets)
  js/catalog.js         irregularities, material catalogue, validation (shared with Worker)
  js/survey.js          survey form, GPS, photo stamping
  js/dashboard.js       dashboard
  js/report.js          report list, PDF and CSV generation
  js/api.js, db.js      server calls, offline outbox (IndexedDB)
worker/                 Cloudflare Worker (R2 storage API)
tools/                  Excel → masters.js converter + source Excel
.github/workflows/      auto-deploy Pages + Worker
```

## Notes
* Photos are resized to 1600 px JPEG (~250–400 KB) before upload to save mobile data and R2 space.
  10 GB of free R2 storage holds roughly 8,000–10,000 surveys with 3 photos each.
* The camera input asks for the rear camera directly (`capture="environment"`), so surveyors take fresh photos rather than picking old ones from the gallery.
* When you deploy changes, GitHub Actions stamps a new service-worker version so phones pick up the update on their next launch.
