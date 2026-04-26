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

  // Chunk 5: the manager AllSeats page supports deep-link filter state
  // via ?p=mgr/seats&ward=CO&type=manual. Since the iframe can't read
  // the top-frame's query string (cross-origin), we forward the rest of
  // the query params as a typed JSON blob to the client via Layout. We
  // strip four reserved keys ('p' is Layout's page dispatch; 'token'
  // is the one-shot auth hand-off from Identity and already consumed
  // above; 'redirect' is the Chunk-11.1 wrapper-layer round-trip param
  // that the wrapper sanitizes off the iframe URL before this doGet
  // sees it; 'xinst' is the Chunk-11.2 wrapper → iframe bridge for
  // the first-time-login-instructions flag — we read it just below
  // and inject the boolean into the Layout template) — every other
  // param passes through untouched. The first three are stripped as
  // defense-in-depth in case a hostile request hits /exec directly
  // with a crafted query.
  var queryParams = {};
  for (var k in params) {
    if (!params.hasOwnProperty(k)) continue;
    if (k === 'p' || k === 'token' || k === 'redirect' || k === 'xinst') continue;
    queryParams[k] = String(params[k] == null ? '' : params[k]);
  }

  // Chunk 11.2: the wrapper's own localStorage holds the
  // first-time-login-instructions flag (the iframe origin's
  // localStorage is unreliable across visits — n-<hash> rotates per
  // Apps Script execution, and third-party storage may be partitioned).
  // The wrapper bridges the flag to the iframe via &xinst=1 on the
  // URL; we read it here and inject the boolean into the Layout
  // template so showLogin can decide whether to render the overlay.
  var instructionsSeen = (String(params.xinst || '') === '1');

  var template = HtmlService.createTemplateFromFile('ui/Layout');
  template.identity_url   = identityUrl;
  template.main_url       = mainUrl;
  template.injected_token = injectedToken;
  template.injected_error = injectedError;
  template.requested_page    = requestedPage;
  template.query_params      = queryParams;
  template.instructions_seen = instructionsSeen;
  template.app_version       = Version_get();
  return template.evaluate()
    .setTitle('Kindoo Access Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// Used by ui/Layout.html scriptlets:  <?!= include('ui/Styles') ?>
function include(path) {
  return HtmlService.createHtmlOutputFromFile(path).getContent();
}
