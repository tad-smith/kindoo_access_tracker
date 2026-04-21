// Weekly (and on-demand) import from the stake's callings spreadsheet.
//
// Entry point: Importer_runImport({ triggeredBy })
//   - Caller (ApiManager_importerRun or the weekly trigger in Chunk 9) wraps
//     this in Lock_withLock with a generous timeout — imports touch every
//     ward tab and can run for tens of seconds on a fresh install.
//   - actor_email on every per-row AuditLog entry is the literal string
//     "Importer" (spec §3.2, architecture.md §5). The signed-in manager's
//     email is recorded only as `triggeredBy` in the import_start /
//     import_end payload. Never conflate the two.
//
// Idempotency is the chunk's hardest acceptance criterion:
//   - Seats diff keys on source_row_hash (SHA-256 of scope|calling|canonical_email
//     per architecture.md D5). So `Alice.Smith@gmail.com` in one run and
//     `alicesmith@gmail.com` in the next hash to the same value — zero
//     inserts, zero deletes on the "unchanged" run.
//   - Access diff keys on (canonical_email, scope, calling). Same stability
//     property.
//   - A row that's unchanged in the source produces zero AuditLog entries —
//     only import_start / import_end brackets are always written.
//
// Writes are batched. ~250 seats on a fresh install would otherwise hit
// Apps Script's 6-minute execution cap with per-row appendRow calls
// (~150 ms each). One setValues per tab per run keeps us well under.

