/**
 * Quiz Submit Worker — Cloudflare Worker
 *
 * 1. Upserts GHL contact with quiz plan tag
 * 2. Calls Claude API to generate personalized email sections
 * 3. Builds HTML results email and sends it directly via GHL conversations API
 *
 * Required environment variables (Cloudflare Workers dashboard):
 *   GHL_API_KEY       — GHL Private Integration Token
 *   ANTHROPIC_API_KEY — Anthropic API key
 *
 * Deploy:
 *   cd workers && npx wrangler deploy --config wrangler-quiz.toml
 * Set secrets:
 *   npx wrangler secret put GHL_API_KEY --config wrangler-quiz.toml
 *   npx wrangler secret put ANTHROPIC_API_KEY --config wrangler-quiz.toml
 */

const LOCATION_ID = 'vawIXBjgzYfIQJECet2z';
const EMAIL_FROM  = 'info@businesssmoothie.com'; // must be a verified sending address in GHL

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const PLAN_NAMES = {
  splash:     'Business Smoothie — Splash',
  lite:       'Business Smoothie — Lite',
  solo:       'Business Smoothie — Solo',
  team:       'Business Smoothie — Team',
  enterprise: 'Business Smoothie — Enterprise'
};

const PLAN_BULLETS = {
  splash: [
    'One focused tool — you choose the piece that matters most right now',
    'Runs from day one with no setup overhead',
    'Fully integrated with the rest of the platform when you are ready to grow',
    'Complete on its own — not a trial, not a starter version'
  ],
  lite: [
    'Business AI — answers calls, texts, and messages so you never miss a lead',
    'Smart Website — professional, fast, and connected to your CRM from day one',
    'Integrated CRM — every contact captured, every conversation tracked',
    'One platform, one login, running your foundation from day one'
  ],
  solo: [
    'Business AI, Smart Website, and Integrated CRM — your full foundation',
    'Automations and Funnels — your follow-up and lead flow, running without you',
    'Digital Freedom Phone, Integrated Social Media, and Reputation Management',
    'Reporting Dashboard — see exactly what is happening in your business'
  ],
  team: [
    'The complete Business Smoothie platform — every tool, for up to 8 users',
    'Business AI running across the entire team — calls, messages, follow-up, reviews',
    'Everyone on the same system — no silos, no dropped leads, no missed handoffs',
    'Built for teams of 3 to 8 who need to operate as one'
  ],
  enterprise: [
    'The complete Business Smoothie platform at full scale — up to 50 users',
    'Business AI running across every team and every location',
    'Built for larger teams, multi-location operations, and real volume',
    'Infrastructure that matches what you are actually running'
  ]
};

