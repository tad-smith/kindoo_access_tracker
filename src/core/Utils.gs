// Shared helpers for the rest of the app. Pure functions; no Sheet I/O.
//
// Naming: every exported function is prefixed `Utils_` because Apps Script
// concatenates all .gs files into a single global scope. Helpers ending in
// `_` are intended as module-private (Apps Script also hides `_`-suffixed
// functions from the editor's Run dropdown).

// ---------------------------------------------------------------------------
// Email handling (architecture.md D4 / open-questions.md I-8).
//
// We store emails AS TYPED — the user's display-form is preserved on every
// write boundary (UI input, Session.getActiveUser, importer reads). Only
// the comparison key is canonicalised: lowercased, trimmed, and (for
// @gmail.com / @googlemail.com only) with local-part .s and +suffix stripped
// and googlemail.com collapsed to gmail.com. No separate "canonical_email"
// column is stored — the canonical form is computed on demand by the
// comparison helper.
//
// This means `first.last@gmail.com` in the Sheet stays `first.last@gmail.com`
// (not `firstlast@gmail.com`), but role resolution still matches it against
// `firstlast@gmail.com` from Session.getActiveUser if Google ever hands us
// the dot-stripped variant.
// ---------------------------------------------------------------------------

// Trim whitespace and discard nulls. Preserves case + dots + +suffix —
// what gets stored / displayed. Use on every write boundary.
function Utils_cleanEmail(input) {
  if (input == null) return '';
  return String(input).trim();
}

// Build the comparison key: lower + Gmail dot/+suffix stripping +
// googlemail.com → gmail.com. NEVER store the result; only use it for
// equality checks via Utils_emailsEqual (or for source_row_hash, where
// stability across format wobbles is the whole point).
function Utils_normaliseEmail(input) {
  if (input == null) return '';
  var s = String(input).trim().toLowerCase();
  if (s === '') return '';
  var at = s.indexOf('@');
  if (at === -1) return s;
  var local = s.substring(0, at);
  var domain = s.substring(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    var plus = local.indexOf('+');
    if (plus !== -1) local = local.substring(0, plus);
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return local + '@' + domain;
}

// Two display-form emails are equivalent if their canonical forms match.
// Use this everywhere we previously compared canonical-to-canonical.
function Utils_emailsEqual(a, b) {
  return Utils_normaliseEmail(a) === Utils_normaliseEmail(b);
}

// ---------------------------------------------------------------------------
// Date / timestamp helpers.
// ---------------------------------------------------------------------------
function Utils_nowTs() {
  return new Date();
}

function Utils_todayIso() {
  var tz = Session.getScriptTimeZone();
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
}

// Coerce a Sheet cell value to a YYYY-MM-DD ISO date string at the read
// boundary. Data-model.md declares start_date / end_date as ISO strings,
// but Google Sheets auto-converts typed YYYY-MM-DD values into Date
// objects on cell entry. getValues() then hands us a Date, and
// String(date) renders `Wed Apr 20 2026 00:00:00 GMT-0600 …` — which
// leaks to the UI and also breaks `end_date < today` lexical compares
// in Expiry_runExpiry.
//
// This helper normalises either shape:
//   - Date → formatted YYYY-MM-DD in the script's timezone (matches
//     Utils_todayIso so both sides of the expiry compare live in the
//     same tz).
//   - string → trimmed; a string that already looks like a date is
//     returned as-is. (Manual entries like '2026-04-20' from the UI
//     flow through unchanged.)
//   - null / undefined / '' → '' (not applicable; manual rows, auto
//     rows, and never-set cells all use empty).
function Utils_formatIsoDate(value) {
  if (value == null) return '';
  if (value instanceof Date) {
    var tz = Session.getScriptTimeZone();
    return Utilities.formatDate(value, tz, 'yyyy-MM-dd');
  }
  var s = String(value).trim();
  return s;
}

function Utils_uuid() {
  return Utilities.getUuid();
}

// ---------------------------------------------------------------------------
// source_row_hash for the importer (architecture.md D5). Stable across runs
// regardless of Gmail dot/+suffix variants because the email is canonicalised
// before hashing.
// ---------------------------------------------------------------------------
function Utils_hashRow(scope, calling, email) {
  var canonical = Utils_normaliseEmail(email);
  var input = String(scope) + '|' + String(calling) + '|' + canonical;
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, input, Utilities.Charset.UTF_8);
  return Utils_bytesToHex_(bytes);
}

