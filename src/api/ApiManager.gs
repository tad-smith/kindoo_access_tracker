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
  // Read path — no lock. Returns { all: {...}, protected: [...], importer: [...] }
  // so the UI can decide which keys to render read-only without re-encoding
  // the policy on the client.
  var all = Config_getAll();
  var protectedKeys = [];
  var importerKeys = [];
  for (var k in all) {
    if (Config_isProtectedKey(k)) protectedKeys.push(k);
    else if (Config_isImporterKey(k)) importerKeys.push(k);
  }
  // session_secret leaks via the wire if we send it back. Mask its value.
  if (all.session_secret) {
    all.session_secret = '(set — ' + String(all.session_secret).length + ' chars; hidden)';
  }
  return { all: all, protected: protectedKeys, importer: importerKeys };
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
  if (Config_isImporterKey(key)) {
    throw new Error('Config key "' + key + '" is owned by the importer; ' +
      'don\'t edit it from here.');
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
// Importer (Chunk 3)
// ===========================================================================
//
// The canonical Chunk-2 shape for writes is (token) → Auth_principalFrom →
// Auth_requireRole → Lock_withLock(before/after/audit). Imports fit the
// same shape, but the actual per-row diff + audit bracketing live inside
// Importer_runImport itself (services/Importer.gs) — the lock wraps the
// whole service call, not each tab. Inside that single acquisition the
// service does: import_start audit → diff-and-apply across all matched
// tabs → Config.last_import_at/summary update → import_end audit. One
// lock, not one-per-tab.
//
// timeoutMs is bumped to 30 s (architecture.md §6) — a real import can
// take longer than the 10 s default if a lot of audit rows are flushed or
// the callings sheet has many tabs. On contention, users see the same
// "Another change is in progress" message every other write path emits.
//
// actor_email on every per-row AuditLog entry is "Importer" (literal
// string — see architecture.md §5 and data-model.md §10). principal.email
// flows in as `triggeredBy` so the import_start / import_end brackets
// can record who ran the import.

function ApiManager_importerRun(token) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'manager');
  return Lock_withLock(function () {
    return Importer_runImport({ triggeredBy: principal.email });
  }, { timeoutMs: 30000 });
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
  return {
    last_import_at:      lastAt,
    last_import_summary: Config_get('last_import_summary') || null,
    callings_sheet_id:   Config_get('callings_sheet_id')   || null
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
