// Router_pick(requestedPage, principal) → { template, pageHtml, pageModel, navHtml }
//
// Page-id map (architecture.md §8):
//
//   bishopric/roster     → ui/bishopric/Roster           (bishopric)
//   stake/roster         → ui/stake/Roster               (stake)
//   stake/ward-rosters   → ui/stake/WardRosters          (stake)
//   new                  → ui/NewRequest                 (bishopric OR stake)
//   my                   → ui/MyRequests                 (bishopric OR stake)
//   mgr/dashboard        → ui/manager/Dashboard          (manager) — Chunk 10
//   mgr/seats            → ui/manager/AllSeats           (manager)
//   mgr/queue            → ui/manager/RequestsQueue      (manager)
//   mgr/config           → ui/manager/Config             (manager)
//   mgr/access           → ui/manager/Access             (manager)
//   mgr/import           → ui/manager/Import             (manager)
//   mgr/audit            → ui/manager/AuditLog           (manager) — Chunk 10
//
// Chunk 6 introduces the first pages that accept MORE THAN ONE role
// (`new` and `my` are open to any request-capable role — bishopric or
// stake). The page map holds a `roles:` array for these; single-role
// pages keep using the simpler `role:` string field. See
// Router_hasAllowedRole_ for the matching logic.
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
  // Chunk 6: shared request pages — either bishopric OR stake is enough.
  'new':                { template: 'ui/NewRequest',         roles: ['bishopric', 'stake'] },
  'my':                 { template: 'ui/MyRequests',         roles: ['bishopric', 'stake'] },
  'mgr/dashboard':      { template: 'ui/manager/Dashboard',  role: 'manager' },
  'mgr/seats':          { template: 'ui/manager/AllSeats',   role: 'manager' },
  'mgr/queue':          { template: 'ui/manager/RequestsQueue', role: 'manager' },
  'mgr/config':         { template: 'ui/manager/Config',     role: 'manager' },
  'mgr/access':         { template: 'ui/manager/Access',     role: 'manager' },
  'mgr/import':         { template: 'ui/manager/Import',     role: 'manager' },
  'mgr/audit':          { template: 'ui/manager/AuditLog',   role: 'manager' }
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
  if (!entry || !Router_hasAllowedRole_(principal, entry)) {
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
// Chunk 10 landed the manager Dashboard and swapped the default here from
// 'mgr/seats' to 'mgr/dashboard'. The post-bootstrap redirect
// (ApiBootstrap_complete → Config.main_url) naturally lands the admin on
// the Dashboard through this default.
function Router_defaultPageFor_(principal) {
  if (Router_hasRole_(principal, 'manager'))   return 'mgr/dashboard';
  if (Router_hasRole_(principal, 'stake'))     return 'stake/roster';
  if (Router_hasRole_(principal, 'bishopric')) return 'bishopric/roster';
  return 'mgr/dashboard'; // unreachable — no-roles branch above short-circuits first
}

function Router_hasRole_(principal, type) {
  if (!principal || !principal.roles) return false;
  for (var i = 0; i < principal.roles.length; i++) {
    if (principal.roles[i].type === type) return true;
  }
  return false;
}

// Page-entry access check — supports both the single-role shape
// (entry.role = 'manager') and the multi-role shape added in Chunk 6
// (entry.roles = ['bishopric', 'stake'], holding ANY one suffices).
function Router_hasAllowedRole_(principal, entry) {
  if (!entry) return false;
  if (entry.role) return Router_hasRole_(principal, entry.role);
  if (entry.roles) {
    for (var i = 0; i < entry.roles.length; i++) {
      if (Router_hasRole_(principal, entry.roles[i])) return true;
    }
  }
  return false;
}
