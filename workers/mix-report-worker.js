/**
 * Business Mix Report — Cloudflare Worker
 *
 * Receives a POST from a GHL workflow webhook, calls Claude API to generate
 * a personalized Business Mix Report, then writes the HTML back to the
 * contact's custom field in GHL so the workflow email can merge it in.
 *
 * Required environment variables (set in Cloudflare Workers dashboard):
 *   ANTHROPIC_API_KEY    — Anthropic API key
 *   GHL_API_KEY          — GHL Private Integration Token
 *   GHL_CUSTOM_FIELD_ID  — ID of the business_mix_report custom field
 *                          (GHL dashboard > Settings > Custom Fields >
 *                           click the field > copy the ID from the URL)
 *
 * Expected GHL webhook JSON body (configure in GHL workflow > Webhook action):
 * {
 *   "contactId":       "{{contact.id}}",
 *   "firstName":       "{{contact.first_name}}",
 *   "email":           "{{contact.email}}",
 *   "businessAge":     "{{contact.q1_business_age}}",
 *   "businessType":    "{{contact.q2_business_type}}",
 *   "onlinePresence":  "{{contact.q3_online_presence}}",
 *   "leadSource":      "{{contact.q4_lead_source}}",
 *   "crmSituation":    "{{contact.q5_crm_situation}}",
 *   "socialActivity":  "{{contact.q6_social_activity}}",
 *   "reviewProcess":   "{{contact.q7_review_process}}",
 *   "aiUsage":         "{{contact.q8_ai_usage}}",
 *   "biggestChallenge":"{{contact.q9_biggest_challenge}}",
 *   "successVision":   "{{contact.q10_success_vision}}"
 * }
 * (Field names in {{}} must match your GHL survey-to-custom-field mappings.)
 */

const SYSTEM_PROMPT = `You are a business operations analyst for Business Smoothie, a platform that helps small and mid-size businesses run smarter using AI and automation. You write in a warm, direct, confident tone — like a trusted advisor, not a salesperson.

You will receive a JSON object containing a business owner's survey responses. Generate a personalized Business Mix Report in this exact order — no reordering:

  1. EXECUTIVE SUMMARY
  2. YOUR 3 NEXT MOVES
  3. The literal string: <!-- CTA_PLACEHOLDER -->
  4. WHERE YOU STAND — 7 DIMENSIONS
  5. PROSPECTING SNAPSHOT

────────────────────────────────────────
SECTION 1 — EXECUTIVE SUMMARY
────────────────────────────────────────
Write 2–3 sentences: the single clearest read of where this business stands, what is working, and what is most in the way. If Business AI would meaningfully help, say so directly and specifically. Wingman energy — direct, honest, warm. No generic advice.

────────────────────────────────────────
SECTION 2 — YOUR 3 NEXT MOVES
────────────────────────────────────────
Output exactly 3 priorities — no more, no less.

Unless the contact explicitly indicated no interest in AI, Business AI must be Move #1. Use the special Business AI template for that move (see below). For the remaining moves, name the action, explain why it matters for their specific situation in 1–2 sentences, and name the Business Smoothie product that addresses it:
Business AI | Smart Website | Integrated CRM | Business Freedom Phone | Integrated Social Media | Reputation and Review Management | Reporting Dashboard | Automations and Funnels

────────────────────────────────────────
SECTION 3 — CTA PLACEHOLDER
────────────────────────────────────────
Output this exact HTML comment on its own line — do not skip it, do not modify it:
<!-- CTA_PLACEHOLDER -->

────────────────────────────────────────
SECTION 4 — WHERE YOU STAND (7 Dimensions)
────────────────────────────────────────
Assign each of the 7 dimensions a status label. Use exactly one of:
- Needs Attention — missing, broken, or a clear liability
- Building — some foundation exists but meaningful gaps remain
- Strong — solid and working for this business

Write 2–3 sentences per dimension. Reference their actual answers — never generic advice. Where AI is relevant to a dimension, name it specifically.

Dimensions:
1. Online Presence & Visibility
2. Lead Generation & Attraction
3. Client Relationships & Follow-Up
4. Social Media Consistency
5. Reputation & Reviews
6. AI & Automation Readiness
7. Operational Systems & Integration

────────────────────────────────────────
SECTION 5 — PROSPECTING SNAPSHOT
────────────────────────────────────────
Based on their leadSource, onlinePresence, socialActivity, reviewProcess, and crmSituation answers, write exactly 3 insight cards:
- Card 1 — "Where Your Leads Come From Today": what their current lead sources tell you about their pipeline
- Card 2 — "Where You're Losing Prospects": the specific gaps causing leads to fall through or never arrive
- Card 3 — "Your Fastest Win": the single highest-leverage prospecting change for this business right now

────────────────────────────────────────
HTML TEMPLATES — use these exactly, no exceptions
────────────────────────────────────────

Executive Summary block:
<div style="background:#f0fdf6;border-left:4px solid #00C45A;padding:14px 18px;border-radius:0 8px 8px 0;margin:0 0 24px;">
<p style="font-family:sans-serif;font-size:1rem;color:#1A5C35;line-height:1.65;margin:0;font-weight:600;">Summary text here.</p>
</div>

Section header:
<h2 style="color:#1A5C35;font-size:1.05rem;font-family:sans-serif;margin:24px 0 8px;padding:0;">SECTION TITLE</h2>

Business AI move (use this template for the Business AI next move only):
<div style="background:#f0fdf6;border:2px solid #00C45A;padding:12px 16px;border-radius:6px;margin:6px 0;">
<h3 style="font-family:sans-serif;font-size:0.95rem;margin:0 0 5px;color:#1A5C35;">⚡ Business AI — [Action Name]</h3>
<p style="font-family:sans-serif;font-size:0.93rem;color:#444;line-height:1.55;margin:0;">Why it matters for this business. Product: <strong>Business AI</strong>.</p>
</div>

Other Next Move blocks:
<div style="background:#f5f5f5;padding:8px 14px;border-radius:4px;margin:6px 0;">
<h3 style="font-family:sans-serif;font-size:0.95rem;margin:0 0 5px;">Priority Name</h3>
<p style="font-family:sans-serif;font-size:0.93rem;color:#444;line-height:1.55;margin:0;">Why it matters + product name in <strong>bold</strong>.</p>
</div>

CTA placeholder (output exactly this, on its own line, between Next Moves and 7 Dimensions):
<!-- CTA_PLACEHOLDER -->

Dimension blocks:
<div style="background:#f5f5f5;padding:8px 14px;border-radius:4px;margin:6px 0;">
<h3 style="font-family:sans-serif;font-size:0.95rem;margin:0 0 5px;">Dimension Name — <span style="color:[#cc0000 for Needs Attention | #e87722 for Building | #00C45A for Strong];font-weight:bold;">[Needs Attention | Building | Strong]</span></h3>
<p style="font-family:sans-serif;font-size:0.93rem;color:#444;line-height:1.55;margin:0;">Explanation here.</p>
</div>

Prospecting Snapshot cards:
<div style="background:#fff8f0;border-left:4px solid #e87722;padding:12px 16px;border-radius:0 6px 6px 0;margin:6px 0;">
<h3 style="font-family:sans-serif;font-size:0.9rem;font-weight:700;color:#e87722;margin:0 0 4px;">[Card Label]</h3>
<p style="font-family:sans-serif;font-size:0.9rem;color:#444;line-height:1.55;margin:0;">Insight here.</p>
</div>

Rules: No <br> tags. No extra whitespace between blocks. No footer. No preamble. No markdown. Output only the HTML content block. The <!-- CTA_PLACEHOLDER --> comment must appear on its own line between the Your 3 Next Moves section and the Where You Stand section.`;