function Utils_bytesToHex_(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

// ---------------------------------------------------------------------------
// base64url encoding/decoding. Apps Script's Utilities.base64DecodeWebSafe /
// base64EncodeWebSafe handle the URL-safe alphabet; we strip / restore
// padding to match the unpadded JWT-style format Auth_signSessionToken
// uses.
// ---------------------------------------------------------------------------
function Utils_base64UrlEncode(str) {
  return Utilities.base64EncodeWebSafe(String(str), Utilities.Charset.UTF_8)
    .replace(/=+$/, '');
}

function Utils_base64UrlEncodeBytes(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function Utils_base64UrlDecode(s) {
  var str = String(s);
  while (str.length % 4 !== 0) str += '=';
  return Utilities.base64DecodeWebSafe(str);
}

function Utils_base64UrlDecodeToString(s) {
  var bytes = Utils_base64UrlDecode(s);
  return Utilities.newBlob(bytes).getDataAsString();
}

// ---------------------------------------------------------------------------
// Tests. Apps Script has no native runner, so each helper logs PASS/FAIL per
// case and throws on any failure. Run from the editor's Run dropdown or via
// the Kindoo Admin → Run normaliseEmail tests menu added in Setup.gs.
// ---------------------------------------------------------------------------
function Utils_test_normaliseEmail() {
  var cases = [
    // From build-plan.md Chunk 1 ("Proof 3" sub-tasks):
    { in: 'Alice.Smith@Gmail.com',            out: 'alicesmith@gmail.com' },
    { in: 'alicesmith+church@googlemail.com', out: 'alicesmith@gmail.com' },
    { in: 'alice@example.org',                out: 'alice@example.org' },
    { in: '  Bob@Foo.COM  ',                  out: 'bob@foo.com' },
    // Defensive cases:
    { in: '',                                 out: '' },
    { in: null,                               out: '' },
    { in: undefined,                          out: '' },
    { in: 'no-at-sign',                       out: 'no-at-sign' },
    { in: 'Foo+bar@gmail.com',                out: 'foo@gmail.com' },
    { in: 'foo@GMAIL.COM',                    out: 'foo@gmail.com' },
    { in: 'john.doe+test@googlemail.com',     out: 'johndoe@gmail.com' },
    // Workspace addresses keep dots and +suffix literally:
    { in: 'first.last@example.org',           out: 'first.last@example.org' },
    { in: 'alice+church@example.org',         out: 'alice+church@example.org' }
  ];
  var fails = [];
  for (var i = 0; i < cases.length; i++) {
    var got = Utils_normaliseEmail(cases[i].in);
    var ok = got === cases[i].out;
    var line = (ok ? 'PASS' : 'FAIL') +
      ' normaliseEmail(' + JSON.stringify(cases[i].in) + ') -> ' + JSON.stringify(got) +
      (ok ? '' : ' (expected ' + JSON.stringify(cases[i].out) + ')');
    Logger.log(line);
    if (!ok) fails.push(line);
  }
  if (fails.length > 0) {
    throw new Error(fails.length + ' normaliseEmail FAIL(s):\n' + fails.join('\n'));
  }
  return 'All ' + cases.length + ' normaliseEmail cases passed.';
}

function Utils_test_base64Url() {
  var decodeCases = [
    { in: 'eyJhbGciOiJIUzI1NiJ9', out: '{"alg":"HS256"}' },
    { in: 'SGVsbG8sIFdvcmxkIQ',   out: 'Hello, World!' },
    { in: 'YQ',   out: 'a' },
    { in: 'YWI',  out: 'ab' },
    { in: 'YWJj', out: 'abc' }
  ];
  var encodeCases = [
    { in: '{"alg":"HS256"}',   out: 'eyJhbGciOiJIUzI1NiJ9' },
    { in: 'Hello, World!',     out: 'SGVsbG8sIFdvcmxkIQ' },
    { in: 'a',   out: 'YQ' },
    { in: 'ab',  out: 'YWI' },
    { in: 'abc', out: 'YWJj' }
  ];
  var fails = [];
  for (var i = 0; i < decodeCases.length; i++) {
    var got;
    try { got = Utils_base64UrlDecodeToString(decodeCases[i].in); }
    catch (e) { got = '<error: ' + (e && e.message ? e.message : String(e)) + '>'; }
    var ok = got === decodeCases[i].out;
    var line = (ok ? 'PASS' : 'FAIL') +
      ' base64UrlDecode(' + JSON.stringify(decodeCases[i].in) + ') -> ' + JSON.stringify(got) +
      (ok ? '' : ' (expected ' + JSON.stringify(decodeCases[i].out) + ')');
    Logger.log(line);
    if (!ok) fails.push(line);
  }
  for (var j = 0; j < encodeCases.length; j++) {
    var enc;
    try { enc = Utils_base64UrlEncode(encodeCases[j].in); }
    catch (e2) { enc = '<error: ' + (e2 && e2.message ? e2.message : String(e2)) + '>'; }
    var encOk = enc === encodeCases[j].out;
    var encLine = (encOk ? 'PASS' : 'FAIL') +
      ' base64UrlEncode(' + JSON.stringify(encodeCases[j].in) + ') -> ' + JSON.stringify(enc) +
      (encOk ? '' : ' (expected ' + JSON.stringify(encodeCases[j].out) + ')');
    Logger.log(encLine);
    if (!encOk) fails.push(encLine);
  }
  if (fails.length > 0) {
    throw new Error(fails.length + ' base64Url FAIL(s):\n' + fails.join('\n'));
  }
  return 'All ' + (decodeCases.length + encodeCases.length) + ' base64Url cases passed.';
}

function Utils_test_emailsEqual() {
  var cases = [
    // Display-form on the left, what Session.getActiveUser might hand us
    // on the right. All should be considered equivalent.
    { a: 'first.last@gmail.com',          b: 'firstlast@gmail.com',          eq: true  },
    { a: 'First.Last@Gmail.com',          b: 'firstlast@googlemail.com',     eq: true  },
    { a: 'first.last+church@gmail.com',   b: 'firstlast@gmail.com',          eq: true  },
    { a: 'first.last@example.org',        b: 'firstlast@example.org',        eq: false }, // dots significant on Workspace
    { a: 'alice@example.org',             b: 'ALICE@example.org',            eq: true  },
    { a: '',                              b: '',                             eq: true  },
    { a: 'foo@gmail.com',                 b: 'bar@gmail.com',                eq: false }
  ];
  var fails = [];
  for (var i = 0; i < cases.length; i++) {
    var got = Utils_emailsEqual(cases[i].a, cases[i].b);
    var ok = got === cases[i].eq;
    var line = (ok ? 'PASS' : 'FAIL') +
      ' emailsEqual(' + JSON.stringify(cases[i].a) + ', ' + JSON.stringify(cases[i].b) +
      ') -> ' + got + (ok ? '' : ' (expected ' + cases[i].eq + ')');
    Logger.log(line);
    if (!ok) fails.push(line);
  }
  if (fails.length > 0) {
    throw new Error(fails.length + ' emailsEqual FAIL(s):\n' + fails.join('\n'));
  }
  return 'All ' + cases.length + ' emailsEqual cases passed.';
}

function Utils_test_all() {
  var results = [];
  results.push(Utils_test_normaliseEmail());
  results.push(Utils_test_emailsEqual());
  results.push(Utils_test_base64Url());
  return results.join('\n');
}
