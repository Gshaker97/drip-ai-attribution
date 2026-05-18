# Drip AI Attribution

Scans GoHighLevel's native **Missed Call Text Back** feature for Drip Plumbing and attributes saved leads (those who replied to the AI text) to revenue in HouseCall Pro.

## What it does

1. **Pulls GHL conversations** in the last 30 days
2. **Detects MCTB events** by matching the templated message: *"Hi this is Drip Plumbing, I saw that we just missed your call how can I help?"*
3. **Identifies saved leads** — contacts who replied at least once after the MCTB
4. **Matches them to HCP customers** by normalized phone number (E.164), then email as fallback
5. **Pulls jobs from HCP** in the 30-day attribution window after the MCTB
6. **Splits results** into `new_acquisition` vs `reactivation`
7. **Records first job revenue + flags recurring customers**

## Setup (Railway + GitHub)

### 1. Push this code to GitHub

The repo is `drip-ai-attribution`. Drop these files in and commit.

### 2. Create a Railway project

- New Project → Deploy from GitHub repo → pick `drip-ai-attribution`
- Add a **Postgres database** service to the same project (Railway will auto-link via `DATABASE_URL`)

### 3. Set environment variables

In Railway's Variables tab, set:

| Variable | Value |
|---|---|
| `GHL_PIT_TOKEN` | Your GHL Private Integration token |
| `GHL_LOCATION_ID` | `ZuxPMpWXcEWGJXcAV7MX` |
| `HCP_API_KEY` | Your HouseCall Pro MAX API key |
| `LOCATION_NAME` | `Drip Plumbing` |
| `ATTRIBUTION_WINDOW_DAYS` | `30` |
| `INITIAL_PULL_DAYS` | `30` |
| `AUTO_SYNC_ENABLED` | `true` |
| `AUTO_SYNC_CRON` | `0 3 */3 * *` (every 3 days at 3 AM) |

`DATABASE_URL` is auto-provided by Railway when you attach the Postgres service.

### 4. Deploy

Railway will:
- Run `npm install` automatically (Nixpacks)
- Run `npm start` which boots the server
- The server auto-creates the database schema on first boot
- Schedules the auto-sync cron job

### 5. Run your first sync

Open the Railway-provided URL (something like `https://drip-ai-attribution-production.up.railway.app`) and click **Sync Now**.

The first sync will:
- Pull all HCP customers (~1-2 min depending on count)
- Pull all HCP jobs in the window + buffer
- Scan GHL conversations for MCTB events
- Compute attributions

## How MCTB detection works

The native GHL Missed Call Text Back feature does NOT use a workflow or Conversation AI. It auto-sends an SMS when a call goes unanswered. We detect it by:

- **Outbound SMS**
- **Body matches the rendered template** (`MCTB_TEMPLATE` env var, with `{{location.name}}` substituted)
- **Regex allows for the GHL-appended "Reply STOP to unsubscribe" compliance line**

If Drip ever changes the template in GHL Settings → Phone System → Missed Call Text Back, update the `MCTB_TEMPLATE` env var to match exactly.

## Customer matching logic

1. **Primary**: GHL contact phone → HCP customer phone or mobile_number (normalized to E.164)
2. **Fallback**: GHL contact email → HCP customer email (case-insensitive)
3. **Confidence**: phone = high, email = medium

## Attribution classification

- **new_acquisition**: HCP customer was created AFTER the MCTB was sent (or up to 7 days before, to allow for the office creating the contact during the initial call attempt)
- **reactivation**: HCP customer existed >7 days before the MCTB

## Local dev (optional)

```bash
cp .env.example .env
# edit .env with real values + a local DATABASE_URL
npm install
npm run init-db
npm start
```

Visit `http://localhost:3000`.

## Manual sync from CLI (Railway shell)

```bash
npm run sync
```

## API endpoints

- `GET /api/summary` — top-line metrics
- `GET /api/attributions` — detailed attributed leads
- `GET /api/mctb-events` — all MCTB events (whether attributed or not)
- `POST /api/sync` — trigger manual sync
- `GET /api/sync-runs` — recent sync history
- `GET /health` — Railway healthcheck

## File structure

```
src/
  server.js              # Express server + cron scheduler
  routes/api.js          # REST API
  jobs/sync.js           # Main sync orchestrator
  connectors/
    ghl.js               # GHL API client
    hcp.js               # HouseCall Pro API client
  lib/
    mctb.js              # Detects the missed-call text-back message
    matching.js          # GHL contact → HCP customer matching
    phone.js             # E.164 phone normalization
  db/
    init.js              # Schema definitions
    pool.js              # PG pool
public/
  index.html             # Dashboard
  app.js                 # Dashboard JS
  styles.css             # Dashboard CSS
```
