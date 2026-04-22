// CacheService wrapper + per-request sheet-handle memo (Chunk 10.5).
//
// The Main Kindoo project's ONE call site for `CacheService` — every hot
// read path memoizes through Cache_memoize, every write path invalidates
// through Cache_invalidate. Keeping the surface narrow means a review can
// confirm invalidation completeness by grepping this file + every repo's
// write paths in one pass (the chunk-10.5 changelog enumerates the sites).
//
// Module shape (architecture.md §7.5):
//   Cache_memoize(key, ttlSeconds, computeFn)
//   Cache_invalidate(keyOrKeys)
//   Cache_invalidateAll()
//   Cache_getStats()
//   Sheet_getTab(name)       -- per-request sheet-handle memo (not CacheService)
//
// Size-limit handling: Apps Script's CacheService enforces 100 KB per
// value. Payloads ≥ 90 KB (soft ceiling — leaves headroom for the JSON
// key wrapper CacheService adds internally) skip the put and fall through
// to computeFn uncached. Never throw on size — cache misses must stay
// transparent; the Sheet is the source of truth.
//
// Stats counter lifecycle: CACHE_STATS_ is a module var, so it resets on
// every Apps Script execution (each rpc gets its own module instantiation).
// That's the natural scope for "what did THIS rpc do?" — surfaces live in
// the manager Configuration page's debug panel, where an operator clicks
// "Refresh stats" after navigating to see warm-cache hits populate.

// 90 KB soft ceiling. CacheService's hard limit is 100 KB per value
// (Apps Script quota); JSON.stringify on a large seats/audit payload can
// sit close to that, and CacheService prefixes its own key metadata
// internally, so 90 KB leaves comfortable headroom. A payload that
// serializes over this threshold falls through to the un-cached compute.
var CACHE_SIZE_LIMIT_BYTES_ = 90 * 1024;

// Per-execution counters. Populated on the fly by Cache_memoize so an
// operator hitting the Config debug panel can see hits / misses / skips
// for the current rpc. Reset on every script invocation (module-var
// scope).
//
// Shape:
//   {
//     byKey: {
//       '<key>': { hits, misses, skipped_size, bytes_cached }
//     },
//     aggregate: { hits, misses, skipped_size }
//   }
var CACHE_STATS_ = null;

// Per-request sheet-handle memo. Distinct from CacheService — this is a
// plain in-memory object keyed by tab name, scoped to the current script
// execution. `SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name)`
// is not free; each call hits the underlying spreadsheet handle. Repos
// that touch the same tab multiple times per request (e.g. Config_get
// called 5 times from the Dashboard endpoint) collapse those N lookups
// to one.
//
// Shape:
//   { ss: <Spreadsheet>, tabs: { '<name>': <Sheet> } }
var SHEET_TAB_CACHE_ = null;

// ---------------------------------------------------------------------------
// Public API — CacheService wrapper
// ---------------------------------------------------------------------------

