// CRUD for the Access tab. Two writers:
//   - Importer (Chunk 3) — diffs auto-generated rows from the callings
//     sheet; stamps source='importer' on inserts; only deletes rows whose
//     source='importer' (manual rows are invisible to the importer's
//     delete-not-seen step).
//   - Manager UI (TASKS.md #1) — inserts source='manual' rows to grant app
//     access to someone whose calling doesn't match any template (or who
//     holds no calling at all); deletes are limited to source='manual'
//     rows (the UI hides the delete button on importer rows, and the API
//     layer refuses to delete them as defense in depth).
//
// Emails are stored as typed (preserve case + dots + +suffix); equality
// is via Utils_emailsEqual (architecture.md D4). Uniqueness for upsert
// is (canonical_email, scope, calling) regardless of source — the
// importer won't double-insert if a manual row already occupies the key
// (see Importer.gs diff logic).
//
// Read-time source fallback: cells that are empty or null map to
// 'importer' so the Chunk-3 → TASKS.md-#1 migration is zero-data: after
// the operator adds the `source` header to column D, existing rows carry
// an empty source cell and resolve as importer-owned. New writes always
// stamp the explicit value.
//
// Lock acquisition + audit writes are the CALLER's responsibility — this
// module does pure single-tab data access (architecture.md §7).

const ACCESS_HEADERS_ = ['email', 'scope', 'calling', 'source'];
const ACCESS_SOURCE_IMPORTER_ = 'importer';
const ACCESS_SOURCE_MANUAL_   = 'manual';

// Chunk 10.5: CacheService key for Access_getAll. Used by role resolution
// (Access_getByEmail → Access_getAll) — on every rpc — so caching the
// full scan is a high-leverage win. Invalidated on every single-row
// write AND at Importer end-of-run (the importer is the dominant writer).
const ACCESS_CACHE_KEY_ = 'access:getAll';
const ACCESS_CACHE_TTL_S_ = 60;

function Access_getAll() {
  return Cache_memoize(ACCESS_CACHE_KEY_, ACCESS_CACHE_TTL_S_, function () {
    var sheet = Sheet_getTab('Access');
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
        calling: String(data[i][2] == null ? '' : data[i][2]),
        source:  Access_normaliseSource_(data[i][3])
      });
    }
    return out;
  });
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
// computes the desired set and only calls _insert for truly-new rows;
// the manager UI rejects a manual insert whose composite key already
// exists, regardless of source).
// No lock, no audit.
//
// `row.source` defaults to 'importer' when omitted — the only two callers
// (Importer + ApiManager_accessInsertManual) both pass it explicitly, but
// the default keeps the legacy Chunk-3 behaviour for any test harness
// that still builds a 3-field row.
function Access_insert(row) {
  if (!row) throw new Error('Access_insert: row required');
  var typed = Utils_cleanEmail(row.email);
  if (!typed) throw new Error('Access_insert: email required');
  var scope = String(row.scope == null ? '' : row.scope);
  if (!scope) throw new Error('Access_insert: scope required');
  var calling = String(row.calling == null ? '' : row.calling);
  if (!calling) throw new Error('Access_insert: calling required');
  var source = Access_normaliseSource_(row.source);
  if (source !== ACCESS_SOURCE_IMPORTER_ && source !== ACCESS_SOURCE_MANUAL_) {
    throw new Error('Access_insert: source must be "importer" or "manual", got "' + source + '"');
  }
  var sheet = Access_sheet_();
  // Header check on write path, symmetric with the read path.
  var headers = sheet.getRange(1, 1, 1, ACCESS_HEADERS_.length).getValues()[0];
  Access_assertHeaders_(headers);
  sheet.appendRow([typed, scope, calling, source]);
  Cache_invalidate(ACCESS_CACHE_KEY_);
  return { email: typed, scope: scope, calling: calling, source: source };
}

// Pure delete by composite key (canonical_email, scope, calling). Scope
// and calling compare exact-string; email compares canonical-on-the-fly.
// Deletes the first matching row. Returns the deleted object (with its
// source), or null if nothing matched (caller decides whether "nothing
// to delete" is an error — the importer treats it as a defensive no-op;
// the manager UI surfaces it as "already deleted").
//
// Source is NOT part of the match key — the caller is responsible for
// deciding whether to touch an importer vs. manual row. The importer
// pre-filters its delete list to source='importer'; the API layer's
// manual-delete endpoint pre-checks source='manual'.
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
      calling: callingKey,
      source:  Access_normaliseSource_(data[i][3])
    };
    sheet.deleteRow(i + 1);
    Cache_invalidate(ACCESS_CACHE_KEY_);
    return before;
  }
  return null;
}

function Access_sheet_() {
  return Sheet_getTab('Access');
}

// Empty / null / unrecognised source cells map to 'importer'. Rationale:
// rows predating the TASKS.md-#1 schema bump carry an empty cell in
// column D after the operator appends the header; those rows are the
// importer's work by definition. Any unexpected non-manual literal
// ("imported", "auto", an accidental typo) also falls through to
// 'importer' — the importer's delete-not-seen step is source-exclusive,
// so a misspelled cell would silently survive, but that's a self-healing
// problem: the next manual edit goes through _insert which normalises.
function Access_normaliseSource_(raw) {
  if (raw === '' || raw == null) return ACCESS_SOURCE_IMPORTER_;
  var s = String(raw).toLowerCase();
  if (s === ACCESS_SOURCE_MANUAL_) return ACCESS_SOURCE_MANUAL_;
  return ACCESS_SOURCE_IMPORTER_;
}

function Access_assertHeaders_(headers) {
  for (var h = 0; h < ACCESS_HEADERS_.length; h++) {
    if (String(headers[h]) !== ACCESS_HEADERS_[h]) {
      throw new Error('Access header drift at column ' + (h + 1) +
        ': expected "' + ACCESS_HEADERS_[h] + '", got "' + String(headers[h]) + '"');
    }
  }
}
