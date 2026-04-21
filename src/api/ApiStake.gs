// Stake Presidency API surface. Read-only in Chunk 5.
//
// ApiStake_roster returns seats with scope='stake'; ApiStake_wardRoster
// returns any ward's roster (read-only view — the Stake Presidency can see
// into every ward, but does not edit). ApiStake_wardsList feeds the
// WardRosters page's dropdown.
//
// Every endpoint checks the stake role independently — a Kindoo Manager
// who is also in the stake presidency hits `manager` + `stake` endpoints
// freely; a bishopric-only user is blocked from every stake endpoint.

function ApiStake_roster(token) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'stake');
  var ctx = Rosters_buildContext_();
  return Rosters_buildResponseForScope('stake', ctx);
}

// Stake can view any ward's roster read-only. wardCode is a parameter here
// (unlike the bishopric endpoint where scope is derived) because the stake
// user is intentionally cross-ward. We still validate that the requested
// ward exists — otherwise a typo'd ward_code would silently return an
// empty roster, which would be confusing.
function ApiStake_wardRoster(token, wardCode) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'stake');
  if (!wardCode) throw new Error('ward_code required');
  var ward = Wards_getByCode(wardCode);
  if (!ward) throw new Error('Unknown ward: ' + wardCode);
  var ctx = Rosters_buildContext_();
  return Rosters_buildResponseForScope(ward.ward_code, ctx);
}

// Populates the WardRosters dropdown. Returns a thin projection rather
// than the full Wards row to keep the payload small and to make it clear
// this isn't an edit surface.
function ApiStake_wardsList(token) {
  var principal = Auth_principalFrom(token);
  Auth_requireRole(principal, 'stake');
  var wards = Wards_getAll();
  return wards.map(function (w) {
    return { ward_code: w.ward_code, ward_name: w.ward_name };
  });
}