function Cache_memoize(key, ttlSeconds, computeFn) {
  if (!key || typeof key !== 'string') {
    throw new Error('Cache_memoize: key (string) required');
  }
  if (typeof computeFn !== 'function') {
    throw new Error('Cache_memoize: computeFn (function) required');
  }
  var keyStats = Cache_stats_bucketFor_(key);
  var cache;
  try {
    cache = CacheService.getScriptCache();
  } catch (e) {
    // CacheService can raise in edge cases (quota, trigger context). Fall
    // through to the compute so reads never fail because of cache trouble.
    Logger.log('[Cache] getScriptCache failed for "' + key + '": ' + e);
    keyStats.misses++;
    CACHE_STATS_.aggregate.misses++;
    return computeFn();
  }

  var hit = null;
  try {
    hit = cache.get(key);
  } catch (e) {
    Logger.log('[Cache] get failed for "' + key + '": ' + e);
  }

  if (hit !== null && hit !== undefined) {
    try {
      var parsed = JSON.parse(hit);
      keyStats.hits++;
      CACHE_STATS_.aggregate.hits++;
      return Cache_reviveDates_(parsed);
    } catch (parseErr) {
      // Corrupt cache entry — drop it and recompute.
      Logger.log('[Cache] parse failed for "' + key + '" — recomputing: ' + parseErr);
      try { cache.remove(key); } catch (e2) { /* ignore */ }
    }
  }

  keyStats.misses++;
  CACHE_STATS_.aggregate.misses++;
  var value = computeFn();

  var serialized;
  try {
    serialized = JSON.stringify(Cache_encodeDates_(value));
  } catch (stringifyErr) {
    // Unserializable result — skip the put, still return the value.
    Logger.log('[Cache] stringify failed for "' + key + '": ' + stringifyErr);
    return value;
  }

  if (serialized.length > CACHE_SIZE_LIMIT_BYTES_) {
    keyStats.skipped_size++;
    CACHE_STATS_.aggregate.skipped_size++;
    Logger.log('[Cache] size-limit skipped "' + key + '" (' +
      Math.round(serialized.length / 1024) + ' KB > ' +
      Math.round(CACHE_SIZE_LIMIT_BYTES_ / 1024) + ' KB)');
    return value;
  }

  try {
    cache.put(key, serialized, ttlSeconds);
    keyStats.bytes_cached = serialized.length;
  } catch (putErr) {
    Logger.log('[Cache] put failed for "' + key + '": ' + putErr);
  }

  return value;
}

// Invalidate a single key or an array of keys. Silently no-ops on empty
// input so write paths can do `Cache_invalidate(null)` without guarding.
function Cache_invalidate(keyOrKeys) {
  if (!keyOrKeys) return;
  var keys = [];
  if (typeof keyOrKeys === 'string') {
    keys = [keyOrKeys];
  } else if (Array.isArray(keyOrKeys)) {
    for (var i = 0; i < keyOrKeys.length; i++) {
      if (keyOrKeys[i]) keys.push(String(keyOrKeys[i]));
    }
  } else {
    throw new Error('Cache_invalidate: expected string or array');
  }
  if (keys.length === 0) return;
  try {
    var cache = CacheService.getScriptCache();
    cache.removeAll(keys);
  } catch (e) {
    Logger.log('[Cache] invalidate failed for ' + JSON.stringify(keys) + ': ' + e);
  }
}

// Nuclear option — used by the manager Config page's "Clear cache" button
// and by operator-initiated test flows. CacheService has no "wipe the
// whole script cache" call, so we enumerate every key the project is
// known to write and removeAll them in one round-trip.
function Cache_invalidateAll() {
  Cache_invalidate(Cache_knownKeys_());
}

// Defensive copy of the per-request stats. The Config debug panel renders
// `{byKey, aggregate}` verbatim; surfacing the private module var would
// let a future client mutate counters by accident.
function Cache_getStats() {
  Cache_stats_ensureInit_();
  var byKey = {};
  for (var k in CACHE_STATS_.byKey) {
    if (!CACHE_STATS_.byKey.hasOwnProperty(k)) continue;
    var b = CACHE_STATS_.byKey[k];
    byKey[k] = {
      hits:         b.hits || 0,
      misses:       b.misses || 0,
      skipped_size: b.skipped_size || 0,
      bytes_cached: b.bytes_cached || 0
    };
  }
  return {
    byKey: byKey,
    aggregate: {
      hits:         CACHE_STATS_.aggregate.hits || 0,
      misses:       CACHE_STATS_.aggregate.misses || 0,
      skipped_size: CACHE_STATS_.aggregate.skipped_size || 0
    }
  };
}

