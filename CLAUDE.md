# businesssmoothie-portal — Claude Workspace

## What this repo is

Frontend source for the Business Smoothie client portal. Deploys automatically to Cloudflare Pages on every push to `main`. **This is a code-only repo** — no ops scripts, no session logging, no automations. All of that lives in the `businesssmoothie` repo.

## Live URLs

| Environment | URL |
|-------------|-----|
| Production | `myportal.businesssmoothie.com` / `portal.businesssmoothie.com` |
| Staging | `businesssmoothie-portal.pages.dev` |

## Stack

- Vanilla HTML/JS/CSS — no build step
- Cloudflare Pages (static hosting + auto-deploy from GitHub)
- Cloudflare Workers (`workers/`) for edge logic
- Service Worker (`sw.js`, `firebase-messaging-sw.js`) for offline + push notifications
- `wrangler.jsonc` — Cloudflare config

## Directory Layout

| Path | Purpose |
|------|---------|
| `index.html` | Portal shell |
| `workers/` | Cloudflare Workers edge scripts |
| `appscript/` | Apps Script files — **portal backend only** (`Code.gs`). Managed via clasp. |
| `ghl-sync/` | Apps Script project for GHL→Notion daily sync. Separate clasp project. |
| `assets/`, `icons/`, `images/` | Static assets |
| `quiz/` | Where Do We Begin? quiz |
| `mix-report/`, `tryout/` | Feature experiments |

## Apps Script — Portal Backend (`appscript/`)

- Sheet: MyPortal Data Sheet (`1UgVcQPbMI4cp6I1AvV7r1W_xBFb9rcAhhCPQa6f3Cmg`)
- clasp script ID: `1brXvPJENZv78Y0ghH39m1Y6ZnRNNi3xTo3JVCR81fFoRtjzRxcLB-yrh`
- Push: `cd appscript && clasp push --force`
- Deployed as web app (Execute as: Me, Who: Anyone)

## Apps Script — GHL→Notion Sync (`ghl-sync/`)

- Script: `syncGhlToNotion.gs`
- clasp script ID: `1aWrHRgRZOLc0qDOH-JlzD8ZOfMIdGVFeHpdsdBUmjsNeIoYtgTxx-36l`
- Push: `cd ghl-sync && clasp push --force`
- Runs daily at 7am CT via Apps Script trigger (self-installs on first run)
- GHL OAuth token stored in Script Properties — see businesssmoothie/CLAUDE.md for full setup notes
- On-demand trigger: `node businesssmoothie/scripts/triggerSync.js`
- Web app (versioned, v6): `AKfycbxWkQbKo85w_KtpWz3shB0nQRpuEmuAr03Jn-I7-9aDuFXfJGI-jrdkHkj-l7fXwMzd`
- Webhook secret stored in `~/.ghl-sync-secret`; Script Property `SYNC_WEBHOOK_SECRET`
- After pushing new code, create a new versioned deployment and update `WEBHOOK_URL` in `triggerSync.js`

## Deployment

Push to `main` → Cloudflare Pages auto-builds and deploys. No build command needed (static site).

Admin key: `Custom1234!`
