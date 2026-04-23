// Consolidated request endpoints for bishopric + stake users (Chunk 6).
//
// One endpoint surface instead of parallel ApiBishopric_submitRequest /
// ApiStake_submitRequest pairs. Scope is ALWAYS validated server-side
// against Auth_requestableScopes(principal) — a bishopric-CO user
// crafting a scope='GE' call hits Forbidden, same as Chunk 5's
// Auth_findBishopricRole pattern.
//
// Scope resolution rule:
//   - If the principal holds exactly one request-capable role
//     (bishopric OR stake), scope is inferred and the `scope`
//     parameter is optional.
//   - If the principal holds multiple request-capable roles (bishopric
//     + stake; or multiple bishopric — rare but possible), scope is
//     REQUIRED.
//   - The scope, once resolved, must appear in
//     Auth_requestableScopes(principal). Otherwise Forbidden.
//
// Every write path wraps its work in Lock_withLock and emits audit rows
// via RequestsService; email sends happen OUTSIDE the lock, best-effort,
// and surface a `warning` field on failure (architecture.md "Email send
// policy"). A mail failure never rolls back a successful write.

// ---------------------------------------------------------------------------
// submit — requester creates a new add_manual / add_temp request.
//
// draft shape:
//   { type, target_email, target_name?, reason, comment?, start_date?, end_date? }
//
// Server returns:
//   { request, warning? }
// where request is the inserted Requests row shape and warning (if set)
// indicates the manager-notify email failed.
// ---------------------------------------------------------------------------
function ApiRequests_submit(token, draft, scope) {
  var principal = Auth_principalFrom(token);
  var resolvedScope = ApiRequests_resolveScope_(principal, scope);

  var result = Lock_withLock(function () {
    return RequestsService_submit({
      scope:              resolvedScope,
      requesterPrincipal: principal,
      draft:              draft
    });
  });

  // Mail is best-effort, outside the lock. Failure becomes a warning
  // on the response rather than an error on the whole submit — the
  // request is already persisted + audited.
  try {
    EmailService_notifyManagersNewRequest(result.request, principal);
  } catch (e) {
    Logger.log('[ApiRequests_submit] notifyManagersNewRequest failed: ' + (e && e.message ? e.message : e));
    result.warning = 'Request saved, but the manager notification email failed to send.';
  }
  return result;
}

// ---------------------------------------------------------------------------
// listMy — the requester's own requests.
//
// Semantics:
//   - Always canonical-email-match (Utils_emailsEqual) so dot/+suffix
//     variants don't hide rows.
//   - If the principal holds one request-capable role, returns all of
//     their requests for that scope; the scope parameter is optional
//     and (if supplied) must match.
//   - If the principal holds multiple request-capable roles:
//       - scope unspecified → returns requests across every scope the
//         principal can submit for (UI uses this for the "All" filter).
//       - scope specified   → filters to that scope; must be allowed.
//   - Defensive: we also filter each returned row's scope against the
//     principal's current allowed scopes, so if someone loses a role
//     their OLD requests don't resurface on this page by accident.
//
// Returns:
//   { scopes: [{type, scope, label}], rows: [...], selected_scope: '' | '<scope>' }
// ---------------------------------------------------------------------------
function ApiRequests_listMy(token, scope) {
  var principal = Auth_principalFrom(token);
  var allowedScopes = Auth_requestableScopes(principal);
  if (!allowedScopes.length) {
    // Zero-scope principals have nothing to list. Rather than Forbidden
    // (which would be confusing — a bishopric+manager whose bishopric role
    // lapses between sign-ins could hit this), return an empty roster
    // with the empty allowed-list so the UI can render "You don't have a
    // role that can submit requests."
    return { scopes: [], rows: [], selected_scope: '' };
  }

  var allowedSet = {};
  for (var i = 0; i < allowedScopes.length; i++) allowedSet[allowedScopes[i].scope] = true;

  var filterScope = scope == null ? '' : String(scope).trim();
  if (filterScope) {
    if (!allowedSet[filterScope]) {
      throw new Error('Forbidden: you cannot view requests for scope "' + filterScope + '".');
    }
  }

  var mine = Requests_getByRequester(principal.email);
  var out = [];
  for (var j = 0; j < mine.length; j++) {
    var r = mine[j];
    if (filterScope) {
      if (r.scope !== filterScope) continue;
    } else {
      // No explicit filter → return everything across the principal's
      // current allowed scopes.
      if (!allowedSet[r.scope]) continue;
    }
    out.push(ApiRequests_shapeForClient_(r));
  }

  // Most-recent first — requested_at is a Date, compare descending.
  out.sort(function (a, b) {
    var ax = a.requested_at_ms || 0;
    var bx = b.requested_at_ms || 0;
    return bx - ax;
  });

  // Post-Chunk-10.6: the NewRequest page uses this response to
  // populate a building-name checkbox group (stake scope only today,
  // may extend to bishopric later). Shipped on every listMy call so
  // NewRequest doesn't need a second round-trip at init. The list is
  // role-blind (any authenticated principal sees the full Buildings
  // catalogue — it's not sensitive) and small enough at target scale
  // that MyRequests.html ignoring it is cheap.
  var buildings = Buildings_getAll().map(function (b) { return b.building_name; });

  return {
    scopes:         allowedScopes,
    rows:           out,
    selected_scope: filterScope,
    buildings:      buildings
  };
}

