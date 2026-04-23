// setupSheet(): idempotently create all 10 tabs with canonical headers and
// seed well-known Config keys. Also installs an onOpen() admin menu on the
// bound Sheet so common ops actions don't require the script editor.
//
// Run from the Apps Script editor, or via Kindoo Admin → Setup sheet… in the
// Sheet UI after the first push (the menu appears on the next sheet open).

// Tab definitions in the order they should appear in the sheet.
// Headers are the canonical case-sensitive set from docs/data-model.md.
const SETUP_TAB_DEFS_ = [
  { name: 'Config',
    headers: ['key', 'value'] },
  { name: 'KindooManagers',
    headers: ['email', 'name', 'active'] },
  { name: 'Buildings',
    headers: ['building_name', 'address'] },
  { name: 'Wards',
    headers: ['ward_code', 'ward_name', 'building_name', 'seat_cap'] },
  { name: 'WardCallingTemplate',
    headers: ['calling_name', 'give_app_access'] },
  { name: 'StakeCallingTemplate',
    headers: ['calling_name', 'give_app_access'] },
  { name: 'Access',
    headers: ['email', 'scope', 'calling'] },
  { name: 'Seats',
    headers: ['seat_id', 'scope', 'type', 'person_email', 'person_name',
              'calling_name', 'source_row_hash', 'reason', 'start_date',
              'end_date', 'building_names', 'created_by', 'created_at',
              'last_modified_by', 'last_modified_at'] },
  { name: 'Requests',
    headers: ['request_id', 'type', 'scope', 'target_email', 'target_name',
              'reason', 'comment', 'start_date', 'end_date', 'building_names',
              'status', 'requester_email', 'requested_at', 'completer_email',
              'completed_at', 'rejection_reason', 'completion_note'] },
  { name: 'AuditLog',
    headers: ['timestamp', 'actor_email', 'action', 'entity_type',
              'entity_id', 'before_json', 'after_json'] }
];

// Config keys seeded with default (or empty) values on first run. Existing
// values are never overwritten. session_secret is special: if seeded as
// empty, Setup_ensureSessionSecret_ generates a strong random value on the
// same run.
const SETUP_CONFIG_SEED_ = [
  { key: 'stake_name',            value: '' },
  { key: 'callings_sheet_id',     value: '' },
  { key: 'stake_seat_cap',        value: '' },
  { key: 'bootstrap_admin_email', value: '' },
  { key: 'main_url',              value: '' },
  { key: 'identity_url',          value: '' },
  { key: 'session_secret',        value: '' },
  { key: 'setup_complete',        value: false },
  { key: 'last_import_at',        value: '' },
  { key: 'last_import_summary',   value: '' },
  // Chunk 10: symmetric with the Importer's last-run stamps. Written at
  // the end of Expiry_runExpiry so the Dashboard can render "last expiry:
  // <ts>, N rows" without scanning the AuditLog. Empty string seed means
  // "never run"; the Expiry service fills both on its next run.
  { key: 'last_expiry_at',        value: '' },
  { key: 'last_expiry_summary',   value: '' },
  { key: 'expiry_hour',           value: 3 },
  // Chunk 9: weekly importer trigger schedule. Script timezone (see
  // appsscript.json). Default: Sunday 04:00 local. Editable from the
  // manager Config page; saving either one requires "Reinstall triggers"
  // to take effect (architecture.md §9.3).
  { key: 'import_day',            value: 'SUNDAY' },
  { key: 'import_hour',           value: 4 },
  // Chunk 9: persisted per-scope over-cap snapshot from the last import
  // run. JSON-encoded array; empty string (or '[]') means "no over-caps".
  // Read by the manager Import page to render a red banner after page
  // load without a second import call. Not editable from the UI — the
  // importer owns the value.
  { key: 'last_over_caps_json',   value: '' },
  // Chunk 6: global off-switch for request-lifecycle notification emails.
  // TRUE by default (the spec calls for emails on submit / complete /
  // reject / cancel). Flip to FALSE via the manager Config page during
  // testing, while the mailbox is being set up, or if a bad address in
  // KindooManagers is generating bounces while an operator triages.
  { key: 'notifications_enabled', value: true }
];

function setupSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var report = [];

  for (var i = 0; i < SETUP_TAB_DEFS_.length; i++) {
    Setup_ensureTab_(ss, SETUP_TAB_DEFS_[i], report);
  }
  Setup_seedConfig_(ss, report);
  Setup_ensureSessionSecret_(ss, report);
  Setup_removeDefaultSheet1_(ss, report);

  var summary = report.join('\n');
  Logger.log(summary);
  return summary;
}

