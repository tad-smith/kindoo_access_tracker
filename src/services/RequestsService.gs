// Request lifecycle: submit / complete / reject / cancel.
//
// Every service function is invoked INSIDE a Lock_withLock acquisition at
// the API layer (ApiRequests_*, ApiManager_*Request). The Sheet write and
// the AuditLog write share the same lock so the log never disagrees with
// data, even on crash (architecture.md §6 / §7). Each function emits
// exactly one audit row per entity touched:
//
//   - submit   → 1 row  (submit_request on the Request)
//   - complete → 2 rows (complete_request on Request + insert on Seat)
//   - reject   → 1 row  (reject_request on the Request)
//   - cancel   → 1 row  (cancel_request on the Request)
//
// The lifecycle verbs (submit_request / complete_request / reject_request /
// cancel_request) come from data-model.md §10 "Action vocabulary". Seat
// inserts from a complete flow use the generic `insert` — that's the
// canonical CRUD verb for any Seats write.
//
// State machine (pending → ... transitions; no other transitions are
// valid):
//
//              submit
//                |
//                v
//             pending
//              / | \
//    complete /  |  \ cancel
//            /   |   \
//           v    v    v
//      complete rejected cancelled
//
// Attempting to complete / reject / cancel a non-pending request returns
// a clean "Request is no longer pending (current status: X)" error. The
// typical cause is a stale queue page — another manager processed the
// request between page load and click — and surfacing the actual current
// status gives the operator what they need to judge their next action
// (refresh, not an apology).
//
// Email notifications are NOT sent from inside these functions — the
// API layer invokes EmailService AFTER the Lock_withLock closure
// completes, best-effort, so a mail failure never unwinds a successful
// write. See EmailService.gs top-level comment for the rationale.

