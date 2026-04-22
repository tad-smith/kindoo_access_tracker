// Kindoo Manager API surface. Every endpoint follows the canonical Chunk-2
// shape established by chunk-1-scaffolding.md's "Next" section:
//
//   function ApiManager_xxxUpsert(token, row) {
//     var principal = Auth_principalFrom(token);   // verifies HMAC, resolves roles
//     Auth_requireRole(principal, 'manager');      // throws Forbidden on non-manager
//     return Lock_withLock(function () {           // serialises with every other writer
//       var before = Xxx_getById(row.xxx_id);
//       var after  = Xxx_insert_or_update(row);
//       AuditRepo_write({                          // single audit row, INSIDE the lock
//         actor_email: principal.email,            // canonical email from verified token
//         action: before ? 'update' : 'insert',
//         entity_type: 'Xxx',
//         entity_id: after.xxx_id,
//         before: before,                          // null on insert
//         after:  after                            // null on delete
//       });
//       return after;
//     });
//   }
//
// Notes:
//   - actor_email comes from the verified principal — NOT Session.getActiveUser
//     (which under Main's USER_DEPLOYING returns the deployer or empty).
//   - The data write and the audit write share one lock acquisition so the
//     log can never disagree with the data, even on crash.
//   - Action vocabulary is the generic 'insert' / 'update' / 'delete' set
//     from data-model.md §10 (the example shape uses 'ward_insert' etc;
//     we follow the canonical vocabulary instead).
//   - entity_type values are capitalised per data-model.md ('Ward', not 'ward').
//   - FK enforcement on deletes (Building→Ward) is here in the API layer,
//     not in repos (architecture.md §7 keeps repos pure single-tab).
//
// "Out of scope per build-plan Chunk 2":
//   - Access edits (importer owns that tab — Chunk 3).
//   - Seats inline edit (Chunk 5/6).
//   - Importer / queue / dashboard endpoints (Chunks 3, 6, 10).

// ===========================================================================
// Config
// ===========================================================================

function ApiManager_configList(token) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  // Read path — no lock. Returns { all: {...}, protected: [...], system: [...] }
  // so the UI can decide which keys to render read-only without re-encoding
  // the policy on the client. `importer` is preserved as a legacy alias for
  // Chunk-2/9 clients; `system` is the Chunk-10 accurate name (the list
  // includes expiry-owned keys too).
  var all = Config_getAll();
  var protectedKeys = [];
  var systemKeys = [];
  for (var k in all) {
    if (Config_isProtectedKey(k)) protectedKeys.push(k);
    else if (Config_isSystemKey(k)) systemKeys.push(k);
    // google.script.run has a serialization edge case where a response
    // object with Date-valued properties alongside null-valued properties
    // can arrive at the client as a literal `null`. Config routinely has
    // both (last_import_at is a Date; unset string keys coerce to null).
    // Pre-stringify every Date here — ApiManager_importStatus does the
    // same trick for the same reason. Values are consumed read-only by
    // the manager Config UI, so the shape change (Date → formatted
    // string) is fine; we don't round-trip them back for a write.
    if (all[k] instanceof Date) {
      var tz = Session.getScriptTimeZone();
      all[k] = Utilities.formatDate(all[k], tz, 'yyyy-MM-dd HH:mm:ss z');
    }
  }
  // session_secret leaks via the wire if we send it back. Mask its value.
  if (all.session_secret) {
    all.session_secret = '(set — ' + String(all.session_secret).length + ' chars; hidden)';
  }
  return {
    all:       all,
    protected: protectedKeys,
    system:    systemKeys,
    importer:  systemKeys  // legacy alias — pre-Chunk-10 clients read this name
  };
}

function ApiManager_configUpdate(token, key, value) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  if (!key) throw new Error('configUpdate: key required');
  // Defence-in-depth: refuse to touch any of the security-sensitive or
  // importer-owned keys via the manager surface, even if the client tries.
  if (Config_isProtectedKey(key)) {
    throw new Error('Config key "' + key + '" is protected from inline edit. ' +
      'Edit it directly in the Sheet (and re-deploy if needed). See ' +
      'docs/open-questions.md C-4.');
  }
  if (Config_isSystemKey(key)) {
    throw new Error('Config key "' + key + '" is managed by a background ' +
      'process (importer or expiry); don\'t edit it from here.');
  }
  return Lock_withLock(function () {
    var result = Config_update(key, value);
    AuditRepo_write({
      actor_email: principal.email,
      action:      'update',
      entity_type: 'Config',
      entity_id:   key,
      before:      { key: key, value: result.before },
      after:       { key: key, value: result.after }
    });
    return result;
  });
}

// ===========================================================================
// Wards
// ===========================================================================

function ApiManager_wardsList(token) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  return Wards_getAll();
}

function ApiManager_wardsUpsert(token, row) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  if (!row || !row.ward_code) throw new Error('wardsUpsert: ward_code required');
  return Lock_withLock(function () {
    var before = Wards_getByCode(row.ward_code);
    // FK validate building_name against the Buildings tab on insert/update.
    // (Inserting with an unknown building_name would create a dangling FK;
    // the user almost always means a typo or stale picker, so reject.)
    if (row.building_name) {
      if (!Buildings_getByName(String(row.building_name).trim())) {
        throw new Error('Unknown building "' + row.building_name +
          '" — add the building first, or pick an existing one.');
      }
    }
    var after, action;
    if (before) {
      after = Wards_update(before.ward_code, row).after;
      action = 'update';
    } else {
      after = Wards_insert(row);
      action = 'insert';
    }
    AuditRepo_write({
      actor_email: principal.email,
      action:      action,
      entity_type: 'Ward',
      entity_id:   after.ward_code,
      before:      before,
      after:       after
    });
    return after;
  });
}

function ApiManager_wardsDelete(token, wardCode) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  if (!wardCode) throw new Error('wardsDelete: ward_code required');
  return Lock_withLock(function () {
    // Ward → Seat FK is not enforced here in Chunk 2 — Seats has no data
    // until Chunk 3 (importer) and Chunk 6 (manual requests). When
    // SeatsRepo lands, add a Seats_countByScope(wardCode) check here
    // mirroring the Building → Ward block below.
    var before = Wards_delete(wardCode);
    AuditRepo_write({
      actor_email: principal.email,
      action:      'delete',
      entity_type: 'Ward',
      entity_id:   wardCode,
      before:      before,
      after:       null
    });
    return { ok: true, deleted: before };
  });
}

