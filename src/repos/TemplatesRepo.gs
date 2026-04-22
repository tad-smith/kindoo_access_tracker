// CRUD for the WardCallingTemplate and StakeCallingTemplate tabs.
//
// Both tabs share an identical schema; this module exposes a single set of
// functions parameterised by the tab name ('WardCallingTemplate' or
// 'StakeCallingTemplate'). calling_name is the PK; duplicate inserts throw.

const TEMPLATES_HEADERS_ = ['calling_name', 'give_app_access'];

const TEMPLATES_TABS_ = {
  ward:  'WardCallingTemplate',
  stake: 'StakeCallingTemplate'
};

// Chunk 10.5: CacheService keys per template kind. 300s TTL — templates
// are nearly-static (a calling added once a quarter is typical) but
// frequently read on every import run. One cache key per kind so a ward-
// template write doesn't thrash the stake-template cache.
const TEMPLATES_CACHE_KEYS_ = {
  ward:  'templates:ward:getAll',
  stake: 'templates:stake:getAll'
};
const TEMPLATES_CACHE_TTL_S_ = 300;

function Templates_getAll(kind) {
  var tabName = Templates_tabName_(kind);
  var cacheKey = TEMPLATES_CACHE_KEYS_[String(kind)];
  return Cache_memoize(cacheKey, TEMPLATES_CACHE_TTL_S_, function () {
    var sheet = Templates_sheet_(tabName);
    var data = sheet.getDataRange().getValues();
    if (data.length === 0) return [];
    Templates_assertHeaders_(data[0], tabName);
    var out = [];
    for (var i = 1; i < data.length; i++) {
      var rawCalling = data[i][0];
      if (rawCalling === '' || rawCalling == null) continue;
      out.push(Templates_rowToObject_(data[i]));
    }
    return out;
  });
}

function Templates_getByName(kind, callingName) {
  if (!callingName) return null;
  var rows = Templates_getAll(kind);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].calling_name === callingName) return rows[i];
  }
  return null;
}

function Templates_insert(kind, row) {
  if (!row || !row.calling_name) throw new Error('Templates_insert: calling_name required');
  var name = String(row.calling_name).trim();
  if (!name) throw new Error('Templates_insert: calling_name required');
  var tabName = Templates_tabName_(kind);
  var sheet = Templates_sheet_(tabName);
  var data = sheet.getDataRange().getValues();
  if (data.length > 0) Templates_assertHeaders_(data[0], tabName);
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === name) {
      throw new Error('A ' + tabName + ' row with calling_name "' + name + '" already exists.');
    }
  }
  var toWrite = {
    calling_name:    name,
    give_app_access: row.give_app_access === true ||
                     String(row.give_app_access).trim().toLowerCase() === 'true'
  };
  sheet.appendRow([toWrite.calling_name, toWrite.give_app_access]);
  Cache_invalidate(TEMPLATES_CACHE_KEYS_[String(kind)]);
  return toWrite;
}

function Templates_update(kind, callingName, patch) {
  if (!callingName) throw new Error('Templates_update: calling_name required');
  var tabName = Templates_tabName_(kind);
  var sheet = Templates_sheet_(tabName);
  var data = sheet.getDataRange().getValues();
  if (data.length > 0) Templates_assertHeaders_(data[0], tabName);
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) !== callingName) continue;
    var before = Templates_rowToObject_(data[i]);
    var nextName = before.calling_name;
    if (patch && patch.calling_name != null && String(patch.calling_name).trim() !== before.calling_name) {
      nextName = String(patch.calling_name).trim();
      if (!nextName) throw new Error('Templates_update: calling_name cannot be blank');
      for (var j = 1; j < data.length; j++) {
        if (j === i) continue;
        if (String(data[j][0]) === nextName) {
          throw new Error('A ' + tabName + ' row with calling_name "' + nextName + '" already exists.');
        }
      }
    }
    var merged = {
      calling_name:    nextName,
      give_app_access: patch && patch.give_app_access != null
                         ? (patch.give_app_access === true ||
                            String(patch.give_app_access).trim().toLowerCase() === 'true')
                         : before.give_app_access
    };
    sheet.getRange(i + 1, 1, 1, TEMPLATES_HEADERS_.length)
         .setValues([[merged.calling_name, merged.give_app_access]]);
    Cache_invalidate(TEMPLATES_CACHE_KEYS_[String(kind)]);
    return { before: before, after: merged };
  }
  throw new Error('Templates_update: no ' + tabName + ' row with calling_name "' + callingName + '"');
}

function Templates_delete(kind, callingName) {
  if (!callingName) throw new Error('Templates_delete: calling_name required');
  var tabName = Templates_tabName_(kind);
  var sheet = Templates_sheet_(tabName);
  var data = sheet.getDataRange().getValues();
  if (data.length > 0) Templates_assertHeaders_(data[0], tabName);
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === callingName) {
      var before = Templates_rowToObject_(data[i]);
      sheet.deleteRow(i + 1);
      Cache_invalidate(TEMPLATES_CACHE_KEYS_[String(kind)]);
      return before;
    }
  }
  throw new Error('Templates_delete: no ' + tabName + ' row with calling_name "' + callingName + '"');
}

function Templates_tabName_(kind) {
  var name = TEMPLATES_TABS_[String(kind)];
  if (!name) throw new Error('Templates: unknown kind "' + kind + '" (expected "ward" or "stake")');
  return name;
}

function Templates_sheet_(tabName) {
  return Sheet_getTab(tabName);
}

function Templates_assertHeaders_(headers, tabName) {
  for (var h = 0; h < TEMPLATES_HEADERS_.length; h++) {
    if (String(headers[h]) !== TEMPLATES_HEADERS_[h]) {
      throw new Error(tabName + ' header drift at column ' + (h + 1) +
        ': expected "' + TEMPLATES_HEADERS_[h] + '", got "' + String(headers[h]) + '"');
    }
  }
}

function Templates_rowToObject_(row) {
  return {
    calling_name:    String(row[0]),
    give_app_access: row[1] === true ||
                     String(row[1]).trim().toLowerCase() === 'true'
  };
}
