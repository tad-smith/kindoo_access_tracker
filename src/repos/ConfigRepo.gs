// Read-only access to the Config tab (key/value pairs). Writes land in
// Chunk 2 alongside Lock.gs and AuditRepo.

const CONFIG_HEADERS_ = ['key', 'value'];

// Keys we coerce to non-string types on read. Everything else is returned as
// the Sheet hands it to us (string, number, boolean, or Date for *_at).
const CONFIG_TYPED_KEYS_ = {
  setup_complete: 'boolean',
  stake_seat_cap: 'number',
  expiry_hour:    'number'
};

function Config_getAll() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Config');
  if (!sheet) throw new Error('Config tab missing — run setupSheet().');
  var data = sheet.getDataRange().getValues();
  Config_assertHeaders_(data);
  var out = {};
  for (var i = 1; i < data.length; i++) {
    var key = data[i][0];
    if (key === '' || key == null) continue;
    out[String(key)] = Config_coerce_(String(key), data[i][1]);
  }
  return out;
}

function Config_get(key) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Config');
  if (!sheet) throw new Error('Config tab missing — run setupSheet().');
  var data = sheet.getDataRange().getValues();
  Config_assertHeaders_(data);
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(key)) {
      return Config_coerce_(String(key), data[i][1]);
    }
  }
  return undefined;
}

function Config_assertHeaders_(data) {
  if (data.length === 0) {
    throw new Error('Config tab is empty — run setupSheet().');
  }
  var headers = data[0];
  for (var h = 0; h < CONFIG_HEADERS_.length; h++) {
    if (String(headers[h]) !== CONFIG_HEADERS_[h]) {
      throw new Error('Config header drift at column ' + (h + 1) +
        ': expected "' + CONFIG_HEADERS_[h] + '", got "' + String(headers[h]) + '"');
    }
  }
}

function Config_coerce_(key, value) {
  if (value === '' || value == null) return null;
  var t = CONFIG_TYPED_KEYS_[key];
  if (t === 'boolean') {
    if (typeof value === 'boolean') return value;
    return String(value).trim().toLowerCase() === 'true';
  }
  if (t === 'number') {
    var n = Number(value);
    return isNaN(n) ? null : n;
  }
  return value;
}
