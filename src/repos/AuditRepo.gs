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
