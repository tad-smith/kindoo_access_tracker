// CRUD for the KindooManagers tab.
//
// Email is the primary key. We store it AS TYPED (preserve case, dots,
// +suffix) so the Sheet shows what the manager actually entered. Equality
// is computed via Utils_emailsEqual (lower + Gmail dot/+suffix stripping
// + googlemail.com → gmail.com), so two display-forms of the same
// canonical address still match for lookup, uniqueness, and role
// resolution. See architecture.md D4.

const KINDOO_MGR_HEADERS_ = ['email', 'name', 'active'];

function KindooManagers_getAll() {
  var sheet = KindooManagers_sheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length === 0) return [];
  KindooManagers_assertHeaders_(data[0]);
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var rawEmail = data[i][0];
    if (rawEmail === '' || rawEmail == null) continue;
    out.push(KindooManagers_rowToObject_(data[i]));
  }
  return out;
}

function KindooManagers_getByEmail(email) {
  if (!email) return null;
  var rows = KindooManagers_getAll();
  for (var i = 0; i < rows.length; i++) {
    if (Utils_emailsEqual(rows[i].email, email)) return rows[i];
  }
  return null;
}

function KindooManagers_isActiveByEmail(email) {
  var row = KindooManagers_getByEmail(email);
  return !!(row && row.active);
}

function KindooManagers_getActiveEmails() {
  var rows = KindooManagers_getAll();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].active) out.push(rows[i].email);
  }
  return out;
}

// Insert. Caller must hold the script lock and emit AuditLog separately.
// Throws if any existing row's email canonicalises to the same value as
// the input (so two display-forms of the same person can't both land in
// the tab).
function KindooManagers_insert(row) {
  if (!row || !row.email) throw new Error('KindooManagers_insert: email required');
  var typed = Utils_cleanEmail(row.email);
  if (!typed) throw new Error('KindooManagers_insert: email did not parse');
  var sheet = KindooManagers_sheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length > 0) KindooManagers_assertHeaders_(data[0]);
  for (var i = 1; i < data.length; i++) {
    if (Utils_emailsEqual(data[i][0], typed)) {
      throw new Error('A Kindoo Manager with the same address (' + String(data[i][0]) +
        ') already exists. Edit that row instead.');
    }
  }
  var toWrite = {
    email:  typed,
    name:   row.name == null ? '' : String(row.name),
    active: row.active === true || String(row.active).trim().toLowerCase() === 'true'
  };
  sheet.appendRow([toWrite.email, toWrite.name, toWrite.active]);
  return toWrite;
}

// Bulk insert. Same contract as Buildings_bulkInsert / Wards_bulkInsert:
// validate all N rows (non-empty email, cross-batch canonical-email
// uniqueness, uniqueness against existing via Utils_emailsEqual) before
// any setValues. Caller owns lock + audit.
function KindooManagers_bulkInsert(rows) {
  if (!rows || rows.length === 0) return [];
  var sheet = KindooManagers_sheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length > 0) KindooManagers_assertHeaders_(data[0]);
  var existingCanonical = {};
  for (var i = 1; i < data.length; i++) {
    var e = String(data[i][0]);
    if (e === '' || e == null) continue;
    existingCanonical[Utils_normaliseEmail(e)] = true;
  }
  var seenCanonical = {};
  var prepared = [];
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    if (!row || !row.email) {
      throw new Error('KindooManagers_bulkInsert: row ' + (r + 1) + ' missing email');
    }
    var typed = Utils_cleanEmail(row.email);
    if (!typed) {
      throw new Error('KindooManagers_bulkInsert: row ' + (r + 1) + ' email did not parse');
    }
    var canon = Utils_normaliseEmail(typed);
    if (seenCanonical[canon]) {
      throw new Error('Duplicate manager email "' + typed + '" in the batch.');
    }
    if (existingCanonical[canon]) {
      throw new Error('A Kindoo Manager with the same address (' + typed + ') already exists.');
    }
    seenCanonical[canon] = true;
    prepared.push({
      email:  typed,
      name:   row.name == null ? '' : String(row.name),
      active: row.active === true || String(row.active).trim().toLowerCase() === 'true'
    });
  }
  var values = prepared.map(function (p) { return [p.email, p.name, p.active]; });
  var startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, values.length, KINDOO_MGR_HEADERS_.length).setValues(values);
  return prepared;
}

// Update by email-equality. Returns { before, after }. Throws if not found.
function KindooManagers_update(email, patch) {
  var typed = Utils_cleanEmail(email);
  if (!typed) throw new Error('KindooManagers_update: email required');
  var sheet = KindooManagers_sheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length > 0) KindooManagers_assertHeaders_(data[0]);
  for (var i = 1; i < data.length; i++) {
    if (!Utils_emailsEqual(data[i][0], typed)) continue;
    var before = KindooManagers_rowToObject_(data[i]);
    var nextEmail = before.email;
    if (patch && patch.email != null) {
      var nextTyped = Utils_cleanEmail(patch.email);
      if (!nextTyped) throw new Error('KindooManagers_update: new email did not parse');
      if (!Utils_emailsEqual(nextTyped, before.email)) {
        for (var j = 1; j < data.length; j++) {
          if (j === i) continue;
          if (Utils_emailsEqual(data[j][0], nextTyped)) {
            throw new Error('A Kindoo Manager with the same address (' + String(data[j][0]) +
              ') already exists.');
          }
        }
      }
      nextEmail = nextTyped;
    }
    var after = {
      email:  nextEmail,
      name:   patch && patch.name != null ? String(patch.name) : before.name,
      active: patch && patch.active != null
                ? (patch.active === true || String(patch.active).trim().toLowerCase() === 'true')
                : before.active
    };
    sheet.getRange(i + 1, 1, 1, KINDOO_MGR_HEADERS_.length)
         .setValues([[after.email, after.name, after.active]]);
    return { before: before, after: after };
  }
  throw new Error('KindooManagers_update: no row matching "' + typed + '"');
}

// Delete by email-equality. Returns the deleted row. Throws if not found.
function KindooManagers_delete(email) {
  var typed = Utils_cleanEmail(email);
  if (!typed) throw new Error('KindooManagers_delete: email required');
  var sheet = KindooManagers_sheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length > 0) KindooManagers_assertHeaders_(data[0]);
  for (var i = 1; i < data.length; i++) {
    if (Utils_emailsEqual(data[i][0], typed)) {
      var before = KindooManagers_rowToObject_(data[i]);
      sheet.deleteRow(i + 1);
      return before;
    }
  }
  throw new Error('KindooManagers_delete: no row matching "' + typed + '"');
}

function KindooManagers_sheet_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('KindooManagers');
  if (!sheet) throw new Error('KindooManagers tab missing — run setupSheet().');
  return sheet;
}

function KindooManagers_assertHeaders_(headers) {
  for (var h = 0; h < KINDOO_MGR_HEADERS_.length; h++) {
    if (String(headers[h]) !== KINDOO_MGR_HEADERS_[h]) {
      throw new Error('KindooManagers header drift at column ' + (h + 1) +
        ': expected "' + KINDOO_MGR_HEADERS_[h] + '", got "' + String(headers[h]) + '"');
    }
  }
}

function KindooManagers_rowToObject_(row) {
  return {
    email:  Utils_cleanEmail(String(row[0])),
    name:   String(row[1] == null ? '' : row[1]),
    active: row[2] === true || String(row[2]).trim().toLowerCase() === 'true'
  };
}
