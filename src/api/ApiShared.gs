// Cross-role endpoints callable from any signed-in principal.
// Every function here takes the HMAC session token as the first argument
// (Identity-issued, see identity-project/Code.gs) and calls Auth_principalFrom
// before doing work — establishing the pattern Chunks 2–10 will copy across
// api/ApiBishopric, api/ApiStake, api/ApiManager.
//
// Function names are prefixed `ApiShared_` because of Apps Script's flat
// namespace. The client's rpc('ApiShared_bootstrap', …) helper auto-injects
// sessionStorage.jwt (which despite the name is the HMAC token) as the
// first argument.

// The setup-complete gate (Chunk 4) runs BEFORE role resolution. Three
// possible outcomes on every page load:
//
//   1. setup_complete=TRUE  → normal role resolution (the Chunks 1-3 path).
//   2. setup_complete=FALSE AND signed-in email matches
//      Config.bootstrap_admin_email → render BootstrapWizard regardless of
//      ?p= (wizard is full-screen during bootstrap).
//   3. setup_complete=FALSE AND signed-in email does NOT match
//      bootstrap_admin_email → render SetupInProgress (not NotAuthorized —
//      the user isn't unauthorised, the app isn't ready yet).
//
// The gate runs before role resolution so the bootstrap admin — who has
// no roles during bootstrap, since KindooManagers is empty and Access is
// empty — doesn't land on NotAuthorized. After they complete setup, the
// auto-add-as-KindooManager step (see services/Bootstrap.gs) means normal
// role resolution returns 'manager' for them.

function ApiShared_bootstrap(token, requestedPage) {
  var _startedMs = Date.now();
  var principal = Auth_principalFrom(token);

  // Stake name for the topbar brand. Read unconditionally so the wizard
  // and the post-setup shell share the same code path; an empty value
  // makes the client keep the "Kindoo Access Tracker" fallback.
  var stakeName = '';
  try { stakeName = String(Config_get('stake_name') || ''); } catch (e) {}

  // Setup-complete gate. Config.setup_complete is coerced to boolean by
  // ConfigRepo; a missing or empty cell comes back as null and is treated
  // as "not complete" (fresh install).
  var complete = Config_get('setup_complete') === true;
  if (!complete) {
    var adminEmail = Config_get('bootstrap_admin_email') || '';
    if (adminEmail && Utils_emailsEqual(principal.email, adminEmail)) {
      // Bootstrap admin — render the wizard, ignore ?p=.
      var wiz = HtmlService.createTemplateFromFile('ui/BootstrapWizard');
      wiz.principal = principal;
      return {
        principal:  principal,
        stake_name: stakeName,
        template:   'ui/BootstrapWizard',
        pageModel:  { principal: principal },
        pageHtml:   wiz.evaluate().getContent(),
        navHtml:    ''
      };
    }
    // Signed in but not the bootstrap admin, and setup isn't done.
    var sip = HtmlService.createTemplateFromFile('ui/SetupInProgress');
    sip.email       = principal.email;
    sip.admin_email = adminEmail;
    return {
      principal:  principal,
      stake_name: stakeName,
      template:   'ui/SetupInProgress',
      pageModel:  { email: principal.email, admin_email: adminEmail },
      pageHtml:   sip.evaluate().getContent(),
      navHtml:    ''
    };
  }

  // Normal path — setup is complete. Router_pick returns the initial
  // page's HTML + navHtml + pageModel; Router_buildPageBundle renders
  // every OTHER role-allowed page so the client can swap tabs with
  // zero further rpcs. The initial page is also present in the bundle
  // (idempotent — same bytes), so a bookmark to any ?p= deep-link hits
  // the same cached HTML the shell will serve for re-entry.
  //
  // The bundle is ~12 page templates worth of HTML (gzipped on the
  // wire). At target scale (1-2 users/week, 12 wards) the up-front
  // cost is negligible and buys instant intra-app navigation for the
  // rest of the session.
  var routed      = Router_pick(requestedPage || '', principal);
  var pageBundle  = Router_buildPageBundle(principal);
  Logger.log('[measure] bootstrap for page=' + (requestedPage || '(default)') +
    ' took ' + (Date.now() - _startedMs) + 'ms');
  return {
    principal:   principal,
    stake_name:  stakeName,
    template:    routed.template,
    pageModel:   routed.pageModel,
    pageHtml:    routed.pageHtml,
    navHtml:     routed.navHtml || '',
    pageBundle:  pageBundle
  };
}

// Lightweight identity probe; useful from the browser console for debugging.
function ApiShared_whoami(token) {
  return Auth_principalFrom(token);
}
