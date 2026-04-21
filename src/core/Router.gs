// Router_pick(requestedPage, principal) → { template, pageHtml, pageModel, navHtml }
//
// Page-id map (architecture.md §8):
//
//   bishopric/roster     → ui/bishopric/Roster           (bishopric)
//   stake/roster         → ui/stake/Roster               (stake)
//   stake/ward-rosters   → ui/stake/WardRosters          (stake)
//   mgr/seats            → ui/manager/AllSeats           (manager)
//   mgr/config           → ui/manager/Config             (manager)
//   mgr/access           → ui/manager/Access             (manager)
//   mgr/import           → ui/manager/Import             (manager)
//
// Unrecognised or forbidden ?p= falls through to the role's default page.
// Default-page priority for multi-role principals: manager > stake >
// bishopric. This means the bootstrap admin (auto-added as a manager in
// Chunk 4) lands on mgr/seats after completing the wizard — which is the
// pre-Chunk-10 replacement for the manager Dashboard (mgr/dashboard lands
// with Chunk 10 and becomes the manager default at that point).
//
// Also returns navHtml (rendered from ui/Nav) — populated only for
// principals that hold at least one role. Login / NotAuthorized /
// BootstrapWizard / SetupInProgress callers never hit Router_pick, so
// they do not get a nav either.

const ROUTER_PAGES_ = {
  'bishopric/roster':   { template: 'ui/bishopric/Roster',   role: 'bishopric' },
  'stake/roster':       { template: 'ui/stake/Roster',       role: 'stake' },
  'stake/ward-rosters': { template: 'ui/stake/WardRosters',  role: 'stake' },
  'mgr/seats':          { template: 'ui/manager/AllSeats',   role: 'manager' },
  'mgr/config':         { template: 'ui/manager/Config',     role: 'manager' },
  'mgr/access':         { template: 'ui/manager/Access',     role: 'manager' },
  'mgr/import':         { template: 'ui/manager/Import',     role: 'manager' }
};

function Router_pick(requestedPage, principal) {
  if (!principal || !principal.roles || principal.roles.length === 0) {
    var na = HtmlService.createTemplateFromFile('ui/NotAuthorized');
    na.email = principal ? principal.email : '';
    return {
      template: 'ui/NotAuthorized',
      pageHtml: na.evaluate().getContent(),
      pageModel: { email: principal ? principal.email : '' },
      navHtml:   ''
    };
  }

  var defaultPage = Router_defaultPageFor_(principal);
  var page        = String(requestedPage || '').trim();
  var entry       = ROUTER_PAGES_[page];

  // Unknown ?p=, or ?p= that the user can't access → land on their
  // default. (The spec's "redirect with toast" UX lands in Chunk 10's
  // polish pass; for now the silent fall-back matches Chunks 2–4.)
  if (!entry || !Router_hasRole_(principal, entry.role)) {
    page  = defaultPage;
    entry = ROUTER_PAGES_[defaultPage];
  }

  var pageTpl = HtmlService.createTemplateFromFile(entry.template);
  pageTpl.principal     = principal;
  pageTpl.requested_page = page;

  var navTpl = HtmlService.createTemplateFromFile('ui/Nav');
  navTpl.principal     = principal;
  navTpl.current_page  = page;

  return {
    template:  entry.template,
    pageHtml:  pageTpl.evaluate().getContent(),
    pageModel: { principal: principal, current_page: page },
    navHtml:   navTpl.evaluate().getContent()
  };
}

// Priority: manager > stake > bishopric. A user who holds multiple roles
// gets the most-privileged role's default landing, on the theory that if
// they're a Kindoo Manager they almost certainly came to the app for
// manager work. Nav shows the union of links so the other roles are still
// one click away.
//
// Chunk-10 note: when mgr/dashboard lands, swap the manager default to
// 'mgr/dashboard' here — that's the spec's manager landing. Until then
// mgr/seats is the single most-useful manager page for a first landing
// (per build-plan Chunk 5 "Out of scope" + the Chunk-5 prompt).
function Router_defaultPageFor_(principal) {
  if (Router_hasRole_(principal, 'manager'))   return 'mgr/seats';
  if (Router_hasRole_(principal, 'stake'))     return 'stake/roster';
  if (Router_hasRole_(principal, 'bishopric')) return 'bishopric/roster';
  return 'mgr/seats'; // unreachable — no-roles branch above short-circuits first
}

function Router_hasRole_(principal, type) {
  if (!principal || !principal.roles) return false;
  for (var i = 0; i < principal.roles.length; i++) {
    if (principal.roles[i].type === type) return true;
  }
  return false;
}
