// Reads and writes the Seats tab (live roster, no soft-delete).
//
// Chunk 3 exposes the minimum the importer needs:
//   - Seats_getByScope(scope)        — all rows for a scope (any type)
//   - Seats_getAutoByScope(scope)    — filter to type=auto (diff input)
//   - Seats_bulkInsertAuto(rows)     — batched append for import inserts
//   - Seats_deleteByHash(hash)       — single-row delete by source_row_hash
//
// Chunk 5 adds the read side for roster pages:
//   - Seats_getAll()                 — full scan used by manager AllSeats
//     (a single getDataRange() read instead of N per-scope reads; at
//     target scale ~250 rows that's well under any budget).
//
// Full CRUD (manual/temp insert, update, delete-by-id) lands in Chunks 5–7.
// The importer is the only writer here today.
//
// Emails are stored as typed per architecture.md D4 (Utils_cleanEmail — trim
// only). source_row_hash is computed on the canonical form (Utils_hashRow)
// so import idempotency survives LCR-side format drift.
//
// Lock acquisition + AuditLog writes are the CALLER's responsibility. The
// importer wraps its entire run in a single Lock_withLock acquisition and
// emits per-row AuditLog entries bracketed by import_start / import_end.

const SEATS_HEADERS_ = [
  'seat_id', 'scope', 'type', 'person_email', 'person_name',
  'calling_name', 'source_row_hash', 'reason', 'start_date',
  'end_date', 'building_names', 'created_by', 'created_at',
  'last_modified_by', 'last_modified_at'
];

function Seats_getAll() {
  return Seats_readAll_();
}

function Seats_getByScope(scope) {
  if (scope === undefined || scope === null) return [];
  var key = String(scope);
  var all = Seats_readAll_();
  var out = [];
  for (var i = 0; i < all.length; i++) {
    if (all[i].scope === key) out.push(all[i]);
  }
  return out;
}

function Seats_getAutoByScope(scope) {
  var rows = Seats_getByScope(scope);
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].type === 'auto') out.push(rows[i]);
  }
  return out;
}

// Batched insert for the importer. One setValues call per run rather than
// N appendRow calls (architecture.md §9 notes the importer is the only
// batched writer; 250 rows × ~150 ms per appendRow would be measurable —
// setValues collapses that to one network round-trip).
//
// Each input must carry:
//   scope, person_email, person_name, calling_name, source_row_hash
// Optional: building_names (default '')
// Fills: seat_id, type='auto', reason='', start_date='', end_date='',
//        created_by='Importer', created_at=now, last_modified_by='Importer',
//        last_modified_at=now.
//
// Returns the array of materialised seat objects (with seat_id, timestamps).
function Seats_bulkInsertAuto(rows) {
  if (!rows || rows.length === 0) return [];
  var sheet = Seats_sheet_();
  var headers = sheet.getRange(1, 1, 1, SEATS_HEADERS_.length).getValues()[0];
  Seats_assertHeaders_(headers);
  var now = new Date();
  var materialised = [];
  var values = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r) throw new Error('Seats_bulkInsertAuto: row ' + i + ' is empty');
    if (!r.scope) throw new Error('Seats_bulkInsertAuto: row ' + i + ' missing scope');
    if (!r.source_row_hash) throw new Error('Seats_bulkInsertAuto: row ' + i + ' missing source_row_hash');
    var seat = {
      seat_id:          Utils_uuid(),
      scope:            String(r.scope),
      type:             'auto',
      person_email:     Utils_cleanEmail(r.person_email),
      person_name:      r.person_name == null ? '' : String(r.person_name),
      calling_name:     r.calling_name == null ? '' : String(r.calling_name),
      source_row_hash:  String(r.source_row_hash),
      reason:           '',
      start_date:       '',
      end_date:         '',
      building_names:   r.building_names == null ? '' : String(r.building_names),
      created_by:       'Importer',
      created_at:       now,
      last_modified_by: 'Importer',
      last_modified_at: now
    };
    materialised.push(seat);
    values.push([
      seat.seat_id, seat.scope, seat.type, seat.person_email, seat.person_name,
      seat.calling_name, seat.source_row_hash, seat.reason, seat.start_date,
      seat.end_date, seat.building_names, seat.created_by, seat.created_at,
      seat.last_modified_by, seat.last_modified_at
    ]);
  }
  var startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, values.length, SEATS_HEADERS_.length).setValues(values);
  return materialised;
}

// Delete the first auto-row whose source_row_hash equals `hash`. Returns
// the deleted object, or null if no match. Manual/temp rows do not have a
// source_row_hash so never match.
function Seats_deleteByHash(hash) {
  if (!hash) throw new Error('Seats_deleteByHash: hash required');
  var key = String(hash);
  var sheet = Seats_sheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length === 0) return null;
  Seats_assertHeaders_(data[0]);
  var hashCol = 6; // 0-based index of source_row_hash
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === '' || data[i][0] == null) continue;
    if (String(data[i][hashCol]) !== key) continue;
    var before = Seats_rowToObject_(data[i]);
    sheet.deleteRow(i + 1);
    return before;
  }
  return null;
}

function Seats_readAll_() {
  var sheet = Seats_sheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length === 0) return [];
  Seats_assertHeaders_(data[0]);
  var out = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === '' || data[i][0] == null) continue;
    out.push(Seats_rowToObject_(data[i]));
  }
  return out;
}

function Seats_sheet_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Seats');
  if (!sheet) throw new Error('Seats tab missing — run setupSheet().');
  return sheet;
}

function Seats_assertHeaders_(headers) {
  for (var h = 0; h < SEATS_HEADERS_.length; h++) {
    if (String(headers[h]) !== SEATS_HEADERS_[h]) {
      throw new Error('Seats header drift at column ' + (h + 1) +
        ': expected "' + SEATS_HEADERS_[h] + '", got "' + String(headers[h]) + '"');
    }
  }
}

function Seats_rowToObject_(row) {
  return {
    seat_id:          String(row[0]),
    scope:            String(row[1] == null ? '' : row[1]),
    type:             String(row[2] == null ? '' : row[2]),
    person_email:     Utils_cleanEmail(String(row[3] == null ? '' : row[3])),
    person_name:      String(row[4] == null ? '' : row[4]),
    calling_name:     String(row[5] == null ? '' : row[5]),
    source_row_hash:  String(row[6] == null ? '' : row[6]),
    reason:           String(row[7] == null ? '' : row[7]),
    start_date:       row[8] == null ? '' : String(row[8]),
    end_date:         row[9] == null ? '' : String(row[9]),
    building_names:   String(row[10] == null ? '' : row[10]),
    created_by:       String(row[11] == null ? '' : row[11]),
    created_at:       row[12] instanceof Date ? row[12] : (row[12] == null ? null : row[12]),
    last_modified_by: String(row[13] == null ? '' : row[13]),
    last_modified_at: row[14] instanceof Date ? row[14] : (row[14] == null ? null : row[14])
  };
}
