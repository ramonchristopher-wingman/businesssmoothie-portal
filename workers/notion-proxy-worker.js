// notion-proxy-worker.js — Cloudflare Worker that proxies Notion API reads (and one
// append-only write) so the Portal (browser) can talk to Notion despite CORS blocking
// direct browser -> api.notion.com calls.
//
// Routes:
//   GET  /notion/cache?pageId=<id>            — Cockpit tab (BB-005): reads the JSON
//     cache code block written by nightlySummary.js.
//   GET  /notion/clients?visibility=Active     — Clients tab (BB-032): queries the
//     Entities DB for Type=Company, Status in [Active Client, Prospect], filtered by
//     Visibility (comma-separated list, default "Active").
//   GET  /notion/page?pageId=<id or Client Brain URL> — Clients tab (BB-032): recursively
//     fetches a page's block tree (tables/toggles included) for client-side rendering.
//   POST /api/scratchpad-append  body: {pageId, text} — Clients tab (BB-032): appends one
//     timestamped paragraph block immediately after the "Scratch Pad" heading on a
//     client's Client Brain page. Top-level search only, never recurses, never edits or
//     deletes existing blocks — pure append to avoid read-modify-write version conflicts
//     with concurrent edits made directly in Notion.
//
// Deploy: cd workers && npx wrangler deploy --config wrangler-notion-proxy.toml
// Secret: npx wrangler secret put NOTION_TOKEN --name notion-proxy

const ALLOWED_ORIGINS = [
  'https://portal.businesssmoothie.com',
  'https://myportal.businesssmoothie.com',
  'https://businesssmoothie-portal.pages.dev',
];

const NOTION_VERSION = '2022-06-28';
const ENTITIES_DB_ID = 'db150108-b987-4069-b77b-3ec7d76544db';
const MAX_BLOCK_DEPTH = 3;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    const cors = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    if (!env.NOTION_TOKEN) {
      return json({ error: 'NOTION_TOKEN secret not configured on worker' }, 500, cors);
    }

    if (url.pathname === '/api/scratchpad-append' && request.method === 'POST') {
      return handleScratchpadAppend(request, env, cors);
    }

    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405, cors);
    }

    if (url.pathname === '/notion/cache') {
      return handleCache(url, env, cors);
    }

    if (url.pathname === '/notion/clients') {
      return handleClients(url, env, cors);
    }

    if (url.pathname === '/notion/page') {
      return handlePage(url, env, cors);
    }

    return json({ error: 'Not found', path: url.pathname }, 404, cors);
  },
};

// ── /notion/cache (BB-005) ────────────────────────────────────────────────────
async function handleCache(url, env, cors) {
  const pageId = url.searchParams.get('pageId');
  if (!pageId) return json({ error: 'pageId query param required' }, 400, cors);

  const notionRes = await fetch(
    `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`,
    { headers: notionHeaders(env) }
  );

  if (!notionRes.ok) {
    const text = await notionRes.text();
    return json({ error: `Notion API ${notionRes.status}`, detail: text.slice(0, 400) }, notionRes.status, cors);
  }

  const data = await notionRes.json();
  const blocks = data.results || [];

  const cacheBlock = blocks.find(b => {
    if (b.type !== 'code') return false;
    const text = (b.code?.rich_text || []).map(r => r.plain_text).join('');
    return text.includes('"yesterday"') || text.includes('"brief"') || text.includes('"last_session"');
  });

  if (!cacheBlock) {
    return json({ error: 'No cache block found in page', blockCount: blocks.length }, 404, cors);
  }

  const rawText = (cacheBlock.code?.rich_text || []).map(r => r.plain_text).join('');
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    return json({ error: 'Cache JSON parse failed', raw: rawText.slice(0, 500) }, 500, cors);
  }

  return json(parsed, 200, cors);
}

