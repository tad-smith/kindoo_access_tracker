// Web-app entry point. Same script project, **two deployments**:
//
//   - **Main** (`executeAs: USER_DEPLOYING`) — renders the user-facing UI.
//     URL stored in `Config.main_url`.
//   - **Identity** (`executeAs: USER_ACCESSING`) — calls
//     `Session.getActiveUser` and HMAC-signs the result back to Main via a
//     top-frame redirect. URL stored in `Config.identity_url`.
//
// `doGet` routes between the two SOLELY on the `?service=identity` query
// parameter. The Login link in `Layout.html` always appends that param to
// `Config.identity_url`, so the user just pastes the bare /exec URL into
// Config — the client tags the navigation with the routing flag.
//
// We tried using `ScriptApp.getService().getUrl()` matched against
// `Config.identity_url` as a secondary signal so that a directly-
// bookmarked Identity URL without the query param would still route. It
// breaks in practice — Apps Script's getUrl() can return the same value
// for both deployments in a multi-deployment setup, which makes the URL-
// match dispatch fire on Main and create a sign-in loop. Removed.
//
// To smoke-test the Identity deployment in isolation, visit it with
// `?service=identity` appended to the URL.
//
// See architecture.md D10 + §4 and open-questions.md A-8.

function doGet(e) {
  var params = (e && e.parameter) || {};

  // Route to the Identity-deployment branch ONLY on ?service=identity. The
  // Login link in Layout.html always auto-appends that query param to
  // Config.identity_url, so the routing fires for every legitimate sign-in
  // navigation regardless of which deployment URL the user pasted.
  //
  // We deliberately do NOT compare ScriptApp.getService().getUrl() against
  // Config.identity_url here — empirically getUrl() returns the same value
  // for both deployments in some Apps Script multi-deployment configs,
  // which makes URL-match dispatch fire on Main and create a sign-in loop.
  // The query-param flag is the only reliable signal.
  if (params.service === 'identity') {
    return Identity_serve();
  }

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

  var template = HtmlService.createTemplateFromFile('ui/Layout');
  template.identity_url   = identityUrl;
  template.main_url       = mainUrl;
  template.injected_token = injectedToken;
  template.injected_error = injectedError;
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
