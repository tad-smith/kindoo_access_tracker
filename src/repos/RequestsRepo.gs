// CRUD for the Requests tab (pending / complete / rejected / cancelled).
//
// `request_id` is a system-generated UUID PK (architecture.md D3); callers
// never see or choose it. Emails (target_email, requester_email,
// completer_email) are stored AS TYPED (trim only) per architecture.md D4;
// equality via Utils_emailsEqual.
//
// Chunk 6 scope:
//   - Requests_getAll()
//   - Requests_getById(request_id)
//   - Requests_getPending()                       — manager queue feed
//   - Requests_getByRequester(email)              — My Requests, all scopes
//   - Requests_getByRequesterAndScope(email, sc)  — My Requests, filtered
//   - Requests_insert(row)                        — full row, any status
//   - Requests_update(request_id, patch)          — limited field set only
//
// Chunk 7 additions:
//   - Requests_getPendingRemoveByScopeAndEmail(scope, email)
//       Single-row lookup for the "removal pending" badge on roster pages
//       and for the duplicate-remove guard in RequestsService_submit.
//   - `completion_note` column on every row (data-model.md Tab 9). Used by
//     RequestsService_complete on the R-1 race ("seat already removed at
//     completion time — no-op") so the audit trail stays honest without
//     overloading rejection_reason. Mutable via Requests_update.
//
// There is intentionally NO Requests_delete — cancelled / rejected /
// completed rows persist so the audit trail holds. State machine transitions
// (pending → complete / rejected / cancelled) are enforced one layer up in
// services/RequestsService.gs; Requests_update only guards which COLUMNS
// may change (status + completer + rejection_reason), not which TRANSITIONS
// are valid. That keeps the repo pure single-tab; service layer owns the
// business invariant.
//
// Lock acquisition + AuditLog writes are the CALLER's responsibility
// (architecture.md §7). RequestsService wraps its work in Lock_withLock
// and emits audit rows in the same closure.

const REQUESTS_HEADERS_ = [
  'request_id', 'type', 'scope',
  'target_email', 'target_name',
  'reason', 'comment',
  'start_date', 'end_date',
  'building_names',
  'status',
  'requester_email', 'requested_at',
  'completer_email', 'completed_at',
  'rejection_reason',
  'completion_note'
];

// Fields Requests_update will accept. The rest of a request row (type,
// scope, target, reason, requester, requested_at, dates) is IMMUTABLE once
// inserted — changing any of them would rewrite history. If a requester
// changes their mind they cancel and submit a new request; if a manager
// needs a different add, they reject with reason and wait for a resubmit.
//
// completion_note (Chunk 7) carries the R-1 "seat already removed at
// completion time" note. Distinct from rejection_reason so the audit log
// can tell a no-op apart from a manager-initiated rejection.
const REQUESTS_MUTABLE_FIELDS_ = {
  status:           true,
  completer_email:  true,
  completed_at:     true,
  rejection_reason: true,
  completion_note:  true
};

const REQUESTS_VALID_STATUSES_ = {
  pending:   true,
  complete:  true,
  rejected:  true,
  cancelled: true
};

const REQUESTS_VALID_TYPES_ = {
  add_manual: true,
  add_temp:   true,
  remove:     true  // Chunk 7: live request type. Roster X/trashcan submits
                    // these; RequestsService_complete deletes the matching
                    // Seats row (or auto-completes with a note if the seat
                    // is already gone — see R-1).
};

function Requests_getAll() {
  return Requests_readAll_();
}

function Requests_getById(requestId) {
  if (!requestId) return null;
  var key = String(requestId);
  var all = Requests_readAll_();
  for (var i = 0; i < all.length; i++) {
    if (all[i].request_id === key) return all[i];
  }
  return null;
}

function Requests_getPending() {
  var all = Requests_readAll_();
  var out = [];
  for (var i = 0; i < all.length; i++) {
    if (all[i].status === 'pending') out.push(all[i]);
  }
  return out;
}

// Canonical-email match so `Alice.Smith@gmail.com` requests show up for a
// principal signing in as `alicesmith@gmail.com` and vice-versa.
function Requests_getByRequester(email) {
  if (!email) return [];
  var all = Requests_readAll_();
  var out = [];
  for (var i = 0; i < all.length; i++) {
    if (Utils_emailsEqual(all[i].requester_email, email)) out.push(all[i]);
  }
  return out;
}

function Requests_getByRequesterAndScope(email, scope) {
  if (!email || !scope) return [];
  var key = String(scope);
  var mine = Requests_getByRequester(email);
  var out = [];
  for (var i = 0; i < mine.length; i++) {
    if (mine[i].scope === key) out.push(mine[i]);
  }
  return out;
}