function Importer_runImport(opts) {
  opts = opts || {};
  var triggeredBy = opts.triggeredBy || 'unknown';
  var startedMs = Date.now();

  // import_start is written BEFORE any mutations, so even a mid-run crash
  // leaves the bracket row in place. The complementary import_end row is
  // written inside the success path; the catch path writes its own end row
  // with {error, elapsedMs}.
  AuditRepo_write({
    actor_email: 'Importer',
    action:      'import_start',
    entity_type: 'Config',
    entity_id:   'last_import_at',
    before:      null,
    after:       { triggeredBy: triggeredBy, scope: 'all' }
  });

  try {
    var result = Importer_runImport_(opts, startedMs);
    var elapsedMs = Date.now() - startedMs;
    var summary = Importer_buildSummary_(result, elapsedMs, null);

    // Record success state. These two Config writes happen inside the
    // outer Lock_withLock frame, so they're serialised against any
    // concurrent manager edits.
    try { Config_update('last_import_at', new Date()); }
    catch (e) { /* Config schema missing key? — ignore; summary still logged */ }
    Config_update('last_import_summary', summary);

    AuditRepo_write({
      actor_email: 'Importer',
      action:      'import_end',
      entity_type: 'Config',
      entity_id:   'last_import_at',
      before:      null,
      after: {
        triggeredBy:    triggeredBy,
        inserted:       result.inserted,
        deleted:        result.deleted,
        access_added:   result.accessAdded,
        access_removed: result.accessRemoved,
        skipped_tabs:   result.skippedTabs,
        warnings:       result.warnings,
        elapsed_ms:     elapsedMs
      }
    });

    Logger.log('[Importer] completed in ' + (elapsedMs / 1000).toFixed(1) +
               's — ' + result.inserted + ' inserts, ' + result.deleted +
               ' deletes, ' + result.accessAdded + ' access+, ' +
               result.accessRemoved + ' access-');

    return {
      ok:             true,
      summary:        summary,
      inserted:       result.inserted,
      deleted:        result.deleted,
      access_added:   result.accessAdded,
      access_removed: result.accessRemoved,
      warnings:       result.warnings,
      skipped_tabs:   result.skippedTabs,
      elapsed_ms:     elapsedMs
    };
  } catch (err) {
    var elapsedMsErr = Date.now() - startedMs;
    var msg = (err && err.message) ? err.message : String(err);
    var failSummary = Importer_buildSummary_(null, elapsedMsErr, msg);

    try { Config_update('last_import_at', new Date()); } catch (e2) {}
    try { Config_update('last_import_summary', failSummary); } catch (e3) {}
    try {
      AuditRepo_write({
        actor_email: 'Importer',
        action:      'import_end',
        entity_type: 'Config',
        entity_id:   'last_import_at',
        before:      null,
        after:       { triggeredBy: triggeredBy, error: msg, elapsed_ms: elapsedMsErr }
      });
    } catch (e4) { /* can't audit — nothing left to do */ }

    Logger.log('[Importer] FAILED after ' + (elapsedMsErr / 1000).toFixed(1) +
               's — ' + msg);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main worker. Pulled out for readability so the public entry can focus on
// start/end bracketing and error handling.
// ---------------------------------------------------------------------------
function Importer_runImport_(opts, startedMs) {
  var callingsSheetId = Config_get('callings_sheet_id');
  if (!callingsSheetId) {
    throw new Error('Config.callings_sheet_id is not set. Add the callings ' +
      'spreadsheet\'s ID to the Config tab before running Import Now.');
  }

  var callingsSpreadsheet;
  try {
    callingsSpreadsheet = SpreadsheetApp.openById(String(callingsSheetId));
  } catch (openErr) {
    var rawMsg = (openErr && openErr.message) ? openErr.message : String(openErr);
    throw new Error('Could not open the callings spreadsheet (id: ' +
      callingsSheetId + '). The deployer account must have at least Viewer ' +
      'access to that sheet. [' + rawMsg + ']');
  }

  var wards = Wards_getAll();
  var wardByCode = {};
  for (var w = 0; w < wards.length; w++) {
    wardByCode[wards[w].ward_code] = wards[w];
  }

  var wardTemplateIndex  = Importer_templateIndex_('ward');
  var stakeTemplateIndex = Importer_templateIndex_('stake');

  // Process each matched tab once; collect desired state per scope before
  // touching the Sheet.
  //   desiredSeatsByScope[scope]  = { hash -> { scope, person_email, person_name, calling_name, source_row_hash, building_names } }
  //   desiredAccessByScope[scope] = { canonical_email|calling -> { email (typed), scope, calling } }
  //   scopesSeen = the set of scopes we actually processed (tabs whose name
  //                matched Wards or "Stake"). Scopes NOT in this set keep
  //                whatever auto-seats they already have — per I-2 we don't
  //                delete a ward's seats just because its tab disappeared.
  var desiredSeatsByScope  = {};
  var desiredAccessByScope = {};
  var scopesSeen = {};
  var skippedTabs = [];
  var warnings = [];

  var tabs = callingsSpreadsheet.getSheets();
  for (var t = 0; t < tabs.length; t++) {
    var tab = tabs[t];
    var name = tab.getName();
    // Ward tabs prefix Position with `<CODE> ` (e.g. "CO Bishop" in the
    // Cordera tab). The Stake tab has no prefix at all — its Position
    // cells carry the full calling name directly, e.g. "Stake Relief
    // Society President". Passing prefix='' disables prefix-stripping
    // in the parser; the Position value is treated verbatim as the
    // calling name.
    var kind, scope, prefix, templateIndex, buildingDefault;
    if (name === 'Stake') {
      kind = 'stake'; scope = 'stake'; prefix = '';
      templateIndex = stakeTemplateIndex; buildingDefault = '';
    } else if (wardByCode[name]) {
      kind = 'ward'; scope = name; prefix = name;
      templateIndex = wardTemplateIndex;
      buildingDefault = wardByCode[name].building_name || '';
    } else {
      skippedTabs.push(name);
      continue;
    }
    scopesSeen[scope] = true;
    desiredSeatsByScope[scope]  = desiredSeatsByScope[scope]  || {};
    desiredAccessByScope[scope] = desiredAccessByScope[scope] || {};

    var parsed = Importer_parseTab_(tab, prefix, scope, templateIndex,
                                    buildingDefault, warnings);
    // Merge parsed into desired maps. Duplicates collapse silently (I-3).
    for (var ps = 0; ps < parsed.seats.length; ps++) {
      var s = parsed.seats[ps];
      desiredSeatsByScope[scope][s.source_row_hash] = s;
    }
    for (var pa = 0; pa < parsed.access.length; pa++) {
      var a = parsed.access[pa];
      var canon = Utils_normaliseEmail(a.email);
      var key = canon + '|' + a.calling;
      desiredAccessByScope[scope][key] = a;
    }
  }

  // Warn once per ward that has no matching tab. Purely advisory — we
  // don't delete that ward's auto-seats (per I-2).
  for (var wi = 0; wi < wards.length; wi++) {
    if (!scopesSeen[wards[wi].ward_code]) {
      warnings.push('No callings-sheet tab named "' + wards[wi].ward_code +
        '" — leaving existing auto-seats and Access rows for that ward untouched.');
    }
  }

  // Diff against existing Seats + Access per scope. For Seats we key on
  // source_row_hash. For Access we key on (canonical_email, scope, calling).
  //
  // We only touch Seats rows with type='auto' — manual/temp rows are owned
  // by the Chunk-6/7 request flow. Access rows have no type discriminator;
  // the importer owns the whole tab.
  var seatsToInsert = [];   // rows for Seats_bulkInsertAuto
  var seatsToDelete = [];   // [{ hash, before }]
  var accessToInsert = [];  // [{ email, scope, calling }]
  var accessToDelete = [];  // [{ email, scope, calling, before }]

  for (var scope1 in scopesSeen) {
    var currentAuto = Seats_getAutoByScope(scope1);
    var currentHashes = {};
    for (var ca = 0; ca < currentAuto.length; ca++) {
      currentHashes[currentAuto[ca].source_row_hash] = currentAuto[ca];
    }
    var desiredSeats = desiredSeatsByScope[scope1];
    for (var h in desiredSeats) {
      if (!currentHashes[h]) {
        seatsToInsert.push(desiredSeats[h]);
      }
    }
    for (var h2 in currentHashes) {
      if (!desiredSeats[h2]) {
        seatsToDelete.push({ hash: h2, before: currentHashes[h2] });
      }
    }

    var currentAccess = Access_getByScope(scope1);
    var currentAccessKeys = {};
    for (var cax = 0; cax < currentAccess.length; cax++) {
      var cRow = currentAccess[cax];
      var cKey = Utils_normaliseEmail(cRow.email) + '|' + cRow.calling;
      currentAccessKeys[cKey] = cRow;
    }
    var desiredAccess = desiredAccessByScope[scope1];
    for (var ak in desiredAccess) {
      if (!currentAccessKeys[ak]) {
        accessToInsert.push(desiredAccess[ak]);
      }
    }
    for (var ak2 in currentAccessKeys) {
      if (!desiredAccess[ak2]) {
        accessToDelete.push({
          email:   currentAccessKeys[ak2].email,
          scope:   currentAccessKeys[ak2].scope,
          calling: currentAccessKeys[ak2].calling,
          before:  currentAccessKeys[ak2]
        });
      }
    }
  }

  // Apply deletes first, then batched inserts. Collect per-row audit
  // entries as we go; flush them in one AuditRepo_writeMany call at the
  // end so the AuditLog tab takes one setValues round-trip rather than N.
  var auditEntries = [];

  for (var sd = 0; sd < seatsToDelete.length; sd++) {
    var d = seatsToDelete[sd];
    var deleted = Seats_deleteByHash(d.hash);
    if (!deleted) continue; // defensive — another writer beat us
    auditEntries.push({
      actor_email: 'Importer',
      action:      'delete',
      entity_type: 'Seat',
      entity_id:   deleted.seat_id,
      before:      deleted,
      after:       null
    });
  }

  // Seats_bulkInsertAuto materialises seat_id / created_at / etc. so the
  // audit entries can carry them.
  var insertedSeats = Seats_bulkInsertAuto(seatsToInsert);
  for (var is = 0; is < insertedSeats.length; is++) {
    auditEntries.push({
      actor_email: 'Importer',
      action:      'insert',
      entity_type: 'Seat',
      entity_id:   insertedSeats[is].seat_id,
      before:      null,
      after:       insertedSeats[is]
    });
  }

  for (var ad = 0; ad < accessToDelete.length; ad++) {
    var adRow = accessToDelete[ad];
    var deletedA = Access_delete(adRow.email, adRow.scope, adRow.calling);
    if (!deletedA) continue;
    auditEntries.push({
      actor_email: 'Importer',
      action:      'delete',
      entity_type: 'Access',
      entity_id:   adRow.email + '|' + adRow.scope + '|' + adRow.calling,
      before:      deletedA,
      after:       null
    });
  }

  // Access inserts — one row at a time. Volumes are tiny (one row per
  // access-granting calling per ward, ~36 on a fresh install) so per-row
  // append is fine.
  for (var ai = 0; ai < accessToInsert.length; ai++) {
    var newA = Access_insert(accessToInsert[ai]);
    auditEntries.push({
      actor_email: 'Importer',
      action:      'insert',
      entity_type: 'Access',
      entity_id:   newA.email + '|' + newA.scope + '|' + newA.calling,
      before:      null,
      after:       newA
    });
  }

  if (auditEntries.length > 0) {
    AuditRepo_writeMany(auditEntries);
  }

  return {
    inserted:       insertedSeats.length,
    deleted:        seatsToDelete.length,
    accessAdded:    accessToInsert.length,
    accessRemoved:  accessToDelete.length,
    warnings:       warnings,
    skippedTabs:    skippedTabs
  };
}

// ---------------------------------------------------------------------------
// Per-tab parser. Returns { seats: [...], access: [...] } for the rows in
// `tab` that match the template. Uses the provided prefix to strip the
// 2-letter code + space from Position. Rows with blank emails or
// non-template callings are silently skipped (per spec §8 and I-5 / I-6).
// ---------------------------------------------------------------------------
function Importer_parseTab_(tab, prefix, scope, templateIndex, buildingDefault,
                            warnings) {
  var values = tab.getDataRange().getValues();
  if (values.length < 2) return { seats: [], access: [] };

  // Layout in the real LCR-exported callings sheet:
  //   Col A  Organization
  //   Col B  Forwarding Email
  //   Col C  Position          (may sit anywhere — find by header name)
  //   Col D  Personal Email(s) (must be column D, but exact header text
  //                             varies: "Personal Email", "Personal Email(s)",
  //                             "Personal Emails", sometimes followed by a
  //                             "Note: …" instruction block). We verify the
  //                             header contains the phrase "Personal Email"
  //                             rather than an exact match.
  //   Col E+ additional email cells for multi-person callings; header text
  //          in those columns is free-form and is ignored.
  // Header row isn't always row 1 — sheets may have a title / instructions
  // block above the real headers. Scan the top 5 rows for the first row
  // that contains both "Position" (anywhere) AND a Col D header that
  // begins with "Personal Email" (with any trailing variation).
  var headerRowIdx = -1;
  var posIdx = -1;
  var emailIdx = 3; // Col D — verified by the check below, not assumed blind
  var scanLimit = Math.min(values.length, 5);
  for (var sr = 0; sr < scanLimit; sr++) {
    var p = Importer_findHeader_(values[sr], 'Position');
    if (p === -1) continue;
    if (values[sr].length <= emailIdx) continue;
    if (!Importer_looksLikePersonalEmailHeader_(values[sr][emailIdx])) continue;
    headerRowIdx = sr;
    posIdx = p;
    break;
  }
  if (headerRowIdx === -1) {
    // Couldn't match the header row. Log what we saw in row 1 so the
    // operator can diff against the expected layout.
    var r1Preview = [];
    var previewCells = Math.min(values[0].length, 10);
    for (var pc = 0; pc < previewCells; pc++) {
      r1Preview.push(JSON.stringify(values[0][pc]));
    }
    warnings.push('Tab "' + tab.getName() + '" header row not found ' +
      '(expected a row within the top 5 that has "Position" anywhere and ' +
      '"Personal Email" — with any trailing variation — in column D). ' +
      'Row 1 starts with: [' + r1Preview.join(', ') + ']. Skipping tab.');
    return { seats: [], access: [] };
  }

  var seats = [];
  var access = [];
  // Empty `prefix` means "no prefix to strip" (Stake tab); otherwise the
  // prefix token we strip is `<CODE> ` (e.g. "CO ").
  var prefixToken = prefix ? (prefix + ' ') : '';

  for (var r = headerRowIdx + 1; r < values.length; r++) {
    var row = values[r];
    var positionRaw = row[posIdx];
    if (positionRaw == null || positionRaw === '') continue;
    var position = String(positionRaw).trim();
    if (!position) continue;

    // Prefix-strip. If the tab has no prefix contract (Stake), use the
    // Position verbatim. Otherwise require the `<CODE> ` prefix — a row
    // without it is almost certainly a typo (I-5), warn and skip; do NOT
    // try to guess a different scope.
    var callingName;
    if (!prefixToken) {
      callingName = position;
    } else if (position.indexOf(prefixToken) === 0) {
      callingName = position.substring(prefixToken.length).trim();
    } else if (position === prefix) {
      continue; // just the prefix with nothing after — nonsensical, skip
    } else {
      warnings.push('Tab "' + tab.getName() + '" row ' + (r + 1) +
        ': Position "' + position + '" does not start with expected prefix "' +
        prefixToken + '" — skipped.');
      continue;
    }

    if (!callingName) continue;
    var tpl = Importer_templateMatch_(templateIndex, callingName);
    if (!tpl) continue;  // not in curation layer — skip silently (I-6)

    // Collect emails: Personal Email(s) cell + every non-blank cell to
    // its right. A cell may contain a bracketed Gmail override such as
    //   "first.last@example.org [GoogleAccount: firstlast@gmail.com]"
    // (LCR's convention for people whose primary address isn't a Google
    // account — the Gmail form is what they actually sign in with). When
    // we see that bracket, use the inner gmail address; otherwise use
    // the cell value as-is.
    var emails = [];
    for (var c = emailIdx; c < row.length; c++) {
      var extracted = Importer_extractEmailFromCell_(row[c]);
      if (!extracted) continue;
      emails.push(extracted);
    }
    if (emails.length === 0) continue; // empty personal email → skip row

    // Emit one (seat, access?) pair per (calling, email). Duplicates across
    // the whole tab collapse in the caller because the hash is the key.
    for (var ei = 0; ei < emails.length; ei++) {
      var email = emails[ei];
      var hash = Utils_hashRow(scope, callingName, email);
      seats.push({
        scope:           scope,
        person_email:    email,
        person_name:     '', // callings sheet has no dedicated name column in this layout
        calling_name:    callingName,
        source_row_hash: hash,
        building_names:  buildingDefault
      });
      if (tpl.give_app_access) {
        access.push({ email: email, scope: scope, calling: callingName });
      }
    }
  }

  return { seats: seats, access: access };
}

function Importer_findHeader_(headers, name) {
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i]).trim() === name) return i;
  }
  return -1;
}

