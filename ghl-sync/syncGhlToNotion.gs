/**
 * syncGhlToNotion.gs — GHL → Notion one-way sync
 * Deployed as a Google Apps Script project.
 *
 * SETUP (one time, in order):
 *   1. Create a GHL Marketplace app (private/internal) — see getAuthUrl() below.
 *   2. Add these Script Properties (Project Settings → Script Properties):
 *        GHL_CLIENT_ID      your OAuth app client_id
 *        GHL_CLIENT_SECRET  your OAuth app client_secret
 *        GHL_REDIRECT_URI   this script's deployed web app URL (deploy → web app first)
 *        NOTION_TOKEN       Notion integration token
 *      Leave GHL_REFRESH_TOKEN blank — exchangeCodeForTokens() sets it.
 *   3. Deploy this script as a Web App (Execute as: Me, Who: Anyone).
 *      Copy the deployed URL → paste into GHL_REDIRECT_URI property.
 *   4. Run getAuthUrl() → open the logged URL in a browser → authorize.
 *      GHL redirects to your web app URL. The page shows the auth code.
 *   5. Run exchangeCodeForTokens('PASTE_CODE_HERE') → stores refresh_token.
 *   6. Run auditSyncReadiness() → confirm everything is green.
 *   7. Run getPipelineStages() → fill in STAGE_TO_STATUS below.
 *   8. Run installDailyTrigger() → done.
 */

// ─── Config ───────────────────────────────────────────────────────────────────

const GHL_BASE    = 'https://services.leadconnectorhq.com';
const NOTION_BASE = 'https://api.notion.com/v1';

const GHL_COMPANY_ID  = 'qdgNq41RazyElZ3Q0xbK';
const NOTION_DB_ID    = 'db150108-b987-4069-b77b-3ec7d76544db';

// Map GHL pipelineStageId → Notion Status select value.
// Populate by running getPipelineStages() and checking the execution log.
// Unmapped stage IDs are skipped — Status in Notion is left unchanged.
const STAGE_TO_STATUS = {
  // ── Demo Pipeline ─────────────────────────────────────────────────
  'f554d09b-f0d9-4d6c-b913-f4d501f9e439': 'Active Client',  // New Client
  '6989dd69-6916-46a2-8b0f-9228bacaffa0': 'Prospect',       // Appt booked
  '43635188-6d82-4261-b7b7-9bc8e6d37a44': 'Paused',         // Service Completed

  // ── Marketing Pipeline (jmdJXeuq61kqp72LWbC0) ────────────────────
  '72dea74d-2f01-4d0a-b5ef-11450f8d50e6': 'Prospect',       // New Lead
  'c37916c7-b585-4568-9728-26807341e6ca': 'Prospect',       // Hot Lead
  '21483be9-4ee8-47b6-a21e-358ec6c4efe9': 'Prospect',       // New Booking
  '45518619-5eec-4add-b159-ae7c2de29033': 'Prospect',       // Visit Attended
  'a872a388-e280-43b8-9023-aa9a77699ba2': 'Active Client',  // Sale
  '179a6787-7563-43d0-9f76-b50e5fa390f8': 'Active Client',  // Left a Review

  // ── Marketing Pipeline (wcdn1ySyUfKKHqNTLIV9) ────────────────────
  '35cc084f-ad70-43bb-9394-8c32f83105eb': 'Prospect',       // New Lead
  '1eacae91-522d-4a91-8963-eed21a0f7094': 'Prospect',       // Hot Lead
  '53d21f88-f2da-4447-a372-c936f6b077e5': 'Prospect',       // New Booking
  '566111a1-8261-4977-90b6-4086e5fee4de': 'Prospect',       // Visit Attended
  'b9ddffcb-7520-40cc-bb86-7d939b13ec3a': 'Active Client',  // Sale
  '860af647-ac14-4a34-9729-e3eaf6545997': 'Active Client',  // Left a Review
};

