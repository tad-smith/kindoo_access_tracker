// Web-app entry point for the Main Kindoo Apps Script project.
//
// Identity (the OAuth round-trip half of the auth flow) lives in a
// SEPARATE Apps Script project, owned by a personal Google account, with
// its own /exec URL. See `identity-project/README.md` and
// architecture.md D1 / D10 / open-questions.md D-3 for why.
//
// Consequently `Main.doGet` has no Identity branch — it always renders
// the Main UI (or consumes the `?token=…` handed back by the personal-
// account Identity project after a sign-in round-trip). The Login link
// in `Layout.html` navigates the top frame to `Config.identity_url`
// directly.

function doGet(e) {
  var params = (e && e.parameter) || {};

  // Main UI branch.
  var mainUrl     = '';
  var identityUrl = '';
  try { mainUrl     = Config_get('main_url')     || ''; } catch (err) {}
  try { identityUrl = Config_get('identity_url') || ''; } catch (err) {}
  if (!mainUrl) {
    try {
      var svc = ScriptApp.getService();
      if (svc) mainUrl = svc.getUrl() || '';
    } catch (err) {
      Logger.log('[Main] doGet could not read deployment URL: ' + (err && err.message));
    }
  }

  var injectedToken = '';
  var injectedError = '';

  if (params.token) {
    try {
      Auth_verifySessionToken(params.token);
      injectedToken = params.token;
    } catch (err) {
      injectedError = (err && err.message) ? err.message : String(err);
      Logger.log('[Main] session token verification failed: ' + injectedError);
    }
  }

  // The HtmlService iframe's URL is on *.googleusercontent.com and does
  // not carry the parent's query string, so client-side
  // `URLSearchParams(window.location.search)` cannot see ?p=. Read it
  // here, server-side, and inject into Layout for the client to use.
  var requestedPage = String(params.p || '');

  var template = HtmlService.createTemplateFromFile('ui/Layout');
  template.identity_url   = identityUrl;
  template.main_url       = mainUrl;
  template.injected_token = injectedToken;
  template.injected_error = injectedError;
  template.requested_page = requestedPage;
  template.app_version    = Version_get();
  return template.evaluate()
    .setTitle('Kindoo Access Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// Used by ui/Layout.html scriptlets:  <?!= include('ui/Styles') ?>
function include(path) {
  return HtmlService.createHtmlOutputFromFile(path).getContent();
}