// Is the given cell value plausibly the Col D "Personal Email(s)" header?
// LCR exports vary the exact text ("Personal Email", "Personal Email(s)",
// "Personal Emails", sometimes followed by a \n-delimited "Note: ..."
// instruction block that bleeds into the header cell). Accept any cell
// whose text contains "personal email" (case-insensitive) as a substring.
function Importer_looksLikePersonalEmailHeader_(cell) {
  if (cell == null) return false;
  var s = String(cell).trim().toLowerCase();
  return s.indexOf('personal email') !== -1;
}

// Extract the email to use for sign-in / role resolution from an LCR
// Personal-Email(s) cell. If the cell contains a "[GoogleAccount: X]"
// bracket (LCR's override for people whose primary address isn't a Gmail
// account), return X — that's the address they actually sign in with.
// Otherwise return the trimmed cell value. Returns '' for empty /
// whitespace-only / malformed cells so callers can skip them.
//
// Examples (per docs/open-questions.md I-9):
//   "alice@gmail.com"                                   → "alice@gmail.com"
//   "alice@example.org [GoogleAccount: alice@gmail.com]"
//                                                       → "alice@gmail.com"
//   "[GoogleAccount: solo@gmail.com]"                   → "solo@gmail.com"
//   "alice@example.org [GoogleAccount: ] stray note"    → "alice@example.org stray note"
//       (malformed bracket — empty capture — fall back to the plain text)
//   ""                                                  → ""
function Importer_extractEmailFromCell_(v) {
  if (v == null) return '';
  var s = String(v).trim();
  if (!s) return '';
  // Case-insensitive match on the bracket. `\s*` after the colon tolerates
  // "[GoogleAccount:foo]" and "[GoogleAccount :  foo]"; `[^\]]+` captures
  // everything up to the closing bracket (no nested brackets expected in
  // these cells).
  var m = s.match(/\[\s*GoogleAccount\s*:\s*([^\]]+?)\s*\]/i);
  if (m && m[1]) {
    var inner = Utils_cleanEmail(m[1]);
    if (inner) return inner;
    // Empty or whitespace-only capture — treat the bracket as noise and
    // fall through to strip it off the plain-text side.
  }
  // Strip any "[GoogleAccount: …]" (or malformed variant) out so the
  // plain-text-only fallback doesn't end up containing bracket fragments.
  var stripped = s.replace(/\s*\[\s*GoogleAccount\s*:[^\]]*\]\s*/ig, ' ')
                  .replace(/\s+/g, ' ')
                  .trim();
  return Utils_cleanEmail(stripped);
}