// ---------------------------------------------------------------------------
// submit — write a new pending Request row.
//
// Validates the draft shape:
//   - type ∈ {add_manual, add_temp, remove}
//   - target_email present and non-empty
//   - reason present (required by spec §3.2 for all types)
//   - if add_temp: start_date + end_date both ISO YYYY-MM-DD, end ≥ start
//   - if remove (Chunk 7):
//       - target must correspond to an active manual/temp seat in the
//         scope (open-questions.md R-3: auto seats can't be removed via
//         this path; that's an LCR change).
//       - no other pending remove request for the same (scope, email)
//         already exists.
//
// Fills request_id (UUID), status = pending, requester_email / requested_at
// from the caller. Returns the inserted Request row shape.
// ---------------------------------------------------------------------------
function RequestsService_submit(args) {
  if (!args || !args.scope) throw new Error('RequestsService_submit: scope required');
  if (!args.requesterPrincipal || !args.requesterPrincipal.email) {
    throw new Error('RequestsService_submit: requesterPrincipal required');
  }
  if (!args.draft) throw new Error('RequestsService_submit: draft required');

  var draft = args.draft;
  var type = String(draft.type || '');
  if (type !== 'add_manual' && type !== 'add_temp' && type !== 'remove') {
    throw new Error('Invalid request type "' + type + '" — must be add_manual, add_temp, or remove.');
  }

  var targetEmail = Utils_cleanEmail(draft.target_email);
  if (!targetEmail) throw new Error('Target email is required.');
  // Minimal sanity check — a "looks like an email" gate so we don't let a
  // comma-separated list or obvious typo into a pending row. We don't do
  // full RFC5322 because the submitted string is a communication target,
  // not a lookup key (Utils_emailsEqual handles canonicalisation at the
  // comparison boundary).
  if (targetEmail.indexOf('@') < 1 || targetEmail.indexOf('@') === targetEmail.length - 1) {
    throw new Error('Target email "' + targetEmail + '" does not look like a valid address.');
  }

  var reason = String(draft.reason || '').trim();
  if (!reason) throw new Error('Reason is required.');

  // building_names — the requester's pick of which Buildings the
  // person needs access to (multi-select in NewRequest.html).
  //
  // Scope rules:
  //   - stake: REQUIRED non-empty on add_manual / add_temp. Stake has
  //     no ward default, so if the requester doesn't pick we'd be
  //     stuck handing the manager an empty selection. Client-side
  //     check in NewRequest is the UX; this server-side check is
  //     authoritative (hand-crafted rpcs can't bypass).
  //   - bishopric: empty allowed — RequestsService_complete falls
  //     back to the ward's default building at complete time.
  //   - remove: no buildings (no Seat inserted); force-empty even
  //     if the client sent something.
  var buildingNames = '';
  if (type !== 'remove') {
    buildingNames = String(draft.building_names || '').trim();
    if (buildingNames) RequestsService_validateBuildings_(buildingNames);
    if (args.scope === 'stake' && !buildingNames) {
      throw new Error('At least one building is required for stake requests.');
    }
  }

  var startDate = '';
  var endDate   = '';
  if (type === 'add_temp') {
    startDate = String(draft.start_date || '').trim();
    endDate   = String(draft.end_date   || '').trim();
    if (!RequestsService_isIsoDate_(startDate)) {
      throw new Error('Start date "' + startDate + '" is not a valid YYYY-MM-DD date.');
    }
    if (!RequestsService_isIsoDate_(endDate)) {
      throw new Error('End date "' + endDate + '" is not a valid YYYY-MM-DD date.');
    }
    // Lexical compare works because both are ISO YYYY-MM-DD.
    if (endDate < startDate) {
      throw new Error('End date (' + endDate + ') must be on or after the start date (' + startDate + ').');
    }
  }

  // Chunk 7: remove-specific guards. All run server-side (the UI hides
  // the X on already-pending rows, but a stale roster page or a crafted
  // rpc could still attempt the submit).
  if (type === 'remove') {
    var matches = Seats_getActiveByScopeAndEmail(args.scope, targetEmail);
    if (matches.length === 0) {
      throw new Error('No active seat for ' + targetEmail + ' in scope ' + args.scope +
        '. The roster page may be stale — refresh and try again.');
    }
    // open-questions.md R-3: auto seats are importer-owned. Filter them
    // out and reason on the removable subset.
    var removable = [];
    for (var m = 0; m < matches.length; m++) {
      if (matches[m].type !== 'auto') removable.push(matches[m]);
    }
    if (removable.length === 0) {
      throw new Error('Cannot remove an auto seat for ' + targetEmail +
        ' — auto seats come from the callings sheet. Update the calling in LCR; ' +
        'the next import will remove the seat.');
    }
    // If a person somehow holds multiple manual/temp seats in the same
    // scope, the request shape can't say which one to remove (no seat_id
    // on the wire — the request's natural key is (scope, target_email)).
    // Refuse the submit loudly until a multi-seat removal UX exists.
    // At target scale this should never fire; if it does, the manager
    // can clean up via the AllSeats inline edit / future hand-edit path
    // before the request goes through.
    if (removable.length > 1) {
      throw new Error('Multiple removable seats found for ' + targetEmail + ' in ' +
        args.scope + ' (' + removable.length + ' rows). The request flow can\'t ' +
        'choose between them — ask a Kindoo Manager to resolve the duplicates first.');
    }
    var existingPending = Requests_getPendingRemoveByScopeAndEmail(args.scope, targetEmail);
    if (existingPending) {
      throw new Error('A removal request for ' + targetEmail + ' in ' + args.scope +
        ' is already pending (request ' + existingPending.request_id + ').');
    }
  }

  var requestId = Utils_uuid();
  var row = {
    request_id:       requestId,
    type:             type,
    scope:            String(args.scope),
    target_email:     targetEmail,
    target_name:      String(draft.target_name || '').trim(),
    reason:           reason,
    comment:          String(draft.comment || '').trim(),
    start_date:       startDate,
    end_date:         endDate,
    building_names:   buildingNames,
    status:           'pending',
    requester_email:  Utils_cleanEmail(args.requesterPrincipal.email),
    requested_at:     Utils_nowTs(),
    completer_email:  '',
    completed_at:     '',
    rejection_reason: '',
    completion_note:  ''
  };
  var inserted = Requests_insert(row);
  AuditRepo_write({
    actor_email: inserted.requester_email,
    action:      'submit_request',
    entity_type: 'Request',
    entity_id:   inserted.request_id,
    before:      null,
    after:       inserted
  });
  return { request: inserted };
}

