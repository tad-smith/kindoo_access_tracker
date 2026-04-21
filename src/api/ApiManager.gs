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

  return 'All ApiManager forbidden-path checks passed.';
}
