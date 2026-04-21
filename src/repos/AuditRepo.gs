// Append-only writer for the AuditLog tab.
//
// Caller passes actor_email explicitly — there is NO fallback to
// Session.getActiveUser. Under Main's executeAs: USER_DEPLOYING, Session
// returns the deployer (or empty), and silently recording the deployer as
// the actor for every write would defeat the whole "two identities" model.
// See architecture.md §5.
//
// The Sheet's file-level revision history will always show the deployer
// for every row — that's correct and uninteresting. AuditLog.actor_email
// is the authoritative authorship record.

const AUDIT_HEADERS_ = ['timestamp', 'actor_email', 'action', 'entity_type',
                        'entity_id', 'before_json', 'after_json'];

function AuditRepo_write(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('AuditRepo.write: entry object required');
  }
  if (!entry.actor_email) {
    throw new Error('AuditRepo.write: actor_email required (no fallback to Session.*)');
  }
  if (!entry.action) {
    throw new Error('AuditRepo.write: action required');
  }
  if (!entry.entity_type) {
    throw new Error('AuditRepo.write: entity_type required');
  }
  if (entry.entity_id === undefined || entry.entity_id === null || entry.entity_id === '') {
    throw new Error('AuditRepo.write: entity_id required');
  }
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('AuditLog');
  if (!sheet) throw new Error('AuditLog tab missing — run setupSheet().');

  var headers = sheet.getRange(1, 1, 1, AUDIT_HEADERS_.length).getValues()[0];
  for (var h = 0; h < AUDIT_HEADERS_.length; h++) {
    if (String(headers[h]) !== AUDIT_HEADERS_[h]) {
      throw new Error('AuditLog header drift at column ' + (h + 1) +
        ': expected "' + AUDIT_HEADERS_[h] + '", got "' + String(headers[h]) + '"');
    }
  }

  // null/undefined → empty cell. Insert audit rows have empty before_json;
  // delete audit rows have empty after_json. JSON.stringify default produces
  // single-line output, which keeps the cell scrollable rather than
  // ballooning the row height.
  var beforeStr = (entry.before === undefined || entry.before === null)
                  ? '' : JSON.stringify(entry.before);
  var afterStr  = (entry.after  === undefined || entry.after  === null)
                  ? '' : JSON.stringify(entry.after);

  sheet.appendRow([
    new Date(),
    String(entry.actor_email),
    String(entry.action),
    String(entry.entity_type),
    String(entry.entity_id),
    beforeStr,
    afterStr
  ]);
}

// Batched writer — one setValues call for N entries. Used by the importer
// (Chunk 3), which emits one audit row per inserted/deleted Seats and
// Access row: hundreds on a fresh install. Per-row appendRow would sit
// around ~150 ms each and eat into the 6-minute execution cap; one
// setValues keeps audit I/O under a second even for full first-run
// populations. Preserves array order.
//
// Same validation as AuditRepo_write: every entry requires
// actor_email / action / entity_type / entity_id. Header drift is
// checked once, not per entry.
function AuditRepo_writeMany(entries) {
  if (!entries || entries.length === 0) return;
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('AuditLog');
  if (!sheet) throw new Error('AuditLog tab missing — run setupSheet().');
  var headers = sheet.getRange(1, 1, 1, AUDIT_HEADERS_.length).getValues()[0];
  for (var h = 0; h < AUDIT_HEADERS_.length; h++) {
    if (String(headers[h]) !== AUDIT_HEADERS_[h]) {
      throw new Error('AuditLog header drift at column ' + (h + 1) +
        ': expected "' + AUDIT_HEADERS_[h] + '", got "' + String(headers[h]) + '"');
    }
  }
  var now = new Date();
  var values = [];
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!e || !e.actor_email) {
      throw new Error('AuditRepo.writeMany: entry ' + i + ' missing actor_email');
    }
    if (!e.action) throw new Error('AuditRepo.writeMany: entry ' + i + ' missing action');
    if (!e.entity_type) throw new Error('AuditRepo.writeMany: entry ' + i + ' missing entity_type');
    if (e.entity_id === undefined || e.entity_id === null || e.entity_id === '') {
      throw new Error('AuditRepo.writeMany: entry ' + i + ' missing entity_id');
    }
    var beforeStr = (e.before === undefined || e.before === null) ? '' : JSON.stringify(e.before);
    var afterStr  = (e.after  === undefined || e.after  === null) ? '' : JSON.stringify(e.after);
    values.push([
      now,
      String(e.actor_email),
      String(e.action),
      String(e.entity_type),
      String(e.entity_id),
      beforeStr,
      afterStr
    ]);
  }
  var startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, values.length, AUDIT_HEADERS_.length).setValues(values);
}