// ===========================================================================
// Buildings
// ===========================================================================

function ApiManager_buildingsList(token) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  return Buildings_getAll();
}

function ApiManager_buildingsUpsert(token, row) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  if (!row || !row.building_name) throw new Error('buildingsUpsert: building_name required');
  return Lock_withLock(function () {
    var before = Buildings_getByName(row.building_name);
    var after, action;
    if (before) {
      after = Buildings_update(before.building_name, row).after;
      action = 'update';
    } else {
      after = Buildings_insert(row);
      action = 'insert';
    }
    AuditRepo_write({
      actor_email: principal.email,
      action:      action,
      entity_type: 'Building',
      entity_id:   after.building_name,
      before:      before,
      after:       after
    });
    return after;
  });
}

function ApiManager_buildingsDelete(token, buildingName) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  if (!buildingName) throw new Error('buildingsDelete: building_name required');
  var key = String(buildingName).trim();
  return Lock_withLock(function () {
    // FK guard: refuse to delete a Building that any Ward references via
    // Wards.building_name.
    var blockers = [];
    var wards = Wards_getAll();
    for (var i = 0; i < wards.length; i++) {
      if (wards[i].building_name === key) {
        blockers.push(wards[i].ward_code);
      }
    }
    if (blockers.length > 0) {
      throw new Error('Cannot delete building "' + key +
        '" — it is still referenced by ' + blockers.length + ' ward' +
        (blockers.length === 1 ? '' : 's') + ' (ward_code: ' +
        blockers.join(', ') + '). Reassign or delete those wards first.');
    }
    var before = Buildings_delete(key);
    AuditRepo_write({
      actor_email: principal.email,
      action:      'delete',
      entity_type: 'Building',
      entity_id:   key,
      before:      before,
      after:       null
    });
    return { ok: true, deleted: before };
  });
}

// ===========================================================================
// KindooManagers
// ===========================================================================

function ApiManager_kindooManagersList(token) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  return KindooManagers_getAll();
}

function ApiManager_kindooManagersUpsert(token, row) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  if (!row || !row.email) throw new Error('kindooManagersUpsert: email required');
  return Lock_withLock(function () {
    // Look up by email-equality (Utils_emailsEqual under the hood), so
    // typing first.last@gmail.com when firstlast@gmail.com already
    // exists hits the existing row instead of creating a duplicate.
    var before = KindooManagers_getByEmail(row.email);
    var after, action;
    if (before) {
      after = KindooManagers_update(before.email, row).after;
      action = 'update';
    } else {
      after = KindooManagers_insert(row);
      action = 'insert';
    }
    AuditRepo_write({
      actor_email: principal.email,
      action:      action,
      entity_type: 'KindooManager',
      entity_id:   after.email,
      before:      before,
      after:       after
    });
    return after;
  });
}

function ApiManager_kindooManagersDelete(token, email) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  if (!email) throw new Error('kindooManagersDelete: email required');
  var typed = Utils_cleanEmail(email);
  return Lock_withLock(function () {
    // Soft warning: deleting the only active manager doesn't block — over-cap
    // emails (Chunk 9) and request notifications (Chunk 6) won't have anyone
    // to send to until a new active manager is added. Block would be too
    // strict (the operator might immediately add a replacement).
    var warning = '';
    var allBefore = KindooManagers_getAll();
    var activeCountBefore = 0;
    var deletingActive = false;
    for (var i = 0; i < allBefore.length; i++) {
      if (allBefore[i].active) activeCountBefore++;
      if (Utils_emailsEqual(allBefore[i].email, typed) && allBefore[i].active) {
        deletingActive = true;
      }
    }
    if (deletingActive && activeCountBefore === 1) {
      warning = 'You just deleted the last active Kindoo Manager. ' +
                'Manager-bound notifications (request submissions, over-cap warnings) ' +
                'will silently drop until you add a new active manager.';
    }
    var before = KindooManagers_delete(typed);
    AuditRepo_write({
      actor_email: principal.email,
      action:      'delete',
      entity_type: 'KindooManager',
      entity_id:   before.email,
      before:      before,
      after:       null
    });
    return { ok: true, deleted: before, warning: warning };
  });
}

// ===========================================================================
// WardCallingTemplate
// ===========================================================================

function ApiManager_wardTemplateList(token) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  return Templates_getAll('ward');
}

function ApiManager_wardTemplateUpsert(token, row) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  return ApiManager_templateUpsert_('ward', principal, row, 'WardCallingTemplate');
}

function ApiManager_wardTemplateDelete(token, callingName) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  return ApiManager_templateDelete_('ward', principal, callingName, 'WardCallingTemplate');
}

// ===========================================================================
// StakeCallingTemplate
// ===========================================================================

function ApiManager_stakeTemplateList(token) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  return Templates_getAll('stake');
}

function ApiManager_stakeTemplateUpsert(token, row) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  return ApiManager_templateUpsert_('stake', principal, row, 'StakeCallingTemplate');
}

function ApiManager_stakeTemplateDelete(token, callingName) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  return ApiManager_templateDelete_('stake', principal, callingName, 'StakeCallingTemplate');
}

// Both template tabs share a schema, so the upsert/delete plumbing is
// shared too. The two endpoints per kind exist as thin wrappers so the
// per-endpoint security check (Auth_requireRole) is right at the top of
// each rpc-callable function — easier to audit and to grep for.
function ApiManager_templateUpsert_(kind, principal, row, label) {
  if (!row || !row.calling_name) throw new Error(label + 'Upsert: calling_name required');
  return Lock_withLock(function () {
    var before = Templates_getByName(kind, row.calling_name);
    var after, action;
    if (before) {
      after = Templates_update(kind, before.calling_name, row).after;
      action = 'update';
    } else {
      after = Templates_insert(kind, row);
      action = 'insert';
    }
    AuditRepo_write({
      actor_email: principal.email,
      action:      action,
      entity_type: 'Template',
      entity_id:   label + '|' + after.calling_name,
      before:      before,
      after:       after
    });
    return after;
  });
}

function ApiManager_templateDelete_(kind, principal, callingName, label) {
  if (!callingName) throw new Error(label + 'Delete: calling_name required');
  return Lock_withLock(function () {
    var before = Templates_delete(kind, callingName);
    AuditRepo_write({
      actor_email: principal.email,
      action:      'delete',
      entity_type: 'Template',
      entity_id:   label + '|' + callingName,
      before:      before,
      after:       null
    });
    return { ok: true, deleted: before };
  });
}

