/**
 * Quiz Submit Worker — Cloudflare Worker
 *
 * 1. Upserts GHL contact with quiz tags and custom field
 * 2. Calls Claude API to generate personalized email sections
 * 3. Builds and sends HTML results email via GHL conversations API
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

const PLAN_DESCS = {
  splash:
    'The focused entry. You pick one thing — Business AI, Smart Website, Integrated CRM, ' +
    'Digital Freedom Phone, Integrated Social Media, or Reputation and Review Management — ' +
    'and it runs for your business from day one. Complete on its own, and you can add more when ' +
    'you are ready. Built for any business that wants to start focused, move fast on one specific ' +
    'thing, or add one more piece to what is already working.',
  lite:
    'The full foundation. Business AI, Smart Website, and Integrated CRM — everything you ' +
    'need to show up online, stay connected with your customers, and never miss a lead. One user, ' +
    'one platform, running from day one.',
  solo:
    'The complete Business Smoothie system. Business AI, Smart Website, Integrated CRM, ' +
    'Automations and Funnels, Digital Freedom Phone, Integrated Social Media, Reputation and ' +
    'Review Management, and Reporting Dashboard — all running for your business. Built for ' +
    'solo operators and 2-person teams who are ready for the full platform.',
  team:
    'The complete Business Smoothie system built for a growing team. Every tool in the platform ' +
    '— for up to 8 users. Everyone on the same system, with AI running across all of it. ' +
    'Built for teams of 3 to 8 who need to stop working in silos and start running as one operation.',
  enterprise:
    'The complete Business Smoothie system at full scale. Every tool in the platform — for ' +
    'organizations with real volume, complexity, and up to 50 users. Built for larger teams, ' +
    'multi-location operations, and businesses that need infrastructure that matches what they ' +
    'are actually running.'
};

const HOW_BS_FITS_STATIC = [
  'Business Smoothie is not a collection of apps. It is one platform where everything your ' +
  'business needs to run — AI, website, CRM, phone, social media, reputation, and reporting ' +
  '— works together from day one.',

  'Business AI leads everything. It answers your calls and texts, follows up with leads, requests ' +
  'reviews, and keeps your business moving 24 hours a day — connected to the latest AI ' +
  'advances and improving automatically. You do not manage it. It just runs.',

  'The rest of the platform supports it. Your website works. Your CRM captures every contact. ' +
  'Your phone is a business tool. Your social stays active. Your reviews keep coming in. And your ' +
  'reporting dashboard shows you what is actually happening so you can make good decisions.'
];

const CLAUDE_SYSTEM =
  'You write personalized results emails for people who just completed the Business Smoothie Biz Quiz. ' +
  'Business Smoothie is a business operations platform — not a marketing platform. It helps ' +
  'businesses run smarter, respond faster, and grow without adding overhead. Business AI always leads ' +
  '— it answers calls, responds to messages, follows up with leads, requests reviews, and keeps ' +
  'the business moving 24/7.\n\n' +

  'The plan recommendations have already been determined by the quiz logic and are passed to you as ' +
  'fixed inputs. Do not change or second-guess the recommendations. Your job is to write warm, ' +
  'specific, honest narrative copy that supports them.\n\n' +

  'Write in second person — "you" and "your business." Direct, warm, confident. Not salesy. ' +
  'No hype. No exclamation marks. Write like a knowledgeable friend who looked at their answers ' +
  'and has something real to say.\n\n' +

  'Return ONLY a JSON object with no markdown, no backticks, no preamble. Exactly this structure:\n' +
  '{\n' +
  '  "whatWeHeard": "3-4 sentences. Reference their specific situation. Make them feel genuinely seen. No product mentions yet.",\n' +
  '  "bigPicture": "2-3 sentences. State the core friction or opportunity clearly. Explain why it matters and what it is costing them or making possible. For businesses with strong systems and good AI, frame as opportunity not problem.",\n' +
  '  "whatYouNeed": "2-3 sentences. Describe what their business operation should actually look like. Outcomes only — no product names yet.",\n' +
  '  "howBSFits": "2-3 sentences. Connect their specific situation to what Business Smoothie does. Business AI leads. Be specific to their signals.",\n' +
  '  "secondaryMention": "1-2 sentences only. If a secondary plan is provided, write a brief natural mention of it as an alternative starting point. If no secondary plan, return an empty string."\n' +
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

  if (!email) return new Response('Email required', { status: 400, headers: CORS });

  const recommendedKey  = planTag ? planTag.replace('quiz-match-', '') : null;
  const secondaryKey    = secondaryPlan || null;
  const displayPlanName = planName || (recommendedKey && PLAN_NAMES[recommendedKey]) || '';

  const tags = ['quiz-completed'];
  if (planTag) tags.push(planTag);

  const upsertPayload = {
    firstName:  firstName || '',
    email:      email,
    locationId: LOCATION_ID,
    tags:       tags
  };
  if (planName) {
    upsertPayload.customFields = [{ key: 'quiz_recommended_plan', field_value: planName }];
  }

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
    } else {
      console.error('GHL upsert error ' + upsertRes.status + ':', await upsertRes.text());
    }
  } catch (e) {
    console.error('GHL upsert fetch error:', e.message);
  }

  // ── STEP 2: Claude API — generate email sections ──────────────────────────
  const secName = secondaryKey ? (PLAN_NAMES[secondaryKey] || secondaryKey) : 'none';

  const userMsg = [
    'First name: ' + (firstName || 'there'),
    'Primary recommended plan: ' + displayPlanName,
    'Secondary plan (if any): ' + secName,
    'What we heard (short): ' + (whatWeHeard || ''),
    'Big issue or opportunity (short): ' + (bigIssue || ''),
    'Recommendation (short): ' + (recommendation || ''),
    'How BS fits (short): ' + (howBSFits || ''),
    '',
    'Write the expanded personalized email sections for this person. The plan recommendations ' +
    'are locked — write narrative that supports ' + displayPlanName +
    ' as the primary recommendation' +
    (secondaryKey ? ', with ' + secName + ' as a brief alternative mention.' : '.')
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
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1800,
        system:     CLAUDE_SYSTEM,
        messages:   [{ role: 'user', content: userMsg }]
      })
    });
    if (claudeRes.ok) {
      const claudeData = await claudeRes.json();
      const raw = claudeData.content[0].text.trim();
      try {
        claude = JSON.parse(raw);
      } catch (pe) {
        console.error('Claude JSON parse error:', pe.message, '| raw:', raw.slice(0, 300));
      }
    } else {
      console.error('Claude API error ' + claudeRes.status + ':', await claudeRes.text());
    }
  } catch (e) {
    console.error('Claude fetch error:', e.message);
  }

  // Fall back to short versions from quiz if Claude failed
  const content = claude || {
    whatWeHeard:      whatWeHeard   || '',
    bigPicture:       bigIssue      || '',
    whatYouNeed:      recommendation || '',
    howBSFits:        howBSFits     || '',
    secondaryMention: ''
  };

  // ── STEP 3: Build HTML email ───────────────────────────────────────────────
  const htmlEmail = buildEmail(firstName, recommendedKey, secondaryKey, displayPlanName, content);

  // ── STEP 4: Send via GHL conversations API ────────────────────────────────
  if (contactId) {
    try {
      const emailRes = await fetch('https://services.leadconnectorhq.com/conversations/messages/outbound', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + GHL_API_KEY,
          'Content-Type':  'application/json',
          'Version':       '2021-04-15'
        },
        body: JSON.stringify({
          type:         'Email',
          contactId:    contactId,
          emailFrom:    'info@businesssmoothie.com',
          emailReplyTo: 'ramon@businesssmoothie.com',
          emailSubject: 'Your Business Smoothie Quiz Results and Recommendation',
          emailBody:    htmlEmail
        })
      });
      if (!emailRes.ok) {
        console.error('GHL email error ' + emailRes.status + ':', await emailRes.text());
      }
    } catch (e) {
      console.error('GHL email fetch error:', e.message);
    }
  } else {
    console.log('No contactId — skipping email send');
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

function buildEmail(firstName, recommendedKey, secondaryKey, planName, content) {
  var name    = esc(firstName || 'there');
  var pName   = esc(planName || (recommendedKey && PLAN_NAMES[recommendedKey]) || '');
  var pDesc   = esc(PLAN_DESCS[recommendedKey] || '');
  var showSec = !!(secondaryKey && content.secondaryMention && content.secondaryMention.trim());
  var sName   = showSec ? esc(PLAN_NAMES[secondaryKey] || secondaryKey) : '';

  var F  = 'font-family:Arial,Helvetica,sans-serif;';
  var WH = F + 'font-size:15px;color:#ffffff;line-height:1.7;margin:0 0 8px;';
  var GY = F + 'font-size:15px;color:#999999;line-height:1.7;margin:0 0 14px;';
  var LB = F + 'font-size:11px;font-weight:700;color:#00C45A;text-transform:uppercase;letter-spacing:1.2px;margin:28px 0 10px 0;';

  function para(text) {
    if (!text) return '';
    return text.split(/\n\n+/).map(function(p) {
      return '<p style="' + GY + '">' + esc(p.trim()) + '</p>';
    }).join('');
  }

  function section(label, body) {
    return '<p style="' + LB + '">' + label + '</p>' + body;
  }

  function btn(label, href) {
    return (
      '<a href="' + href + '" style="' + F +
      'display:inline-block;background:#00C45A;color:#ffffff;font-size:14px;font-weight:bold;' +
      'text-decoration:none;padding:14px 28px;border-radius:8px;margin:8px 0;">' +
      label + '</a><br>'
    );
  }

  var staticFits = HOW_BS_FITS_STATIC.map(function(p) {
    return '<p style="' + GY + '">' + esc(p) + '</p>';
  }).join('');

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
    '<div style="text-align:center;margin-bottom:32px;">' +
    '<img src="https://businesssmoothie-portal.pages.dev/assets/Copy_of_Business__10_.png"' +
    ' alt="Business Smoothie" width="200"' +
    ' style="display:inline-block;max-width:200px;width:100%;" />' +
    '</div>' +

    // Opening
    '<p style="' + WH + '">Hi ' + name + ',</p>' +
    '<p style="' + F + 'font-size:15px;color:#999999;line-height:1.7;margin:0 0 28px;">' +
    'Thanks for taking the Business Smoothie Biz Quiz. We went through every answer — here is what we found.' +
    '</p>' +

    section('WHAT WE HEARD',            para(content.whatWeHeard)) +
    section('THE BIG PICTURE',          para(content.bigPicture)) +
    section('WHAT YOUR BUSINESS NEEDS', para(content.whatYouNeed)) +
    section('HOW BUSINESS SMOOTHIE FITS', staticFits + para(content.howBSFits)) +

    section('YOUR PLAN MATCH',
      '<p style="' + GY + '">Based on your results, here is what we recommend:</p>' +
      '<p style="' + F + 'font-size:22px;font-weight:bold;color:#00C45A;line-height:1.2;margin:0 0 14px;">' + pName + '</p>' +
      '<p style="' + GY + '">' + pDesc + '</p>'
    ) +

    (showSec ? section('ALSO WORTH A LOOK',
      '<p style="' + F + 'font-size:18px;font-weight:bold;color:#ffffff;line-height:1.2;margin:0 0 12px;">' + sName + '</p>' +
      para(content.secondaryMention)
    ) : '') +

    section('WHAT HAPPENS NEXT',
      '<p style="' + GY + '">You have a few options depending on where you are.</p>' +
      '<p style="' + GY + '">' +
      'If you are ready to talk through your results and take the next step — book a 25-minute call ' +
      'with one of our specialists. We will look at your results together and map out exactly what makes ' +
      'sense for your business. No pitch, no pressure — just a real conversation about what would actually help.' +
      '</p>' +
      '<p style="' + GY + '">' +
      'If you want to hear what Business Smoothie sounds like for a business like yours — give us a call. ' +
      'Our AI assistant is available now and can walk you through what the platform does and how it works.' +
      '</p>'
    ) +

    '<div style="text-align:center;padding:8px 0 28px;">' +
    btn('Book a Specialist Call', 'https://link.businesssmoothie.com/widget/booking/Y6ptSOI0hEEvhwyLaUxU') +
    btn('Call Us — 515.400.0448', 'tel:5154000448') +
    btn('Experience the AI Demo — 515.400.0332', 'tel:5154000332') +
    '</div>' +

    '<p style="' + F + 'font-size:15px;color:#999999;line-height:1.8;margin:0;">' +
    'Talk soon,<br>' +
    '<strong style="color:#ffffff;">The Smoothie Squad</strong><br>' +
    'Business Smoothie<br>' +
    '515.400.0448<br>' +
    'businesssmoothie.com' +
    '</p>' +

    '</td></tr></table>' +
    '</td></tr></table>' +
    '</body></html>'
  );
}