// ─── OAuth helpers ────────────────────────────────────────────────────────────

function getAgencyAccessToken() {
  const p = PropertiesService.getScriptProperties();
  const resp = UrlFetchApp.fetch(GHL_BASE + '/oauth/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      client_id:     p.getProperty('GHL_CLIENT_ID'),
      client_secret: p.getProperty('GHL_CLIENT_SECRET'),
      grant_type:    'refresh_token',
      refresh_token: p.getProperty('GHL_REFRESH_TOKEN'),
      user_type:     'Company',
    },
    muteHttpExceptions: true,
  });

  const data = JSON.parse(resp.getContentText());
  if (!data.access_token) {
    throw new Error('Agency token refresh failed: ' + resp.getContentText());
  }
  if (data.refresh_token) {
    p.setProperty('GHL_REFRESH_TOKEN', data.refresh_token);
  }
  return data.access_token;
}

function getLocationAccessToken(agencyToken, locationId) {
  const resp = UrlFetchApp.fetch(GHL_BASE + '/oauth/locationToken', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + agencyToken,
      'Version': '2021-07-28',
    },
    payload: JSON.stringify({ companyId: GHL_COMPANY_ID, locationId: locationId }),
    muteHttpExceptions: true,
  });

  const data = JSON.parse(resp.getContentText());
  if (!data.access_token) {
    throw new Error('Location token failed for ' + locationId + ': ' + resp.getContentText());
  }
  return data.access_token;
}

// ─── GHL data fetchers ────────────────────────────────────────────────────────

function getLatestOpportunity(locationToken, locationId) {
  var url = GHL_BASE + '/opportunities/search?location_id=' + locationId + '&limit=1&order=updatedAt';
  const resp = UrlFetchApp.fetch(url, {
    headers: {
      'Authorization': 'Bearer ' + locationToken,
      'Version': '2021-07-28',
    },
    muteHttpExceptions: true,
  });
  const data = JSON.parse(resp.getContentText());
  const opps = data.opportunities || [];
  return opps.length ? opps[0] : null;
}

function getLatestConversation(agencyToken, locationId) {
  var url = GHL_BASE + '/conversations/search?locationId=' + locationId + '&limit=1&sortBy=last_message_date&sort=desc';
  const resp = UrlFetchApp.fetch(url, {
    headers: {
      'Authorization': 'Bearer ' + agencyToken,
      'Version': '2021-04-15',
    },
    muteHttpExceptions: true,
  });
  const data = JSON.parse(resp.getContentText());
  const convos = data.conversations || [];
  return convos.length ? convos[0] : null;
}

// ─── Notion helpers ───────────────────────────────────────────────────────────

function getNotionCompanies() {
  const token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  const resp = UrlFetchApp.fetch(NOTION_BASE + '/databases/' + NOTION_DB_ID + '/query', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Notion-Version': '2022-06-28',
    },
    payload: JSON.stringify({
      filter: {
        and: [
          { property: 'Ops Platform', select: { equals: 'GHL Sub-Account' } },
          { property: 'Visibility',   select: { equals: 'Active' } },
        ],
      },
    }),
    muteHttpExceptions: true,
  });
  const data = JSON.parse(resp.getContentText());
  if (!data.results) throw new Error('Notion query failed: ' + resp.getContentText());
  return data.results;
}

function updateNotionPage(pageId, updates) {
  const token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  const resp = UrlFetchApp.fetch(NOTION_BASE + '/pages/' + pageId, {
    method: 'patch',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Notion-Version': '2022-06-28',
    },
    payload: JSON.stringify({ properties: updates }),
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() >= 400) {
    throw new Error('Notion update failed (' + resp.getResponseCode() + '): ' + resp.getContentText());
  }
}