// ── /notion/clients (BB-032) ──────────────────────────────────────────────────
async function handleClients(url, env, cors) {
  const visParam = (url.searchParams.get('visibility') || 'Active').toLowerCase();
  const allowedVis = ['active', 'snoozed', 'archived'];
  const visList = visParam.split(',').map(v => v.trim()).filter(v => allowedVis.includes(v));
  const visibilities = (visList.length ? visList : ['active']).map(v => v[0].toUpperCase() + v.slice(1));

  const filter = {
    and: [
      { property: 'Type', select: { equals: 'Company' } },
      {
        or: [
          { property: 'Status', select: { equals: 'Active Client' } },
          { property: 'Status', select: { equals: 'Prospect' } },
        ],
      },
      {
        or: visibilities.map(v => ({ property: 'Visibility', select: { equals: v } })),
      },
    ],
  };

  let results = [];
  let cursor;
  let pages = 0;
  do {
    const body = { filter, sorts: [{ property: 'Company Name', direction: 'ascending' }], page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const notionRes = await fetch(`https://api.notion.com/v1/databases/${ENTITIES_DB_ID}/query`, {
      method: 'POST',
      headers: { ...notionHeaders(env), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!notionRes.ok) {
      const text = await notionRes.text();
      return json({ error: `Notion API ${notionRes.status}`, detail: text.slice(0, 400) }, notionRes.status, cors);
    }

    const data = await notionRes.json();
    results = results.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : null;
    pages += 1;
  } while (cursor && pages < 10);

  const clients = results.map(page => {
    const props = page.properties || {};
    return {
      id: page.id,
      name: props['Company Name']?.title?.map(t => t.plain_text).join('') || 'Untitled',
      status: props['Status']?.select?.name || null,
      visibility: props['Visibility']?.select?.name || null,
      plan: props['Plan']?.select?.name || null,
      clientBrainUrl: props['Client Brain']?.url || null,
    };
  });

  return json({ clients }, 200, cors);
}

// ── /notion/page (BB-032) ─────────────────────────────────────────────────────
async function handlePage(url, env, cors) {
  const pageId = normalizeNotionId(url.searchParams.get('pageId'));
  if (!pageId) return json({ error: 'pageId query param required (raw ID or Notion URL)' }, 400, cors);

  try {
    const blocks = await fetchBlockChildren(pageId, env, 0);
    return json({ pageId, blocks }, 200, cors);
  } catch (e) {
    return json({ error: e.message }, 502, cors);
  }
}

async function fetchBlockChildren(blockId, env, depth) {
  const results = [];
  let cursor;
  do {
    const qs = cursor ? `&start_cursor=${cursor}` : '';
    const res = await fetch(
      `https://api.notion.com/v1/blocks/${blockId}/children?page_size=100${qs}`,
      { headers: notionHeaders(env) }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Notion API ${res.status} fetching children of ${blockId}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    for (const block of data.results || []) {
      if (block.has_children && depth < MAX_BLOCK_DEPTH) {
        block.children = await fetchBlockChildren(block.id, env, depth + 1);
      }
      results.push(block);
    }
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return results;
}

// ── /api/scratchpad-append (BB-032) ───────────────────────────────────────────
async function handleScratchpadAppend(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Invalid JSON body' }, 400, cors);
  }

  const pageId = normalizeNotionId(body.pageId);
  const text = (body.text || '').trim();
  if (!pageId) return json({ error: 'pageId required (raw ID or Notion URL)' }, 400, cors);
  if (!text) return json({ error: 'text required' }, 400, cors);

  // Top-level search only — never recurse into nested blocks.
  let headingBlockId = null;
  let cursor;
  do {
    const qs = cursor ? `&start_cursor=${cursor}` : '';
    const res = await fetch(
      `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100${qs}`,
      { headers: notionHeaders(env) }
    );
    if (!res.ok) {
      const errText = await res.text();
      return json({ error: `Notion API ${res.status}`, detail: errText.slice(0, 400) }, res.status, cors);
    }
    const data = await res.json();
    for (const block of data.results || []) {
      if (block.type === 'heading_2') {
        const t = (block.heading_2?.rich_text || []).map(r => r.plain_text).join('');
        const cleaned = t.replace(/[^\x00-\x7F]/g, '').trim().toLowerCase();
        if (cleaned === 'scratch pad') {
          headingBlockId = block.id;
          break;
        }
      }
    }
    cursor = headingBlockId ? null : (data.has_more ? data.next_cursor : null);
  } while (cursor);

  if (!headingBlockId) {
    return json({ error: "Couldn't locate Scratch Pad section — add directly in Notion" }, 404, cors);
  }

  const entryText = `[${ctTimestamp()}] — ${text}`;

  const appendRes = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
    method: 'PATCH',
    headers: { ...notionHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      after: headingBlockId,
      children: [
        {
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [{ type: 'text', text: { content: entryText } }] },
        },
      ],
    }),
  });

  if (!appendRes.ok) {
    const errText = await appendRes.text();
    return json({ error: `Notion API ${appendRes.status}`, detail: errText.slice(0, 400) }, appendRes.status, cors);
  }

  return json({ success: true, entry: entryText }, 200, cors);
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function notionHeaders(env) {
  return {
    'Authorization': `Bearer ${env.NOTION_TOKEN}`,
    'Notion-Version': NOTION_VERSION,
  };
}

function ctTimestamp() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} CT`;
}

function normalizeNotionId(input) {
  if (!input) return null;
  const dashed = input.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (dashed) return dashed[0];
  const hex = input.replace(/-/g, '').match(/[0-9a-f]{32}/i);
  if (!hex) return null;
  const h = hex[0];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
