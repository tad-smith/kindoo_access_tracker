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
  var principal = Auth_principalFrom(token);

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
        principal: principal,
        template:  'ui/BootstrapWizard',
        pageModel: { principal: principal },
        pageHtml:  wiz.evaluate().getContent(),
        navHtml:   ''
      };
    }
    // Signed in but not the bootstrap admin, and setup isn't done.
    var sip = HtmlService.createTemplateFromFile('ui/SetupInProgress');
    sip.email       = principal.email;
    sip.admin_email = adminEmail;
    return {
      principal: principal,
      template:  'ui/SetupInProgress',
      pageModel: { email: principal.email, admin_email: adminEmail },
      pageHtml:  sip.evaluate().getContent(),
      navHtml:   ''
    };
  }

  // Normal path — setup is complete. Router_pick also returns navHtml
  // (populated for principals with roles; empty for NotAuthorized).
  var routed = Router_pick(requestedPage || '', principal);
  return {
    principal: principal,
    template:  routed.template,
    pageModel: routed.pageModel,
    pageHtml:  routed.pageHtml,
    navHtml:   routed.navHtml || ''
  };
}

// Lightweight identity probe; useful from the browser console for debugging.
function ApiShared_whoami(token) {
  return Auth_principalFrom(token);
}
