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
// Chunk 6 adds the manual/temp write side:
//   - Seats_getById(seat_id)         — looked up before inline edits
//   - Seats_getActiveByScopeAndEmail — duplicate-check lookup (req → seat)
//   - Seats_insert(row)              — manual/temp insert on request complete
//   - Seats_update(seat_id, patch)   — inline edit of manual/temp fields
//                                       (person_name, reason, building_names,
//                                        and dates on temp). scope, type,
//                                        seat_id, person_email are immutable.
//                                       auto rows are still importer-owned;
//                                       the UI does not expose an edit
//                                       affordance on them.
//
// Chunk 7 adds:
//   - Seats_deleteById(seat_id)     — single-row delete by PK for the
//     remove-request complete path. Caller (RequestsService_complete) owns
//     the lock and the AuditLog write per the repo/service boundary.
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

// Chunk 6: single-row lookup by seat_id. Used by the inline-edit path
// on the manager AllSeats page so the API layer has a `before` shape for
// the audit row.
function Seats_getById(seatId) {
  if (!seatId) return null;
  var key = String(seatId);
  var all = Seats_readAll_();
  for (var i = 0; i < all.length; i++) {
    if (all[i].seat_id === key) return all[i];
  }
  return null;
}

// Chunk 6: duplicate-check. Returns every seat in the given scope whose
// person_email canonicalises to the supplied email. Used by
// ApiRequests_checkDuplicate and RequestsQueue's server-side duplicate
// warning — "active" here means "in the tab right now" (no soft-delete
// in the schema, per spec §3.2 — rows are inserted on add, deleted on
// remove/expire, so every row is active).
function Seats_getActiveByScopeAndEmail(scope, email) {
  if (!scope || !email) return [];
  var scopeKey = String(scope);
  var rows = Seats_getByScope(scopeKey);
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (Utils_emailsEqual(rows[i].person_email, email)) out.push(rows[i]);
  }
  return out;
}

// Chunk 6: manual / temp insert. Caller (RequestsService_complete) provides
// the full row shape — seat_id (UUID), scope, type ('manual' | 'temp'),
// person_email / person_name / reason / start_date / end_date /
// building_names / created_by / last_modified_by. The repo fills
// created_at / last_modified_at from the server clock and validates
// type ∈ {manual, temp} (auto rows are the importer's responsibility via
// Seats_bulkInsertAuto; mixing surfaces would break import idempotency).
function Seats_insert(row) {
  if (!row || typeof row !== 'object') throw new Error('Seats_insert: row required');
  if (!row.seat_id)      throw new Error('Seats_insert: seat_id required');
  if (!row.scope)        throw new Error('Seats_insert: scope required');
  if (row.type !== 'manual' && row.type !== 'temp') {
    throw new Error('Seats_insert: type must be "manual" or "temp" (auto rows use Seats_bulkInsertAuto)');
  }
  if (!row.created_by)       throw new Error('Seats_insert: created_by required');
  if (!row.last_modified_by) throw new Error('Seats_insert: last_modified_by required');

  var sheet = Seats_sheet_();
  var headers = sheet.getRange(1, 1, 1, SEATS_HEADERS_.length).getValues()[0];
  Seats_assertHeaders_(headers);

  // Uniqueness check on seat_id — symmetric with Requests_insert.
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(row.seat_id)) {
      throw new Error('Seats_insert: duplicate seat_id "' + row.seat_id + '"');
    }
  }

  var now = row.created_at instanceof Date ? row.created_at : new Date();
  var modAt = row.last_modified_at instanceof Date ? row.last_modified_at : now;

  var seat = {
    seat_id:          String(row.seat_id),
    scope:            String(row.scope),
    type:             String(row.type),
    person_email:     Utils_cleanEmail(row.person_email),
    person_name:      row.person_name == null ? '' : String(row.person_name),
    calling_name:     '',       // manual/temp never carry a calling
    source_row_hash:  '',       // manual/temp never have a hash
    reason:           row.reason == null ? '' : String(row.reason),
    start_date:       row.start_date == null ? '' : String(row.start_date),
    end_date:         row.end_date == null ? '' : String(row.end_date),
    building_names:   row.building_names == null ? '' : String(row.building_names),
    created_by:       String(row.created_by),
    created_at:       now,
    last_modified_by: String(row.last_modified_by),
    last_modified_at: modAt
  };
  sheet.appendRow([
    seat.seat_id, seat.scope, seat.type, seat.person_email, seat.person_name,
    seat.calling_name, seat.source_row_hash, seat.reason, seat.start_date,
    seat.end_date, seat.building_names, seat.created_by, seat.created_at,
    seat.last_modified_by, seat.last_modified_at
  ]);
  return seat;
}