function Setup_ensureTab_(ss, def, report) {
  var sheet = ss.getSheetByName(def.name);
  if (!sheet) {
    sheet = ss.insertSheet(def.name);
    sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, def.headers.length).setFontWeight('bold');
    report.push('CREATED  ' + def.name + '  (' + def.headers.length + ' cols)');
    return;
  }
  // Existing tab — verify headers byte-for-byte.
  var lastCol = Math.max(sheet.getLastColumn(), def.headers.length);
  var existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var driftCol = -1;
  for (var h = 0; h < def.headers.length; h++) {
    if (String(existing[h]) !== def.headers[h]) {
      driftCol = h;
      break;
    }
  }
  if (driftCol >= 0) {
    var msg = 'HEADER DRIFT in ' + def.name + ' at column ' + (driftCol + 1) +
      ': expected "' + def.headers[driftCol] +
      '", got "' + String(existing[driftCol]) + '". Fix by hand; setupSheet refuses to touch this tab.';
    Logger.log(msg);
    report.push('SKIP     ' + def.name + '  (header drift — see log)');
    return;
  }
  report.push('OK       ' + def.name);
}

function Setup_seedConfig_(ss, report) {
  var sheet = ss.getSheetByName('Config');
  if (!sheet) return;
  var data = sheet.getDataRange().getValues();
  var existingKeys = {};
  for (var i = 1; i < data.length; i++) {
    var k = data[i][0];
    if (k !== '' && k != null) existingKeys[String(k)] = true;
  }
  var toAdd = [];
  for (var j = 0; j < SETUP_CONFIG_SEED_.length; j++) {
    var seed = SETUP_CONFIG_SEED_[j];
    if (!existingKeys[seed.key]) toAdd.push([seed.key, seed.value]);
  }
  if (toAdd.length === 0) {
    report.push('OK       Config keys (no seeding needed)');
    return;
  }
  sheet.getRange(sheet.getLastRow() + 1, 1, toAdd.length, 2).setValues(toAdd);
  report.push('SEEDED   Config (' + toAdd.length + ' missing key' +
    (toAdd.length === 1 ? '' : 's') + ')');
}

// Generates a strong random session_secret on first setup if the cell is
// empty (or contains a placeholder shorter than 32 chars). Two concatenated
// UUIDs = 73 chars, ~256 bits of entropy — comfortably enough for HMAC-SHA256.
// Existing values are never overwritten — to rotate, the admin clears the
// cell and re-runs setupSheet (and accepts that all live tokens become
// invalid, which is what rotation should mean).
function Setup_ensureSessionSecret_(ss, report) {
  var sheet = ss.getSheetByName('Config');
  if (!sheet) return;
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] !== 'session_secret') continue;
    var existing = data[i][1];
    if (existing && String(existing).length >= 32) {
      report.push('OK       Config.session_secret (already set)');
      return;
    }
    var generated = Utilities.getUuid() + '-' + Utilities.getUuid();
    sheet.getRange(i + 1, 2).setValue(generated);
    report.push('GENERATED Config.session_secret');
    return;
  }
}

function Setup_removeDefaultSheet1_(ss, report) {
  var sheet1 = ss.getSheetByName('Sheet1');
  if (!sheet1) return;
  if (ss.getSheets().length === 1) return; // never delete the last sheet
  if (sheet1.getLastRow() > 1 || sheet1.getLastColumn() > 1) {
    report.push('SKIP     Sheet1 (not empty — leaving it alone)');
    return;
  }
  ss.deleteSheet(sheet1);
  report.push('REMOVED  Sheet1 (empty default)');
}

// onOpen() runs whenever someone opens the bound Sheet. We use it to install
// a Kindoo Admin menu so setup actions don't require the script editor.
//
// Chunk 8 added "Install/reinstall triggers" and "Run expiry now". Chunk 9
// adds "Run weekly import now" — the same code path the weekly trigger
// fires, but initiated by the operator; useful for debugging without
// waiting for the scheduled time or logging into the web app.
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Kindoo Admin')
    .addItem('Setup sheet…', 'setupSheet')
    .addSeparator()
    .addItem('Install/reinstall triggers', 'TriggersService_install')
    .addItem('Run expiry now', 'Expiry_runExpiry')
    .addItem('Run weekly import now', 'Importer_runImport')
    .addSeparator()
    .addItem('Run normaliseEmail tests', 'Utils_test_normaliseEmail')
    .addItem('Run emailsEqual tests', 'Utils_test_emailsEqual')
    .addItem('Run base64url tests', 'Utils_test_base64Url')
    .addItem('Run Importer email-cell tests', 'Importer_test_extractEmailFromCell')
    .addItem('Run Importer wildcard tests', 'Importer_test_wildcardMatch')
    .addItem('Run forbidden-path tests', 'ApiManager_test_forbidden')
    .addToUi();
}