// ---------------------------------------------------------------------------
// Public API — per-request sheet-handle memo
// ---------------------------------------------------------------------------
//
// Architecture.md §7 has described Sheet_getTab as a helper since Chunk 1,
// but until Chunk 10.5 the repos called
// `SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name)` directly
// each time. A single Dashboard load triggers ~20 such lookups across
// the repos; this memo collapses them to one per tab.
//
// Module-var scope means the memo vanishes between Apps Script
// executions, which matches the "request lifetime" semantics we want —
// no cross-request staleness risk. The CacheService memoize (above) is
// separate and lives across requests.

function Sheet_getTab(name) {
  if (!name) throw new Error('Sheet_getTab: name required');
  if (!SHEET_TAB_CACHE_) {
    SHEET_TAB_CACHE_ = {
      ss:   SpreadsheetApp.getActiveSpreadsheet(),
      tabs: {}
    };
  }
  if (!SHEET_TAB_CACHE_.tabs[name]) {
    var sheet = SHEET_TAB_CACHE_.ss.getSheetByName(name);
    if (!sheet) {
      // Don't cache the miss — a tab that was just created should be
      // visible to the caller on retry within the same request.
      throw new Error(name + ' tab missing — run setupSheet().');
    }
    SHEET_TAB_CACHE_.tabs[name] = sheet;
  }
  return SHEET_TAB_CACHE_.tabs[name];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function Cache_stats_ensureInit_() {
  if (!CACHE_STATS_) {
    CACHE_STATS_ = {
      byKey:     {},
      aggregate: { hits: 0, misses: 0, skipped_size: 0 }
    };
  }
}

function Cache_stats_bucketFor_(key) {
  Cache_stats_ensureInit_();
  if (!CACHE_STATS_.byKey[key]) {
    CACHE_STATS_.byKey[key] = { hits: 0, misses: 0, skipped_size: 0, bytes_cached: 0 };
  }
  return CACHE_STATS_.byKey[key];
}

// Every cache key the project writes. Cache_invalidateAll() enumerates
// this list because CacheService has no "wipe everything this script
// ever put" call. Keep in sync with the memoize call sites below; a
// missing entry here means Cache_invalidateAll leaves stale data.
//
// Keys are also exported as constants from the repos that own them so a
// reviewer can `grep 'CACHE_KEY_'` to find every producer + consumer in
// one pass.
function Cache_knownKeys_() {
  return [
    'config:getAll',
    'kindooManagers:getAll',
    'access:getAll',
    'wards:getAll',
    'buildings:getAll',
    'templates:ward:getAll',
    'templates:stake:getAll'
  ];
}

// JSON has no native Date type, so JSON.stringify(date) produces an ISO
// string and JSON.parse returns a string. The repos hand us objects with
// Date-typed fields (e.g. Seats.created_at); if the cache round-tripped
// those as strings, callers that type-check `instanceof Date` would
// silently get wrong answers.
//
// Encode: Date → { __date__: ISO string }. Revive reads the sentinel and
// reconstructs a Date. Every other type passes through unchanged.
function Cache_encodeDates_(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return { __date__: value.toISOString() };
  if (Array.isArray(value)) {
    var out = [];
    for (var i = 0; i < value.length; i++) out.push(Cache_encodeDates_(value[i]));
    return out;
  }
  if (typeof value === 'object') {
    var obj = {};
    for (var k in value) {
      if (value.hasOwnProperty(k)) obj[k] = Cache_encodeDates_(value[k]);
    }
    return obj;
  }
  return value;
}

function Cache_reviveDates_(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object' && value.__date__ && Object.keys(value).length === 1) {
    var d = new Date(value.__date__);
    return isNaN(d.getTime()) ? value.__date__ : d;
  }
  if (Array.isArray(value)) {
    var out = [];
    for (var i = 0; i < value.length; i++) out.push(Cache_reviveDates_(value[i]));
    return out;
  }
  if (typeof value === 'object') {
    var obj = {};
    for (var k in value) {
      if (value.hasOwnProperty(k)) obj[k] = Cache_reviveDates_(value[k]);
    }
    return obj;
  }
  return value;
}
