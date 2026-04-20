// Router_pick(requestedPage, principal) → { template, pageHtml, pageModel }
//
// Chunk 1 only routes to Hello (or NotAuthorized when the principal has zero
// roles). The full page map (architecture.md §8) lands in Chunk 5+.

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
  var hello = HtmlService.createTemplateFromFile('ui/Hello');
  hello.principal = principal;
  return {
    template: 'ui/Hello',
    pageHtml: hello.evaluate().getContent(),
    pageModel: { principal: principal }
  };
}
