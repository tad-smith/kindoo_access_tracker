// CRUD for the Wards tab.
//
// `ward_code` is the primary key — a 2-character string that must match
// the corresponding tab name in the callings spreadsheet (importer's
// tab-to-ward join). Stored as typed (case-sensitive); no canonicalisation.
// `building_name` is the FK to Buildings.
//
// Cross-tab FK enforcement (Buildings → Wards on building delete; Wards →
// Seats on ward delete in Chunk 5+) lives in the API layer, not here
// (architecture.md §7).

const WARDS_HEADERS_ = ['ward_code', 'ward_name', 'building_name', 'seat_cap'];
const WARDS_CODE_LEN_ = 2;

function Wards_getAll() {
  var sheet = Wards_sheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length === 0) return [];
  Wards_assertHeaders_(data[0]);
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var raw = data[i][0];
    if (raw === '' || raw == null) continue;
    out.push(Wards_rowToObject_(data[i]));
  }
  return out;
}

function Wards_getByCode(wardCode) {
  if (!wardCode) return null;
  var key = String(wardCode).trim();
  if (!key) return null;
  var rows = Wards_getAll();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].ward_code === key) return rows[i];
  }
  return null;
}

function Wards_insert(row) {
  if (!row || !row.ward_code) throw new Error('Wards_insert: ward_code required');
  var code = String(row.ward_code).trim();
  Wards_validateCode_(code);
  var sheet = Wards_sheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length > 0) Wards_assertHeaders_(data[0]);
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === code) {
      throw new Error('A ward with ward_code "' + code + '" already exists.');
    }
  }
  var toWrite = Wards_normaliseInput_(row);
  toWrite.ward_code = code;
  sheet.appendRow([toWrite.ward_code, toWrite.ward_name,
                   toWrite.building_name, toWrite.seat_cap]);
  return toWrite;
}

function Wards_update(wardCode, patch) {
  if (!wardCode) throw new Error('Wards_update: ward_code required');
  var key = String(wardCode).trim();
  if (!key) throw new Error('Wards_update: ward_code required');
  var sheet = Wards_sheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length > 0) Wards_assertHeaders_(data[0]);
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) !== key) continue;
    var before = Wards_rowToObject_(data[i]);
    var nextCode = before.ward_code;
    if (patch && patch.ward_code != null && String(patch.ward_code).trim() !== before.ward_code) {
      nextCode = String(patch.ward_code).trim();
      Wards_validateCode_(nextCode);
      for (var j = 1; j < data.length; j++) {
        if (j === i) continue;
        if (String(data[j][0]) === nextCode) {
          throw new Error('A ward with ward_code "' + nextCode + '" already exists.');
        }
      }
    }
    var merged = {
      ward_code:     nextCode,
      ward_name:     patch && patch.ward_name     != null ? String(patch.ward_name)     : before.ward_name,
      building_name: patch && patch.building_name != null ? String(patch.building_name).trim() : before.building_name,
      seat_cap:      patch && patch.seat_cap      != null ? Wards_coerceSeatCap_(patch.seat_cap) : before.seat_cap
    };
    sheet.getRange(i + 1, 1, 1, WARDS_HEADERS_.length)
         .setValues([[merged.ward_code, merged.ward_name,
                      merged.building_name, merged.seat_cap]]);
    return { before: before, after: merged };
  }
  throw new Error('Wards_update: no ward with ward_code "' + key + '"');
}

function Wards_delete(wardCode) {
  if (!wardCode) throw new Error('Wards_delete: ward_code required');
  var key = String(wardCode).trim();
  if (!key) throw new Error('Wards_delete: ward_code required');
  var sheet = Wards_sheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length > 0) Wards_assertHeaders_(data[0]);
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === key) {
      var before = Wards_rowToObject_(data[i]);
      sheet.deleteRow(i + 1);
      return before;
    }
  }
  throw new Error('Wards_delete: no ward with ward_code "' + key + '"');
}

function Wards_validateCode_(code) {
  if (!code) throw new Error('ward_code is required.');
  if (code.length !== WARDS_CODE_LEN_) {
    throw new Error('ward_code must be exactly ' + WARDS_CODE_LEN_ +
      ' characters (got "' + code + '"). It must match the corresponding ' +
      'tab name in the callings spreadsheet.');
  }
}

function Wards_sheet_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Wards');
  if (!sheet) throw new Error('Wards tab missing — run setupSheet().');
  return sheet;
}

function Wards_assertHeaders_(headers) {
  for (var h = 0; h < WARDS_HEADERS_.length; h++) {
    if (String(headers[h]) !== WARDS_HEADERS_[h]) {
      throw new Error('Wards header drift at column ' + (h + 1) +
        ': expected "' + WARDS_HEADERS_[h] + '", got "' + String(headers[h]) + '"');
    }
  }
}

function Wards_rowToObject_(row) {
  return {
    ward_code:     String(row[0]).trim(),
    ward_name:     String(row[1] == null ? '' : row[1]),
    building_name: String(row[2] == null ? '' : row[2]).trim(),
    seat_cap:      Wards_coerceSeatCap_(row[3])
  };
}

function Wards_normaliseInput_(row) {
  return {
    ward_code:     String(row.ward_code || '').trim(),
    ward_name:     String(row.ward_name == null ? '' : row.ward_name),
    building_name: String(row.building_name == null ? '' : row.building_name).trim(),
    seat_cap:      Wards_coerceSeatCap_(row.seat_cap)
  };
}

function Wards_coerceSeatCap_(v) {
  if (v === '' || v == null) return null;
  var n = Number(v);
  return isNaN(n) ? null : n;
}