// Runnable smoke test for the wildcard matcher. Wired into the
// Kindoo Admin menu in Setup.gs#onOpen.
function Importer_test_wildcardMatch() {
  var cases = [
    // Exact beats wildcard (via Importer_templateMatch_, not tested here
    // directly; we just verify the regex layer). The matcher is anchored,
    // so a pattern has to describe the whole calling.
    { pat: 'Bishop',                      target: 'Bishop',                           match: true },
    { pat: 'Bishop',                      target: 'Bishop ',                          match: false },
    { pat: 'Stake High Councilor*',       target: 'Stake High Councilor',             match: true },
    { pat: 'Stake High Councilor*',       target: 'Stake High Councilor - Cordera Ward', match: true },
    { pat: 'Stake High Councilor*',       target: 'Bishop',                           match: false },
    { pat: '*',                           target: 'anything',                         match: true },
    { pat: '*',                           target: '',                                 match: true },
    { pat: 'Second*Counselor',            target: 'Second Counselor',                 match: true },
    { pat: 'Second*Counselor',            target: 'Second Ward Counselor',            match: true },
    { pat: 'Second*Counselor',            target: 'First Counselor',                  match: false },
    // Regex metacharacters in the pattern must be literal.
    { pat: 'Clerk (Assistant)',           target: 'Clerk (Assistant)',                match: true },
    { pat: 'Clerk (Assistant)',           target: 'Clerk Assistant',                  match: false },
    { pat: 'A.B',                         target: 'AxB',                              match: false },
    { pat: 'A.B',                         target: 'A.B',                              match: true }
  ];
  var fails = [];
  for (var i = 0; i < cases.length; i++) {
    var got = Importer_wildcardToRegex_(cases[i].pat).test(cases[i].target);
    var ok = got === cases[i].match;
    var line = (ok ? 'PASS' : 'FAIL') +
      ' wildcard(' + JSON.stringify(cases[i].pat) + ' vs ' +
      JSON.stringify(cases[i].target) + ') -> ' + got +
      (ok ? '' : ' (expected ' + cases[i].match + ')');
    Logger.log(line);
    if (!ok) fails.push(line);
  }
  if (fails.length > 0) {
    throw new Error(fails.length + ' wildcard FAIL(s):\n' + fails.join('\n'));
  }
  return 'All ' + cases.length + ' wildcard cases passed.';
}

