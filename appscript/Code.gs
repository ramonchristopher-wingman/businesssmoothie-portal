// MyPortal — Google Apps Script backend
// Sheet ID: 1UgVcQPbMI4cp6I1AvV7r1W_xBFb9rcAhhCPQa6f3Cmg
// v6.1: read, upsert, delete
// v7.0: archiveAccount, restoreAccount, updateClientWorkspace, updateAgencyNotes,
//        requestMagicLink, validateToken, readClient,
//        stampOnboarding, toggleOnboardingStep, addOnboardingStep, deleteOnboardingStep,
//        addComment
// v7.1: requestAdminMagicLink, validateAdminToken, addComment (+ email notifications)
// v7.2: addMessage
// v8.0: saveFcmToken; FCM push via HTTP v1 API; unified notifyClient/notifyAdmin; email fallback

var SHEET_ID   = '1UgVcQPbMI4cp6I1AvV7r1W_xBFb9rcAhhCPQa6f3Cmg';
var PORTAL_URL = 'https://portal.businesssmoothie.com';

// ── Notification event config ──────────────────────────────────────
// Set any value to false to disable that notification type globally.
var NOTIFICATION_CONFIG = {
  newMessage:             true,  // admin → client: new message sent
  clientMessageReply:     true,  // client → admin: client sent a message
  taskAssigned:           true,  // admin → client: task assigned
  taskStatusChange:       true,  // admin → client: task status updated
  onboardingStepComplete: true,  // client → admin: client completed a step
  projectUpdate:          true,  // admin → client: project updated
  commentFromAdmin:       true,  // admin → client: admin left a comment
  commentFromClient:      true   // client → admin: client left a comment
};

// ── Firebase / FCM credentials ────────────────────────────────────
// Store these in Apps Script → Project Settings → Script Properties:
//   FCM_PROJECT_ID  →  business-smoothie-portal
//   FCM_SA_EMAIL    →  your-sa@business-smoothie-portal.iam.gserviceaccount.com
//   FCM_SA_KEY      →  -----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n
// Also add FCMToken column to Orgs tab and Admins tab (one device per user for now).
// Also add NotifSent column to Messages tab (boolean — email dedup guard).

// ── Entry points ───────────────────────────────────────────────────