// ---------------------------------------------------------------------------
// cancel — requester flips their own pending request to cancelled.
//
// Only the requester may cancel — enforced in RequestsService_cancel via
// Utils_emailsEqual on requester_email. A manager who wants to shut a
// request down unilaterally should Reject with a reason.
// ---------------------------------------------------------------------------
function ApiRequests_cancel(token, requestId) {
  var principal = Auth_principalFrom(token);
  if (!requestId) throw new Error('request_id required');

  var result = Lock_withLock(function () {
    return RequestsService_cancel(principal, requestId);
  });

  try {
    EmailService_notifyManagersCancelled(result.request, principal);
  } catch (e) {
    Logger.log('[ApiRequests_cancel] notifyManagersCancelled failed: ' + (e && e.message ? e.message : e));
    result.warning = 'Request cancelled, but the manager notification email failed to send.';
  }
  return result;
}

// ---------------------------------------------------------------------------
// checkDuplicate — returns any existing active seats whose person_email
// canonicalises to targetEmail in the given scope.
//
// Warns, never blocks. The client-side NewRequest page surfaces the
// result so the requester can see what's already there before submitting;
// the RequestsQueue page surfaces the same check to managers at complete
// time. If the user submits anyway, the manager uses judgment — spec
// allows duplicates (two scopes could legitimately overlap).
//
// Reuses the Chunk-5 Rosters_mapRow_ shape so the client's
// rosterRowHtml helper renders the preview without a separate code path.
//
// Returns:
//   { exists: bool, existing: [ <rosterRow>, ... ], scope: '<resolved>' }
// ---------------------------------------------------------------------------
function ApiRequests_checkDuplicate(token, targetEmail, scope) {
  var principal = Auth_principalFrom(token);
  var resolvedScope = ApiRequests_resolveScope_(principal, scope);
  var email = Utils_cleanEmail(targetEmail);
  if (!email) return { exists: false, existing: [], scope: resolvedScope };

  var seats = Seats_getActiveByScopeAndEmail(resolvedScope, email);
  var ctx = Rosters_buildContext_();
  var rows = [];
  for (var i = 0; i < seats.length; i++) {
    rows.push(Rosters_mapRow_(seats[i], ctx.today));
  }
  return {
    exists:   rows.length > 0,
    existing: rows,
    scope:    resolvedScope
  };
}

// ---------------------------------------------------------------------------
// Scope resolution — shared by submit / checkDuplicate (and any future
// per-scope request endpoint). listMy doesn't use this because it supports
// an "unspecified = all allowed" mode that this helper rejects.
// ---------------------------------------------------------------------------
function ApiRequests_resolveScope_(principal, scope) {
  var allowedScopes = Auth_requestableScopes(principal);
  if (!allowedScopes.length) {
    throw new Error('Forbidden: must hold a bishopric or stake role to submit requests.');
  }
  var supplied = scope == null ? '' : String(scope).trim();
  var resolved = supplied || (allowedScopes.length === 1 ? allowedScopes[0].scope : '');
  if (!resolved) {
    throw new Error('Scope required: you hold multiple request-capable roles; pick one.');
  }
  var ok = false;
  for (var i = 0; i < allowedScopes.length; i++) {
    if (allowedScopes[i].scope === resolved) { ok = true; break; }
  }
  if (!ok) throw new Error('Forbidden: you cannot submit requests for scope ' + resolved);
  return resolved;
}

// Client-facing shape for a Request row — wraps the Date fields into
// display-ready forms. google.script.run's automatic Date handling has
// edge cases (Chunk 3 ran into this with last_import_at); sending
// pre-formatted strings is predictable. The *_ms twins exist so the
// client can sort descending without re-parsing.
function ApiRequests_shapeForClient_(req) {
  return {
    request_id:          req.request_id,
    type:                req.type,
    scope:               req.scope,
    target_email:        req.target_email,
    target_name:         req.target_name,
    reason:              req.reason,
    comment:             req.comment,
    start_date:          req.start_date,
    end_date:            req.end_date,
    status:              req.status,
    requester_email:     req.requester_email,
    requested_at:        ApiRequests_formatDate_(req.requested_at),
    requested_at_ms:     req.requested_at instanceof Date ? req.requested_at.getTime() : 0,
    completer_email:     req.completer_email,
    completed_at:        ApiRequests_formatDate_(req.completed_at),
    completed_at_ms:     req.completed_at instanceof Date ? req.completed_at.getTime() : 0,
    rejection_reason:    req.rejection_reason,
    completion_note:     req.completion_note || ''
  };
}

function ApiRequests_formatDate_(d) {
  if (!d) return null;
  if (d instanceof Date) {
    var tz = Session.getScriptTimeZone();
    return Utilities.formatDate(d, tz, 'yyyy-MM-dd HH:mm:ss z');
  }
  return String(d);
}
