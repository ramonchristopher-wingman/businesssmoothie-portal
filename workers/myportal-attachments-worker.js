// MyPortal Attachments Worker
// Handles R2 file upload, retrieval, and deletion for myportal.businesssmoothie.com

const ALLOWED_ORIGINS = [
  'https://myportal.businesssmoothie.com',
  'https://portal.businesssmoothie.com',
];

const ALLOWED_EXT = new Set(['pdf','doc','docx','xls','xlsx','png','jpg','jpeg','gif','zip']);
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    const cors = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === '/upload' && request.method === 'POST') {
        return await handleUpload(request, env, cors);
      }
      if (url.pathname === '/file' && request.method === 'GET') {
        return await handleGetFile(request, env, cors);
      }
      if (url.pathname === '/file' && request.method === 'DELETE') {
        return await handleDeleteFile(request, env, cors);
      }
      return json({ error: 'Not found' }, 404, cors);
    } catch (err) {
      console.error(err);
      return json({ error: err.message }, 500, cors);
    }
  },
};

async function handleUpload(request, env, cors) {
  const form = await request.formData();
  const file = form.get('file');
  const orgId = form.get('orgId') || '';
  const contextType = form.get('contextType') || 'task';
  const contextId = form.get('contextId') || '';
  const uploaderName = form.get('uploaderName') || 'Admin';

  if (!file || !(file instanceof File)) return json({ error: 'No file provided' }, 400, cors);
  if (!orgId) return json({ error: 'orgId is required' }, 400, cors);
  if (!contextId) return json({ error: 'contextId is required' }, 400, cors);
  if (file.size > MAX_BYTES) return json({ error: 'File exceeds 10 MB limit' }, 400, cors);

  const ext = file.name.split('.').pop().toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return json({ error: `File type .${ext} is not supported` }, 400, cors);
  }

  const safeName = file.name.replace(/[^\w.\-]/g, '_');
  const key = `clients/${orgId}/${contextType}/${contextId}/${Date.now()}-${safeName}`;

  await env.R2.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
    customMetadata: { uploadedBy: uploaderName, orgId, contextType, contextId },
  });

  return json({
    success: true,
    path: key,
    filename: file.name,
    size: file.size,
    uploadedBy: uploaderName,
    uploadedAt: new Date().toISOString(),
  }, 200, cors);
}

async function handleGetFile(request, env, cors) {
  const url = new URL(request.url);
  const key = url.searchParams.get('path');
  if (!key) return json({ error: 'path parameter required' }, 400, cors);

  const obj = await env.R2.get(key);
  if (!obj) return json({ error: 'File not found' }, 404, cors);

  // Stream the file through the Worker (Worker is the secure access layer;
  // files are private in R2 and only reachable via this endpoint).
  const headers = new Headers(cors);
  obj.writeHttpMetadata(headers);
  const rawName = key.split('/').pop().replace(/^\d+-/, '');
  headers.set('Content-Disposition', `inline; filename="${rawName}"`);
  headers.set('Cache-Control', 'private, max-age=3600');

  return new Response(obj.body, { headers });
}

async function handleDeleteFile(request, env, cors) {
  const url = new URL(request.url);
  const key = url.searchParams.get('path');
  if (!key) return json({ error: 'path parameter required' }, 400, cors);

  await env.R2.delete(key);
  return json({ success: true }, 200, cors);
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