const HEADER_HTML = `<div style="background:#00C45A;padding:18px 24px;text-align:center;border-radius:6px 6px 0 0;margin-bottom:0;">
  <span style="font-family:Arial,sans-serif;font-size:1.25rem;font-weight:bold;color:#ffffff;letter-spacing:0.04em;">Business Mix Report</span>
</div>
<div style="background:#ffffff;padding:20px 24px 8px;border-radius:0 0 6px 6px;">`;

const CTA_HTML = `<div style="background:#1A5C35;border-radius:10px;padding:24px 20px;text-align:center;margin:28px 0;">
  <p style="font-family:sans-serif;font-size:1rem;font-weight:700;color:#ffffff;margin:0 0 6px;">Ready to talk through what this means for your business?</p>
  <p style="font-family:sans-serif;font-size:0.875rem;color:rgba(255,255,255,0.85);margin:0 0 18px;line-height:1.5;">Book a free strategy call — no pitch, just a real conversation about your next move.</p>
  <a href="https://link.businesssmoothie.com/widget/bookings/bs-strategy-call234" style="display:inline-block;background:#00C45A;color:#ffffff;font-family:sans-serif;font-size:0.95rem;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:100px;">Book Your Free Strategy Call →</a>
</div>`;

const FOOTER_HTML = `</div>
<hr style="margin:28px 0;border:none;border-top:1px solid #ddd8ce;">
<p style="font-family:sans-serif;font-size:15px;color:#444;line-height:1.6;margin:0;">
  <strong style="color:#1A5C35;">Want to hear what AI sounds like for your business?</strong><br>
  Call or text our demo line: <a href="tel:5154000448" style="color:#00C45A;">515.400.0448</a>
</p>`;

addEventListener("fetch", function(event) {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response("Invalid JSON body", { status: 400 });
  }

  console.log("Full payload:", JSON.stringify(body));

  const contactId = body.contactId || body.contact_id || body.id || (body.contact && body.contact.id);

  // ── Call Claude API ────────────────────────────────────────────────────────
  let claudeRes;
  try {
    claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 3000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: JSON.stringify(body) }]
      })
    });
  } catch (e) {
    console.error("Claude fetch error:", e.message);
    return new Response("Claude API unreachable", { status: 502 });
  }

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    console.error("Claude API error " + claudeRes.status + ":", errText);
    return new Response(JSON.stringify({ success: false, claudeStatus: claudeRes.status, claudeError: errText }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const claudeData = await claudeRes.json();
  const claudeOutput = claudeData.content[0].text.replace('<!-- CTA_PLACEHOLDER -->', CTA_HTML);
  const reportHtml = HEADER_HTML + claudeOutput + FOOTER_HTML;

  // ── Write report to GHL contact custom field (skip if no contactId) ────────
  if (contactId) {
    try {
      const ghlRes = await fetch("https://services.leadconnectorhq.com/contacts/" + contactId, {
        method: "PUT",
        headers: {
          "Authorization": "Bearer " + GHL_API_KEY,
          "Content-Type": "application/json",
          "Version": "2021-07-28"
        },
        body: JSON.stringify({
          customFields: [
            { id: GHL_CUSTOM_FIELD_ID, field_value: reportHtml }
          ]
        })
      });

      if (!ghlRes.ok) {
        const ghlErr = await ghlRes.text();
        console.error("GHL write error " + ghlRes.status + ":", ghlErr);
      }
    } catch (e) {
      console.error("GHL fetch error:", e.message);
    }
  } else {
    console.log("No contactId found — skipping GHL write. receivedKeys:", Object.keys(body));
  }

  return new Response(JSON.stringify({ success: true, contactId: contactId || null, report: reportHtml }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
