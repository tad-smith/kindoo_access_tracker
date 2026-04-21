// CRUD for the Access tab. The importer (Chunk 3) is the only writer —
// the manager UI exposes a read-only view; there is no bishopric/stake
// write path at all.
//
// Emails are stored as typed (preserve case + dots + +suffix); equality
// is via Utils_emailsEqual (architecture.md D4). Uniqueness for upsert
// is (canonical_email, scope, calling).
//
// Lock acquisition + audit writes are the CALLER's responsibility — this
// module does pure single-tab data access (architecture.md §7).

const ACCESS_HEADERS_ = ['email', 'scope', 'calling'];

function Access_getAll() {
  var sheet = Access_sheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length === 0) return [];
  Access_assertHeaders_(data[0]);
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var rawEmail = data[i][0];
    if (rawEmail === '' || rawEmail == null) continue;
    out.push({
      email:   Utils_cleanEmail(String(rawEmail)),
      scope:   String(data[i][1] == null ? '' : data[i][1]),
      calling: String(data[i][2] == null ? '' : data[i][2])
    });
  }
  return out;
}

function Access_getByEmail(email) {
  if (!email) return [];
  var all = Access_getAll();
  var out = [];
  for (var i = 0; i < all.length; i++) {
    if (Utils_emailsEqual(all[i].email, email)) out.push(all[i]);
  }
  return out;
}

function Access_getByScope(scope) {
  if (scope === undefined || scope === null) return [];
  var key = String(scope);
  var all = Access_getAll();
  var out = [];
  for (var i = 0; i < all.length; i++) {
    if (all[i].scope === key) out.push(all[i]);
  }
  return out;
}

// Pure insert. Caller handles uniqueness / diff semantics (the importer
// computes the desired set and only calls _insert for truly-new rows).
// No lock, no audit.
function Access_insert(row) {
  if (!row) throw new Error('Access_insert: row required');
  var typed = Utils_cleanEmail(row.email);
  if (!typed) throw new Error('Access_insert: email required');
  var scope = String(row.scope == null ? '' : row.scope);
  if (!scope) throw new Error('Access_insert: scope required');
  var calling = String(row.calling == null ? '' : row.calling);
  if (!calling) throw new Error('Access_insert: calling required');
  var sheet = Access_sheet_();
  // Header check on write path, symmetric with the read path.
  var headers = sheet.getRange(1, 1, 1, ACCESS_HEADERS_.length).getValues()[0];
  Access_assertHeaders_(headers);
  sheet.appendRow([typed, scope, calling]);
  return { email: typed, scope: scope, calling: calling };
}

// Pure delete by composite key (canonical_email, scope, calling). Scope
// and calling compare exact-string; email compares canonical-on-the-fly.
// Deletes the first matching row. Returns the deleted object, or null if
// nothing matched (caller decides whether "nothing to delete" is an error
// — the importer treats it as a defensive no-op).
function Access_delete(email, scope, calling) {
  var typedEmail = Utils_cleanEmail(email);
  var scopeKey = String(scope == null ? '' : scope);
  var callingKey = String(calling == null ? '' : calling);
  var sheet = Access_sheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length === 0) return null;
  Access_assertHeaders_(data[0]);
  for (var i = 1; i < data.length; i++) {
    var rowEmail = data[i][0];
    if (rowEmail === '' || rowEmail == null) continue;
    if (String(data[i][1]) !== scopeKey) continue;
    if (String(data[i][2]) !== callingKey) continue;
    if (!Utils_emailsEqual(rowEmail, typedEmail)) continue;
    var before = {
      email:   Utils_cleanEmail(String(rowEmail)),
      scope:   scopeKey,
      calling: callingKey
    };
    sheet.deleteRow(i + 1);
    return before;
  }
  return null;
}

function Access_sheet_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Access');
  if (!sheet) throw new Error('Access tab missing — run setupSheet().');
  return sheet;
}

function Access_assertHeaders_(headers) {
  for (var h = 0; h < ACCESS_HEADERS_.length; h++) {
    if (String(headers[h]) !== ACCESS_HEADERS_[h]) {
      throw new Error('Access header drift at column ' + (h + 1) +
        ': expected "' + ACCESS_HEADERS_[h] + '", got "' + String(headers[h]) + '"');
    }
  }
}
