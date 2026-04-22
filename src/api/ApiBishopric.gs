// Bishopric API surface. Roster read endpoint lives here; the request-
// submit / list-my / cancel / checkDuplicate endpoints consolidated into
// api/ApiRequests.gs in Chunk 6 (same endpoint set used by stake
// principals — scope is derived server-side from the verified
// principal, not chosen by the caller).
//
// Every endpoint derives its scope from the verified principal — never
// from an endpoint parameter. A bishopric member for CO must not be able
// to read GE's roster by hand-crafting an rpc call with a spoofed
// wardCode, so we don't accept one. The principal.roles array carries the
// user's ward via Auth_findBishopricRole — see core/Auth.gs.
//
// Chunk 7 adds the X/trashcan removal flow on Roster.html, which will
// emit a `type='remove'` request via ApiRequests_submit.

function ApiBishopric_roster(token) {
  var _startedMs = Date.now();
  var principal = Auth_principalFrom(token);
  var role = Auth_findBishopricRole(principal);
  if (!role) {
    // Not "silently empty" — explicit Forbidden so a manager or stake
    // user who hits this endpoint for debugging gets a clear signal rather
    // than a misleading empty roster.
    throw new Error('Forbidden: bishopric role required');
  }
  var ctx = Rosters_buildContext_();
  var response = Rosters_buildResponseForScope(role.wardId, ctx);
  Logger.log('[measure] bishopric/roster ward=' + role.wardId +
    ' rows=' + response.rows.length + ' took ' + (Date.now() - _startedMs) + 'ms');
  return response;
}