// Runnable smoke test — Kindoo Admin → Run Importer email-cell tests
// (wired up in Setup.gs#onOpen).
function Importer_test_extractEmailFromCell() {
  var cases = [
    { in: 'alice@gmail.com',
      out: 'alice@gmail.com' },
    { in: 'alice@example.org [GoogleAccount: alice@gmail.com]',
      out: 'alice@gmail.com' },
    { in: '  Alice.Smith@Gmail.com  ',
      out: 'Alice.Smith@Gmail.com' },
    { in: '[GoogleAccount: solo@gmail.com]',
      out: 'solo@gmail.com' },
    { in: '[googleaccount:  mixedcase@gmail.com  ]',
      out: 'mixedcase@gmail.com' },
    { in: 'alice@example.org [GoogleAccount: ] stray note',
      out: 'alice@example.org stray note' },
    { in: '',       out: '' },
    { in: '   ',    out: '' },
    { in: null,     out: '' },
    { in: undefined, out: '' }
  ];
  var fails = [];
  for (var i = 0; i < cases.length; i++) {
    var got = Importer_extractEmailFromCell_(cases[i].in);
    var ok = got === cases[i].out;
    var line = (ok ? 'PASS' : 'FAIL') +
      ' extractEmailFromCell(' + JSON.stringify(cases[i].in) +
      ') -> ' + JSON.stringify(got) +
      (ok ? '' : ' (expected ' + JSON.stringify(cases[i].out) + ')');
    Logger.log(line);
    if (!ok) fails.push(line);
  }
  if (fails.length > 0) {
    throw new Error(fails.length + ' extractEmailFromCell FAIL(s):\n' + fails.join('\n'));
  }
  return 'All ' + cases.length + ' extractEmailFromCell cases passed.';
}