// ===========================================================================
// Importer (Chunks 3 + 9)
// ===========================================================================
//
// Chunk 3 established the single-lock contract: one Lock_withLock covers
// the full run, inside which the service emits import_start → diff-and-
// apply → Config.last_import_at / summary update → import_end audit.
//
// Chunk 9 moves that lock INSIDE Importer_runImport itself so the weekly
// trigger (which calls Importer_runImport directly) gets the same
// acquisition shape as a manual run. The endpoint here just verifies the
// manager role and forwards; no Lock_withLock wrap here any more (would be
// a nested acquisition — Lock_withLock is not reentrant).
//
// After the import lock releases, Importer_runImport runs a second pass
// for over-cap detection (a read-only scan) and — if any pool is over —
// writes a single `over_cap_warning` audit row in its own small lock and
// sends an email best-effort OUTSIDE both locks (architecture.md §9.5).
// Both the manual endpoint and the weekly trigger exercise the same
// over-cap path.
//
// actor_email on every per-row AuditLog entry (including over_cap_warning)
// is "Importer" (literal string — see architecture.md §5 and
// data-model.md §10). principal.email flows in as `triggeredBy` so the
// import_start / import_end brackets record who ran the import; the
// weekly trigger substitutes the literal 'weekly-trigger' for the same
// field.

function ApiManager_importerRun(token) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  return Importer_runImport({ triggeredBy: principal.email });
}

function ApiManager_importStatus(token) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  // Serialise Date to an ISO-ish string server-side. google.script.run's
  // automatic Date-to-string conversion has edge cases (notably returning
  // the whole response as null in some SDK versions when a Date property
  // coexists with null-valued siblings) — a pre-formatted string is
  // predictable. Client parses it back with `new Date()` for locale
  // rendering if it wants to.
  var rawAt = Config_get('last_import_at');
  var lastAt = null;
  if (rawAt instanceof Date) {
    var tz = Session.getScriptTimeZone();
    lastAt = Utilities.formatDate(rawAt, tz, 'yyyy-MM-dd HH:mm:ss z');
  } else if (rawAt) {
    lastAt = String(rawAt);
  }
  // Chunk 9: last-run over-cap snapshot. Parsed server-side so a
  // malformed cell (hand-edited) surfaces as an empty banner rather than
  // a client-side parse exception. '' / '[]' → no banner.
  var lastOverCaps = [];
  var rawOverCaps = Config_get('last_over_caps_json');
  if (rawOverCaps) {
    try {
      var parsed = JSON.parse(String(rawOverCaps));
      if (Array.isArray(parsed)) lastOverCaps = parsed;
    } catch (e) {
      Logger.log('[ApiManager_importStatus] last_over_caps_json parse failed: ' + e);
    }
  }
  return {
    last_import_at:      lastAt,
    last_import_summary: Config_get('last_import_summary') || null,
    callings_sheet_id:   Config_get('callings_sheet_id')   || null,
    last_over_caps:      lastOverCaps
  };
}

// ===========================================================================
// Access — read-only manager view of importer-owned tab
// ===========================================================================

function ApiManager_accessList(token) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  return Access_getAll();
}

// ===========================================================================
// Triggers — self-heal surface (Chunk 8)
// ===========================================================================
//
// architecture.md §9.3: the Configuration page carries a "Reinstall
// triggers" button so an operator can fix a lost trigger without opening
// the Apps Script editor. Same code path as the bootstrap wizard's
// Complete-Setup call — TriggersService_install is idempotent.
//
// The list endpoint is read-only (no lock) so the UI can render the
// current trigger set alongside the button for verification.

function ApiManager_listTriggers(token) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  return TriggersService_list();
}

function ApiManager_reinstallTriggers(token) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  return Lock_withLock(function () {
    var before = TriggersService_list();
    var result = TriggersService_install();
    var after = TriggersService_list();
    AuditRepo_write({
      actor_email: principal.email,
      action:      'reinstall_triggers',
      entity_type: 'Config',
      entity_id:   'triggers',
      before:      { triggers: before },
      after:       { triggers: after, result: result }
    });
    return {
      installed: result.installed,
      removed:   result.removed,
      message:   result.message,
      triggers:  after
    };
  });
}

// ===========================================================================
// Rosters — All Seats (Chunk 5)
// ===========================================================================
//
// Manager-facing equivalent of ApiBishopric_roster / ApiStake_roster. Returns
// every seat across every scope, filtered by optional { ward, building,
// type } filters, plus per-scope summaries for the utilization bar(s) and
// the filter-dropdown option lists. Filters combine as AND.
//
// ward filter values: '' / 'all' (no filter), 'stake', or any ward_code.
// building filter:    '' / 'all' (no filter), or a Buildings.building_name.
//                     Matches if the seat's comma-separated building_names
//                     contains an exact-match entry.
// type filter:        '' / 'all', 'auto', 'manual', 'temp'.

