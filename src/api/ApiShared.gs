// Cross-role endpoints callable from any signed-in principal.
// Every function here takes the HMAC session token as the first argument
// (Identity-issued, see services/Identity.gs) and calls Auth_principalFrom
// before doing work — establishing the pattern Chunks 2–10 will copy across
// api/ApiBishopric, api/ApiStake, api/ApiManager.
//
// Function names are prefixed `ApiShared_` because of Apps Script's flat
// namespace. The client's rpc('ApiShared_bootstrap', …) helper auto-injects
// sessionStorage.jwt (which despite the name is the HMAC token) as the
// first argument.

function ApiShared_bootstrap(token, requestedPage) {
  var principal = Auth_principalFrom(token);
  var routed = Router_pick(requestedPage || '', principal);
  return {
    principal: principal,
    template:  routed.template,
    pageModel: routed.pageModel,
    pageHtml:  routed.pageHtml
  };
}

// Lightweight identity probe; useful from the browser console for debugging.
function ApiShared_whoami(token) {
  return Auth_principalFrom(token);
}
