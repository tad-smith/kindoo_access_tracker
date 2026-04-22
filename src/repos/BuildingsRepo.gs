// CRUD for the Buildings tab.
//
// `building_name` is the primary key. Stored as typed (trimmed only); no
// canonicalisation. Equality is exact-string-match (case-sensitive),
// because building names are user-chosen labels — "Stake Center" and
// "stake center" are not the same input.
//
// Cross-tab FK enforcement (cannot delete a Building referenced by any
// Ward via Wards.building_name) lives in the API layer (architecture.md §7).

const BUILDINGS_HEADERS_ = ['building_name', 'address'];

// Chunk 10.5: CacheService key for Buildings_getAll. 300s TTL — nearly
// static; a new building lands maybe once a year. Invalidated on every
// write, plus Buildings_getByName delegates to the cached Buildings_getAll.
const BUILDINGS_CACHE_KEY_ = 'buildings:getAll';
const BUILDINGS_CACHE_TTL_S_ = 300;

function Buildings_getAll() {
  return Cache_memoize(BUILDINGS_CACHE_KEY_, BUILDINGS_CACHE_TTL_S_, function () {
    var sheet = Buildings_sheet_();
    var data = sheet.getDataRange().getValues();
    if (data.length === 0) return [];
    Buildings_assertHeaders_(data[0]);
    var out = [];
    for (var i = 1; i < data.length; i++) {
      var raw = data[i][0];
      if (raw === '' || raw == null) continue;
      out.push(Buildings_rowToObject_(data[i]));
    }
    return out;
  });
}

function Buildings_getByName(buildingName) {
  if (!buildingName) return null;
  var key = String(buildingName).trim();
  if (!key) return null;
  var rows = Buildings_getAll();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].building_name === key) return rows[i];
  }
  return null;
}

function Buildings_insert(row) {
  if (!row || !row.building_name) throw new Error('Buildings_insert: building_name required');
  var name = String(row.building_name).trim();
  if (!name) throw new Error('Buildings_insert: building_name required');
  var sheet = Buildings_sheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length > 0) Buildings_assertHeaders_(data[0]);
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === name) {
      throw new Error('A building named "' + name + '" already exists.');
    }
  }
  var toWrite = {
    building_name: name,
    address:       String(row.address == null ? '' : row.address)
  };
  sheet.appendRow([toWrite.building_name, toWrite.address]);
  Cache_invalidate(BUILDINGS_CACHE_KEY_);
  return toWrite;
}

// Bulk insert. Batches N rows into a single setValues call. Used by the
// Chunk-4 bootstrap wizard to commit a step's accumulated pending rows in
// one round-trip. Validates each row and cross-row PK uniqueness (within
// the batch AND against existing rows) before touching the Sheet, so a
// validation failure on row 5 leaves the Sheet unchanged. Returns the
// array of inserted row objects in the same order.
//
// Caller owns the lock and the audit writes (emit N entries via
// AuditRepo_writeMany for symmetry with single-row inserts).
function Buildings_bulkInsert(rows) {
  if (!rows || rows.length === 0) return [];
  var sheet = Buildings_sheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length > 0) Buildings_assertHeaders_(data[0]);
  var existing = {};
  for (var i = 1; i < data.length; i++) {
    var k = String(data[i][0]);
    if (k !== '' && k != null) existing[k] = true;
  }
  var seen = {};
  var prepared = [];
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    if (!row || !row.building_name) {
      throw new Error('Buildings_bulkInsert: row ' + (r + 1) + ' missing building_name');
    }
    var name = String(row.building_name).trim();
    if (!name) {
      throw new Error('Buildings_bulkInsert: row ' + (r + 1) + ' has empty building_name');
    }
    if (seen[name]) {
      throw new Error('Duplicate building "' + name + '" in the batch.');
    }
    if (existing[name]) {
      throw new Error('A building named "' + name + '" already exists.');
    }
    seen[name] = true;
    prepared.push({
      building_name: name,
      address:       String(row.address == null ? '' : row.address)
    });
  }
  var values = prepared.map(function (p) { return [p.building_name, p.address]; });
  var startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, values.length, BUILDINGS_HEADERS_.length).setValues(values);
  Cache_invalidate(BUILDINGS_CACHE_KEY_);
  return prepared;
}

function Buildings_update(buildingName, patch) {
  if (!buildingName) throw new Error('Buildings_update: building_name required');
  var key = String(buildingName).trim();
  if (!key) throw new Error('Buildings_update: building_name required');
  var sheet = Buildings_sheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length > 0) Buildings_assertHeaders_(data[0]);
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) !== key) continue;
    var before = Buildings_rowToObject_(data[i]);
    var nextName = before.building_name;
    if (patch && patch.building_name != null && String(patch.building_name).trim() !== before.building_name) {
      nextName = String(patch.building_name).trim();
      if (!nextName) throw new Error('Buildings_update: building_name cannot be blank');
      for (var j = 1; j < data.length; j++) {
        if (j === i) continue;
        if (String(data[j][0]) === nextName) {
          throw new Error('A building named "' + nextName + '" already exists.');
        }
      }
    }
    var merged = {
      building_name: nextName,
      address:       patch && patch.address != null ? String(patch.address) : before.address
    };
    sheet.getRange(i + 1, 1, 1, BUILDINGS_HEADERS_.length)
         .setValues([[merged.building_name, merged.address]]);
    Cache_invalidate(BUILDINGS_CACHE_KEY_);
    return { before: before, after: merged };
  }
  throw new Error('Buildings_update: no building named "' + key + '"');
}

function Buildings_delete(buildingName) {
  if (!buildingName) throw new Error('Buildings_delete: building_name required');
  var key = String(buildingName).trim();
  if (!key) throw new Error('Buildings_delete: building_name required');
  var sheet = Buildings_sheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length > 0) Buildings_assertHeaders_(data[0]);
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === key) {
      var before = Buildings_rowToObject_(data[i]);
      sheet.deleteRow(i + 1);
      Cache_invalidate(BUILDINGS_CACHE_KEY_);
      return before;
    }
  }
  throw new Error('Buildings_delete: no building named "' + key + '"');
}

function Buildings_sheet_() {
  return Sheet_getTab('Buildings');
}

function Buildings_assertHeaders_(headers) {
  for (var h = 0; h < BUILDINGS_HEADERS_.length; h++) {
    if (String(headers[h]) !== BUILDINGS_HEADERS_[h]) {
      throw new Error('Buildings header drift at column ' + (h + 1) +
        ': expected "' + BUILDINGS_HEADERS_[h] + '", got "' + String(headers[h]) + '"');
    }
  }
}

function Buildings_rowToObject_(row) {
  return {
    building_name: String(row[0]).trim(),
    address:       String(row[1] == null ? '' : row[1])
  };
}