// Chunk 7: lookup the (at most one) pending `remove` request matching
// (scope, target_email). Used by:
//   - RequestsService_submit('remove', …) to refuse duplicate submits.
//   - Rosters_buildResponseForScope to flag the row's `removal_pending`
//     badge so the X/trashcan can render disabled.
//   - ApiManager_listRequests for symmetric defence (a pending remove
//     against an already-removed seat shows the no-op indicator).
//
// Canonical-email match via Utils_emailsEqual, so a `first.last@gmail.com`
// roster row and a `firstlast@gmail.com` request still resolve to the
// same person. Returns the first match (there should be at most one;
// the submit-time guard enforces it).
function Requests_getPendingRemoveByScopeAndEmail(scope, email) {
  if (!scope || !email) return null;
  var scopeKey = String(scope);
  var all = Requests_readAll_();
  for (var i = 0; i < all.length; i++) {
    var r = all[i];
    if (r.status !== 'pending') continue;
    if (r.type !== 'remove') continue;
    if (r.scope !== scopeKey) continue;
    if (Utils_emailsEqual(r.target_email, email)) return r;
  }
  return null;
}

// Insert a fresh Request row. Caller is responsible for generating
// request_id (so services can return it without a round-trip), setting
// `status`, `requester_email`, and `requested_at`. This keeps the repo
// dumb: it writes exactly what it's handed after validating the shape.
function Requests_insert(row) {
  if (!row || typeof row !== 'object') {
    throw new Error('Requests_insert: row object required');
  }
  if (!row.request_id) throw new Error('Requests_insert: request_id required');
  if (!row.type || !REQUESTS_VALID_TYPES_[row.type]) {
    throw new Error('Requests_insert: invalid type "' + row.type + '"');
  }
  if (!row.scope) throw new Error('Requests_insert: scope required');
  if (!row.status || !REQUESTS_VALID_STATUSES_[row.status]) {
    throw new Error('Requests_insert: invalid status "' + row.status + '"');
  }
  if (!row.requester_email) throw new Error('Requests_insert: requester_email required');

  var sheet = Requests_sheet_();
  var headers = sheet.getRange(1, 1, 1, REQUESTS_HEADERS_.length).getValues()[0];
  Requests_assertHeaders_(headers);

  // Uniqueness check on request_id is belt-and-braces — Utils_uuid gives
  // us ~128 bits of entropy so collisions are astronomical, but cheap
  // here and protects against a caller reusing an id on a retry.
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(row.request_id)) {
      throw new Error('Requests_insert: duplicate request_id "' + row.request_id + '"');
    }
  }

  var toWrite = Requests_normaliseInput_(row);
  sheet.appendRow([
    toWrite.request_id, toWrite.type, toWrite.scope,
    toWrite.target_email, toWrite.target_name,
    toWrite.reason, toWrite.comment,
    toWrite.start_date, toWrite.end_date,
    toWrite.building_names,
    toWrite.status,
    toWrite.requester_email, toWrite.requested_at,
    toWrite.completer_email, toWrite.completed_at,
    toWrite.rejection_reason, toWrite.completion_note
  ]);
  return toWrite;
}

// Targeted update. Only status / completer_email / completed_at /
// rejection_reason can change; a patch that touches any other field
// throws. Returns { before, after }.
//
// Does not enforce state-machine transitions (that's
// RequestsService_complete / _reject / _cancel's job — which read the row
// first, assert `status==='pending'`, and then call this).
function Requests_update(requestId, patch) {
  if (!requestId) throw new Error('Requests_update: request_id required');
  if (!patch || typeof patch !== 'object') {
    throw new Error('Requests_update: patch object required');
  }
  for (var k in patch) {
    if (!patch.hasOwnProperty(k)) continue;
    if (!REQUESTS_MUTABLE_FIELDS_[k]) {
      throw new Error('Requests_update: cannot modify "' + k + '" — ' +
        'only status / completer_email / completed_at / rejection_reason / completion_note are mutable.');
    }
  }
  if (patch.status != null && !REQUESTS_VALID_STATUSES_[patch.status]) {
    throw new Error('Requests_update: invalid status "' + patch.status + '"');
  }

  var sheet = Requests_sheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length > 0) Requests_assertHeaders_(data[0]);
  var key = String(requestId);
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) !== key) continue;
    var before = Requests_rowToObject_(data[i]);
    var after = {
      request_id:       before.request_id,
      type:             before.type,
      scope:            before.scope,
      target_email:     before.target_email,
      target_name:      before.target_name,
      reason:           before.reason,
      comment:          before.comment,
      start_date:       before.start_date,
      end_date:         before.end_date,
      building_names:   before.building_names,
      status:           patch.status           != null ? String(patch.status)           : before.status,
      requester_email:  before.requester_email,
      requested_at:     before.requested_at,
      completer_email:  patch.completer_email  != null ? Utils_cleanEmail(patch.completer_email) : before.completer_email,
      completed_at:     patch.completed_at     != null ? patch.completed_at             : before.completed_at,
      rejection_reason: patch.rejection_reason != null ? String(patch.rejection_reason) : before.rejection_reason,
      completion_note:  patch.completion_note  != null ? String(patch.completion_note)  : before.completion_note
    };
    sheet.getRange(i + 1, 1, 1, REQUESTS_HEADERS_.length).setValues([[
      after.request_id, after.type, after.scope,
      after.target_email, after.target_name,
      after.reason, after.comment,
      after.start_date, after.end_date,
      after.building_names,
      after.status,
      after.requester_email, after.requested_at,
      after.completer_email, after.completed_at,
      after.rejection_reason, after.completion_note
    ]]);
    return { before: before, after: after };
  }
  throw new Error('Requests_update: no request with request_id "' + key + '"');
}