// Build a lookup index over a calling template. `calling_name` entries
// containing the `*` wildcard turn into regex patterns; plain entries stay
// on the fast-path exact-match map. Exact matches always take priority
// over wildcard matches in Importer_templateMatch_ so a row with e.g.
// `Bishop` (exact) wins over `B*` (wildcard) for Position `Bishop`.
//
// Wildcard semantics: `*` → "any run of characters (including none)",
// equivalent to `.*` in a regex. All other characters are literal. Match
// is case-sensitive and anchored to both ends (the pattern must describe
// the whole calling, not a prefix). Examples:
//   `Stake High Councilor*`        → matches `Stake High Councilor`,
//                                    `Stake High Councilor - Cordera Ward`
//   `*`                            → matches every calling on the tab
//   `Second*Counselor`             → matches `Second Ward Counselor`
function Importer_templateIndex_(kind) {
  var rows = Templates_getAll(kind);
  var exact = {};
  var wildcards = [];
  for (var i = 0; i < rows.length; i++) {
    var name = rows[i].calling_name;
    var give = rows[i].give_app_access === true;
    if (!name) continue;
    if (name.indexOf('*') === -1) {
      exact[name] = { calling_name: name, give_app_access: give };
    } else {
      wildcards.push({
        calling_name:    name,
        give_app_access: give,
        regex:           Importer_wildcardToRegex_(name)
      });
    }
  }
  return { exact: exact, wildcards: wildcards };
}

