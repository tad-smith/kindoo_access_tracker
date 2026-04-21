// First-run wizard state machine + API surface.
//
// During bootstrap (Config.setup_complete=FALSE) the signed-in bootstrap
// admin gets `ui/BootstrapWizard.html` — a single multi-step page driven
// entirely by these server endpoints. Every ApiBootstrap_* call:
//
//   1. Auth_principalFrom(token)        — verifies the HMAC session token.
//   2. Bootstrap_requireBootstrapAdmin_ — checks the signed-in email
//      against Config.bootstrap_admin_email AND checks setup_complete is
//      still FALSE. Both conditions required. Once setup flips to TRUE
//      every endpoint hard-refuses regardless of caller (the wizard is a
//      one-shot; post-setup edits go through the normal manager
//      Configuration page in Chunk 2).
//   3. Lock_withLock(...) + AuditRepo_write — same pattern every other
//      writer in the codebase uses.
//
// The wizard is architecturally distinct from the normal manager surface
// because the bootstrap admin holds NO roles yet (KindooManagers is empty,
// Access is empty), so Auth_requireRole('manager') would reject them.
// Giving them a temporary manager role would make the setup flow indirect
// and leak a special-case role into every other guard. Keeping their
// endpoints separate with their own auth gate is cleaner.
//
// State is persisted in the real tabs — Wards, Buildings, KindooManagers,
// Config. The wizard reads those tabs on every page load to decide which
// step to show; closing the browser mid-setup and coming back resumes at
// whatever step is next. The only wizard-specific Config key is
// setup_complete itself.
//
// The bootstrap admin is auto-added to KindooManagers on first wizard
// load (see Bootstrap_ensureAdminAsManager_). Rationale: they obviously
// need to be a manager post-setup, re-typing their own email is friction,
// and forgetting to add themselves would leave them locked out (they
// would have to edit the Sheet by hand). The auto-add runs inside the
// same lock and emits its own audit row, so the invariant "every write
// is locked + audited" holds.

// ---------------------------------------------------------------------------
// Auth gate (internal)
// ---------------------------------------------------------------------------

// Throws a user-friendly error if either (a) the signed-in email doesn't
// match Config.bootstrap_admin_email, or (b) setup_complete is already
// TRUE. On success, returns the principal unchanged. The Error messages
// are the ones the UI surfaces as toasts — keep them legible.
function Bootstrap_requireBootstrapAdmin_(principal) {
  if (!principal || !principal.email) {
    throw new Error('Bootstrap endpoints require a signed-in user.');
  }
  var adminEmail = Config_get('bootstrap_admin_email');
  if (!adminEmail) {
    throw new Error('bootstrap_admin_email is not set in Config. Seed it in the Sheet and retry.');
  }
  if (!Utils_emailsEqual(principal.email, adminEmail)) {
    throw new Error('Forbidden: only the bootstrap admin can run setup.');
  }
  var complete = Config_get('setup_complete');
  if (complete === true) {
    throw new Error('Setup is already complete — the bootstrap wizard is one-shot. ' +
      'Use the Configuration page for ongoing changes.');
  }
  return principal;
}

// Wraps the common Auth_principalFrom + bootstrap-admin check. Every
// ApiBootstrap_* entry point calls this first.
function Bootstrap_principalFrom_(token) {
  var principal = Auth_principalFrom(token);
  Bootstrap_requireBootstrapAdmin_(principal);
  return principal;
}

// ---------------------------------------------------------------------------
// State reader
// ---------------------------------------------------------------------------
//
// Returns the full shape the wizard UI needs to render itself. Steps are
// numbered 1..4 to match spec.md §10 / architecture.md §10. `currentStep`
// is the lowest incomplete step; the UI may still navigate to higher
// steps (step 4 is optional and has no completion condition). `canFinish`
// is the "Complete Setup" button's enabled flag — steps 1-3 all complete.
//
// `email` is the signed-in admin's email (what Identity handed us, what's
// now in KindooManagers after auto-add). The Config.bootstrap_admin_email
// cell may be a gmail dot-variant of the same address; we use the signed-
// in form here so the UI's "you" marker matches the KindooManagers row
// the admin is looking at.
//
// Shape:
//   {
//     email: '<signed-in admin email>',
//     step1: { stake_name, callings_sheet_id, stake_seat_cap, complete },
//     step2: { buildings: [ {building_name, address}, ... ], complete },
//     step3: { wards: [ {ward_code, ward_name, building_name, seat_cap}, ... ],
//              complete, buildings: [...] },   // buildings included for the select
//     step4: { managers: [ {email, name, active}, ... ] },
//     currentStep: 1..4,
//     canFinish: boolean
//   }

