// notion-proxy-worker.js — Cloudflare Worker that proxies Notion API reads.
// Browser fetch to api.notion.com is blocked by CORS; this worker runs at the
// edge and forwards requests using the NOTION_TOKEN secret.
//
// Routes:
//   GET /notion/cache?pageId=<id>  — reads children blocks of a Notion page,
//     finds the JSON code block written by nightlySummary.js, and returns it.
//
// Deploy: cd workers && npx wrangler deploy --config wrangler-notion-proxy.toml
// Secret: npx wrangler secret put NOTION_TOKEN --name notion-proxy

const ALLOWED_ORIGINS = [
  'https://portal.businesssmoothie.com',
  'https://myportal.businesssmoothie.com',
  'https://businesssmoothie-portal.pages.dev',
];

const NOTION_VERSION = '2022-06-28';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    const cors = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405, cors);
    }

    const url = new URL(request.url);

    if (!env.NOTION_TOKEN) {
      return json({ error: 'NOTION_TOKEN secret not configured on worker' }, 500, cors);
    }

    if (url.pathname === '/notion/cache') {
      const pageId = url.searchParams.get('pageId');
      if (!pageId) return json({ error: 'pageId query param required' }, 400, cors);

      const notionRes = await fetch(
        `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`,
        {
          headers: {
            'Authorization': `Bearer ${env.NOTION_TOKEN}`,
            'Notion-Version': NOTION_VERSION,
          },
        }
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

    return json({ error: 'Not found', path: url.pathname }, 404, cors);
  },
};

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