function ApiManager_allSeats(token, filters) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  filters = filters || {};

  var wardFilter     = ApiManager_allSeats_coerce_(filters.ward);
  var buildingFilter = ApiManager_allSeats_coerce_(filters.building);
  var typeFilter     = ApiManager_allSeats_coerce_(filters.type);

  var ctx   = Rosters_buildContext_();
  var seats = Seats_getAll();

  // Filter first, then bucket + shape via Rosters_buildResponseFromSeats_
  // so the per-scope summaries reflect the *filtered* view (e.g., filtering
  // to type=manual shows a small utilization relative to cap, which is
  // correct: that's how many manual seats exist, not how many total).
  //
  // Note: over-cap summaries always reflect the filtered count. An operator
  // who picks type=auto and sees over_cap=false even when the ward is over
  // cap overall is by design — the header-level "over cap" signal belongs
  // on the Dashboard (Chunk 10), not here.
  var filtered = [];
  for (var i = 0; i < seats.length; i++) {
    var row = seats[i];
    if (wardFilter && row.scope !== wardFilter) continue;
    if (typeFilter && row.type  !== typeFilter) continue;
    if (buildingFilter && !ApiManager_allSeats_matchesBuilding_(row.building_names, buildingFilter)) continue;
    filtered.push(row);
  }

  // Bucket by scope for per-scope summaries. Order: 'stake' first, then
  // ward_codes alphabetically — matches the stake-first convention used
  // on the manager Access page.
  var byScope = {};
  for (var j = 0; j < filtered.length; j++) {
    var sc = filtered[j].scope;
    if (!byScope[sc]) byScope[sc] = [];
    byScope[sc].push(filtered[j]);
  }
  var scopeKeys = Object.keys(byScope).sort(function (a, b) {
    if (a === 'stake') return -1;
    if (b === 'stake') return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  var summaries = [];
  var rows      = [];
  for (var k = 0; k < scopeKeys.length; k++) {
    var packet = Rosters_buildResponseFromSeats_(scopeKeys[k], byScope[scopeKeys[k]], ctx);
    summaries.push(packet.summary);
    for (var r = 0; r < packet.rows.length; r++) rows.push(packet.rows[r]);
  }

  // Filter-option lists. Tiny at scale (12 wards + Stake, handful of
  // buildings), always sent so the client can render the filter row
  // without a second round-trip. The ward list includes 'stake' as a
  // pseudo-entry since it's a valid filter value.
  var wardList = [];
  var allWards = Wards_getAll();
  for (var w = 0; w < allWards.length; w++) {
    wardList.push({ ward_code: allWards[w].ward_code, ward_name: allWards[w].ward_name });
  }
  var buildingList = [];
  var allBuildings = Buildings_getAll();
  for (var b = 0; b < allBuildings.length; b++) {
    buildingList.push(allBuildings[b].building_name);
  }

  return {
    rows:           rows,
    summaries:      summaries,
    total_rows:     rows.length,
    filter_options: {
      wards:     wardList,
      buildings: buildingList
    },
    applied_filters: {
      ward:     wardFilter     || '',
      building: buildingFilter || '',
      type:     typeFilter     || ''
    }
  };
}

function ApiManager_allSeats_coerce_(v) {
  if (v == null) return '';
  var s = String(v).trim();
  if (!s || s === 'all') return '';
  return s;
}

// Seat's building_names is a comma-separated string of building_name
// values (data-model.md Tab 8). An empty value means "uses the ward's
// default" — for filter purposes we treat empty as "no match" against
// any specific building_name so the filter excludes un-assigned seats.
// The manager can either filter to 'all' or edit the seat to add an
// explicit building_name. (Chunk-6 inline edit adds that surface.)
function ApiManager_allSeats_matchesBuilding_(buildingNames, filter) {
  if (!buildingNames) return false;
  var parts = String(buildingNames).split(',');
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].trim() === filter) return true;
  }
  return false;
}

// ===========================================================================
// Requests Queue + inline Seat edit (Chunk 6)
// ===========================================================================
//
// Manager surface for the request lifecycle. Submit / cancel flows live in
// api/ApiRequests.gs (shared across bishopric + stake principals);
// complete / reject are manager-only and live here.
//
// Self-approval policy (build-plan.md Chunk 6 → "Policy (confirmed)"): a
// manager who is ALSO a bishopric / stake member may complete or reject
// requests they themselves submitted. The server-side handler does NOT
// check requester_email against managerPrincipal.email — the audit trail
// already records who submitted and who completed, so the chain of
// custody is clear even when those addresses are the same. No guard
// here; none in the queue UI.
//
// Email sends happen OUTSIDE Lock_withLock, best-effort; a mail failure
// surfaces as a `warning` field on the response rather than unwinding
// the write (same pattern as ApiRequests_submit / _cancel).

// Queue state filter. `state='pending'` shows only open requests.
// `state='complete'` groups the three terminal statuses (complete,
// rejected, cancelled) — the queue UI only needs to distinguish "waiting
// on a manager" from "done, for whatever definition of done". A future
// Chunk-10 audit-log page may want to filter by the exact status value;
// that surface can call ApiManager_listRequests with a different filter
// shape then.
const REQUESTS_STATE_TERMINAL_ = {
  complete:  true,
  rejected:  true,
  cancelled: true
};