// Split a long string into ≤2000-char Notion rich_text chunks (API limit).
function chunkRichText_(str) {
  var chunks = [];
  for (var i = 0; i < str.length; i += 2000) {
    chunks.push({ type: 'text', text: { content: str.slice(i, i + 2000) } });
  }
  return chunks;
}

// Delete all existing children of a Notion page, then append newBlocks.
function replacePageContent_(pageId, newBlocks) {
  var token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  var headers = {
    'Authorization':  'Bearer ' + token,
    'Notion-Version': '2022-06-28',
  };

  var listResp = UrlFetchApp.fetch(
    NOTION_BASE + '/blocks/' + pageId + '/children?page_size=100',
    { headers: headers, muteHttpExceptions: true }
  );
  var existing = (JSON.parse(listResp.getContentText()).results || []);

  existing.forEach(function(block) {
    UrlFetchApp.fetch(NOTION_BASE + '/blocks/' + block.id, {
      method: 'delete',
      headers: headers,
      muteHttpExceptions: true,
    });
  });

  var appendResp = UrlFetchApp.fetch(NOTION_BASE + '/blocks/' + pageId + '/children', {
    method: 'patch',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify({ children: newBlocks }),
    muteHttpExceptions: true,
  });
  if (appendResp.getResponseCode() >= 400) {
    throw new Error('Notion append failed (' + appendResp.getResponseCode() + '): ' +
      appendResp.getContentText().slice(0, 300));
  }
}

// ─── Brief cache ──────────────────────────────────────────────────────────────

var BRIEF_CACHE_PAGE_ID    = '383bbe80-2621-81cc-81f6-d6497ccd433a';
var PROGRESS_LOG_LAST_SESSION_URL =
  'https://script.google.com/macros/s/AKfycbzkXFPaCN0VGkGg8o8pAHGsg31E76kGWKHR7siYUvYcHpyglGPS5Yr12_839hmHoCbn/exec?action=lastSession';

function writeBriefCache_() {
  var briefData = buildBriefData_();

  var lastSession;
  try {
    var sessionResp = UrlFetchApp.fetch(PROGRESS_LOG_LAST_SESSION_URL, {
      muteHttpExceptions: true,
      followRedirects: true,
    });
    lastSession = JSON.parse(sessionResp.getContentText());
  } catch (err) {
    Logger.log('WARNING: Progress Log fetch failed: ' + err.message);
    lastSession = { error: 'fetch failed: ' + err.message };
  }

  var cache = {
    written_at:   new Date().toISOString(),
    brief:        briefData,
    last_session: lastSession,
  };

  var jsonStr   = JSON.stringify(cache, null, 2);
  var codeBlock = {
    object: 'block',
    type:   'code',
    code: {
      rich_text: chunkRichText_(jsonStr),
      language:  'json',
    },
  };

  replacePageContent_(BRIEF_CACHE_PAGE_ID, [codeBlock]);
  Logger.log('✅ Brief cache written to Notion page ' + BRIEF_CACHE_PAGE_ID);
}

function installBriefCacheTrigger() {
  installBriefCacheTrigger_();
}

function installBriefCacheTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'writeBriefCache_') ScriptApp.deleteTrigger(t);
  });
  // Apps Script time triggers specify only the hour; fires between 5:00–6:00 AM CT.
  ScriptApp.newTrigger('writeBriefCache_')
    .timeBased()
    .everyDays(1)
    .atHour(5)
    .create();
  Logger.log('✅ Daily brief cache trigger installed — writeBriefCache_ fires daily at ~5–6am CT.');
}

// ─── Main sync ────────────────────────────────────────────────────────────────

