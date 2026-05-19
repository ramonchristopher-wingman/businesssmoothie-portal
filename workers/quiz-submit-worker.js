/**
 * Quiz Submit Worker — Cloudflare Worker
 *
 * Receives a POST from quiz/index.html, upserts the contact
 * in GHL, and applies quiz result tags.
 *
 * Required environment variable (set in Cloudflare Workers dashboard):
 *   GHL_API_KEY — GHL Private Integration Token
 *
 * Expected POST body:
 * {
 *   "firstName": "Jane",
 *   "email":     "jane@example.com",
 *   "planTag":   "quiz-match-solo",
 *   "planName":  "Business Smoothie — Solo"
 * }
 *
 * Deploy:
 *   cd workers && npx wrangler deploy --config wrangler-quiz.toml
 * Then set secret:
 *   npx wrangler secret put GHL_API_KEY --config wrangler-quiz.toml
 */

const LOCATION_ID = 'vawIXBjgzYfIQJECet2z';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

addEventListener('fetch', function(event) {
  event.respondWith(handle(event.request));
});

async function handle(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  let body;
  try { body = await request.json(); }
  catch (e) { return new Response('Invalid JSON', { status: 400, headers: CORS }); }

  const { firstName, email, planTag, planName } = body;
  if (!email) return new Response('Email required', { status: 400, headers: CORS });

  const tags = ['quiz-completed'];
  if (planTag) tags.push(planTag);

  const payload = {
    firstName:  firstName || '',
    email:      email,
    locationId: LOCATION_ID,
    tags:       tags
  };

  if (planName) {
    payload.customFields = [{ key: 'quiz_recommended_plan', field_value: planName }];
  }

  try {
    const res = await fetch('https://services.leadconnectorhq.com/contacts/upsert', {
      method:  'POST',
      headers: {
        'Authorization': 'Bearer ' + GHL_API_KEY,
        'Content-Type':  'application/json',
        'Version':       '2021-07-28'
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) console.error('GHL error ' + res.status + ':', await res.text());
  } catch (e) {
    console.error('GHL fetch error:', e.message);
  }

  return new Response(JSON.stringify({ success: true }), {
    status:  200,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}