function ApiManager_listRequests(token, filters) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  filters = filters || {};
  var wardFilter = ApiManager_listRequests_coerce_(filters.ward);
  var typeFilter = ApiManager_listRequests_coerce_(filters.type);
  // state is the canonical UI filter ('pending' | 'complete'); default
  // pending. `status` (singular-value) is still accepted for future
  // pages that want an exact match; if both are supplied, state wins.
  var stateFilter = ApiManager_listRequests_coerce_(filters.state);
  var exactStatus = ApiManager_listRequests_coerce_(filters.status);
  if (!stateFilter && !exactStatus) stateFilter = 'pending';
  if (stateFilter && stateFilter !== 'pending' && stateFilter !== 'complete') {
    throw new Error('Invalid state filter "' + stateFilter + '" — must be pending or complete.');
  }

  // Read once; filter in memory. Target scale is 1-2 requests/week; a
  // full scan is trivially cheap here.
  var all = Requests_getAll();
  var rows = [];
  for (var i = 0; i < all.length; i++) {
    var r = all[i];
    if (stateFilter === 'pending'  && r.status !== 'pending') continue;
    if (stateFilter === 'complete' && !REQUESTS_STATE_TERMINAL_[r.status]) continue;
    if (exactStatus && !stateFilter && r.status !== exactStatus) continue;
    if (wardFilter && r.scope !== wardFilter) continue;
    if (typeFilter && r.type  !== typeFilter) continue;
    rows.push(ApiManager_shapeRequestForClient_(r));
  }
  // Pending queue: oldest-first so the backlog clears FIFO.
  // Complete view: newest-first so recently-resolved requests are
  // immediately visible (the typical "what just happened" need).
  if (stateFilter === 'pending' || exactStatus === 'pending') {
    rows.sort(function (a, b) {
      return (a.requested_at_ms || 0) - (b.requested_at_ms || 0);
    });
  } else {
    rows.sort(function (a, b) {
      // Use completed_at when set, fall back to requested_at.
      var ax = a.completed_at_ms || a.requested_at_ms || 0;
      var bx = b.completed_at_ms || b.requested_at_ms || 0;
      return bx - ax;
    });
  }

  // Duplicate-preview map: relevant only for pending rows (managers
  // use it at complete-time to check for dupes). Terminal rows skip
  // the preview since the decision's already been made.
  //
  // Chunk 7: for pending REMOVE requests, also attach the current Seats
  // row so the queue card can render "what will be deleted" with a
  // strikethrough — or, if no removable seat exists, a status indicator
  // so the manager knows what Complete will actually do before clicking.
  // Three current_seat_status values surface the three real cases:
  //   - 'removable'  → current_seat is a manual/temp row to be deleted
  //   - 'auto_only'  → only auto matches exist; Complete will be a no-op
  //                    AND the LCR-managed seat stays in place. UI says
  //                    "Only an LCR-managed seat remains — no manual/temp
  //                    to delete."
  //   - 'none'       → no matches at all (R-1 race). UI says "Seat
  //                    already removed."
  // duplicate_existing stays empty for remove (the dupe check is
  // meaningful for adds; for removes the analogous information is
  // current_seat itself).
  //
  // We don't need Rosters_buildContext_ here — only `today` is consumed
  // (for Rosters_mapRow_'s expiry-badge math), and that's a one-line
  // helper. Building the full ctx would do an unnecessary Wards_getAll
  // + Requests_getPending per queue load.
  var today = Utils_todayIso();
  for (var d = 0; d < rows.length; d++) {
    var rd = rows[d];
    if (rd.status !== 'pending') {
      rd.duplicate_existing = [];
      rd.current_seat = null;
      rd.current_seat_status = '';
      continue;
    }
    if (rd.type === 'remove') {
      rd.duplicate_existing = [];
      var rmMatches = Seats_getActiveByScopeAndEmail(rd.scope, rd.target_email);
      var match = null;
      for (var mm = 0; mm < rmMatches.length; mm++) {
        if (rmMatches[mm].type !== 'auto') { match = rmMatches[mm]; break; }
      }
      if (match) {
        rd.current_seat = Rosters_mapRow_(match, today);
        rd.current_seat_status = 'removable';
      } else if (rmMatches.length > 0) {
        rd.current_seat = null;
        rd.current_seat_status = 'auto_only';
      } else {
        rd.current_seat = null;
        rd.current_seat_status = 'none';
      }
    } else {
      rd.current_seat = null;
      rd.current_seat_status = '';
      var existing = Seats_getActiveByScopeAndEmail(rd.scope, rd.target_email);
      rd.duplicate_existing = existing.map(function (s) { return Rosters_mapRow_(s, today); });
    }
  }

  // Filter-option lists for the UI dropdowns. The Complete-confirmation
  // dialog also reads from here — it needs the full Buildings list
  // (for the checkbox group) and each ward's default building (for the
  // pre-check). Wards are sent with their building_name so the dialog
  // doesn't have to call a second endpoint.
  var wardList = [];
  var allWards = Wards_getAll();
  for (var w = 0; w < allWards.length; w++) {
    wardList.push({
      ward_code:     allWards[w].ward_code,
      ward_name:     allWards[w].ward_name,
      building_name: allWards[w].building_name || ''
    });
  }
  var buildingList = [];
  var allBuildings = Buildings_getAll();
  for (var b = 0; b < allBuildings.length; b++) {
    buildingList.push(allBuildings[b].building_name);
  }

  return {
    rows:            rows,
    total_rows:      rows.length,
    filter_options:  { wards: wardList, buildings: buildingList },
    applied_filters: {
      ward:   wardFilter  || '',
      type:   typeFilter  || '',
      state:  stateFilter || '',
      status: exactStatus || ''
    }
  };
}

// overrides (optional): { building_names: 'Stake Center,Foo Hall' }
//
// When the manager confirms via the queue dialog they pass their chosen
// building_names selection; omitting overrides falls back to the ward's
// default (for wards) or '' (for stake). Validation happens in
// RequestsService_validateBuildings_.
function ApiManager_completeRequest(token, requestId, overrides) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  if (!requestId) throw new Error('request_id required');

  var result = Lock_withLock(function () {
    return RequestsService_complete(principal, requestId, overrides);
  });

  try {
    EmailService_notifyRequesterCompleted(result.request, principal, result.seat);
  } catch (e) {
    Logger.log('[ApiManager_completeRequest] notifyRequesterCompleted failed: ' +
      (e && e.message ? e.message : e));
    result.warning = 'Request completed, but the requester notification email failed to send.';
  }
  return result;
}

function ApiManager_rejectRequest(token, requestId, rejectionReason) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  if (!requestId) throw new Error('request_id required');

  var result = Lock_withLock(function () {
    return RequestsService_reject(principal, requestId, rejectionReason);
  });

  try {
    EmailService_notifyRequesterRejected(result.request, principal, rejectionReason);
  } catch (e) {
    Logger.log('[ApiManager_rejectRequest] notifyRequesterRejected failed: ' +
      (e && e.message ? e.message : e));
    result.warning = 'Request rejected, but the requester notification email failed to send.';
  }
  return result;
}

// Inline seat edit on the manager All Seats page. Fields editable by the
// manager:
//   - person_name, reason, building_names   (always)
//   - start_date, end_date                  (temp seats only; repo guards)
// Everything else is immutable (auto seats are fully locked — the repo
// throws). Patch is handed to Seats_update, which does the immutable-field
// check and returns { before, after } for the audit row.
function ApiManager_updateSeat(token, seatId, patch) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  if (!seatId) throw new Error('seat_id required');

  // Accept only the whitelisted editable fields from the client. Anything
  // else is stripped silently — the repo would throw, but this keeps the
  // failure mode narrow (client can't accidentally fabricate a
  // `scope: 'stake'` patch by typo).
  var narrowed = {};
  if (patch && patch.person_name    !== undefined) narrowed.person_name    = patch.person_name;
  if (patch && patch.reason         !== undefined) narrowed.reason         = patch.reason;
  if (patch && patch.building_names !== undefined) narrowed.building_names = patch.building_names;
  if (patch && patch.start_date     !== undefined) narrowed.start_date     = patch.start_date;
  if (patch && patch.end_date       !== undefined) narrowed.end_date       = patch.end_date;
  narrowed.last_modified_by = principal.email;

  return Lock_withLock(function () {
    var result = Seats_update(seatId, narrowed);
    AuditRepo_write({
      actor_email: principal.email,
      action:      'update',
      entity_type: 'Seat',
      entity_id:   seatId,
      before:      result.before,
      after:       result.after
    });
    return { ok: true, seat: result.after };
  });
}

function ApiManager_listRequests_coerce_(v) {
  if (v == null) return '';
  var s = String(v).trim();
  if (!s || s === 'all') return '';
  return s;
}

