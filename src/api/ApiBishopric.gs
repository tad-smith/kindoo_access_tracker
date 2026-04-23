// Bishopric API surface. Roster read endpoint lives here; the request-
// submit / list-my / cancel / checkDuplicate endpoints consolidated into
// api/ApiRequests.gs in Chunk 6 (same endpoint set used by stake
// principals — scope is derived server-side from the verified
// principal, not chosen by the caller).
//
// Multi-ward bishopric principals: the wardCode parameter is accepted
// but validated against the principal's own bishopric wards, so a CO
// bishopric still cannot spoof `?wardCode=GE` to read another ward's
// roster. When omitted, the first bishopric ward (sheet order) is
// returned. The allowed-wards list ships in the response so the client
// can render a ward picker when the principal holds more than one.
// Single-ward principals (the common case) pay no extra UI cost —
// response looks identical to the Chunk-5 shape with an extra
// `allowed_wards: [{scope, label}]` of length 1.
//
// Chunk 7 adds the X/trashcan removal flow on Roster.html, which emits
// a `type='remove'` request via ApiRequests_submit.

function ApiBishopric_roster(token, wardCode) {
  var _startedMs = Date.now();
  var principal = Auth_principalFrom(token);
  var allowedWards = Auth_bishopricWards(principal);
  if (allowedWards.length === 0) {
    // Not "silently empty" — explicit Forbidden so a manager or stake
    // user who hits this endpoint for debugging gets a clear signal rather
    // than a misleading empty roster.
    throw new Error('Forbidden: bishopric role required');
  }
  var requested = wardCode == null ? '' : String(wardCode).trim();
  var selectedScope;
  if (requested) {
    var match = null;
    for (var i = 0; i < allowedWards.length; i++) {
      if (allowedWards[i].scope === requested) { match = allowedWards[i]; break; }
    }
    if (!match) {
      throw new Error('Forbidden: not a bishopric for ward "' + requested + '"');
    }
    selectedScope = match.scope;
  } else {
    selectedScope = allowedWards[0].scope;
  }
  var ctx = Rosters_buildContext_();
  var response = Rosters_buildResponseForScope(selectedScope, ctx);
  response.allowed_wards  = allowedWards;
  response.selected_scope = selectedScope;
  Logger.log('[measure] bishopric/roster ward=' + selectedScope +
    ' allowed=' + allowedWards.length +
    ' rows=' + response.rows.length +
    ' took ' + (Date.now() - _startedMs) + 'ms');
  return response;
}
