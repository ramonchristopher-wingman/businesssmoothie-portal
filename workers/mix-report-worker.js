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

You will receive a JSON object containing a business owner's survey responses. Your job is to generate a personalized Business Mix Report.

The report has two sections:

SECTION 1 — WHERE YOU STAND (7 Dimensions)
Score each of the following 7 dimensions on a scale of 1–10 based on the survey answers. Write 2–3 sentences per dimension explaining what the score means for this specific business. Be specific — reference their answers, not generic advice.

Dimensions:
1. Online Presence & Visibility
2. Lead Generation & Attraction
3. Client Relationships & Follow-Up
4. Social Media Consistency
5. Reputation & Reviews
6. AI & Automation Readiness
7. Operational Systems & Integration

SECTION 2 — YOUR NEXT MOVES (Top 3 priorities)
Based on the scores, identify the 3 highest-leverage actions this business should take. For each:
- Name the action clearly
- Explain why it matters for their specific situation (1–2 sentences)
- Name which Business Smoothie product addresses it: Business AI | Smart Website | Integrated CRM | Business Freedom Phone | Integrated Social Media | Reputation and Review Management | Reporting Dashboard | Automations and Funnels

End with one paragraph — a direct, warm summary of where they are and what their next move should be. No fluff. Wingman energy.

Respond in clean HTML — use h2 for section headers, h3 for dimension names, p for body text, strong for emphasis. No markdown. No preamble. Output only the HTML content that will be inserted into the email body.`;

const FOOTER_HTML = `
<hr style="margin:36px 0;border:none;border-top:1px solid #ddd8ce;">
<p style="font-family:sans-serif;font-size:15px;color:#444;line-height:1.6;">
  <strong style="color:#1A5C35;">Ready to talk it through?</strong><br>
  <a href="https://link.businesssmoothie.com/widget/bookings/bs-strategy-call234" style="color:#00C45A;">Book a free strategy call</a>
</p>
<p style="font-family:sans-serif;font-size:15px;color:#444;line-height:1.6;margin-top:16px;">
  <strong style="color:#1A5C35;">Want to hear what AI sounds like for your business?</strong><br>
  Call or text our demo line: <a href="tel:5154003057" style="color:#00C45A;">515.400.3057</a>
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
  if (!contactId) {
    return new Response(
      JSON.stringify({ success: false, error: "contactId not found", receivedKeys: Object.keys(body) }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

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
        model: "claude-sonnet-4-20250514",
        max_tokens: 2048,
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
    return new Response("Claude API error", { status: 502 });
  }

  const claudeData = await claudeRes.json();
  const reportHtml = claudeData.content[0].text + FOOTER_HTML;

  // ── Write report to GHL contact custom field ───────────────────────────────
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
      // Do not return an error — Claude succeeded; GHL write failure is logged
    }
  } catch (e) {
    console.error("GHL fetch error:", e.message);
  }

  return new Response(JSON.stringify({ success: true, contactId: contactId }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