// Wire shape for queue rendering. Dates pre-formatted; the `_ms` twins
// carry the raw millisecond stamp so the UI can sort without re-parsing.
function ApiManager_shapeRequestForClient_(req) {
  return {
    request_id:       req.request_id,
    type:             req.type,
    scope:            req.scope,
    target_email:     req.target_email,
    target_name:      req.target_name,
    reason:           req.reason,
    comment:          req.comment,
    start_date:       req.start_date,
    end_date:         req.end_date,
    status:           req.status,
    requester_email:  req.requester_email,
    requested_at:     ApiManager_formatDate_(req.requested_at),
    requested_at_ms:  req.requested_at instanceof Date ? req.requested_at.getTime() : 0,
    completer_email:  req.completer_email,
    completed_at:     ApiManager_formatDate_(req.completed_at),
    completed_at_ms:  req.completed_at instanceof Date ? req.completed_at.getTime() : 0,
    rejection_reason: req.rejection_reason,
    completion_note:  req.completion_note || ''
  };
}

function ApiManager_formatDate_(d) {
  if (!d) return null;
  if (d instanceof Date) {
    var tz = Session.getScriptTimeZone();
    return Utilities.formatDate(d, tz, 'yyyy-MM-dd HH:mm:ss z');
  }
  return String(d);
}

// ===========================================================================
// Audit Log + Dashboard (Chunk 10)
// ===========================================================================
//
// These are the only read endpoints that deliberately diverge from the
// "no server-side pagination for v1" rule in architecture.md §1. The
// AuditLog tab grows unbounded — ~300-500 rows/week at target scale, so a
// year's data is ~20k rows that we can't render in a single table. Every
// other page stays on the one-page model.
//
// Pagination is offset/limit (simpler than cursor-based given we already
// read the full tab to filter); max limit is 100. See
// architecture.md §8 "Audit Log pagination exception".

// Hard limit — the client UI also caps at 100, but defence-in-depth in
// case a crafted rpc passes something absurd. Keeps the wire payload
// bounded regardless of filter.
const AUDIT_LOG_MAX_LIMIT_ = 100;

// Default date window when no date_from / date_to is supplied. 7 days is
// enough to see "what happened this week" which is the dominant use case;
// longer windows are one filter away.
const AUDIT_LOG_DEFAULT_DAYS_ = 7;

// Valid entity_type values — matches data-model.md §10 plus the explicit
// Chunk-9 `System` entry. The enum is validated server-side so a crafted
// filter can't silently match nothing because of a typo.
const AUDIT_LOG_VALID_ENTITY_TYPES_ = [
  'Seat', 'Request', 'Access', 'Config', 'Ward', 'Building',
  'KindooManager', 'Template', 'System', 'Triggers'
];

function ApiManager_auditLog(token, filters) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  filters = filters || {};

  // Coerce + validate each filter. Invalid filters throw with a clean
  // error (not a stack trace) so a crafted rpc surfaces as a toast.
  var actor      = ApiManager_auditLog_coerce_(filters.actor_email);
  var action     = ApiManager_auditLog_coerce_(filters.action);
  var entityType = ApiManager_auditLog_coerce_(filters.entity_type);
  var entityId   = ApiManager_auditLog_coerce_(filters.entity_id);
  var dateFrom   = ApiManager_auditLog_coerce_(filters.date_from);
  var dateTo     = ApiManager_auditLog_coerce_(filters.date_to);

  if (entityType && AUDIT_LOG_VALID_ENTITY_TYPES_.indexOf(entityType) === -1) {
    throw new Error('auditLog: invalid entity_type "' + entityType +
      '" — must be one of ' + AUDIT_LOG_VALID_ENTITY_TYPES_.join(', '));
  }

  // Date range defaults to the last 7 days so the initial page load isn't
  // a full-history scan. The UI surfaces both edges of the default so the
  // user can see the constraint and broaden it.
  var tz = Session.getScriptTimeZone();
  var today = Utils_todayIso();
  var usedDefaultRange = false;
  if (!dateFrom && !dateTo) {
    usedDefaultRange = true;
    dateTo = today;
    var d = new Date();
    d.setDate(d.getDate() - (AUDIT_LOG_DEFAULT_DAYS_ - 1));
    dateFrom = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  }
  // Validate date shape (YYYY-MM-DD). A crafted "all time" via blank
  // date_from + blank date_to is already handled by the default above; a
  // blank supplied alongside the other is valid.
  if (dateFrom && !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
    throw new Error('auditLog: date_from must be YYYY-MM-DD');
  }
  if (dateTo && !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    throw new Error('auditLog: date_to must be YYYY-MM-DD');
  }

  var limit  = Number(filters.limit)  || AUDIT_LOG_MAX_LIMIT_;
  var offset = Number(filters.offset) || 0;
  if (limit <= 0 || isNaN(limit))    limit  = AUDIT_LOG_MAX_LIMIT_;
  if (limit > AUDIT_LOG_MAX_LIMIT_)  limit  = AUDIT_LOG_MAX_LIMIT_;
  if (offset < 0 || isNaN(offset))   offset = 0;

  // Day boundaries are inclusive on both ends, in the script timezone —
  // matching the expiry rule's "today = script tz" convention. Build a
  // timestamp-ms range by parsing the ISO date as the beginning of that
  // day (00:00:00) and the end of date_to (23:59:59.999).
  var fromMs = dateFrom ? ApiManager_auditLog_dayStartMs_(dateFrom, tz) : 0;
  var toMs   = dateTo   ? ApiManager_auditLog_dayEndMs_(dateTo, tz)     : Number.MAX_SAFE_INTEGER;

  var rows = AuditRepo_getAll();

  // Filter. AND-combined. Canonical-email compare for actor_email so
  // `first.last@gmail.com` and `firstlast@gmail.com` resolve to the same
  // person; the literal strings `Importer` and `ExpiryTrigger` pass
  // through the same path (they're trivially equal to themselves).
  var matched = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.timestamp_ms < fromMs || r.timestamp_ms > toMs) continue;
    if (action     && r.action      !== action)     continue;
    if (entityType && r.entity_type !== entityType) continue;
    if (entityId   && r.entity_id   !== entityId)   continue;
    if (actor) {
      // Literal-string match for the automated actors; canonical-email
      // match for real users (so a manager's display variant doesn't
      // escape the filter).
      if (actor === 'Importer' || actor === 'ExpiryTrigger') {
        if (r.actor_email !== actor) continue;
      } else {
        if (!Utils_emailsEqual(r.actor_email, actor)) continue;
      }
    }
    matched.push(r);
  }

  // Newest first — the queue's dominant "what just happened" frame.
  matched.sort(function (a, b) { return b.timestamp_ms - a.timestamp_ms; });

  var total = matched.length;
  var slice = matched.slice(offset, offset + limit);

  // Shape for the client. We pre-format the timestamp (so the client
  // doesn't need to reconstruct a Date for every row) but also pass the
  // raw ms so the client can re-sort / re-compare if it wants.
  var out = [];
  for (var s = 0; s < slice.length; s++) {
    var row = slice[s];
    out.push({
      timestamp:    row.timestamp
        ? Utilities.formatDate(row.timestamp, tz, 'yyyy-MM-dd HH:mm:ss z')
        : '',
      timestamp_ms: row.timestamp_ms,
      actor_email:  row.actor_email,
      action:       row.action,
      entity_type:  row.entity_type,
      entity_id:    row.entity_id,
      before_json:  row.before_json,
      after_json:   row.after_json
    });
  }

  return {
    rows:     out,
    total:    total,
    offset:   offset,
    limit:    limit,
    has_more: (offset + limit) < total,
    applied_filters: {
      actor_email: actor,
      action:      action,
      entity_type: entityType,
      entity_id:   entityId,
      date_from:   dateFrom,
      date_to:     dateTo
    },
    used_default_range: usedDefaultRange
  };
}

