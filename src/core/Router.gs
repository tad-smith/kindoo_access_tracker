// Router_pick(requestedPage, principal) → { template, pageHtml, pageModel }
//
// Page-id map mirrors architecture.md §8. Pages not yet implemented fall
// through to the role's default page (Hello in Chunks 1–4; the real
// dashboards land in Chunks 5+).
//
// Chunk 2 adds:
//   - mgr/config → ui/manager/Config (manager only)
//
// Cross-role unknowns or insufficient permissions silently fall back to
// the role's default page (the spec's "redirect with toast" model — toast
// surfacing on the client side is Chunk 5).

function Router_pick(requestedPage, principal) {
  if (!principal || !principal.roles || principal.roles.length === 0) {
    var na = HtmlService.createTemplateFromFile('ui/NotAuthorized');
    na.email = principal ? principal.email : '';
    return {
      template: 'ui/NotAuthorized',
      pageHtml: na.evaluate().getContent(),
      pageModel: { email: principal ? principal.email : '' }
    };
  }

  var page = String(requestedPage || '').trim();

  if (page === 'mgr/config') {
    if (Router_hasRole_(principal, 'manager')) {
      var cfg = HtmlService.createTemplateFromFile('ui/manager/Config');
      cfg.principal = principal;
      return {
        template: 'ui/manager/Config',
        pageHtml: cfg.evaluate().getContent(),
        pageModel: { principal: principal }
      };
    }
    // Non-manager hit a manager-only deep link — silently fall through to
    // their default page. (Real toast/redirect UX in Chunk 5.)
  }

  // Default: the Chunk-1-only Hello page. Replaced by real role-aware
  // dashboards in Chunk 5 (and Hello.html is deleted then).
  var hello = HtmlService.createTemplateFromFile('ui/Hello');
  hello.principal = principal;
  return {
    template: 'ui/Hello',
    pageHtml: hello.evaluate().getContent(),
    pageModel: { principal: principal }
  };
}

function Router_hasRole_(principal, type) {
  if (!principal || !principal.roles) return false;
  for (var i = 0; i < principal.roles.length; i++) {
    if (principal.roles[i].type === type) return true;
  }
  return false;
}
