// Bishopric API surface. Read-only in Chunk 5.
//
// Every endpoint derives its scope from the verified principal — never
// from an endpoint parameter. A bishopric member for CO must not be able
// to read GE's roster by hand-crafting an rpc call with a spoofed
// wardCode, so we don't accept one. The principal.roles array carries the
// user's ward via Auth_findBishopricRole — see core/Auth.gs.
//
// Chunk 6 will add submitRequest / myRequests / cancelRequest; those will
// still take the requested-ward scope from the principal. Chunk 7 adds the
// X/trashcan removal flow.

function ApiBishopric_roster(token) {
  var principal = Auth_principalFrom(token);
  var role = Auth_findBishopricRole(principal);
  if (!role) {
    // Not "silently empty" — explicit Forbidden so a manager or stake
    // user who hits this endpoint for debugging gets a clear signal rather
    // than a misleading empty roster.
    throw new Error('Forbidden: bishopric role required');
  }
  var ctx = Rosters_buildContext_();
  return Rosters_buildResponseForScope(role.wardId, ctx);
}