function Bootstrap_getState_(principal) {
  var all = Config_getAll();

  var step1 = {
    stake_name:        all.stake_name        || '',
    callings_sheet_id: all.callings_sheet_id || '',
    stake_seat_cap:    all.stake_seat_cap    == null ? '' : all.stake_seat_cap,
    complete: !!(
      all.stake_name &&
      all.callings_sheet_id &&
      typeof all.stake_seat_cap === 'number' && all.stake_seat_cap > 0
    )
  };

  var buildings = Buildings_getAll();
  var step2 = { buildings: buildings, complete: buildings.length > 0 };

  var wards = Wards_getAll();
  var step3 = { wards: wards, complete: wards.length > 0, buildings: buildings };

  var managers = KindooManagers_getAll();
  var step4 = { managers: managers };

  var currentStep = 1;
  if (step1.complete) currentStep = 2;
  if (step1.complete && step2.complete) currentStep = 3;
  if (step1.complete && step2.complete && step3.complete) currentStep = 4;

  return {
    email:       (principal && principal.email) || all.bootstrap_admin_email || '',
    step1:       step1,
    step2:       step2,
    step3:       step3,
    step4:       step4,
    currentStep: currentStep,
    canFinish:   step1.complete && step2.complete && step3.complete
  };
}

// Idempotent: ensures the bootstrap admin is present in KindooManagers as
// active=true. Called automatically inside each state/step rpc; if the
// row already exists (common after first call), does nothing. When it
// does insert, it emits its own audit row with actor="Bootstrap" so the
// log reflects that this wasn't a manual action by the admin.
//
// Kept separate from Bootstrap_getState_ because state is read-only and
// auto-add is a write; the lock-and-audit wrapper lives inside each API
// endpoint, never in the state reader.
function Bootstrap_ensureAdminAsManager_(principal) {
  var existing = KindooManagers_getByEmail(principal.email);
  if (existing) return null;
  var after = KindooManagers_insert({
    email:  principal.email,
    name:   '',
    active: true
  });
  AuditRepo_write({
    actor_email: principal.email,
    action:      'insert',
    entity_type: 'KindooManager',
    entity_id:   after.email,
    before:      null,
    after:       after
  });
  return after;
}

// ===========================================================================
// API endpoints (rpc-callable)
// ===========================================================================

// Page-load fetch for the wizard. Reads the current state of the underlying
// tabs, auto-adds the bootstrap admin to KindooManagers if missing, and
// returns the full state shape for the UI to render.
function ApiBootstrap_getState(token) {
  var principal = Bootstrap_principalFrom_(token);
  Lock_withLock(function () {
    // Auto-add happens inside the lock so the read that builds state sees
    // the freshly-inserted manager row. Audit is emitted inside the helper.
    Bootstrap_ensureAdminAsManager_(principal);
  });
  return Bootstrap_getState_(principal);
}

// Step 1 submit: writes stake_name, callings_sheet_id, stake_seat_cap to
// Config. All three values required in the same call — the UI collects
// them together. Returns the updated state.
function ApiBootstrap_step1Submit(token, payload) {
  var principal = Bootstrap_principalFrom_(token);
  if (!payload) throw new Error('step1Submit: payload required');
  var stakeName = String(payload.stake_name || '').trim();
  var sheetId   = String(payload.callings_sheet_id || '').trim();
  var seatCap   = Number(payload.stake_seat_cap);
  if (!stakeName)      throw new Error('Stake name is required.');
  if (!sheetId)        throw new Error('Callings-sheet ID is required.');
  if (!(seatCap > 0) || Math.floor(seatCap) !== seatCap) {
    throw new Error('Stake seat cap must be a positive whole number.');
  }
  Lock_withLock(function () {
    Bootstrap_ensureAdminAsManager_(principal);
    var writes = [
      { key: 'stake_name',        value: stakeName },
      { key: 'callings_sheet_id', value: sheetId   },
      { key: 'stake_seat_cap',    value: seatCap   }
    ];
    for (var i = 0; i < writes.length; i++) {
      var result = Config_update(writes[i].key, writes[i].value);
      AuditRepo_write({
        actor_email: principal.email,
        action:      'update',
        entity_type: 'Config',
        entity_id:   writes[i].key,
        before:      { key: writes[i].key, value: result.before },
        after:       { key: writes[i].key, value: result.after }
      });
    }
  });
  return Bootstrap_getState_(principal);
}

// Step 2: add or update a building. Delegates to Buildings_insert /
// Buildings_update via the same shape ApiManager_buildingsUpsert uses.
// Returns the post-write state so the UI re-renders the building list.
function ApiBootstrap_buildingsUpsert(token, row) {
  var principal = Bootstrap_principalFrom_(token);
  if (!row || !row.building_name) throw new Error('buildingsUpsert: building_name required');
  Lock_withLock(function () {
    Bootstrap_ensureAdminAsManager_(principal);
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
  });
  return Bootstrap_getState_(principal);
}