const CLAUDE_SYSTEM =
  'You write personalized results emails for people who just completed the Business Smoothie Biz Quiz. ' +
  'Business Smoothie is a complete business operations system. Most businesses need a system they can ' +
  'trust that runs without them babysitting it. That is the message — not a feature breakdown, not an AI pitch.\n\n' +

  'The plan recommendations have already been determined by the quiz logic and are passed to you as ' +
  'fixed inputs. Do not change or second-guess them. Write like a knowledgeable advisor who reviewed ' +
  'their answers and has a clear point of view — not a sales page.\n\n' +

  'Write in second person — "you" and "your business." Direct, warm, confident. No hype. ' +
  'No exclamation marks. Do not explain what AI does at length. ' +
  'Business Smoothie is the system. AI is part of it. Neither needs to be explained — just trusted.\n\n' +

  'The plan match should feel like a colleague saying "based on what you told us, this is the right fit." ' +
  'Confident. Warm. Done.\n\n' +

  'FORMAT RULES — follow exactly:\n' +
  '- whatWeHeard: array of exactly 3 bullet strings. Personal, specific to their answers. No product mentions.\n' +
  '- whatYouNeed: array of exactly 3 bullet strings. Outcomes only — what their business operation should look like. Tight. 1 sentence each.\n' +
  '- whatWeCanDo: a single paragraph, 2-3 sentences max. Do NOT mention the plan name — the email already names it. ' +
  'Focus entirely on what changes for their business: their specific situation, the friction that goes away, the outcome they get. ' +
  'Benefits-focused, advisor tone. Do not list features. Be direct.\n' +
  '- The reader should be able to scan the full email in under 60 seconds.\n\n' +

  'Return ONLY a JSON object with no markdown, no backticks, no preamble. Exactly this structure:\n' +
  '{\n' +
  '  "whatWeHeard": ["bullet 1", "bullet 2", "bullet 3"],\n' +
  '  "whatYouNeed": ["bullet 1", "bullet 2", "bullet 3"],\n' +
  '  "whatWeCanDo": "2-3 sentence paragraph specific to their situation."\n' +
  '}';

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

  const {
    firstName, email,
    planTag, planName,
    whatWeHeard, bigIssue, recommendation, howBSFits,
    secondaryPlan
  } = body;

  console.log('[1] Incoming payload — firstName:', firstName, '| email:', email, '| planTag:', planTag, '| planName:', planName, '| whatWeHeard length:', (whatWeHeard || '').length, '| bigIssue length:', (bigIssue || '').length);

  if (!email) return new Response('Email required', { status: 400, headers: CORS });

  const recommendedKey  = planTag ? planTag.replace('quiz-match-', '') : null;
  const displayPlanName = planName || (recommendedKey && PLAN_NAMES[recommendedKey]) || '';

  const tags = [];
  if (planTag) tags.push(planTag);

  const upsertPayload = {
    firstName:  firstName || '',
    email:      email,
    locationId: LOCATION_ID,
    tags:       tags
  };

  // ── STEP 1: GHL contact upsert ────────────────────────────────────────────
  let contactId = null;
  try {
    const upsertRes = await fetch('https://services.leadconnectorhq.com/contacts/upsert', {
      method:  'POST',
      headers: {
        'Authorization': 'Bearer ' + GHL_API_KEY,
        'Content-Type':  'application/json',
        'Version':       '2021-07-28'
      },
      body: JSON.stringify(upsertPayload)
    });
    if (upsertRes.ok) {
      const upsertData = await upsertRes.json();
      contactId = (upsertData.contact && upsertData.contact.id) || upsertData.id || null;
      console.log('[2] GHL upsert OK — status:', upsertRes.status, '| contactId:', contactId);
    } else {
      const upsertErr = await upsertRes.text();
      console.error('[2] GHL upsert error — status:', upsertRes.status, '| body:', upsertErr);
    }
  } catch (e) {
    console.error('GHL upsert fetch error:', e.message);
  }

  // ── STEP 2: Claude API — generate email sections ──────────────────────────
  const userMsg = [
    'First name: ' + (firstName || 'there'),
    'Recommended plan: ' + displayPlanName,
    'What we heard (short): ' + (whatWeHeard || ''),
    'Big issue or opportunity (short): ' + (bigIssue || ''),
    'Recommendation (short): ' + (recommendation || ''),
    'How BS fits (short): ' + (howBSFits || ''),
    '',
    'Write the personalized email sections. The plan recommendation is locked — write copy that ' +
    'supports ' + displayPlanName + ' with confidence and specificity.'
  ].join('\n');

  let claude = null;
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 1200,
        system:     CLAUDE_SYSTEM,
        messages:   [{ role: 'user', content: userMsg }]
      })
    });
    if (claudeRes.ok) {
      const claudeData = await claudeRes.json();
      const raw = claudeData.content[0].text.trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '');
      console.log('[3] Claude API OK — status:', claudeRes.status, '| raw length:', raw.length);
      try {
        claude = JSON.parse(raw);
      } catch (pe) {
        console.error('[3] Claude JSON parse error:', pe.message, '| raw:', raw.slice(0, 300));
      }
    } else {
      const claudeErr = await claudeRes.text();
      console.error('[3] Claude API error — status:', claudeRes.status, '| body:', claudeErr);
    }
  } catch (e) {
    console.error('Claude fetch error:', e.message);
  }

  // Fall back to short quiz versions if Claude failed
  const content = claude || {
    whatWeHeard:  whatWeHeard    ? [whatWeHeard]    : [],
    whatYouNeed:  recommendation ? [recommendation] : [],
    whatWeCanDo:  howBSFits      || ''
  };

  // ── STEP 3: Build HTML email ───────────────────────────────────────────────
  const htmlEmail = buildEmail(firstName, recommendedKey, displayPlanName, content);

  // ── STEP 4: Send results email directly via GHL conversations API ─────────
  if (contactId) {
    try {
      const emailRes = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + GHL_API_KEY,
          'Content-Type':  'application/json',
          'Version':       '2021-04-15'
        },
        body: JSON.stringify({
          type:      'Email',
          contactId: contactId,
          emailFrom: EMAIL_FROM,
          subject:   'Your Business Smoothie Full Quiz Results',
          html:      htmlEmail
        })
      });
      if (emailRes.ok) {
        const emailData = await emailRes.json();
        console.log('[4] Email sent OK — status:', emailRes.status, '| messageId:', emailData.messageId || emailData.id || '(none)');
      } else {
        const emailErr = await emailRes.text();
        console.error('[4] Email send error — status:', emailRes.status, '| body:', emailErr);
      }
    } catch (e) {
      console.error('[4] Email send fetch error:', e.message);
    }
  } else {
    console.log('[4] No contactId — skipping email send');
  }

  return new Response(JSON.stringify({ success: true }), {
    status:  200,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

/* ── HTML EMAIL BUILDER ───────────────────────────────────────────────────── */

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildEmail(firstName, recommendedKey, planName, content) {
  var name   = esc(firstName || 'there');
  var pName  = esc(planName || (recommendedKey && PLAN_NAMES[recommendedKey]) || '');
  var pShort = recommendedKey
    ? (recommendedKey.charAt(0).toUpperCase() + recommendedKey.slice(1))
    : pName;

  var F  = 'font-family:Arial,Helvetica,sans-serif;';
  var TX = F + 'font-size:15px;color:#ffffff;line-height:1.75;margin:0 0 14px;';
  // Section headers — green spaced caps, same weight/size as what was working
  var LB = F + 'font-size:11px;font-weight:700;color:#00C45A;text-transform:uppercase;letter-spacing:1.2px;margin:0 0 10px;';
  // Sub-labels inside WHAT HAPPENS NEXT
  var SL = F + 'font-size:11px;font-weight:700;color:#00C45A;text-transform:uppercase;letter-spacing:1.2px;margin:24px 0 8px;';
  var HR = '<hr style="border:none;border-top:1px solid #2a2a2a;margin:32px 0;" />';

  function para(text) {
    if (!text) return '';
    return text.split(/\n\n+/).map(function(p) {
      return '<p style="' + TX + '">' + esc(p.trim()) + '</p>';
    }).join('');
  }

  function bullets(arr) {
    if (!arr || !arr.length) return '';
    var LI = F + 'font-size:15px;color:#ffffff;line-height:1.75;padding:4px 0 4px 20px;position:relative;';
    var items = arr.map(function(item) {
      return '<li style="' + LI + '"><span style="position:absolute;left:0;color:#00C45A;font-weight:bold;">•</span>' + esc(item) + '</li>';
    }).join('');
    return '<ul style="list-style:none;padding:0;margin:0 0 14px;">' + items + '</ul>';
  }

  function section(label, body) {
    return HR + '<p style="' + LB + '">' + label + '</p>' + body;
  }

  function btn(label, href) {
    return (
      '<a href="' + href + '" style="' + F +
      'display:inline-block;background:#00C45A;color:#ffffff;font-size:14px;font-weight:bold;' +
      'text-decoration:none;padding:14px 28px;border-radius:8px;margin:8px 0;">' +
      label + '</a><br>'
    );
  }

  var planFeatures = bullets(PLAN_BULLETS[recommendedKey] || []);

  return (
    '<!DOCTYPE html><html lang="en"><head>' +
    '<meta charset="UTF-8" />' +
    '<meta name="viewport" content="width=device-width,initial-scale=1" />' +
    '</head>' +
    '<body style="margin:0;padding:0;background:#0f0f0f;">' +

    '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0f0f0f;">' +
    '<tr><td align="center" style="padding:32px 16px;">' +

    '<table cellpadding="0" cellspacing="0" border="0" align="center"' +
    ' style="max-width:600px;width:100%;background:#1a1a1a;border-radius:12px;">' +
    '<tr><td style="padding:40px;">' +

    // Logo
    '<div style="text-align:center;margin-bottom:36px;">' +
    '<img src="https://businesssmoothie-portal.pages.dev/assets/Copy_of_Business__10_.png"' +
    ' alt="Business Smoothie" width="200"' +
    ' style="display:inline-block;max-width:200px;width:100%;" />' +
    '</div>' +

    // Opening
    '<p style="' + F + 'font-size:15px;color:#ffffff;line-height:1.75;margin:0 0 6px;">Hi ' + name + ',</p>' +
    '<p style="' + TX + 'margin:0;">' +
    'Thanks for taking the Business Smoothie Biz Quiz. Here is what we found.' +
    '</p>' +

    // WHAT WE HEARD
    section('What We Heard', bullets(content.whatWeHeard)) +

    // WHAT YOUR BUSINESS NEEDS
    section('What Your Business Needs', bullets(content.whatYouNeed)) +

    // WHAT WE CAN DO TOGETHER
    section('What We Can Do Together',
      '<p style="' + TX + '">' +
      'Based on what you shared, the Business Smoothie ' + esc(pShort) + ' plan seems like the right fit for where you are.' +
      '</p>' +
      para(content.whatWeCanDo)
    ) +

    // YOUR PLAN MATCH
    section('Your Plan Match',
      '<p style="' + F + 'font-size:22px;font-weight:bold;color:#00C45A;line-height:1.2;margin:8px 0 16px;">' + pName + '</p>' +
      planFeatures +
      '<p style="' + TX + 'margin:16px 0 0;">' +
      'Want to see exactly what this looks like for your business? ' +
      '<a href="https://businesssmoothie.com" style="color:#00C45A;font-weight:bold;text-decoration:underline;">' +
      'Learn more about the ' + esc(pShort) + ' plan' +
      '</a>' +
      '</p>'
    ) +

    // WHAT HAPPENS NEXT
    section('What Happens Next',

      // Option 1 — Specialist Call
      '<p style="' + SL + '">Book a Specialist Call</p>' +
      '<p style="' + TX + '">A 25-minute call with a specialist to talk through your results and next steps.</p>' +
      '<div style="text-align:center;padding:4px 0 20px;">' +
      btn('Book a Specialist Call', 'https://link.businesssmoothie.com/widget/bookings/bs-strategy-call234') +
      '</div>' +

      // Option 2 — Aimy
      '<p style="' + SL + '">Talk to Aimy — 515.400.0448</p>' +
      '<div style="text-align:center;margin:0 0 12px;">' +
      '<img src="https://businesssmoothie-portal.pages.dev/images/aimy.png" alt="Aimy" width="120"' +
      ' style="display:inline-block;width:120px;border-radius:8px;" />' +
      '</div>' +
      '<p style="' + TX + '">Aimy is our AI assistant. She can answer questions about the platform, walk you through how it works, and book you with a specialist if you are ready. Good option if you want to learn more first.</p>' +
      '<div style="text-align:center;padding:4px 0 20px;">' +
      btn('Talk to Aimy — 515.400.0448', 'tel:5154000448') +
      '</div>' +

      // Option 3 — Kaiya demo
      '<p style="' + SL + '">Experience the AI Demo — 515.400.0332</p>' +
      '<div style="text-align:center;margin:0 0 12px;">' +
      '<img src="https://businesssmoothie-portal.pages.dev/images/kaiya.png" alt="Kaiya" width="120"' +
      ' style="display:inline-block;width:120px;border-radius:8px;" />' +
      '</div>' +
      '<p style="' + TX + '">This is Kaiya, our AI Mixologist. Call this number to hear what Business AI sounds like for <em>your business</em>. Just tell her your business name and industry, and she will do the rest.</p>' +
      '<div style="text-align:center;padding:4px 0 8px;">' +
      btn('Experience the AI Demo — 515.400.0332', 'tel:5154000332') +
      '</div>'
    ) +

    HR +

    // Sign-off
    '<p style="' + F + 'font-size:15px;color:#ffffff;line-height:1.8;margin:0;">' +
    'Talk soon,<br>' +
    '<strong>The Smoothie Squad</strong><br>' +
    'Business Smoothie<br>' +
    '515.400.0448<br>' +
    'businesssmoothie.com' +
    '</p>' +

    '</td></tr></table>' +
    '</td></tr></table>' +
    '</body></html>'
  );
}
