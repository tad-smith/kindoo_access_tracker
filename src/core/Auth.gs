// Identity + role resolution for the two-deployment Session+HMAC pattern.
//
// Identity is established by the *Identity* deployment (executeAs:
// USER_ACCESSING) calling `Session.getActiveUser().getEmail()`. The email
// is wrapped in a short-lived HMAC token signed with `Config.session_secret`,
// shipped to the Main deployment via a top-frame redirect, and verified on
// every subsequent rpc call.
//
// We use `Session.getActiveUser()` rather than browser-side OAuth (GSI,
// implicit, code) because Apps Script HtmlService renders user code in an
// iframe on `*.googleusercontent.com`, and Google's OAuth endpoints reject
// all browser-initiated requests from that origin (`origin_mismatch`).
// Server-to-server token-exchange escapes the origin check, but the initial
// browser-side `accounts.google.com` GET cannot. `Session.getActiveUser`
// under USER_ACCESSING bypasses OAuth entirely. See architecture.md D10
// and open-questions.md A-8 for the full discovery trail.

const AUTH_TOKEN_TTL_S_   = 3600; // 1 hour
const AUTH_CLOCK_SKEW_S_  = 30;
const AUTH_MIN_SECRET_LEN = 32;

// Token shape:
//   <base64url(JSON({email, exp, nonce}))>.<base64url(HMAC-SHA256(payload, secret))>
//
// Two segments, dot-separated. Distinguishable from a JWT (three segments).
// Stored client-side in sessionStorage.jwt (the key name is preserved for
// rpc-helper compat — it predates this auth pivot).

function Auth_signSessionToken(email, ttlSeconds) {
  var canonical = Utils_normaliseEmail(email);
  if (!canonical) throw new Error('AuthInvalid');
  var secret = Auth_requireSessionSecret_();
  var payload = {
    email: canonical,
    exp:   Math.floor(Date.now() / 1000) + (ttlSeconds || AUTH_TOKEN_TTL_S_),
    nonce: Utils_uuid()
  };
  var payloadB64 = Utils_base64UrlEncode(JSON.stringify(payload));
  var sigBytes   = Utilities.computeHmacSha256Signature(payloadB64, secret);
  var sigB64     = Utils_base64UrlEncodeBytes(sigBytes);
  return payloadB64 + '.' + sigB64;
}

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
    email:   Utils_normaliseEmail(payload.email),
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

// Resolves a canonical email to the union of roles that email holds in the
// sheet. Always returns { email, roles }; an empty roles array means "no
// access" (the caller should render NotAuthorized).
function Auth_resolveRoles(email) {
  var canon = Utils_normaliseEmail(email);
  var roles = [];

  if (KindooManagers_isActiveByEmail(canon)) {
    roles.push({ type: 'manager' });
  }

  var accessRows = Access_getByEmail(canon);
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

  return { email: canon, roles: roles };
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