// ---------------------------------------------------------------------------
// complete — flip a pending Request to a terminal `complete` state and
// apply the matching Seats mutation atomically, both inside the caller's
// Lock_withLock.
//
// add_manual / add_temp:
//   Inserts a new Seats row stamped with manager credentials. Two audit
//   rows: complete_request on Request + insert on Seat.
//
// remove (Chunk 7):
//   Deletes the matching Seats row (lookup by scope + canonical email).
//   Two audit rows on the happy path: complete_request on Request +
//   delete on Seat.
//   R-1 RACE: if the seat is already gone (concurrent remove, future
//   expiry trigger, manual sheet edit), still flip the Request to
//   complete — the requester's ask is fulfilled — but stamp
//   completion_note so the audit trail is honest. ONE audit row in that
//   case (complete_request only; no Seat row was deleted, so no Seat
//   audit). The completion email body mentions the no-op so the
//   requester isn't confused by getting a "done" notification when
//   nothing visibly changed.
//
// The request_id → seat_id pairing is recorded implicitly by the shared
// timestamp and the managerPrincipal.email on both rows; if we needed a
// harder link we could embed request_id in the Seat's audit payload, but
// current reporting needs don't require it.
// ---------------------------------------------------------------------------
function RequestsService_complete(managerPrincipal, requestId, overrides) {
  if (!managerPrincipal || !managerPrincipal.email) {
    throw new Error('RequestsService_complete: managerPrincipal required');
  }
  if (!requestId) throw new Error('RequestsService_complete: requestId required');

  var req = Requests_getById(requestId);
  if (!req) throw new Error('Request not found: ' + requestId);
  if (req.status !== 'pending') {
    throw new Error('Request is no longer pending (current status: ' + req.status + ').');
  }
  if (req.type !== 'add_manual' && req.type !== 'add_temp' && req.type !== 'remove') {
    throw new Error('Request type "' + req.type + '" is not completable.');
  }

  if (req.type === 'remove') {
    return RequestsService_completeRemove_(managerPrincipal, req);
  }

  // Build the Seat row first so validation errors (e.g. Seats_insert's
  // type guard) throw BEFORE we update the Request row — keeps the Sheet
  // state consistent if anything goes wrong mid-flow.
  //
  // building_names resolution:
  //   1. If the caller passed `overrides.building_names` (Chunk-6
  //      confirmation dialog — manager's final choice), use it verbatim.
  //   2. Else if the requester stored a selection on the request row,
  //      use that (added post-Chunk-10.6 for the stake scope, which has
  //      no ward default).
  //   3. Else fall back to the ward's default building_name. Stake-scope
  //      requests with no requester selection fall through to ''.
  //
  // Validation: each submitted building_name must exist in Buildings.
  // Empty string is REJECTED on complete — the manager's dialog enforces
  // "at least one ticked" before Confirm enables, and the server repeats
  // the check so a hand-crafted rpc can't sneak through. (remove requests
  // don't insert a Seat; the check is skipped for them.)
  var managerEmail = managerPrincipal.email;
  var buildingNames;
  if (overrides && overrides.building_names !== undefined && overrides.building_names !== null) {
    buildingNames = String(overrides.building_names);
    RequestsService_validateBuildings_(buildingNames);
  } else if (req.building_names) {
    buildingNames = String(req.building_names);
    RequestsService_validateBuildings_(buildingNames);
  } else {
    buildingNames = '';
    if (req.scope && req.scope !== 'stake') {
      var ward = Wards_getByCode(req.scope);
      if (ward && ward.building_name) buildingNames = ward.building_name;
    }
  }
  // At-least-one rule. A trimmed empty string means every token was
  // blank (or there were no tokens at all). Throws a clear user-facing
  // error — the manager sees it as a toast on the queue page.
  var trimmedBuildings = buildingNames
    .split(',').map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
  if (trimmedBuildings.length === 0) {
    throw new Error('At least one building is required to complete this request. ' +
      'Pick one or more in the confirmation dialog.');
  }
  buildingNames = trimmedBuildings.join(',');
  var seatRow = {
    seat_id:          Utils_uuid(),
    scope:            req.scope,
    type:             req.type === 'add_manual' ? 'manual' : 'temp',
    person_email:     req.target_email,    // stored as typed (D4)
    person_name:      req.target_name || '',
    reason:           req.reason || '',
    start_date:       req.start_date || '',
    end_date:         req.end_date   || '',
    building_names:   buildingNames,
    created_by:       managerEmail,
    last_modified_by: managerEmail
  };

  var seatInserted = Seats_insert(seatRow);

  var updatedReq = Requests_update(requestId, {
    status:          'complete',
    completer_email: managerEmail,
    completed_at:    Utils_nowTs()
  }).after;

  AuditRepo_writeMany([
    {
      actor_email: managerEmail,
      action:      'complete_request',
      entity_type: 'Request',
      entity_id:   requestId,
      before:      req,
      after:       updatedReq
    },
    {
      actor_email: managerEmail,
      action:      'insert',
      entity_type: 'Seat',
      entity_id:   seatInserted.seat_id,
      before:      null,
      after:       seatInserted
    }
  ]);

  return { request: updatedReq, seat: seatInserted };
}

