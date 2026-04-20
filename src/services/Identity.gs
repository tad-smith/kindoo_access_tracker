// Identity_serve(): rendered by the **Identity** web-app deployment
// (`executeAs: USER_ACCESSING`). Reads the signed-in user's email via
// `Session.getActiveUser().getEmail()`, HMAC-signs it via
// `Auth_signSessionToken`, and renders a tiny HTML page that navigates the
// top frame back to the **Main** web-app deployment with the token in the
// query string.
//
// Why this exists: see architecture.md D10 / open-questions.md A-8. All
// browser-initiated OAuth flows from inside Apps Script HtmlService are
// rejected by Google with `origin_mismatch` because the iframe origin
// (`*.googleusercontent.com`) is on Google's permanent OAuth-origin
// denylist. `Session.getActiveUser` under `USER_ACCESSING` is the only
// identity primitive available to consumer-Gmail users from inside Apps
// Script — but it forces the script to run under the user's permissions,
// which would expose the backing Sheet to every user. The two-deployment
// pattern keeps Main on `USER_DEPLOYING` (Sheet stays private) and uses
// Identity as a thin "what's your email?" service.
//
// This function is dispatched from `Main.doGet` when the request hits the
// Identity deployment.

function Identity_serve() {
  var email = '';
  try {
    var u = Session.getActiveUser();
    if (u) email = u.getEmail() || '';
  } catch (e) {
    Logger.log('[Identity] Session.getActiveUser threw: ' + (e && e.message));
  }

  if (!email) {
    return Identity_renderError_(
      'Sign-in unavailable',
      'We could not determine your Google identity. This usually means ' +
      'the Identity web app has not been authorised yet — visit it once ' +
      'directly to grant the email-address permission, then return to the ' +
      'app.'
    );
  }

  var mainUrl = '';
  try { mainUrl = Config_get('main_url') || ''; } catch (err) {}
  if (!mainUrl) {
    return Identity_renderError_(
      'Configuration error',
      'main_url is not configured in the backing Sheet (Config tab). ' +
      'Set it to the Main web-app deployment URL.'
    );
  }

  var token;
  try {
    token = Auth_signSessionToken(email);
  } catch (err) {
    var msg = (err && err.message) ? err.message : String(err);
    if (msg.indexOf('AuthNotConfigured') !== -1) {
      return Identity_renderError_(
        'Configuration error',
        'session_secret is not configured in the backing Sheet ' +
        '(Config tab). Run setupSheet from the editor to auto-generate one.'
      );
    }
    return Identity_renderError_('Sign-in error', msg);
  }

  var sep = mainUrl.indexOf('?') === -1 ? '?' : '&';
  var redirect = mainUrl + sep + 'token=' + encodeURIComponent(token);

  // Render a tiny page whose only job is to navigate the top frame back to
  // Main with the token. <base target="_top"> + window.top.location.replace
  // keeps the redirect a top-level navigation (escapes the iframe). The
  // <noscript> link is a fallback if JS is disabled.
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
    '<p>Signing in… <a href="' + redirect + '">Continue</a> if you are not redirected automatically.</p>' +
    '<script>' +
      'window.top.location.replace(' + JSON.stringify(redirect) + ');' +
    '</script>' +
    '</body></html>';

  return HtmlService.createHtmlOutput(html)
    .setTitle('Signing in…')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function Identity_renderError_(title, body) {
  var html =
    '<!DOCTYPE html>' +
    '<html><head>' +
    '<base target="_top">' +
    '<meta charset="utf-8">' +
    '<title>' + Identity_escape_(title) + '</title>' +
    '<style>' +
      'body{font-family:system-ui,-apple-system,sans-serif;padding:24px;color:#1d2333;max-width:640px;margin:0 auto}' +
      'h1{font-size:1.5em}' +
    '</style>' +
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