function Requests_readAll_() {
  var sheet = Requests_sheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length === 0) return [];
  Requests_assertHeaders_(data[0]);
  var out = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === '' || data[i][0] == null) continue;
    out.push(Requests_rowToObject_(data[i]));
  }
  return out;
}

// Chunk 10.5: Requests is intentionally NOT CacheService-memoized per
// architecture.md §7.5 — write-hot (submit / complete / cancel flows)
// and directly surfaced on the manager queue, which users refresh to
// see freshness. Per-request Sheet_getTab still applies.
function Requests_sheet_() {
  return Sheet_getTab('Requests');
}

function Requests_assertHeaders_(headers) {
  for (var h = 0; h < REQUESTS_HEADERS_.length; h++) {
    if (String(headers[h]) !== REQUESTS_HEADERS_[h]) {
      throw new Error('Requests header drift at column ' + (h + 1) +
        ': expected "' + REQUESTS_HEADERS_[h] + '", got "' + String(headers[h]) + '"');
    }
  }
}

function Requests_rowToObject_(row) {
  return {
    request_id:       String(row[0]),
    type:             String(row[1] == null ? '' : row[1]),
    scope:            String(row[2] == null ? '' : row[2]),
    target_email:     Utils_cleanEmail(String(row[3] == null ? '' : row[3])),
    target_name:      String(row[4] == null ? '' : row[4]),
    reason:           String(row[5] == null ? '' : row[5]),
    comment:          String(row[6] == null ? '' : row[6]),
    start_date:       Utils_formatIsoDate(row[7]),
    end_date:         Utils_formatIsoDate(row[8]),
    building_names:   String(row[9] == null ? '' : row[9]),
    status:           String(row[10] == null ? '' : row[10]),
    requester_email:  Utils_cleanEmail(String(row[11] == null ? '' : row[11])),
    requested_at:     row[12] instanceof Date ? row[12] : (row[12] == null ? null : row[12]),
    completer_email:  Utils_cleanEmail(String(row[13] == null ? '' : row[13])),
    completed_at:     row[14] instanceof Date ? row[14] : (row[14] == null ? null : row[14]),
    rejection_reason: String(row[15] == null ? '' : row[15]),
    completion_note:  String(row[16] == null ? '' : row[16])
  };
}

function Requests_normaliseInput_(row) {
  return {
    request_id:       String(row.request_id),
    type:             String(row.type),
    scope:            String(row.scope),
    target_email:     Utils_cleanEmail(row.target_email),
    target_name:      row.target_name == null ? '' : String(row.target_name),
    reason:           row.reason == null ? '' : String(row.reason),
    comment:          row.comment == null ? '' : String(row.comment),
    start_date:       Utils_formatIsoDate(row.start_date),
    end_date:         Utils_formatIsoDate(row.end_date),
    building_names:   row.building_names == null ? '' : String(row.building_names),
    status:           String(row.status),
    requester_email:  Utils_cleanEmail(row.requester_email),
    requested_at:     row.requested_at instanceof Date ? row.requested_at : (row.requested_at == null ? '' : row.requested_at),
    completer_email:  row.completer_email == null ? '' : Utils_cleanEmail(row.completer_email),
    completed_at:     row.completed_at instanceof Date ? row.completed_at : (row.completed_at == null ? '' : row.completed_at),
    rejection_reason: row.rejection_reason == null ? '' : String(row.rejection_reason),
    completion_note:  row.completion_note == null ? '' : String(row.completion_note)
  };
}