function ApiManager_auditLog_coerce_(v) {
  if (v == null) return '';
  var s = String(v).trim();
  if (!s || s === 'all') return '';
  return s;
}

function ApiManager_auditLog_dayStartMs_(iso, tz) {
  // Parse as midnight local tz. Utilities.parseDate handles the tz
  // offset (so the returned Date's ms is an absolute UTC ms).
  try {
    var d = Utilities.parseDate(iso + ' 00:00:00', tz, 'yyyy-MM-dd HH:mm:ss');
    return d.getTime();
  } catch (e) {
    throw new Error('auditLog: could not parse date_from "' + iso + '"');
  }
}

function ApiManager_auditLog_dayEndMs_(iso, tz) {
  try {
    var d = Utilities.parseDate(iso + ' 23:59:59', tz, 'yyyy-MM-dd HH:mm:ss');
    return d.getTime() + 999;
  } catch (e) {
    throw new Error('auditLog: could not parse date_to "' + iso + '"');
  }
}

// Dashboard aggregation (Chunk 10). Single rpc so the manager landing
// renders in one round-trip. Read-heavy — hits Requests, Seats, Wards,
// Config, AuditLog, and the trigger list. Logs elapsed_ms at the end so
// we have a monitoring signal if the page starts feeling sluggish. If it
// ever creeps past ~2 s, split into smaller endpoints + CacheService.
function ApiManager_dashboard(token) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');

  var startedMs = Date.now();

  // --- Pending requests by type ---------------------------------------
  var pending = Requests_getPending();
  var byType = { add_manual: 0, add_temp: 0, remove: 0 };
  for (var p = 0; p < pending.length; p++) {
    var t = pending[p].type;
    if (byType[t] === undefined) byType[t] = 0;
    byType[t]++;
  }

  // --- Utilization per scope -----------------------------------------
  // Chunk 5's Rosters_buildContext_ + Rosters_buildSummary_ already own
  // the cap / count / over-cap logic; reuse it.
  var ctx = Rosters_buildContext_();
  var seats = Seats_getAll();
  var countsByScope = {};
  for (var si = 0; si < seats.length; si++) {
    var sc = String(seats[si].scope || '');
    if (!sc) continue;
    countsByScope[sc] = (countsByScope[sc] || 0) + 1;
  }
  var utilization = [];
  // Stake pool first (mirrors the All Seats page convention).
  var stakeSummary = Rosters_buildSummary_('stake', countsByScope['stake'] || 0, ctx);
  utilization.push(ApiManager_dashboard_summaryToUtil_(stakeSummary));
  // Every configured ward, alphabetical by ward_code.
  var wards = Wards_getAll();
  var wardCodes = [];
  for (var wi = 0; wi < wards.length; wi++) wardCodes.push(wards[wi].ward_code);
  wardCodes.sort();
  for (var wc = 0; wc < wardCodes.length; wc++) {
    var s = Rosters_buildSummary_(wardCodes[wc], countsByScope[wardCodes[wc]] || 0, ctx);
    utilization.push(ApiManager_dashboard_summaryToUtil_(s));
  }

  // --- Warnings (over-cap snapshot from Config) ----------------------
  var warnings = { over_caps: [] };
  var rawOverCaps = Config_get('last_over_caps_json');
  if (rawOverCaps) {
    try {
      var parsed = JSON.parse(String(rawOverCaps));
      if (Array.isArray(parsed)) warnings.over_caps = parsed;
    } catch (e) {
      Logger.log('[ApiManager_dashboard] last_over_caps_json parse failed: ' + e);
    }
  }

  // --- Recent Activity (last 10 AuditLog rows) -----------------------
  var allAudit = AuditRepo_getAll();
  allAudit.sort(function (a, b) { return b.timestamp_ms - a.timestamp_ms; });
  var tz = Session.getScriptTimeZone();
  var recentActivity = [];
  for (var ai = 0; ai < Math.min(10, allAudit.length); ai++) {
    var ar = allAudit[ai];
    recentActivity.push({
      timestamp:    ar.timestamp
        ? Utilities.formatDate(ar.timestamp, tz, 'yyyy-MM-dd HH:mm:ss z')
        : '',
      timestamp_ms: ar.timestamp_ms,
      actor_email:  ar.actor_email,
      action:       ar.action,
      entity_type:  ar.entity_type,
      entity_id:    ar.entity_id,
      summary:      ApiManager_dashboard_auditSummary_(ar)
    });
  }

  // --- Last Operations ----------------------------------------------
  function fmtDate(v) {
    if (!v) return null;
    if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm:ss z');
    return String(v);
  }
  // The last-triggers-installed timestamp isn't a Config key — we derive
  // it from the most recent reinstall_triggers or setup_complete audit
  // row (both write the trigger install result to after_json). That
  // survives rotations without adding another Config key to keep in sync.
  var lastTriggersInstalledAt = null;
  for (var ai2 = 0; ai2 < allAudit.length; ai2++) {
    var r2 = allAudit[ai2];
    if (r2.action === 'reinstall_triggers' || r2.action === 'setup_complete') {
      lastTriggersInstalledAt = r2.timestamp
        ? Utilities.formatDate(r2.timestamp, tz, 'yyyy-MM-dd HH:mm:ss z')
        : null;
      break;
    }
  }

  var lastOperations = {
    last_import_at:             fmtDate(Config_get('last_import_at')),
    last_import_summary:        Config_get('last_import_summary') || null,
    last_expiry_at:             fmtDate(Config_get('last_expiry_at')),
    last_expiry_summary:        Config_get('last_expiry_summary') || null,
    last_triggers_installed_at: lastTriggersInstalledAt
  };

  var elapsedMs = Date.now() - startedMs;
  Logger.log('[ApiManager_dashboard] rendered in ' + elapsedMs + 'ms — ' +
    pending.length + ' pending, ' + utilization.length + ' scopes, ' +
    warnings.over_caps.length + ' over-cap, ' + recentActivity.length + ' recent');

  return {
    pending: {
      total:   pending.length,
      by_type: byType
    },
    recent_activity: recentActivity,
    utilization:     utilization,
    warnings:        warnings,
    last_operations: lastOperations,
    elapsed_ms:      elapsedMs
  };
}

