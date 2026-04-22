// Read + targeted-write access to the Config tab (key/value pairs).
//
// Writes in Chunk 2:
//   - Config_update(key, value): updates an existing seeded key. Throws if
//     the key is unknown — the Config tab's set of valid keys is owned by
//     setupSheet (data-model.md "Known keys"). Inserting arbitrary keys
//     from the UI would let drift accumulate silently.
//   - The set of keys that may NEVER be written through this repo (or the
//     manager API) is enforced separately at the API layer; ConfigRepo
//     itself happily overwrites any seeded key, because Importer / Bootstrap
//     legitimately need to write last_import_at, setup_complete, etc.

const CONFIG_HEADERS_ = ['key', 'value'];

// Keys we coerce to non-string types on read. Everything else is returned as
// the Sheet hands it to us (string, number, boolean, or Date for *_at).
const CONFIG_TYPED_KEYS_ = {
  setup_complete:        'boolean',
  stake_seat_cap:        'number',
  expiry_hour:           'number',
  import_hour:           'number',   // Chunk 9: weekly importer hour
  notifications_enabled: 'boolean'  // Chunk 6: global mail kill-switch
};

// Valid values for Config.import_day. UPPERCASE canonical form — the manager
// Config UI renders a dropdown with these exact labels, and Config_update
// rejects anything else with a clear error (so the user sees "must be one of
// …" instead of a stack trace from ScriptApp.WeekDay[undefined]).
const CONFIG_VALID_IMPORT_DAYS_ = [
  'SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'
];

// Keys the manager Config UI must NEVER expose to inline edit. session_secret
// rotation invalidates every active session; main_url / identity_url
// rotation breaks the auth round-trip; bootstrap_admin_email is read at
// Chunk-4 wizard start and not meaningfully editable post-bootstrap.
// Server-side ApiManager_configUpdate enforces this list as defence-in-
// depth even if the client accidentally tries to send one.
const CONFIG_PROTECTED_KEYS_ = {
  session_secret:        true,
  main_url:              true,
  identity_url:          true,
  bootstrap_admin_email: true
};

// System-managed keys — manager UI shows them read-only because they reflect
// background-process state, not editable settings. Server-side editing is
// allowed (the Importer / Expiry services write them) but
// ApiManager_configUpdate refuses to touch them from the manager surface.
//
// Chunk 10 renamed this (previously CONFIG_IMPORTER_KEYS_) to cover keys
// owned by any background process, not just the importer — the Chunk-10
// Expiry run gained its own last_expiry_at / last_expiry_summary pair
// symmetric with last_import_at / last_import_summary.
const CONFIG_SYSTEM_KEYS_ = {
  last_import_at:        true,
  last_import_summary:   true,
  last_over_caps_json:   true,  // Chunk 9: over-cap snapshot
  last_expiry_at:        true,  // Chunk 10: last expiry run timestamp
  last_expiry_summary:   true   // Chunk 10: last expiry run summary
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

// Returns the row's pre-write value (coerced) so the caller can build an
// audit row's before_json. Throws if the key is unknown — Config keys come
// from setupSheet's seed list, and accepting unknown keys here would let
// the UI leak free-form keys into the tab.
function Config_update(key, value) {
  if (!key || typeof key !== 'string') {
    throw new Error('Config_update: key required');
  }
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Config');
  if (!sheet) throw new Error('Config tab missing — run setupSheet().');
  var data = sheet.getDataRange().getValues();
  Config_assertHeaders_(data);
  // Refuse to write to a tab whose headers have drifted — symmetric with
  // the read path's loud-throw behaviour.
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === key) {
      var oldRaw = data[i][1];
      var oldCoerced = Config_coerce_(key, oldRaw);
      // Coerce booleans into actual booleans so the cell stores TRUE/FALSE
      // rather than the string "true"/"false".
      var t = CONFIG_TYPED_KEYS_[key];
      var toWrite = value;
      if (t === 'boolean') {
        if (typeof value === 'boolean') toWrite = value;
        else toWrite = String(value).trim().toLowerCase() === 'true';
      } else if (t === 'number') {
        var n = Number(value);
        if (isNaN(n)) throw new Error('Config_update: ' + key + ' must be a number, got ' + JSON.stringify(value));
        toWrite = n;
      } else if (value === null || value === undefined) {
        toWrite = '';
      }
      // Per-key domain validation. Kept in the repo (rather than the API
      // layer) so the bootstrap wizard and importer writes also benefit —
      // anything that lands in the Sheet via Config_update is vetted.
      if (key === 'expiry_hour' || key === 'import_hour') {
        var hv = Number(toWrite);
        if (isNaN(hv) || hv < 0 || hv > 23 || Math.floor(hv) !== hv) {
          throw new Error('Config_update: ' + key + ' must be an integer 0–23, got ' + JSON.stringify(value));
        }
        toWrite = hv;
      } else if (key === 'import_day') {
        var dv = String(toWrite == null ? '' : toWrite).trim().toUpperCase();
        if (CONFIG_VALID_IMPORT_DAYS_.indexOf(dv) === -1) {
          throw new Error('Config_update: import_day must be one of ' +
            CONFIG_VALID_IMPORT_DAYS_.join(', ') + ', got ' + JSON.stringify(value));
        }
        toWrite = dv;
      }
      sheet.getRange(i + 1, 2).setValue(toWrite);
      return { key: key, before: oldCoerced, after: Config_coerce_(key, toWrite) };
    }
  }
  throw new Error('Config_update: unknown key "' + key + '" — add it via setupSheet first.');
}

// True if the key is one the manager Config UI must not expose to edit.
function Config_isProtectedKey(key) {
  return !!CONFIG_PROTECTED_KEYS_[String(key)];
}

// True if the key is owned by a background process (not editable from the
// manager Config UI even though it isn't a security-sensitive secret).
// Kept under the old name Config_isImporterKey for backward-compat with
// callers; the list itself now covers expiry-owned keys too (Chunk 10).
function Config_isImporterKey(key) {
  return !!CONFIG_SYSTEM_KEYS_[String(key)];
}

// Public alias under the more accurate name. New call sites should use
// this; the old Config_isImporterKey stays as a thin wrapper so Chunk 2's
// ApiManager_configUpdate and Chunk 9's ApiManager_configList don't need
// a touch-up.
function Config_isSystemKey(key) {
  return !!CONFIG_SYSTEM_KEYS_[String(key)];
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
