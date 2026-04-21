// Router_pick(requestedPage, principal) → { template, pageHtml, pageModel }
//
// Page-id map mirrors architecture.md §8. Pages not yet implemented fall
// through to the role's default page (Hello in Chunks 1–4; the real
// dashboards land in Chunks 5+).
//
// Implemented so far:
//   - mgr/config → ui/manager/Config (manager only) — Chunk 2
//   - mgr/import → ui/manager/Import (manager only) — Chunk 3
//   - mgr/access → ui/manager/Access (manager only) — Chunk 3
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

  var managerPages = {
    'mgr/config': 'ui/manager/Config',
    'mgr/import': 'ui/manager/Import',
    'mgr/access': 'ui/manager/Access'
  };

  if (managerPages[page]) {
    if (Router_hasRole_(principal, 'manager')) {
      var tpl = HtmlService.createTemplateFromFile(managerPages[page]);
      tpl.principal = principal;
      return {
        template: managerPages[page],
        pageHtml: tpl.evaluate().getContent(),
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