function syncGhlToNotion() {
  Logger.log('=== GHL → Notion sync started ===');
  const agencyToken = getAgencyAccessToken();
  const companies   = getNotionCompanies();
  Logger.log('Companies in scope: ' + companies.length);

  companies.forEach(function(page) {
    const props  = page.properties;
    const name   = props['Company Name'] && props['Company Name'].title && props['Company Name'].title[0]
                   ? props['Company Name'].title[0].plain_text : '(unknown)';
    const ghlId  = props['GHL ID'] && props['GHL ID'].rich_text && props['GHL ID'].rich_text[0]
                   ? props['GHL ID'].rich_text[0].plain_text : null;

    if (!ghlId) {
      Logger.log('SKIP ' + name + ' — GHL ID missing');
      return;
    }

    try {
      const locToken = getLocationAccessToken(agencyToken, ghlId);
      const updates  = {};

      const opp = getLatestOpportunity(locToken, ghlId);
      if (opp) {
        const stageId = opp.pipelineStageId;
        const status  = STAGE_TO_STATUS[stageId];
        if (status) {
          updates['Status'] = { select: { name: status } };
        } else {
          Logger.log(name + ': stageId "' + stageId + '" not in STAGE_TO_STATUS — Status unchanged');
        }
        updates['Last Contact'] = { date: { start: opp.updatedAt } };
      }

      const convo = getLatestConversation(agencyToken, ghlId);
      if (convo && convo.lastMessageDate) {
        const convoTs = new Date(convo.lastMessageDate).toISOString();
        const oppTs   = updates['Last Contact'] ? updates['Last Contact'].date.start : '';
        if (!oppTs || convoTs > oppTs) {
          updates['Last Contact'] = { date: { start: convoTs } };
        }
      }

      if (Object.keys(updates).length) {
        updateNotionPage(page.id, updates);
        Logger.log('OK ' + name);
      } else {
        Logger.log(name + ': nothing to update');
      }
    } catch (err) {
      Logger.log('ERROR ' + name + ': ' + err.message);
    }
  });

  Logger.log('=== sync complete ===');
}

// ─── Pipeline stage inspector ─────────────────────────────────────────────────

function getPipelineStages() {
  const agencyToken = getAgencyAccessToken();
  const locationId  = 'go4koQW1pahaSqxZppSI';
  const locToken    = getLocationAccessToken(agencyToken, locationId);
  var url = GHL_BASE + '/opportunities/pipelines?locationId=' + locationId;
  const resp = UrlFetchApp.fetch(url, {
    headers: {
      'Authorization': 'Bearer ' + locToken,
      'Version': '2021-07-28',
    },
    muteHttpExceptions: true,
  });

  const data = JSON.parse(resp.getContentText());
  const pipelines = data.pipelines || data;
  (Array.isArray(pipelines) ? pipelines : [pipelines]).forEach(function(pipeline) {
    Logger.log('\nPipeline: "' + pipeline.name + '" (' + pipeline.id + ')');
    (pipeline.stages || []).forEach(function(stage) {
      Logger.log("  '" + stage.id + "': '',  // \"" + stage.name + '"');
    });
  });
}

// ─── Audit ────────────────────────────────────────────────────────────────────

function auditSyncReadiness() {
  const p = PropertiesService.getScriptProperties();
  Logger.log('=== Script Properties ===');
  ['GHL_CLIENT_ID','GHL_CLIENT_SECRET','GHL_REFRESH_TOKEN','GHL_REDIRECT_URI','NOTION_TOKEN']
    .forEach(function(k) { Logger.log(k + ': ' + (p.getProperty(k) ? '✅ set' : '❌ MISSING')); });

  Logger.log('\n=== Notion companies in sync scope ===');
  try {
    const companies = getNotionCompanies();
    Logger.log('Count: ' + companies.length);
    companies.forEach(function(page) {
      const pp    = page.properties;
      const name  = pp['Company Name'] && pp['Company Name'].title && pp['Company Name'].title[0]
                    ? pp['Company Name'].title[0].plain_text : '?';
      const ghlId = pp['GHL ID'] && pp['GHL ID'].rich_text && pp['GHL ID'].rich_text[0]
                    ? pp['GHL ID'].rich_text[0].plain_text : '❌ MISSING';
      Logger.log('  ' + name + ': ' + ghlId);
    });
  } catch (e) {
    Logger.log('Notion query failed: ' + e.message);
  }

  Logger.log('\n=== STAGE_TO_STATUS map ===');
  const mapped = Object.keys(STAGE_TO_STATUS).length;
  Logger.log(mapped ? (mapped + ' stages mapped') : '❌ Empty — run getPipelineStages() first');
}

