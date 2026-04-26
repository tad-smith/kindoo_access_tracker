// Kindoo Identity Service — standalone Apps Script project.
//
// Read this together with identity-project/README.md.
//
// This is the *Identity* half of the Kindoo Access Tracker auth flow. It is
// a SEPARATE Apps Script project from the main Kindoo project — owned by a
// PERSONAL Google Drive account, not a Workspace one — because consumer-
// Gmail users cannot authorize a Workspace-owned Apps Script project's
// `executeAs: USER_ACCESSING` deployment (the Workspace tenant gates the
// OAuth-authorize step regardless of "Who has access" + External + In-
// production OAuth consent settings).
//
// This project is NOT pushed via clasp. Set it up manually in the
// Apps Script editor by copy-pasting these two files (Code.gs +
// appsscript.json). See identity-project/README.md for the runbook.
//
// What this script does:
//   1. Reads `Session.getActiveUser().getEmail()` — works because the
//      deployment runs `executeAs: USER_ACCESSING` in a personal-account
//      Cloud project that consumer-Gmail users can authorize.
//   2. HMAC-SHA256-signs `{ email, exp, nonce }` with `session_secret`,
//      a value shared with the Workspace-owned Main project. The shared
//      value lives in:
//        - Main's backing Sheet, `Config.session_secret` cell
//        - This project's Script Properties, key `session_secret`
//      Sync them by hand on rotation (see README "Rotating session_secret").
//   3. Renders a tiny HTML page with a "Continue" link that navigates
//      the top frame to Main's /exec URL with `?token=<signed-token>`
//      appended. A best-effort `window.top.location.replace` runs first,
//      but cross-origin top-frame navigation from Apps Script's iframe
//      sandbox without user activation is blocked by browsers, so most
//      users will need to click the Continue link.
//
// Token format (must stay byte-identical to what Main's
// Auth_verifySessionToken expects):
//   <base64url(JSON({email, exp, nonce}))>.<base64url(HMAC-SHA256(payload, secret))>
//
// Required Script Properties (Project Settings → Script Properties):
//   session_secret  — copy from Main's Sheet `Config.session_secret`. ≥ 32 chars.
//   main_url        — copy from Main's Sheet `Config.main_url`. The /exec URL
//                     of the Workspace-bound Main deployment.

const IDENTITY_TOKEN_TTL_S_ = 3600;       // 1 hour, matches Main
const IDENTITY_MIN_SECRET_LEN_ = 32;

function doGet(e) {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('session_secret');
  var mainUrl = props.getProperty('main_url');

  // Chunk 11.1: opaque pass-through of a `redirect` query param. The
  // Login button on Main builds the Identity URL with
  // `&redirect=<encoded original query>`; we round-trip that value
  // verbatim onto the Continue link so the wrapper at Main can restore
  // the user's deep-link destination after auth. Identity makes no
  // claims about the value's meaning — it's opaque here. The wrapper
  // strips any nested `token`/`redirect` on arrival.
  var rawRedirect = (e && e.parameter && e.parameter.redirect) || '';

  if (!secret || secret.length < IDENTITY_MIN_SECRET_LEN_) {
    return Identity_errPage_(
      'Configuration error',
      'session_secret is missing or too short in this Identity project\'s ' +
      'Script Properties. Open Apps Script editor → Project Settings → ' +
      'Script Properties and paste the value from the Main Sheet\'s ' +
      'Config.session_secret cell.'
    );
  }
  if (!mainUrl) {
    return Identity_errPage_(
      'Configuration error',
      'main_url is missing in this Identity project\'s Script Properties. ' +
      'Open Apps Script editor → Project Settings → Script Properties and ' +
      'paste the value from the Main Sheet\'s Config.main_url cell.'
    );
  }

  var email = '';
  try {
    var u = Session.getActiveUser();
    if (u) email = (u.getEmail() || '').trim();
  } catch (e) {
    Logger.log('[Identity] Session.getActiveUser threw: ' + (e && e.message));
  }

  if (!email) {
    return Identity_errPage_(
      'Sign-in unavailable',
      'We could not determine your Google identity. This usually means you ' +
      'have not granted the email-address permission to this Identity ' +
      'service yet — visit this URL once directly to grant it, then return ' +
      'to the app and click Sign in again.'
    );
  }

  var token = Identity_signToken_(email, secret);
  var sep = mainUrl.indexOf('?') === -1 ? '?' : '&';
  var redirect = mainUrl + sep + 'token=' + encodeURIComponent(token);
  if (rawRedirect) {
    // The redirect value is already encoded once (URLSearchParams output
    // from Login.html); encodeURIComponent here adds the second encoding
    // that survives travel as a query-param value on the Continue URL.
    redirect += '&redirect=' + encodeURIComponent(rawRedirect);
  }

  // Tiny page whose only job is to navigate the top frame back to Main.
  // <base target="_top"> + window.top.location.replace keeps the redirect
  // top-level (escapes the HtmlService iframe). The Continue link is the
  // reliable fallback — browsers usually block the auto-redirect because
  // it's a cross-origin top-frame navigation from inside Apps Script's
  // iframe sandbox without user activation.
  var html =
    '<!DOCTYPE html>' +
    '<html><head>' +
    '<base target="_top">' +
    '<meta charset="utf-8">' +
    '<meta name="referrer" content="no-referrer">' +
    '<title>Signing in…</title>' +
    '<style>' +
      'body{font-family:system-ui,-apple-system,sans-serif;padding:24px;color:#1d2333}' +
      'a{color:#1f3a93}' +
    '</style>' +
    '</head><body>' +
    '<p>Signing in… <a href="' + Identity_escape_(redirect) + '">Continue</a> if you are not redirected automatically.</p>' +
    '<script>' +
      'try { window.top.location.replace(' + JSON.stringify(redirect) + '); } catch (e) {}' +
    '</script>' +
    '</body></html>';

  return HtmlService.createHtmlOutput(html)
    .setTitle('Signing in…')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// HMAC-SHA256 sign. Output format: <base64url(payload)>.<base64url(sig)>.
// Must remain byte-identical to what Main's Auth_verifySessionToken expects.
function Identity_signToken_(email, secret) {
  var payload = {
    email: String(email).trim(),
    exp:   Math.floor(Date.now() / 1000) + IDENTITY_TOKEN_TTL_S_,
    nonce: Utilities.getUuid()
  };
  var payloadB64 = Identity_b64u_(JSON.stringify(payload));
  var sigBytes   = Utilities.computeHmacSha256Signature(payloadB64, secret);
  return payloadB64 + '.' + Identity_b64u_(sigBytes);
}

function Identity_b64u_(data) {
  var s = (typeof data === 'string')
    ? Utilities.base64EncodeWebSafe(data, Utilities.Charset.UTF_8)
    : Utilities.base64EncodeWebSafe(data);
  return s.replace(/=+$/, '');
}

function Identity_errPage_(title, body) {
  var html =
    '<!DOCTYPE html>' +
    '<html><head>' +
    '<base target="_top">' +
    '<meta charset="utf-8">' +
    '<title>' + Identity_escape_(title) + '</title>' +
    '<style>body{font-family:system-ui,-apple-system,sans-serif;padding:24px;color:#1d2333;max-width:640px;margin:0 auto}h1{font-size:1.5em}</style>' +
    '</head><body>' +
    '<h1>' + Identity_escape_(title) + '</h1>' +
    '<p>' + Identity_escape_(body) + '</p>' +
    '</body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle(title)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function Identity_escape_(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