// Chunk 6: manager inline edit. Mutable fields:
//   - person_name            (always)
//   - reason                 (always — required for manual/temp per spec)
//   - building_names         (always)
//   - start_date, end_date   (only when row.type === 'temp')
//   - last_modified_by       (caller provides; typically managerPrincipal.email)
//
// Immutable: seat_id, scope, type, person_email, calling_name,
// source_row_hash, created_by, created_at. Changing any of them means a
// different seat; the right path is delete (Seats_deleteById, Chunk 7)
// + insert. Refusing here defends the audit trail (a patch that looked
// like `{person_email: 'new@example.com'}` would turn a seat into a new
// person silently).
//
// auto rows refuse every patch — they're importer-owned and would be
// clobbered on the next run; the UI hides the edit affordance on them,
// but the repo reinforces the rule.
function Seats_update(seatId, patch) {
  if (!seatId) throw new Error('Seats_update: seat_id required');
  if (!patch || typeof patch !== 'object') {
    throw new Error('Seats_update: patch object required');
  }
  var sheet = Seats_sheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length === 0) throw new Error('Seats_update: no seat with seat_id "' + seatId + '"');
  Seats_assertHeaders_(data[0]);
  var key = String(seatId);
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) !== key) continue;
    var before = Seats_rowToObject_(data[i]);

    if (before.type === 'auto') {
      throw new Error('Auto seats are managed by the weekly import and cannot be edited here. ' +
        'Changes made in the callings sheet flow through on the next Import Now run.');
    }

    // Refuse immutable-field patches loudly rather than silently ignoring them —
    // a client bug that thinks it's renaming a person should surface, not
    // look successful.
    var immutable = ['seat_id', 'scope', 'type', 'person_email',
                     'calling_name', 'source_row_hash',
                     'created_by', 'created_at'];
    for (var m = 0; m < immutable.length; m++) {
      if (patch[immutable[m]] !== undefined) {
        throw new Error('Seats_update: cannot modify "' + immutable[m] + '" — it is immutable. ' +
          'If you need to change this, delete the seat and create a new one.');
      }
    }

    // Temp-only fields are silently ignored on non-temp rows (harmless;
    // the UI only surfaces the date inputs on temp rows, and a patch with
    // null/undefined dates from a manual-row edit shouldn't throw).
    var isTemp = before.type === 'temp';
    var nextStart = before.start_date;
    var nextEnd   = before.end_date;
    if (isTemp) {
      if (patch.start_date !== undefined) nextStart = patch.start_date == null ? '' : String(patch.start_date);
      if (patch.end_date   !== undefined) nextEnd   = patch.end_date   == null ? '' : String(patch.end_date);
    } else {
      if (patch.start_date !== undefined || patch.end_date !== undefined) {
        // Loud failure on a date patch to a manual row — almost certainly a
        // UI bug, and silently dropping would mask it.
        throw new Error('Seats_update: start_date / end_date are only editable on temp seats (type=' + before.type + ').');
      }
    }

    var now = new Date();
    var after = {
      seat_id:          before.seat_id,
      scope:            before.scope,
      type:             before.type,
      person_email:     before.person_email,
      person_name:      patch.person_name    !== undefined ? (patch.person_name    == null ? '' : String(patch.person_name))    : before.person_name,
      calling_name:     before.calling_name,
      source_row_hash:  before.source_row_hash,
      reason:           patch.reason         !== undefined ? (patch.reason         == null ? '' : String(patch.reason))         : before.reason,
      start_date:       nextStart,
      end_date:         nextEnd,
      building_names:   patch.building_names !== undefined ? (patch.building_names == null ? '' : String(patch.building_names)) : before.building_names,
      created_by:       before.created_by,
      created_at:       before.created_at,
      last_modified_by: patch.last_modified_by != null ? String(patch.last_modified_by) : before.last_modified_by,
      last_modified_at: now
    };
    sheet.getRange(i + 1, 1, 1, SEATS_HEADERS_.length).setValues([[
      after.seat_id, after.scope, after.type, after.person_email, after.person_name,
      after.calling_name, after.source_row_hash, after.reason, after.start_date,
      after.end_date, after.building_names, after.created_by, after.created_at,
      after.last_modified_by, after.last_modified_at
    ]]);
    return { before: before, after: after };
  }
  throw new Error('Seats_update: no seat with seat_id "' + seatId + '"');
}

// Chunk 7: delete a row by seat_id. Returns the deleted object, or null
// if no row matched (the caller — RequestsService_complete on a remove
// request — interprets the null as the R-1 race: the seat was already
// gone by the time complete fired). Symmetric with Seats_getById /
// Seats_update — same lookup, but the row is removed rather than mutated.
//
// No type guard here. Auto rows are theoretically removable via this path
// (the service layer guarantees that won't happen — remove requests are
// rejected on submit if they target an auto row, see RequestsService_submit
// and ApiBishopric / ApiStake roster pages, which only render the X on
// manual/temp rows). Keeping the repo dumb means a future "force-delete
// auto seat" surface (none planned) doesn't have to fight the repo.
function Seats_deleteById(seatId) {
  if (!seatId) throw new Error('Seats_deleteById: seat_id required');
  var key = String(seatId);
  var sheet = Seats_sheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length === 0) return null;
  Seats_assertHeaders_(data[0]);
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === '' || data[i][0] == null) continue;
    if (String(data[i][0]) !== key) continue;
    var before = Seats_rowToObject_(data[i]);
    sheet.deleteRow(i + 1);
    return before;
  }
  return null;
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