// ---------------------------------------------------------------------------
// completeRemove — internal: complete a pending `remove` request.
//
// Looks up the matching active seat by (scope, canonical email). Two
// outcomes:
//   - Seat found  → delete the Seats row, flip Request to complete; emit
//     two audit rows (complete_request on Request, delete on Seat).
//     Returns { request, seat_deleted }.
//   - Seat absent → R-1 race. Flip Request to complete with a
//     completion_note; emit ONE audit row (complete_request only).
//     Returns { request, noop: true }.
//
// In both cases the requester gets the completion email. The body of
// the email differs (EmailService_notifyRequesterCompleted reads
// `request.completion_note`), so the no-op case isn't silently
// indistinguishable from a real removal.
// ---------------------------------------------------------------------------
function RequestsService_completeRemove_(managerPrincipal, req) {
  var managerEmail = managerPrincipal.email;
  var seat = null;
  var matches = Seats_getActiveByScopeAndEmail(req.scope, req.target_email);
  // Skip auto rows defensively: a remove against an auto seat is rejected
  // at submit, but if a calling change between submit and complete turned
  // the only matching seat into an auto-only result, treat it as already-
  // removed for our purposes (the LCR-managed row is the canonical source).
  for (var i = 0; i < matches.length; i++) {
    if (matches[i].type !== 'auto') { seat = matches[i]; break; }
  }

  // R-1 race: nothing to delete. Still mark the request complete so the
  // requester's ask is closed out, and stamp a note for the audit trail.
  if (!seat) {
    return RequestsService_completeRemoveNoop_(req, managerEmail);
  }

  // Delete the Seat first; if it throws (header drift, race) we'd rather
  // surface that BEFORE flipping the Request, same defence-in-depth as
  // the add path's "build seat row first".
  var deleted = Seats_deleteById(seat.seat_id);
  if (!deleted) {
    // Seat vanished between Seats_getActiveByScopeAndEmail and
    // Seats_deleteById — shouldn't happen inside the lock, but if it
    // does, fall back to the no-op path so we don't 500 on the manager.
    return RequestsService_completeRemoveNoop_(req, managerEmail);
  }

  var updatedReqOk = Requests_update(req.request_id, {
    status:          'complete',
    completer_email: managerEmail,
    completed_at:    Utils_nowTs()
  }).after;

  AuditRepo_writeMany([
    {
      actor_email: managerEmail,
      action:      'complete_request',
      entity_type: 'Request',
      entity_id:   req.request_id,
      before:      req,
      after:       updatedReqOk
    },
    {
      actor_email: managerEmail,
      action:      'delete',
      entity_type: 'Seat',
      entity_id:   deleted.seat_id,
      before:      deleted,
      after:       null
    }
  ]);

  return { request: updatedReqOk, seat_deleted: deleted };
}

// Fired from RequestsService_completeRemove_ when the matching seat is
// gone (either Seats_getActiveByScopeAndEmail returned no removable rows,
// or Seats_deleteById returned null after a positive lookup — both end up
// here so the audit trail and the email body are identical regardless of
// which sub-case raced). Flips the Request to complete, stamps a note,
// emits ONE AuditLog row (no Seat audit because no Seat changed). Returns
// the same { request, noop: true } shape the happy path returns
// (sans seat_deleted), so EmailService_notifyRequesterCompleted can read
// `request.completion_note` uniformly.
function RequestsService_completeRemoveNoop_(req, managerEmail) {
  var note = 'Seat already removed at completion time (no-op).';
  var updatedReq = Requests_update(req.request_id, {
    status:          'complete',
    completer_email: managerEmail,
    completed_at:    Utils_nowTs(),
    completion_note: note
  }).after;
  AuditRepo_write({
    actor_email: managerEmail,
    action:      'complete_request',
    entity_type: 'Request',
    entity_id:   req.request_id,
    before:      req,
    after:       updatedReq
  });
  return { request: updatedReq, noop: true };
}