function doGet(e) {
  var action   = (e.parameter.action || 'read');
  var callback = (e.parameter.callback || '');
  var result;

  try {
    if      (action === 'read')          { result = readAll(); }
    else if (action === 'readClient')         { result = readClient(e.parameter.orgId || ''); }
    else if (action === 'validateToken')      { result = validateToken(e.parameter.token || ''); }
    else if (action === 'validateAdminToken') { result = validateAdminToken(e.parameter.token || ''); }
    else                                      { result = { error: 'Unknown GET action: ' + action }; }
  } catch (err) {
    result = { error: err.toString() };
  }

  var json = JSON.stringify(result);
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var p      = e.parameter;
  var action = p.action || '';
  var result = { success: false, error: 'No action matched' };

  try {
    switch (action) {
      // ── v6.1 ──────────────────────────────────────────────────
      case 'upsert':
        result = upsertRow(p.tab, JSON.parse(p.data || '{}'));
        break;
      case 'delete':
        result = deleteRow(p.tab, p.id);
        break;

      // ── v7.0 ──────────────────────────────────────────────────
      case 'archiveAccount':
        result = setOrgStatus(p.orgId, 'archived');
        break;
      case 'restoreAccount':
        result = setOrgStatus(p.orgId, 'active');
        break;
      case 'updateClientWorkspace':
        result = updateOrgField(p.orgId, 'ClientWorkspace', p.value || '');
        break;
      case 'updateAgencyNotes':
        result = updateOrgField(p.orgId, 'AgencyNotes', p.value || '');
        break;
      case 'requestMagicLink':
        result = requestMagicLink(p.email || '');
        break;
      case 'stampOnboarding':
        result = stampOnboarding(p.orgId || '');
        break;
      case 'toggleOnboardingStep':
        result = toggleOnboardingStep(
          p.stepId || '',
          p.done === 'true',
          p.completedBy || '',
          p.doneDate || ''
        );
        break;
      case 'addOnboardingStep':
        result = addOnboardingStep(p.orgId || '', p.stepName || '', p.assignedTo || 'both');
        break;
      case 'deleteOnboardingStep':
        result = deleteOnboardingStep(p.stepId || '');
        break;
      case 'addComment':
        result = addComment(p.taskId || '', p.orgId || '', p.author || '', p.authorRole || 'admin', p.body || '');
        break;
      case 'requestAdminMagicLink':
        result = requestAdminMagicLink(p.email || '');
        break;

      // ── v7.2 ──────────────────────────────────────────────────
      case 'addMessage':
        result = addMessage(p.orgId || '', p.orgName || '', p.sender || 'Ramon', p.body || '');
        break;

      // ── v8.0 ──────────────────────────────────────────────────
      case 'saveFcmToken':
        result = saveFcmToken(p.orgId || '', p.token || '', p.tokenType || 'client');
        break;

      default:
        result = { success: false, error: 'Unknown action: ' + action };
    }
  } catch (err) {
    result = { success: false, error: err.toString() };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Low-level sheet helpers ────────────────────────────────────────

function ss() {
  return SpreadsheetApp.openById(SHEET_ID);
}

function getTab(name) {
  var sheet = ss().getSheetByName(name);
  if (!sheet) throw new Error('Tab not found: ' + name);
  return sheet;
}

function sheetToObjects(sheet) {
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  var headers = data[0];
  return data.slice(1).map(function(row) {
    var obj = {};
    headers.forEach(function(h, i) { obj[String(h)] = row[i]; });
    return obj;
  });
}

// Returns 1-based row number of the first row where idCol === id, or -1.
function findRowById(sheet, idCol, id) {
  var data    = sheet.getDataRange().getValues();
  var headers = data[0];
  var colIdx  = headers.indexOf(idCol);
  if (colIdx === -1) return -1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][colIdx]) === String(id)) return i + 1;
  }
  return -1;
}

// Returns 0-based column index of a named header, or -1.
function findColIndex(sheet, colName) {
  var lastCol  = sheet.getLastColumn();
  if (lastCol < 1) return -1;
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  return headers.indexOf(colName);
}

function generateId(prefix) {
  return (prefix || 'id') + '_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
}