// Compact summary → dashboard utilization card shape. Dashboard shows
// state (ok / warn / over) as a pre-computed label so the UI doesn't need
// to duplicate the threshold math.
function ApiManager_dashboard_summaryToUtil_(s) {
  var state = 'ok';
  if (s.over_cap) {
    state = 'over';
  } else if (s.seat_cap != null && s.seat_cap > 0 && s.total_seats / s.seat_cap >= 0.9) {
    state = 'warn';
  }
  return {
    scope:           s.scope,
    label:           s.ward_name,
    count:           s.total_seats,
    cap:             s.seat_cap,
    utilization_pct: s.utilization_pct,
    over_cap:        s.over_cap,
    state:           state
  };
}

// One-line summary of an audit row for the Recent Activity card. Keeps
// the wire shape small; the Audit Log page itself renders the full diff.
function ApiManager_dashboard_auditSummary_(r) {
  var prefix = r.action;
  var tail = r.entity_type + ' ' + r.entity_id;
  // For over_cap_warning we can surface the pool count inline — it's
  // the one thing worth showing without expanding the row.
  if (r.action === 'over_cap_warning' && r.after_json) {
    try {
      var parsed = JSON.parse(r.after_json);
      if (parsed && parsed.pools) {
        tail += ' (' + parsed.pools.length + ' pool' +
          (parsed.pools.length === 1 ? '' : 's') + ' over)';
      }
    } catch (e) { /* ignore */ }
  }
  return prefix + ' · ' + tail;
}

// ===========================================================================
// Manual smoke tests, runnable from the Apps Script editor.
// Not callable via google.script.run from the client (no token argument).
// ===========================================================================

// Demonstrates the Forbidden path without a real verified token.
// Builds a fake Principal that holds zero roles and confirms each endpoint
// throws 'Forbidden' before doing any work. Run from the editor's Run
// dropdown.
function ApiManager_test_forbidden() {
  var fakePrincipal = { email: 'test-no-role@example.com', name: '', picture: '', roles: [] };
  // Direct guard call should throw.
  var threw = false, msg = '';
  try {
    Auth_requireRole(fakePrincipal, 'manager');
  } catch (e) {
    threw = true;
    msg = e.message;
  }
  if (!threw) throw new Error('FAIL: Auth_requireRole(empty roles) did not throw');
  if (msg !== 'Forbidden') throw new Error('FAIL: expected "Forbidden", got "' + msg + '"');
  Logger.log('PASS: empty-roles principal -> Auth_requireRole throws Forbidden');

  // Same again with a bishopric-only principal.
  var bishopric = { email: 'b@example.com', name: '', picture: '',
                    roles: [{ type: 'bishopric', wardId: 'cordera-1st' }] };
  threw = false;
  try {
    Auth_requireRole(bishopric, 'manager');
  } catch (e2) {
    threw = true;
  }
  if (!threw) throw new Error('FAIL: bishopric-only principal passed manager check');
  Logger.log('PASS: bishopric-only principal -> Auth_requireRole(manager) throws Forbidden');

  // Chunk 5: scope-guard checks — a bishopric for CO must not be treated
  // as a stake user, and Auth_findBishopricRole on a stake-only principal
  // must return null (so ApiBishopric_roster throws Forbidden rather than
  // falling through to an empty roster or an "undefined" scope).
  var stakeOnly = { email: 's@example.com', name: '', picture: '',
                    roles: [{ type: 'stake' }] };
  if (Auth_findBishopricRole(stakeOnly) !== null) {
    throw new Error('FAIL: Auth_findBishopricRole(stake-only) returned non-null');
  }
  Logger.log('PASS: Auth_findBishopricRole(stake-only) returns null');

  var coBishopric = { email: 'bco@example.com', name: '', picture: '',
                      roles: [{ type: 'bishopric', wardId: 'CO' }] };
  var found = Auth_findBishopricRole(coBishopric);
  if (!found || found.wardId !== 'CO') {
    throw new Error('FAIL: Auth_findBishopricRole(CO bishopric) did not return the CO role');
  }
  Logger.log('PASS: Auth_findBishopricRole(CO bishopric) returns the CO role');

  // CO bishopric failing the stake role check — that's what keeps them from
  // calling ApiStake_* endpoints (the endpoints themselves do this check).
  threw = false;
  try {
    Auth_requireRole(coBishopric, 'stake');
  } catch (e3) { threw = true; }
  if (!threw) throw new Error('FAIL: CO bishopric passed stake role check');
  Logger.log('PASS: CO bishopric -> Auth_requireRole(stake) throws Forbidden');

  // Auth_requireWardScope: CO bishopric can read CO but not GE.
  threw = false;
  try {
    Auth_requireWardScope(coBishopric, 'GE');
  } catch (e4) { threw = true; }
  if (!threw) throw new Error('FAIL: CO bishopric passed ward-scope check for GE');
  Logger.log('PASS: CO bishopric -> Auth_requireWardScope(GE) throws Forbidden');

  Auth_requireWardScope(coBishopric, 'CO'); // should NOT throw
  Logger.log('PASS: CO bishopric -> Auth_requireWardScope(CO) allows');

  return 'All ApiManager forbidden-path checks passed.';
}