// ---------------------------------------------------------------------------
// reject — flip a pending Request to rejected with a reason.
//
// The rejection reason is required per data-model.md Tab 9
// (rejection_reason is flagged "Required on rejected"). If the caller
// passes an empty string the UI should have caught it first; we still
// reject here (clean error, no audit row).
// ---------------------------------------------------------------------------
function RequestsService_reject(managerPrincipal, requestId, rejectionReason) {
  if (!managerPrincipal || !managerPrincipal.email) {
    throw new Error('RequestsService_reject: managerPrincipal required');
  }
  if (!requestId) throw new Error('RequestsService_reject: requestId required');
  var reason = String(rejectionReason || '').trim();
  if (!reason) throw new Error('A rejection reason is required.');

  var req = Requests_getById(requestId);
  if (!req) throw new Error('Request not found: ' + requestId);
  if (req.status !== 'pending') {
    throw new Error('Request is no longer pending (current status: ' + req.status + ').');
  }

  var managerEmail = managerPrincipal.email;
  var updatedReq = Requests_update(requestId, {
    status:           'rejected',
    completer_email:  managerEmail,
    completed_at:     Utils_nowTs(),
    rejection_reason: reason
  }).after;

  AuditRepo_write({
    actor_email: managerEmail,
    action:      'reject_request',
    entity_type: 'Request',
    entity_id:   requestId,
    before:      req,
    after:       updatedReq
  });

  return { request: updatedReq };
}

// ---------------------------------------------------------------------------
// cancel — the requester (or the stake user) flips their own pending
// Request to cancelled. Only the requester may cancel; a different
// bishopric / stake / manager user trying to cancel someone else's
// request hits a Forbidden check here.
//
// Rationale for the guard: even though managers can't self-approve (R-6
// allows that), cancel is conceptually "I changed my mind" — the
// requester owns that decision. A manager who wants to shut a request
// down unilaterally should Reject with a reason.
// ---------------------------------------------------------------------------
function RequestsService_cancel(requesterPrincipal, requestId) {
  if (!requesterPrincipal || !requesterPrincipal.email) {
    throw new Error('RequestsService_cancel: requesterPrincipal required');
  }
  if (!requestId) throw new Error('RequestsService_cancel: requestId required');

  var req = Requests_getById(requestId);
  if (!req) throw new Error('Request not found: ' + requestId);
  if (!Utils_emailsEqual(req.requester_email, requesterPrincipal.email)) {
    throw new Error('Forbidden: you can only cancel requests you submitted.');
  }
  if (req.status !== 'pending') {
    throw new Error('Request is no longer pending (current status: ' + req.status + ').');
  }

  var updatedReq = Requests_update(requestId, {
    status:       'cancelled',
    completed_at: Utils_nowTs()
  }).after;

  AuditRepo_write({
    actor_email: requesterPrincipal.email,
    action:      'cancel_request',
    entity_type: 'Request',
    entity_id:   requestId,
    before:      req,
    after:       updatedReq
  });

  return { request: updatedReq };
}

// Validate a comma-separated building_names string against the Buildings
// tab. Empty string is valid (seats can be unassigned). Each non-empty
// token must match an existing Buildings.building_name exactly
// (case-sensitive, per data-model.md). Throws with the offending name on
// failure so the manager's dialog surfaces a useful error.
function RequestsService_validateBuildings_(buildingNames) {
  var s = String(buildingNames || '').trim();
  if (!s) return;  // empty string is allowed
  var tokens = s.split(',');
  var known = {};
  var all = Buildings_getAll();
  for (var i = 0; i < all.length; i++) known[all[i].building_name] = true;
  var seen = {};
  for (var j = 0; j < tokens.length; j++) {
    var t = tokens[j].trim();
    if (!t) continue;  // blank token from trailing comma — ignore
    if (!known[t]) {
      throw new Error('Unknown building "' + t + '" — add it via Configuration first, ' +
        'or pick an existing one.');
    }
    if (seen[t]) {
      throw new Error('Building "' + t + '" is listed twice; please pick each building only once.');
    }
    seen[t] = true;
  }
}

// YYYY-MM-DD sanity check. Must be exactly 10 chars, dashes in position 5
// and 8, and JS Date() must parse it to a real date. Rejects 2026-02-30.
function RequestsService_isIsoDate_(s) {
  if (!s || typeof s !== 'string') return false;
  if (s.length !== 10) return false;
  if (s.charAt(4) !== '-' || s.charAt(7) !== '-') return false;
  var y = Number(s.substring(0, 4));
  var m = Number(s.substring(5, 7));
  var d = Number(s.substring(8, 10));
  if (isNaN(y) || isNaN(m) || isNaN(d)) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  // Round-trip through Date to catch Feb 30 etc.
  var parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}
