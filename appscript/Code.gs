// MyPortal — Google Apps Script backend
// Sheet ID: 1UgVcQPbMI4cp6I1AvV7r1W_xBFb9rcAhhCPQa6f3Cmg
// v6.1: read, upsert, delete
// v7.0: archiveAccount, restoreAccount, updateClientWorkspace, updateAgencyNotes,
//        requestMagicLink, validateToken, readClient,
//        stampOnboarding, toggleOnboardingStep, addOnboardingStep, deleteOnboardingStep,
//        addComment

var SHEET_ID   = '1UgVcQPbMI4cp6I1AvV7r1W_xBFb9rcAhhCPQa6f3Cmg';
var PORTAL_URL = 'https://myportal.businesssmoothie.com';

// ── Entry points ───────────────────────────────────────────────────

function doGet(e) {
  var action   = (e.parameter.action || 'read');
  var callback = (e.parameter.callback || '');
  var result;

  try {
    if      (action === 'read')          { result = readAll(); }
    else if (action === 'readClient')    { result = readClient(e.parameter.orgId || ''); }
    else if (action === 'validateToken') { result = validateToken(e.parameter.token || ''); }
    else                                 { result = { error: 'Unknown GET action: ' + action }; }
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
  var expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  // Tokens tab columns: TokenID | OrgID | OrgName | Token | Expires | Used
  getTab('Tokens').appendRow([
    generateId('tok'),
    org.OrgID,
    org.OrgName || '',
    token,
    expires,
    false
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
  if (new Date() > new Date(match.Expires)) {
    return { valid: false, error: 'Token expired' };
  }

  // Mark used = TRUE
  var rowNum  = findRowById(sheet, 'Token', token);
  var usedCol = findColIndex(sheet, 'Used');
  if (rowNum > 0 && usedCol >= 0) {
    sheet.getRange(rowNum, usedCol + 1).setValue(true);
  }

  // Enrich with ContactName from Orgs
  var orgs = sheetToObjects(getTab('Orgs'));
  var org  = orgs.filter(function(r) { return String(r.OrgID) === String(match.OrgID); })[0] || {};

  return {
    valid:       true,
    orgId:       match.OrgID,
    orgName:     match.OrgName || org.OrgName || '',
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

  return { success: true, commentId: commentId, timestamp: timestamp };
}