function generateToken32() {
  var chars  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var result = '';
  for (var i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// ── v6.1: read / upsert / delete ──────────────────────────────────

function readAll() {
  var s = ss();
  return {
    orgs:       sheetToObjects(s.getSheetByName('Orgs')),
    projects:   sheetToObjects(s.getSheetByName('Projects')),
    tasks:      sheetToObjects(s.getSheetByName('Tasks')),
    ideas:      sheetToObjects(s.getSheetByName('Ideas')),
    messages:   sheetToObjects(s.getSheetByName('Messages')),
    onboarding: sheetToObjects(s.getSheetByName('Onboarding')),
    comments:   sheetToObjects(s.getSheetByName('Comments'))
  };
}

// Returns only data scoped to one OrgID — served to the client portal.
function readClient(orgId) {
  if (!orgId) return { error: 'orgId required' };
  var s = ss();

  function byOrg(rows) {
    return rows.filter(function(r) { return String(r.OrgID) === String(orgId); });
  }

  var orgs = sheetToObjects(s.getSheetByName('Orgs'));
  var org  = orgs.filter(function(r) { return String(r.OrgID) === String(orgId); })[0] || {};

  return {
    projects:        byOrg(sheetToObjects(s.getSheetByName('Projects'))),
    tasks:           byOrg(sheetToObjects(s.getSheetByName('Tasks'))),
    onboarding:      byOrg(sheetToObjects(s.getSheetByName('Onboarding'))),
    comments:        byOrg(sheetToObjects(s.getSheetByName('Comments'))),
    clientWorkspace: org.ClientWorkspace || ''
  };
}

function upsertRow(tabName, data) {
  var sheet   = getTab(tabName);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var idCol   = headers[0];
  var id      = data[idCol];
  var rowNum  = id ? findRowById(sheet, idCol, id) : -1;
  var rowData = headers.map(function(h) { return (data[h] !== undefined) ? data[h] : ''; });

  if (rowNum > 0) {
    sheet.getRange(rowNum, 1, 1, rowData.length).setValues([rowData]);
  } else {
    sheet.appendRow(rowData);
  }
  return { success: true };
}

function deleteRow(tabName, id) {
  var sheet   = getTab(tabName);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var idCol   = headers[0];
  var rowNum  = findRowById(sheet, idCol, id);
  if (rowNum < 1) return { success: false, error: 'Row not found' };
  sheet.deleteRow(rowNum);
  return { success: true };
}

// ── v7.0: archive / restore / workspace / notes ───────────────────

function setOrgStatus(orgId, status) {
  if (!orgId) return { success: false, error: 'orgId required' };
  var sheet  = getTab('Orgs');
  var rowNum = findRowById(sheet, 'OrgID', orgId);
  if (rowNum < 1) return { success: false, error: 'Org not found' };
  var col = findColIndex(sheet, 'Status');
  if (col < 0) return { success: false, error: 'Status column missing from Orgs tab' };
  sheet.getRange(rowNum, col + 1).setValue(status);
  return { success: true };
}

function updateOrgField(orgId, fieldName, value) {
  if (!orgId) return { success: false, error: 'orgId required' };
  var sheet  = getTab('Orgs');
  var rowNum = findRowById(sheet, 'OrgID', orgId);
  if (rowNum < 1) return { success: false, error: 'Org not found' };
  var col = findColIndex(sheet, fieldName);
  if (col < 0) return { success: false, error: fieldName + ' column missing from Orgs tab' };
  sheet.getRange(rowNum, col + 1).setValue(value);
  return { success: true };
}

// ── v7.0: magic link ──────────────────────────────────────────────

function requestMagicLink(email) {
  if (!email) return { success: false, error: 'Email required' };

  var orgs = sheetToObjects(getTab('Orgs'));
  var org  = orgs.filter(function(r) {
    return String(r.ContactEmail || '').toLowerCase().trim() === email.toLowerCase().trim();
  })[0];

  if (!org) return { success: false, error: 'Email not found' };

  var token   = generateToken32();
  var now     = new Date().toISOString();
  var expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  // Tokens tab columns: Token | OrgID | Email | CreatedAt | ExpiresAt | Used | TokenType
  getTab('Tokens').appendRow([
    token,
    org.OrgID,
    email,
    now,
    expires,
    false,
    'client'
  ]);

  var link    = PORTAL_URL + '?token=' + token;
  var subject = 'Your login link — Business Smoothie Client Portal';
  var body    =
    'Hi ' + (org.ContactName || 'there') + ',\n\n' +
    'Click the link below to access your client portal.\n' +
    'This link expires in 24 hours and can only be used once.\n\n' +
    link + '\n\n' +
    '— Business Smoothie';

  MailApp.sendEmail(email, subject, body);
  return { success: true };
}

// ── v7.0: validate token ──────────────────────────────────────────

function validateToken(token) {
  if (!token) return { valid: false, error: 'No token provided' };

  var sheet = getTab('Tokens');
  var rows  = sheetToObjects(sheet);

  var match = rows.filter(function(r) { return String(r.Token) === String(token); })[0];
  if (!match) return { valid: false, error: 'Token not found' };

  // Check used
  if (match.Used === true || String(match.Used).toUpperCase() === 'TRUE') {
    return { valid: false, error: 'Token already used' };
  }

  // Check expiry
  if (new Date() > new Date(match.ExpiresAt)) {
    return { valid: false, error: 'Token expired' };
  }

  // Mark used = TRUE
  var rowNum  = findRowById(sheet, 'Token', token);
  var usedCol = findColIndex(sheet, 'Used');
  if (rowNum > 0 && usedCol >= 0) {
    sheet.getRange(rowNum, usedCol + 1).setValue(true);
  }

  // Enrich with OrgName and ContactName from Orgs
  var orgs = sheetToObjects(getTab('Orgs'));
  var org  = orgs.filter(function(r) { return String(r.OrgID) === String(match.OrgID); })[0] || {};

  return {
    valid:       true,
    orgId:       match.OrgID,
    orgName:     org.OrgName || '',
    contactName: org.ContactName || ''
  };
}

// ── v7.0: onboarding ──────────────────────────────────────────────

function stampOnboarding(orgId) {
  if (!orgId) return { success: false, error: 'orgId required' };

  var obSheet = getTab('Onboarding');
  var existing = sheetToObjects(obSheet).filter(function(r) {
    return String(r.OrgID) === String(orgId);
  });
  if (existing.length > 0) {
    return { success: false, error: 'Onboarding already started for this org', steps: existing };
  }

  var templates = sheetToObjects(getTab('OnboardingTemplates'));

  // Onboarding tab columns: StepID | OrgID | StepName | AssignedTo | Done | CompletedBy | DoneDate | Order
  templates.forEach(function(t) {
    obSheet.appendRow([
      generateId('step'),
      orgId,
      t.StepName   || '',
      t.AssignedTo || 'both',
      false,
      '',
      '',
      t.Order || 0
    ]);
  });

  var newSteps = sheetToObjects(obSheet).filter(function(r) {
    return String(r.OrgID) === String(orgId);
  });
  return { success: true, steps: newSteps };
}

function toggleOnboardingStep(stepId, done, completedBy, doneDate) {
  if (!stepId) return { success: false, error: 'stepId required' };

  var sheet  = getTab('Onboarding');
  var rowNum = findRowById(sheet, 'StepID', stepId);
  if (rowNum < 1) return { success: false, error: 'Step not found' };

  var doneCol    = findColIndex(sheet, 'Done');
  var byCol      = findColIndex(sheet, 'CompletedBy');
  var dateCol    = findColIndex(sheet, 'DoneDate');

  if (doneCol >= 0)  sheet.getRange(rowNum, doneCol  + 1).setValue(done);
  if (byCol   >= 0)  sheet.getRange(rowNum, byCol    + 1).setValue(done ? (completedBy || '') : '');
  if (dateCol >= 0)  sheet.getRange(rowNum, dateCol  + 1).setValue(
    done ? (doneDate || new Date().toISOString().slice(0, 10)) : ''
  );

  // Notify Ramon when a client (non-admin) completes a step
  if (done && completedBy && completedBy.toLowerCase() !== 'ramon') {
    try {
      var steps    = sheetToObjects(sheet);
      var step     = steps.filter(function(r) { return String(r.StepID) === String(stepId); })[0];
      var stepName = step ? (step.StepName || stepId) : stepId;
      notifyAdmin(
        'Onboarding step completed',
        (completedBy || 'A client') + ' completed: ' + stepName + '\n\n' + PORTAL_URL,
        'onboardingStepComplete'
      );
    } catch (e) { }
  }

  return { success: true };
}

function addOnboardingStep(orgId, stepName, assignedTo) {
  if (!orgId || !stepName) return { success: false, error: 'orgId and stepName required' };

  var sheet    = getTab('Onboarding');
  var existing = sheetToObjects(sheet).filter(function(r) {
    return String(r.OrgID) === String(orgId);
  });
  var maxOrder = existing.reduce(function(m, r) {
    return Math.max(m, parseInt(r.Order) || 0);
  }, 0);

  var stepId = generateId('step');
  sheet.appendRow([stepId, orgId, stepName, assignedTo || 'both', false, '', '', maxOrder + 1]);
  return { success: true, stepId: stepId };
}

function deleteOnboardingStep(stepId) {
  if (!stepId) return { success: false, error: 'stepId required' };

  var sheet  = getTab('Onboarding');
  var rowNum = findRowById(sheet, 'StepID', stepId);
  if (rowNum < 1) return { success: false, error: 'Step not found' };
  sheet.deleteRow(rowNum);
  return { success: true };
}

// ── v7.0: comments ────────────────────────────────────────────────

function addComment(taskId, orgId, author, authorRole, body) {
  if (!taskId || !body) return { success: false, error: 'taskId and body required' };

  // Comments tab columns: CommentID | TaskID | OrgID | Author | AuthorRole | Body | Timestamp
  var commentId = generateId('cmt');
  var timestamp = new Date().toISOString();

  getTab('Comments').appendRow([
    commentId,
    taskId,
    orgId,
    author     || '',
    authorRole || 'admin',
    body,
    timestamp
  ]);

  // ── v8.0: unified push / email notification ───────────────
  try {
    var taskRows = sheetToObjects(getTab('Tasks'));
    var taskRow  = taskRows.filter(function(r) { return String(r.TaskID) === String(taskId); })[0];
    var taskName = taskRow ? (taskRow.TaskName || 'a task') : 'a task';

    if ((authorRole || '').toLowerCase() === 'client') {
      notifyAdmin(
        'New comment from ' + (author || 'a client'),
        (author || 'Client') + ' commented on ' + taskName + ':\n\n' + body + '\n\n' + PORTAL_URL,
        'commentFromClient'
      );
    } else {
      notifyClient(orgId, null, 'Business Smoothie Portal',
        'New update on your task: ' + taskName, 'commentFromAdmin');
    }
  } catch (e) {
    // notification failure must not break the comment save
  }

  return { success: true, commentId: commentId, timestamp: timestamp };
}

// ── v7.1: admin magic link ─────────────────────────────────────────

function requestAdminMagicLink(email) {
  if (!email) return { success: false, error: 'Email required' };

  var admins = sheetToObjects(getTab('Admins'));
  var admin  = admins.filter(function(r) {
    return String(r.Email || '').toLowerCase().trim() === email.toLowerCase().trim();
  })[0];

  if (!admin) return { success: false, error: 'Email not found' };
  if (String(admin.Active).toUpperCase() !== 'TRUE') {
    return { success: false, error: 'Account is not active' };
  }

  var token   = generateToken32();
  var now     = new Date().toISOString();
  var expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  // Tokens tab columns: Token | OrgID | Email | CreatedAt | ExpiresAt | Used | TokenType
  getTab('Tokens').appendRow([
    token,
    admin.AdminID || '',
    email,
    now,
    expires,
    false,
    'admin'
  ]);

  var link    = PORTAL_URL + '?admintoken=' + token;
  var subject = 'Your login link — MyPortal';
  var body    =
    'Hi ' + (admin.Name || 'there') + ',\n\n' +
    'Click the link below to access MyPortal.\n' +
    'This link expires in 24 hours and can only be used once.\n\n' +
    link + '\n\n' +
    '— Business Smoothie';

  MailApp.sendEmail(email, subject, body);
  return { success: true };
}

function validateAdminToken(token) {
  if (!token) return { valid: false, error: 'No token provided' };

  var sheet = getTab('Tokens');
  var rows  = sheetToObjects(sheet);

  var match = rows.filter(function(r) {
    return String(r.Token) === String(token) && String(r.TokenType) === 'admin';
  })[0];
  if (!match) return { valid: false, error: 'Token not found' };

  if (match.Used === true || String(match.Used).toUpperCase() === 'TRUE') {
    return { valid: false, error: 'Token already used' };
  }
  if (new Date() > new Date(match.ExpiresAt)) {
    return { valid: false, error: 'Token expired' };
  }

  // Mark used
  var rowNum  = findRowById(sheet, 'Token', token);
  var usedCol = findColIndex(sheet, 'Used');
  if (rowNum > 0 && usedCol >= 0) {
    sheet.getRange(rowNum, usedCol + 1).setValue(true);
  }

  // Look up admin record
  var admins = sheetToObjects(getTab('Admins'));
  var admin  = admins.filter(function(r) {
    return String(r.AdminID) === String(match.OrgID);
  })[0] || {};

  return {
    valid: true,
    name:  admin.Name  || '',
    email: admin.Email || match.Email || ''
  };
}

// ── v7.2: addMessage ──────────────────────────────────────────────

function addMessage(orgId, orgName, sender, body) {
  if (!orgId || !body) return { success: false, error: 'orgId and body required' };
  var msgId     = generateId('msg');
  var timestamp = new Date().toISOString();

  // Messages tab columns: MsgID | OrgID | OrgName | SenderName | Body | Timestamp | Read | NotifSent
  // Add NotifSent column to the Messages tab in the sheet if not already present.
  getTab('Messages').appendRow([msgId, orgId, orgName || '', sender || 'Ramon', body, timestamp, true, false]);

  try {
    var isAdminSender = ((sender || '').toLowerCase() === 'ramon');
    if (isAdminSender) {
      notifyClient(orgId, msgId, 'Business Smoothie Portal',
        'You have a new message from your team.', 'newMessage');
    } else {
      notifyAdmin(
        'New message from ' + (orgName || 'a client'),
        (sender || 'Client') + ' says: ' + body.slice(0, 200),
        'clientMessageReply'
      );
    }
  } catch (e) { }

  return { success: true, msgId: msgId, timestamp: timestamp };
}

// ── v8.0: FCM push notifications ─────────────────────────────────

// Save an FCM device token for a client (orgId = OrgID) or admin (orgId = Email).
// Requires FCMToken column in Orgs tab (for clients) and Admins tab (for admins).
function saveFcmToken(orgId, token, tokenType) {
  if (!orgId || !token) return { success: false, error: 'orgId and token required' };
  var tabName = (tokenType === 'admin') ? 'Admins' : 'Orgs';
  var idCol   = (tokenType === 'admin') ? 'Email'  : 'OrgID';
  var sheet   = getTab(tabName);
  var rowNum  = findRowById(sheet, idCol, orgId);
  var col     = findColIndex(sheet, 'FCMToken');
  if (col < 0)    return { success: false, error: 'FCMToken column missing from ' + tabName + ' tab — add it first' };
  if (rowNum < 1) return { success: false, error: 'Record not found in ' + tabName };
  sheet.getRange(rowNum, col + 1).setValue(token);
  return { success: true };
}

// Exchange service account key for a short-lived OAuth2 access token for FCM.
function getFcmAccessToken() {
  var props   = PropertiesService.getScriptProperties();
  var saEmail = props.getProperty('FCM_SA_EMAIL');
  var saKey   = props.getProperty('FCM_SA_KEY');
  if (!saEmail || !saKey) throw new Error('FCM_SA_EMAIL or FCM_SA_KEY not set in Script Properties');

  var now     = Math.floor(Date.now() / 1000);
  var header  = Utilities.base64EncodeWebSafe(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).replace(/=+$/, '');
  var payload = Utilities.base64EncodeWebSafe(JSON.stringify({
    iss:   saEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600
  })).replace(/=+$/, '');

  var toSign    = header + '.' + payload;
  var signature = Utilities.base64EncodeWebSafe(
    Utilities.computeRsaSha256Signature(toSign, saKey)
  ).replace(/=+$/, '');

  var resp   = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method:  'post',
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: toSign + '.' + signature },
    muteHttpExceptions: true
  });
  var parsed = JSON.parse(resp.getContentText());
  if (!parsed.access_token) throw new Error('Token exchange failed: ' + resp.getContentText());
  return parsed.access_token;
}

