# businesssmoothie-portal

Ramon's internal ops cockpit for Business Smoothie. Three-tab single-page app:

- **Cockpit** — daily snapshot pulled from Notion Brief Cache (tasks, projects, clients, last session)
- **Resources** — all platform links, IDs, contacts, booking links
- **Ops Map** — visual diagram of the full BS system (entities → platforms → infrastructure)

## Deploy

Push to `main` → Cloudflare Pages auto-deploys to [portal.businesssmoothie.com](https://portal.businesssmoothie.com).

No build step. Single file: `index.html`.

## Notion cache

The Cockpit tab reads from the Notion Brief Cache page via a Cloudflare Worker proxy (CORS bypass). Cache is written nightly at 3am CT by `scripts/nightlySummary.js` and on-demand via `scripts/triggerBriefCache.js`.

**To refresh the cache manually:**
```bash
cd /path/to/businesssmoothie
node scripts/triggerBriefCache.js
```

## Notion proxy worker

Worker: `workers/notion-proxy-worker.js`  
Deployed at: `https://notion-proxy.summer-mouse-2464.workers.dev`  
Config: `workers/wrangler-notion-proxy.toml`  
Secret required: `NOTION_TOKEN` (set via `npx wrangler secret put NOTION_TOKEN --name notion-proxy`)

To redeploy:
```bash
cd workers
npx wrangler deploy --config wrangler-notion-proxy.toml
```

## Auth

Cloudflare Access protects this domain — configure manually after deploy:
- Dashboard → Access → Applications → Add `portal.businesssmoothie.com`
- Allow: ramon.christopher@gmail.com, admin@smoothiesystems.com, ethemanifestor@gmail.com
- Auth method: Google OAuth

## Other files

| Path | Purpose |
|------|---------|
| `ghl-sync/` | Apps Script — GHL→Notion daily sync (runs 7am CT, separate from portal) |
| `appscript/` | Apps Script — legacy portal backend |
| `workers/` | Cloudflare Workers edge scripts |