// Bulk insert for Step 2. The wizard UI accumulates pending building rows
// client-side and flushes them in one rpc on navigate / Complete. Shape:
// rows = [ { building_name, address }, ... ]. Validation failures (dup
// names, blanks, existing-name collision) abort the whole batch BEFORE
// any Sheet write, so a bad row doesn't half-commit.
function ApiBootstrap_buildingsBulkInsert(token, rows) {
  var principal = Bootstrap_principalFrom_(token);
  if (!rows || rows.length === 0) return Bootstrap_getState_(principal);
  Lock_withLock(function () {
    Bootstrap_ensureAdminAsManager_(principal);
    var inserted = Buildings_bulkInsert(rows);
    var auditEntries = inserted.map(function (row) {
      return {
        actor_email: principal.email,
        action:      'insert',
        entity_type: 'Building',
        entity_id:   row.building_name,
        before:      null,
        after:       row
      };
    });
    AuditRepo_writeMany(auditEntries);
  });
  return Bootstrap_getState_(principal);
}

function ApiBootstrap_buildingsDelete(token, buildingName) {
  var principal = Bootstrap_principalFrom_(token);
  if (!buildingName) throw new Error('buildingsDelete: building_name required');
  var key = String(buildingName).trim();
  Lock_withLock(function () {
    Bootstrap_ensureAdminAsManager_(principal);
    // Same FK guard the manager endpoint uses — can't orphan wards.
    var blockers = [];
    var wards = Wards_getAll();
    for (var i = 0; i < wards.length; i++) {
      if (wards[i].building_name === key) blockers.push(wards[i].ward_code);
    }
    if (blockers.length > 0) {
      throw new Error('Cannot delete building "' + key +
        '" — it is still referenced by ward(s): ' + blockers.join(', ') +
        '. Remove or reassign those wards first.');
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
  });
  return Bootstrap_getState_(principal);
}

// Step 3: add or update a ward.
function ApiBootstrap_wardsUpsert(token, row) {
  var principal = Bootstrap_principalFrom_(token);
  if (!row || !row.ward_code) throw new Error('wardsUpsert: ward_code required');
  Lock_withLock(function () {
    Bootstrap_ensureAdminAsManager_(principal);
    var before = Wards_getByCode(row.ward_code);
    if (row.building_name) {
      if (!Buildings_getByName(String(row.building_name).trim())) {
        throw new Error('Unknown building "' + row.building_name +
          '" — pick one from the dropdown or add it in the previous step.');
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
  });
  return Bootstrap_getState_(principal);
}

// Bulk insert for Step 3. Same contract as buildingsBulkInsert. Also
// validates building_name FK once, up-front, against the current
// Buildings tab — a row that references a building-name not in the tab
// aborts the whole batch.
function ApiBootstrap_wardsBulkInsert(token, rows) {
  var principal = Bootstrap_principalFrom_(token);
  if (!rows || rows.length === 0) return Bootstrap_getState_(principal);
  Lock_withLock(function () {
    Bootstrap_ensureAdminAsManager_(principal);
    // Build a name→exists set from Buildings once, then FK-check each row.
    var buildingNames = {};
    var bld = Buildings_getAll();
    for (var b = 0; b < bld.length; b++) buildingNames[bld[b].building_name] = true;
    for (var i = 0; i < rows.length; i++) {
      var bn = rows[i] && rows[i].building_name ? String(rows[i].building_name).trim() : '';
      if (!bn) {
        throw new Error('Row ' + (i + 1) + ' ("' + (rows[i] && rows[i].ward_code) + '"): building required.');
      }
      if (!buildingNames[bn]) {
        throw new Error('Row ' + (i + 1) + ' ("' + (rows[i] && rows[i].ward_code) +
          '"): unknown building "' + bn + '". Pick one from the Buildings step.');
      }
    }
    var inserted = Wards_bulkInsert(rows);
    var auditEntries = inserted.map(function (row) {
      return {
        actor_email: principal.email,
        action:      'insert',
        entity_type: 'Ward',
        entity_id:   row.ward_code,
        before:      null,
        after:       row
      };
    });
    AuditRepo_writeMany(auditEntries);
  });
  return Bootstrap_getState_(principal);
}

function ApiBootstrap_wardsDelete(token, wardCode) {
  var principal = Bootstrap_principalFrom_(token);
  if (!wardCode) throw new Error('wardsDelete: ward_code required');
  var key = String(wardCode).trim();
  Lock_withLock(function () {
    Bootstrap_ensureAdminAsManager_(principal);
    var before = Wards_delete(key);
    AuditRepo_write({
      actor_email: principal.email,
      action:      'delete',
      entity_type: 'Ward',
      entity_id:   key,
      before:      before,
      after:       null
    });
  });
  return Bootstrap_getState_(principal);
}

// Step 4: add or update an additional KindooManager. The bootstrap admin
// themselves is auto-added by Bootstrap_ensureAdminAsManager_; this endpoint
// is for any further managers the admin wants to seed during setup.
function ApiBootstrap_kindooManagersUpsert(token, row) {
  var principal = Bootstrap_principalFrom_(token);
  if (!row || !row.email) throw new Error('kindooManagersUpsert: email required');
  Lock_withLock(function () {
    Bootstrap_ensureAdminAsManager_(principal);
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
  });
  return Bootstrap_getState_(principal);
}

// Bulk insert for Step 4. Same contract. Uniqueness uses canonical email
// (Utils_emailsEqual), so `first.last@gmail.com` and `firstlast@gmail.com`
// can't both land in the same batch. The admin row auto-added by
// Bootstrap_ensureAdminAsManager_ also counts for the "against existing"
// check, so the admin can't accidentally re-insert themselves here.
function ApiBootstrap_kindooManagersBulkInsert(token, rows) {
  var principal = Bootstrap_principalFrom_(token);
  if (!rows || rows.length === 0) return Bootstrap_getState_(principal);
  Lock_withLock(function () {
    Bootstrap_ensureAdminAsManager_(principal);
    var inserted = KindooManagers_bulkInsert(rows);
    var auditEntries = inserted.map(function (row) {
      return {
        actor_email: principal.email,
        action:      'insert',
        entity_type: 'KindooManager',
        entity_id:   row.email,
        before:      null,
        after:       row
      };
    });
    AuditRepo_writeMany(auditEntries);
  });
  return Bootstrap_getState_(principal);
}

function ApiBootstrap_kindooManagersDelete(token, email) {
  var principal = Bootstrap_principalFrom_(token);
  if (!email) throw new Error('kindooManagersDelete: email required');
  var typed = Utils_cleanEmail(email);
  // Don't let the admin delete themselves mid-wizard — they need to stay
  // in KindooManagers so post-completion role resolution returns 'manager'
  // and they land on the dashboard. The auto-add would just re-insert on
  // the next rpc, but the deliberate block is clearer.
  if (Utils_emailsEqual(typed, principal.email)) {
    throw new Error('You can\'t remove yourself as a Kindoo Manager during setup — ' +
      'you need this role to use the app after setup completes.');
  }
  Lock_withLock(function () {
    Bootstrap_ensureAdminAsManager_(principal);
    var before = KindooManagers_delete(typed);
    AuditRepo_write({
      actor_email: principal.email,
      action:      'delete',
      entity_type: 'KindooManager',
      entity_id:   before.email,
      before:      before,
      after:       null
    });
  });
  return Bootstrap_getState_(principal);
}

// Finish: flip setup_complete to TRUE, install triggers (stubbed this
// chunk), write the setup_complete audit row. Everything happens inside
// one lock acquisition. After this call succeeds every ApiBootstrap_*
// endpoint (including this one) will refuse on the next invocation
// because Bootstrap_requireBootstrapAdmin_ re-checks setup_complete.
//
// Returns { ok: true, redirect: '<MAIN_URL>' } so the client can
// re-navigate the top frame back to the dashboard. (A plain reload also
// works — setup_complete=TRUE routes via normal role resolution.)
function ApiBootstrap_complete(token) {
  var principal = Bootstrap_principalFrom_(token);
  var state = Bootstrap_getState_(principal);
  if (!state.canFinish) {
    throw new Error('Steps 1-3 must be complete before finishing setup. ' +
      'Current step: ' + state.currentStep + '.');
  }
  var triggersMsg = '';
  Lock_withLock(function () {
    Bootstrap_ensureAdminAsManager_(principal);
    // Triggers first so we audit the call even if the flag flip fails
    // partway (though neither should fail under normal conditions).
    try {
      triggersMsg = TriggersService_install() || '';
    } catch (e) {
      triggersMsg = 'TriggersService_install threw: ' + (e && e.message ? e.message : String(e));
      Logger.log('[Bootstrap] ' + triggersMsg);
      // Not fatal — Chunk-4 stub is a no-op, and real triggers land in
      // Chunk 8/9 with their own install-failure handling. Record in the
      // audit payload so it's not silently lost.
    }
    var before = Config_get('setup_complete');
    var result = Config_update('setup_complete', true);
    AuditRepo_write({
      actor_email: principal.email,
      action:      'setup_complete',
      entity_type: 'Config',
      entity_id:   'setup_complete',
      before:      { key: 'setup_complete', value: before },
      after:       {
        key:              'setup_complete',
        value:            result.after,
        triggers_install: triggersMsg
      }
    });
  });
  // Caller navigates top-frame; we return main_url so the client doesn't
  // have to re-read Config to know where to go.
  return { ok: true, redirect: Config_get('main_url') || '' };
}
