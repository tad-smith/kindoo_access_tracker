// Token verification + role resolution for the Main Kindoo project.
//
// Token *issuance* lives in a SEPARATE Apps Script project (personal-
// account-owned, see identity-project/README.md) — Main only verifies.
// Both projects share the same `session_secret`, kept in sync by hand:
//   - Main reads it from the backing Sheet's Config.session_secret cell.
//   - Identity reads it from its own Script Properties (key: session_secret).
// Rotation procedure is documented in identity-project/README.md.
//
// We use `Session.getActiveUser` (in the Identity project) rather than
// browser-side OAuth (GSI, implicit, code) because Apps Script HtmlService
// renders user code in an iframe on `*.googleusercontent.com`, and
// Google's OAuth endpoints reject all browser-initiated requests from
// that origin (`origin_mismatch`). The split-project design exists
// because Workspace-bound Apps Script projects can't accept consumer-
// Gmail OAuth authorize for `executeAs: USER_ACCESSING` deployments.
// See architecture.md D1 / D10 and open-questions.md A-8 / D-3 for the
// full discovery.

const AUTH_TOKEN_TTL_S_   = 3600; // 1 hour
const AUTH_CLOCK_SKEW_S_  = 30;
const AUTH_MIN_SECRET_LEN = 32;

// Token shape (issued by the Identity project; see identity-project/Code.gs):
//   <base64url(JSON({email, exp, nonce}))>.<base64url(HMAC-SHA256(payload, secret))>
//
// Two segments, dot-separated. Distinguishable from a JWT (three segments).
// Stored client-side in sessionStorage.jwt (the key name is preserved for
// rpc-helper compat — it predates this auth pivot).

// Returns { email, name, picture } on success.
// Throws AuthInvalid / AuthExpired / AuthNotConfigured.
// Compatible-shape return so callers (Auth_principalFrom) stay simple.
function Auth_verifySessionToken(token) {
  if (!token || typeof token !== 'string') throw new Error('AuthInvalid');
  var parts = token.split('.');
  if (parts.length !== 2) throw new Error('AuthInvalid');

  var secret = Auth_requireSessionSecret_();
  var expectedSigBytes = Utilities.computeHmacSha256Signature(parts[0], secret);
  var expectedSigB64   = Utils_base64UrlEncodeBytes(expectedSigBytes);

  // Constant-time-ish comparison
  if (parts[1].length !== expectedSigB64.length) throw new Error('AuthInvalid');
  var diff = 0;
  for (var i = 0; i < parts[1].length; i++) {
    diff |= parts[1].charCodeAt(i) ^ expectedSigB64.charCodeAt(i);
  }
  if (diff !== 0) throw new Error('AuthInvalid');

  var payload;
  try {
    payload = JSON.parse(Utils_base64UrlDecodeToString(parts[0]));
  } catch (e) {
    throw new Error('AuthInvalid');
  }

  var nowS = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number') throw new Error('AuthInvalid');
  if (payload.exp + AUTH_CLOCK_SKEW_S_ < nowS) throw new Error('AuthExpired');
  if (!payload.email) throw new Error('AuthInvalid');

  return {
    email:   Utils_cleanEmail(payload.email),  // typed form, preserved
    name:    '',  // Session.getActiveUser doesn't surface this; can fill via People API later
    picture: ''
  };
}

function Auth_requireSessionSecret_() {
  var secret = Config_get('session_secret');
  if (!secret || String(secret).length < AUTH_MIN_SECRET_LEN) {
    throw new Error('AuthNotConfigured');
  }
  return String(secret);
}

// Resolves an email (display form) to the union of roles that email holds
// in the sheet. The repos use Utils_emailsEqual under the hood, so dot/
// +suffix variants of the same gmail address resolve correctly. Returns
// the email in its display form (whatever the caller passed in); an empty
// roles array means "no access" (caller should render NotAuthorized).
function Auth_resolveRoles(email) {
  var typed = Utils_cleanEmail(email);
  var roles = [];

  if (KindooManagers_isActiveByEmail(typed)) {
    roles.push({ type: 'manager' });
  }

  var accessRows = Access_getByEmail(typed);
  var seenStake = false;
  var seenWards = {};
  for (var i = 0; i < accessRows.length; i++) {
    var scope = accessRows[i].scope;
    if (scope === 'stake') {
      if (!seenStake) {
        roles.push({ type: 'stake' });
        seenStake = true;
      }
    } else if (scope) {
      if (!seenWards[scope]) {
        roles.push({ type: 'bishopric', wardId: scope });
        seenWards[scope] = true;
      }
    }
  }

  return { email: typed, roles: roles };
}

// Composes verifySessionToken + resolveRoles into the Principal object the
// rest of the app passes around. Every api/* endpoint should call this
// before doing work.
function Auth_principalFrom(token) {
  var claims = Auth_verifySessionToken(token);
  var resolution = Auth_resolveRoles(claims.email);
  return {
    email:   resolution.email,
    name:    claims.name,
    picture: claims.picture,
    roles:   resolution.roles
  };
}

// requireRole(principal, 'manager')
// requireRole(principal, { type: 'bishopric', wardId: 'cordera-1st' })
// Throws Error('Forbidden') on mismatch. Manager and stake never satisfy a
// bishopric-scoped check by default — use requireWardScope for the cross-role
// "can this user see this ward's data?" question.
function Auth_requireRole(principal, matcher) {
  if (!principal || !principal.roles) throw new Error('Forbidden');
  var matchType, matchWard;
  if (typeof matcher === 'string') {
    matchType = matcher;
  } else if (matcher && matcher.type) {
    matchType = matcher.type;
    matchWard = matcher.wardId;
  } else {
    throw new Error('Forbidden');
  }
  for (var i = 0; i < principal.roles.length; i++) {
    var r = principal.roles[i];
    if (r.type !== matchType) continue;
    if (matchWard !== undefined && r.wardId !== matchWard) continue;
    return;
  }
  throw new Error('Forbidden');
}

// Allows access if the principal is (a) a Kindoo Manager, (b) in the stake
// presidency, or (c) a bishopric for the requested ward. Used by every per-
// ward endpoint to prevent a bishopric counsellor from reading another ward's
// data via a crafted rpc call.
function Auth_requireWardScope(principal, wardId) {
  if (!principal || !principal.roles) throw new Error('Forbidden');
  for (var i = 0; i < principal.roles.length; i++) {
    var r = principal.roles[i];
    if (r.type === 'manager' || r.type === 'stake') return;
    if (r.type === 'bishopric' && r.wardId === wardId) return;
  }
  throw new Error('Forbidden');
}