// Return the template entry matching `callingName`, or null. Exact matches
// win over wildcard matches. Among wildcard matches, the first listed in
// the Sheet wins (Templates_getAll preserves Sheet row order) — we don't
// try to pick the "most specific" pattern.
function Importer_templateMatch_(index, callingName) {
  if (index.exact[callingName]) return index.exact[callingName];
  for (var i = 0; i < index.wildcards.length; i++) {
    if (index.wildcards[i].regex.test(callingName)) return index.wildcards[i];
  }
  return null;
}

// Turn a user-facing wildcard pattern (with `*`) into an anchored regex.
// Every regex metacharacter except `*` is escaped; `*` becomes `.*`.
function Importer_wildcardToRegex_(pattern) {
  // Escape regex specials except * (which will be substituted next).
  var escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  // Turn * into .* (zero-or-more of anything).
  var rx = escaped.replace(/\*/g, '.*');
  return new RegExp('^' + rx + '$');
}

// ---------------------------------------------------------------------------
// Summary string for Config.last_import_summary and the Import page's
// "last import" line. Manager UI renders this verbatim.
// ---------------------------------------------------------------------------
function Importer_buildSummary_(result, elapsedMs, errMsg) {
  var tz = Session.getScriptTimeZone();
  var when = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm z');
  if (errMsg) {
    return 'FAILED: ' + errMsg + ' (' + when + ', ' + (elapsedMs / 1000).toFixed(1) + 's)';
  }
  var parts = [
    result.inserted + ' insert' + (result.inserted === 1 ? '' : 's'),
    result.deleted + ' delete' + (result.deleted === 1 ? '' : 's')
  ];
  if (result.accessAdded > 0 || result.accessRemoved > 0) {
    parts.push(result.accessAdded + ' access+/' + result.accessRemoved + ' access-');
  }
  if (result.warnings && result.warnings.length > 0) {
    parts.push(result.warnings.length + ' warning' +
               (result.warnings.length === 1 ? '' : 's'));
  }
  return parts.join(', ') + ' (' + when + ', ' + (elapsedMs / 1000).toFixed(1) + 's)';
}