// Send a push notification via FCM HTTP v1 API. Returns true on success.
function sendPush(fcmToken, title, body) {
  var props     = PropertiesService.getScriptProperties();
  var projectId = props.getProperty('FCM_PROJECT_ID');
  if (!projectId) { console.warn('FCM_PROJECT_ID not set in Script Properties'); return false; }

  try {
    var accessToken = getFcmAccessToken();
    var message = {
      message: {
        token: fcmToken,
        notification: { title: title, body: body },
        webpush: { fcm_options: { link: PORTAL_URL } }
      }
    };
    var resp = UrlFetchApp.fetch(
      'https://fcm.googleapis.com/v1/projects/' + projectId + '/messages:send',
      {
        method:      'post',
        contentType: 'application/json',
        headers:     { Authorization: 'Bearer ' + accessToken },
        payload:     JSON.stringify(message),
        muteHttpExceptions: true
      }
    );
    return resp.getResponseCode() === 200;
  } catch (err) {
    console.error('sendPush failed: ' + err.message);
    return false;
  }
}

// Notify a client: push if they have an FCM token, else email with NotifSent dedup guard.
// msgId is the Messages tab row ID — pass null for non-message events (comments, etc.).
function notifyClient(orgId, msgId, title, body, eventType) {
  if (!NOTIFICATION_CONFIG[eventType]) return;
  if (!orgId) return;

  var orgs = sheetToObjects(getTab('Orgs'));
  var org  = orgs.filter(function(r) { return String(r.OrgID) === String(orgId); })[0];
  if (!org) return;

  var fcmToken = String(org.FCMToken || '').trim();
  if (fcmToken) {
    sendPush(fcmToken, title, body);
    return;
  }

  // Email fallback — only if a contact email is set
  if (!org.ContactEmail) return;

  // Dedup guard: if this is a message event, check/set NotifSent before emailing
  if (msgId) {
    var msgSheet = getTab('Messages');
    var rowNum   = findRowById(msgSheet, 'MsgID', msgId);
    var notifCol = findColIndex(msgSheet, 'NotifSent');
    if (rowNum > 0 && notifCol >= 0) {
      var sent = msgSheet.getRange(rowNum, notifCol + 1).getValue();
      if (sent === true || String(sent).toUpperCase() === 'TRUE') return;
      msgSheet.getRange(rowNum, notifCol + 1).setValue(true); // mark before sending
    }
  }

  var firstName = String(org.ContactName || '').split(' ')[0] || 'there';
  MailApp.sendEmail({
    to:      org.ContactEmail,
    name:    'Business Smoothie Portal',
    subject: 'You have a new message in your Business Smoothie Portal',
    body:    'Hi ' + firstName + ',\n\n' +
             'You have a new message waiting in your Business Smoothie Portal.\n\n' +
             'View Message → ' + PORTAL_URL + '\n\n' +
             '— The Smoothie Squad'
  });
}

// Notify the admin (Ramon): push if FCM token registered, else email ramon@businesssmoothie.com.
function notifyAdmin(title, body, eventType) {
  if (!NOTIFICATION_CONFIG[eventType]) return;

  var admins = sheetToObjects(getTab('Admins'));
  var admin  = admins.filter(function(r) { return String(r.Active).toUpperCase() === 'TRUE'; })[0];
  if (!admin) return;

  var fcmToken = String(admin.FCMToken || '').trim();
  if (fcmToken) {
    sendPush(fcmToken, title, body);
    return;
  }

  MailApp.sendEmail({
    to:      'ramon@businesssmoothie.com',
    name:    'Business Smoothie Portal',
    subject: title,
    body:    body
  });
}