// ─── Trigger management ───────────────────────────────────────────────────────

function deleteSyncTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'syncGhlToNotion') {
      ScriptApp.deleteTrigger(t);
      Logger.log('Deleted trigger: ' + t.getUniqueId());
    }
  });
}

function installWeeklyTrigger() {
  ScriptApp.newTrigger('syncGhlToNotion')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(17)
    .create();
  Logger.log('✅ Weekly trigger installed — syncGhlToNotion runs Sundays at 5pm CT.');
}

function resetSyncTrigger() {
  // Delete all existing syncGhlToNotion triggers
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'syncGhlToNotion') {
      ScriptApp.deleteTrigger(t);
    }
  });

  // Set new daily trigger at 4am CT
  ScriptApp.newTrigger('syncGhlToNotion')
    .timeBased()
    .everyDays(1)
    .atHour(4)
    .inTimezone('America/Chicago')
    .create();

  Logger.log('syncGhlToNotion trigger set: daily at 4am CT');
}

// ─── Webhook trigger ──────────────────────────────────────────────────────────

// POST {"action":"sync","key":"<SYNC_WEBHOOK_SECRET>"}          — run sync now
// POST {"action":"setup-trigger","key":"<SYNC_WEBHOOK_SECRET>"} — replace trigger with weekly Sunday 5pm
function doPost(e) {
  try {
    const body   = JSON.parse(e.postData.contents);
    const secret = PropertiesService.getScriptProperties().getProperty('SYNC_WEBHOOK_SECRET');
    if (!secret || body.key !== secret) {
      return ContentService.createTextOutput(JSON.stringify({ error: 'unauthorized' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (body.action === 'sync') {
      syncGhlToNotion();
      return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (body.action === 'setup-trigger') {
      deleteSyncTriggers();
      installWeeklyTrigger();
      return ContentService.createTextOutput(JSON.stringify({ status: 'ok', message: 'Weekly Sunday 5pm trigger installed.' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (body.action === 'write-brief-cache') {
      writeBriefCache_();
      return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    return ContentService.createTextOutput(JSON.stringify({ error: 'unknown action' }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ─── Daily Brief Data endpoint ────────────────────────────────────────────────
//
// GET ?action=brief-data&secret=<SYNC_WEBHOOK_SECRET>
// Returns pre-filtered Tasks, Companies, Projects, Notes in one JSON response.
//
// Database IDs used:
//   Tasks     01451a31-10f6-43aa-8047-e77c0579b614
//   Companies db150108-b987-4069-b77b-3ec7d76544db
//   Projects  a17fcc1f-52a4-47a8-8082-cf7a5a965685
//   Notes     bee79702-c20f-4c57-8cb4-8a79ddbcf0c3
//
// Property names to verify if queries fail:
//   Tasks:    Status (status type assumed — change to select if wrong)
//             Due Date (date)
//   Projects: Status (select assumed), Due Date (date)
//   Notes:    Date (date — verify actual property name), Company (relation), Brand (select)

function buildBriefData_() {
  var today    = new Date();
  today.setHours(0, 0, 0, 0);
  var todayStr = today.toISOString().slice(0, 10);
  var weekStr  = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  var sinceStr = new Date(today.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  return {
    generated_at:   new Date().toISOString(),
    tasks:          queryBriefTasks_(todayStr),
    companies:      queryBriefCompanies_(todayStr),
    projects:       queryBriefProjects_(todayStr, weekStr),
    notes_last_24h: queryBriefNotes_(sinceStr),
  };
}

function getDailyBriefData_(e) {
  const secret = PropertiesService.getScriptProperties().getProperty('SYNC_WEBHOOK_SECRET');
  if (!secret || e.parameter.secret !== secret) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'unauthorized' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  try {
    return ContentService.createTextOutput(JSON.stringify(buildBriefData_()))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Paginated Notion database query — returns all results across pages.
function notionQuery_(databaseId, payload) {
  const token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  var allResults = [];
  var cursor = null;
  var hasMore = true;

  while (hasMore) {
    var body = JSON.parse(JSON.stringify(payload)); // shallow clone
    if (cursor) body.start_cursor = cursor;

    var resp = UrlFetchApp.fetch(NOTION_BASE + '/databases/' + databaseId + '/query', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Notion-Version': '2022-06-28',
      },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });

    var data = JSON.parse(resp.getContentText());
    if (!data.results) {
      throw new Error('Notion query failed for ' + databaseId + ': ' + resp.getContentText().slice(0, 300));
    }
    allResults = allResults.concat(data.results);
    hasMore = !!data.has_more;
    cursor  = data.next_cursor || null;
  }

  return allResults;
}

function titleText_(props, key) {
  var p = props[key];
  if (!p) return '';
  if (p.title && p.title[0]) return p.title[0].plain_text;
  if (p.rich_text && p.rich_text[0]) return p.rich_text[0].plain_text;
  return '';
}

function queryBriefTasks_(todayStr) {
  // Filter: Status is not Done AND not Cancelled. Sort: Due Date ascending.
  // Status is confirmed "select" type in the Operational Tasks database.
  var pages = notionQuery_('01451a31-10f6-43aa-8047-e77c0579b614', {
    filter: {
      and: [
        { property: 'Status', select: { does_not_equal: 'Done' } },
        { property: 'Status', select: { does_not_equal: 'Cancelled' } }
      ]
    },
    sorts: [{ property: 'Due Date', direction: 'ascending' }]
  });

  var overdue = [], dueToday = [], upcoming = [];

  pages.forEach(function(page) {
    var props   = page.properties;
    var name    = titleText_(props, 'Task Name') || '(unnamed)';
    var st      = props['Status'];
    var status  = st ? ((st.status && st.status.name) || (st.select && st.select.name) || '') : '';
    var dueDate = props['Due Date'] && props['Due Date'].date ? props['Due Date'].date.start : null;

    var task = { name: name, status: status, due_date: dueDate };

    if (!dueDate) {
      upcoming.push(task);
    } else if (dueDate < todayStr) {
      overdue.push(task);
    } else if (dueDate === todayStr) {
      dueToday.push(task);
    } else {
      upcoming.push(task);
    }
  });

  return { overdue: overdue, due_today: dueToday, upcoming: upcoming };
}

function queryBriefCompanies_(todayStr) {
  // Filter: Visibility = Active. Bucket in Apps Script by status + days_since_contact.
  // Uses confirmed-working page ID for Companies database.
  var pages = notionQuery_(NOTION_DB_ID, {
    filter: { property: 'Visibility', select: { equals: 'Active' } }
  });

  var staleActiveClients = [], staleProspects = [], noContactLogged = [];
  var todayMs = new Date(todayStr).getTime();

  pages.forEach(function(page) {
    var props       = page.properties;
    var name        = titleText_(props, 'Company Name') || titleText_(props, 'Name') || '(unnamed)';
    var status      = props['Status'] && props['Status'].select ? props['Status'].select.name : '';
    var lastContact = props['Last Contact'] && props['Last Contact'].date
                      ? props['Last Contact'].date.start : null;

    if (!lastContact) {
      noContactLogged.push({ name: name, status: status });
      return;
    }

    var daysSince = Math.floor((todayMs - new Date(lastContact).getTime()) / 86400000);
    var entry     = { name: name, status: status, last_contact: lastContact, days_since_contact: daysSince };

    if (status === 'Active Client' && daysSince >= 7) {
      staleActiveClients.push(entry);
    } else if (status === 'Prospect' && daysSince >= 14) {
      staleProspects.push(entry);
    }
  });

  return {
    stale_active_clients: staleActiveClients,
    stale_prospects:      staleProspects,
    no_contact_logged:    noContactLogged
  };
}

function queryBriefProjects_(todayStr, weekStr) {
  // Filter: Status in [In Progress, Not Started, Waiting].
  // Assumes "Status" is a select property. Verify property names against schema if empty.
  var pages = notionQuery_('a17fcc1f-52a4-47a8-8082-cf7a5a965685', {
    filter: {
      or: [
        { property: 'Status', select: { equals: 'In Progress' } },
        { property: 'Status', select: { equals: 'Not Started' } },
        { property: 'Status', select: { equals: 'Waiting' } }
      ]
    }
  });

  var overdue = [], dueThisWeek = [], otherOpen = [];

  pages.forEach(function(page) {
    var props   = page.properties;
    var name    = titleText_(props, 'Project Name') || '(unnamed)';
    var status  = props['Status'] && props['Status'].select ? props['Status'].select.name : '';
    var dueDate = props['Due Date'] && props['Due Date'].date ? props['Due Date'].date.start : null;

    var entry = { name: name, status: status, due_date: dueDate };

    if (!dueDate) {
      otherOpen.push(entry);
    } else if (dueDate < todayStr) {
      overdue.push(entry);
    } else if (dueDate <= weekStr) {
      dueThisWeek.push(entry);
    } else {
      otherOpen.push(entry);
    }
  });

  return { overdue: overdue, due_this_week: dueThisWeek, other_open: otherOpen };
}

function queryBriefNotes_(sinceStr) {
  // Filter: Date on or after sinceStr (24h ago).
  // Verify property names: "Date" (date), "Company" (relation), "Brand" (select or text).
  var pages = notionQuery_('bee79702-c20f-4c57-8cb4-8a79ddbcf0c3', {
    filter: { property: 'Date', date: { on_or_after: sinceStr } },
    sorts:  [{ property: 'Date', direction: 'descending' }]
  });

  return pages.map(function(page) {
    var props   = page.properties;
    var name    = titleText_(props, 'Name') || titleText_(props, 'Note') || '(unnamed)';
    var date    = props['Date'] && props['Date'].date ? props['Date'].date.start : null;
    // Company is a relation — returns page IDs, not names
    var company = props['Company'] && props['Company'].relation && props['Company'].relation[0]
                  ? props['Company'].relation[0].id : '';
    var brand   = props['Brand'] && props['Brand'].select ? props['Brand'].select.name
                : (props['Brand'] && props['Brand'].rich_text && props['Brand'].rich_text[0]
                   ? props['Brand'].rich_text[0].plain_text : '');
    return { name: name, date: date, company: company, brand: brand };
  });
}

// ─── One-time OAuth setup helpers ─────────────────────────────────────────────

function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'brief-data') {
    return getDailyBriefData_(e);
  }
  const code = e && e.parameter && e.parameter.code;
  if (code) {
    return ContentService.createTextOutput(
      'Auth code received:\n\n' + code + '\n\n' +
      'Now run  exchangeCodeForTokens("' + code + '")  in the Apps Script editor.'
    );
  }
  return ContentService.createTextOutput('GHL OAuth redirect handler — no code in request.');
}

function getAuthUrl() {
  const p = PropertiesService.getScriptProperties();
  const clientId    = p.getProperty('GHL_CLIENT_ID');
  const redirectUri = p.getProperty('GHL_REDIRECT_URI');

  if (!clientId || !redirectUri) {
    Logger.log('❌ Set GHL_CLIENT_ID and GHL_REDIRECT_URI in Script Properties first.');
    return;
  }

  const scopes = 'opportunities.readonly conversations/message.readonly locations.readonly';
  const url =
    'https://marketplace.gohighlevel.com/oauth/chooselocation' +
    '?response_type=code' +
    '&redirect_uri=' + encodeURIComponent(redirectUri) +
    '&client_id=' + encodeURIComponent(clientId) +
    '&scope=' + encodeURIComponent(scopes) +
    '&user_type=Company';

  Logger.log('Open this URL in your browser to authorize:\n\n' + url);
}

function exchangeCodeForTokens(code) {
  const p = PropertiesService.getScriptProperties();
  const resp = UrlFetchApp.fetch(GHL_BASE + '/oauth/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      client_id:     p.getProperty('GHL_CLIENT_ID'),
      client_secret: p.getProperty('GHL_CLIENT_SECRET'),
      grant_type:    'authorization_code',
      code:          code,
    },
    muteHttpExceptions: true,
  });

  const data = JSON.parse(resp.getContentText());
  Logger.log('Response: ' + JSON.stringify(data));

  if (data.refresh_token) {
    p.setProperty('GHL_REFRESH_TOKEN', data.refresh_token);
    Logger.log('✅ GHL_REFRESH_TOKEN stored. OAuth setup complete.');
  } else {
    Logger.log('❌ No refresh_token — check client_id, client_secret, and redirect_uri match your GHL app exactly.');
  }
}

// ─── One-time setup helpers ───────────────────────────────────────────────────

function setWebhookSecret(secret) {
  PropertiesService.getScriptProperties().setProperty('SYNC_WEBHOOK_SECRET', secret);
  Logger.log('SYNC_WEBHOOK_SECRET set.');
}

// ─── Sub-account finder ───────────────────────────────────────────────────────

// Search all GHL sub-accounts by name fragment. Logs ID + name for each match.
// Usage: run findSubAccounts() then copy IDs into Notion GHL ID fields.
function findSubAccounts() {
  const agencyToken = getAgencyAccessToken();
  const queries = ['Joppa', 'Highland Park', 'Ironside'];

  queries.forEach(function(q) {
    var url = GHL_BASE + '/locations/search?companyId=' + GHL_COMPANY_ID + '&query=' + encodeURIComponent(q) + '&limit=5';
    var resp = UrlFetchApp.fetch(url, {
      headers: { 'Authorization': 'Bearer ' + agencyToken, 'Version': '2021-07-28' },
      muteHttpExceptions: true,
    });
    var data = JSON.parse(resp.getContentText());
    var locations = data.locations || [];
    if (!locations.length) {
      Logger.log('No results for "' + q + '"');
      return;
    }
    locations.forEach(function(loc) {
      Logger.log(q + ' → ' + loc.id + '  (' + loc.name + ')');
    });
  });
}

// ─── Debug ────────────────────────────────────────────────────────────────────

function debugAdrianaFetch() {
  var locId = 'go4koQW1pahaSqxZppSI';
  var agencyToken = getAgencyAccessToken();
  var locToken = getLocationAccessToken(agencyToken, locId);

  var oppUrl = GHL_BASE + '/opportunities/search?location_id=' + locId + '&limit=1&order=updatedAt';
  var oppResp = UrlFetchApp.fetch(oppUrl, {
    headers: { 'Authorization': 'Bearer ' + locToken, 'Version': '2021-07-28' },
    muteHttpExceptions: true
  });
  Logger.log('Opps: ' + oppResp.getContentText());

  var convoUrl = GHL_BASE + '/conversations/search?locationId=' + locId + '&limit=1&sortBy=last_message_date&sort=desc';
  var convoResp = UrlFetchApp.fetch(convoUrl, {
    headers: { 'Authorization': 'Bearer ' + agencyToken, 'Version': '2021-04-15' },
    muteHttpExceptions: true
  });
  Logger.log('Convos: ' + convoResp.getContentText());
}
