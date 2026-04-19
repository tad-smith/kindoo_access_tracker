# Architecture

## 1. Goals

- One deployable artifact (a single bound Apps Script project).
- Everything stored in the backing Sheet — no external DB, no Script Properties except for rare low-level flags.
- Clear separation between data access (`repos/`), business logic (`services/`), and client-facing API (`api/`), so each layer is reviewable in isolation.
- Every write is serialised by `LockService` and audited to `AuditLog`.
- Cloudflare Worker is decoupled and added last.

### Scale targets (confirmed 2026-04-19)

12 wards, ~250 active seats, 1–2 manual/temp requests per week. This is low-traffic software: no server-side pagination, no polling/real-time updates, no batched writes, and no importer continuation-token scheme needed for v1. If any of these assumptions shift by >5×, revisit.

## 2. Decisions made here (not explicit in the spec)

| # | Decision | Why |
| --- | --- | --- |
| D1 | **Container-bound** Apps Script project (bound to the backing Sheet via Extensions → Apps Script). | Simpler deploy and permissions model; `SpreadsheetApp.getActiveSpreadsheet()` always returns the right sheet, no Script-Property plumbing. Trade-off: one sheet per deployment. |
| D2 | `webapp.executeAs = "USER_DEPLOYING"` and `webapp.access = "ANYONE_WITH_GOOGLE_ACCOUNT"`. | Users never need read access to the backing sheet (the deployer does). All users are on consumer Gmail, so `DOMAIN` access doesn't apply; `ANYONE_WITH_GOOGLE_ACCOUNT` gates the app at the Google login wall. Identity is established by GSI (D10), not `Session.getActiveUser().getEmail()` — the latter returns empty cross-customer. |
| D3 | UUIDs (`Utilities.getUuid()`) for `seat_id` and `request_id`. Human-readable slugs (e.g., `cordera-1st`) for `ward_id` and `building_id`. | UUIDs avoid race conditions on ID generation; slug IDs keep audit logs and cross-references readable. |
| D4 | Emails are normalised to a **canonical form** before compare/store/hash: lowercased, and — for `@gmail.com` / `@googlemail.com` only — with `.`s and `+suffix` stripped from the local part, and `googlemail.com` collapsed to `gmail.com`. Workspace addresses are preserved literally. | Gmail routes `alice.smith+foo@gmail.com` and `alicesmith@gmail.com` to the same inbox, and LCR / GSI sometimes disagree on which form they hand us. Without canonicalisation, role resolution and seat uniqueness silently drift. See [`open-questions.md` I-8](open-questions.md#i-8-resolved-2026-04-19-gmail-address-canonicalisation--apply-from-day-1) for the exact algorithm. |
| D5 | `source_row_hash` = SHA-256 of `scope|calling|canonical_email` (canonicalisation per D4). | Stable; identifies a specific auto-seat assignment across imports regardless of row order or incoming email variant. |
| D6 | All sheet reads go through a thin `Repo` layer that returns plain objects; callers never touch `Range`/`Values` directly. | Lets us swap out Sheet for another backend later; and keeps column-index knowledge in exactly one place. |
| D7 | A single `Setup.gs` function (`setupSheet`) creates/repairs all tabs and headers. Optionally exposed via `onOpen()` custom menu. | Removes human error from manual tab creation; safely re-runnable. |
| D8 | Dates stored as ISO date strings in `Requests.start_date`, `Seats.start_date`, etc.; timestamps stored as `Date` in `*_at` columns. | ISO dates sort lexically and are unambiguous across locales; `Date` on `*_at` lets Sheets show human-readable times. |
| D9 | Query routing via a single `?p=` query param; default page picked by highest-privilege role held by the user. | Keeps URLs short, makes deep links possible, preserves single-entry-point `doGet`. |
| D10 | **Google Sign-In (GSI) with server-side JWT verification** as the identity layer. Every `google.script.run` call passes the GSI-issued ID token; the server verifies it against Google's JWKS on each call and extracts the verified `email` claim. | Required because all users are on consumer Gmail (separate security realms), so `Session.getActiveUser().getEmail()` returns empty. JWT verification is pure local crypto after the JWKS is cached — one HTTP fetch every ~6 h. |

See [`open-questions.md`](open-questions.md) for decisions I'm not sure about.

## 3. Directory structure

```
src/
├── appsscript.json                # manifest (scopes, timezone, webapp config)
│
├── core/                          # cross-cutting infrastructure
│   ├── Main.gs                    # doGet / doPost entry points
│   ├── Router.gs                  # maps (role, page) → template
│   ├── Auth.gs                    # resolves signed-in email → roles
│   ├── Lock.gs                    # withLock(fn) helper
│   └── Utils.gs                   # date, hash, uuid, email-normalise helpers
│
├── repos/                         # one module per Sheet tab — pure data access
│   ├── ConfigRepo.gs
│   ├── KindooManagersRepo.gs
│   ├── BuildingsRepo.gs
│   ├── WardsRepo.gs
│   ├── TemplatesRepo.gs           # both WardCallingTemplate and StakeCallingTemplate
│   ├── AccessRepo.gs
│   ├── SeatsRepo.gs
│   ├── RequestsRepo.gs
│   └── AuditRepo.gs
│
├── services/                      # business logic; calls repos, wraps locks, writes audit
│   ├── Setup.gs                   # setupSheet(): idempotent tab/header creation
│   ├── Bootstrap.gs               # first-run wizard state machine
│   ├── Importer.gs                # weekly import from callings sheet
│   ├── Expiry.gs                  # daily temp-seat expiry
│   ├── RequestsService.gs         # submit / complete / reject / cancel
│   ├── EmailService.gs            # typed wrappers over MailApp.sendEmail
│   └── TriggersService.gs         # install/remove time-based triggers
│
├── api/                           # server-side entry points exposed to google.script.run
│   ├── ApiShared.gs               # whoami(), version, health
│   ├── ApiBishopric.gs
│   ├── ApiStake.gs
│   └── ApiManager.gs
│
└── ui/                            # HTML served via HtmlService
    ├── Layout.html                # shell: head, nav, role switcher, content slot
    ├── Nav.html                   # per-role navigation links
    ├── Styles.html                # shared CSS (<style>)
    ├── ClientUtils.html           # shared client JS (<script>) — rpc helper, toasts
    ├── NotAuthorized.html
    ├── BootstrapWizard.html
    ├── bishopric/
    │   ├── Roster.html
    │   ├── NewRequest.html
    │   └── MyRequests.html
    ├── stake/
    │   ├── Roster.html
    │   ├── NewRequest.html
    │   ├── MyRequests.html
    │   └── WardRosters.html
    └── manager/
        ├── Dashboard.html
        ├── RequestsQueue.html
        ├── AllSeats.html
        ├── Config.html
        ├── Access.html
        ├── Import.html
        └── AuditLog.html
```

**Note on Apps Script's flat namespace.** Apps Script concatenates all `.gs` files into one global scope at runtime; subdirectories under `src/` become folder prefixes in the Apps Script editor (e.g., `repos/SeatsRepo`) but don't isolate anything. Every exported function must have a unique, prefixed name — `Seats_getByScope`, not `getByScope`. Treat the repo modules like `namespace.module` identifiers.

## 4. Request lifecycle

Authentication is split between the client (handles GSI) and the server (verifies the resulting JWT on every call). `doGet` intentionally does *not* try to identify the user — it only renders the shell.

```mermaid
sequenceDiagram
    participant U as User
    participant C as Client (browser)
    participant G as Google Identity
    participant S as Server (Apps Script)

    U->>C: visit /exec (or kindoo.csnorth.org)
    C->>S: doGet(e)
    S-->>C: Layout.html (shell + gsi_client_id)
    C->>C: check sessionStorage for JWT
    alt no JWT / expired
      C->>G: GSI sign-in (One Tap or button)
      G-->>C: id_token (JWT, RS256-signed)
      C->>C: sessionStorage.jwt = id_token
    end
    C->>S: rpc('bootstrap', { jwt, requestedPage })
    S->>S: Auth.verifyIdToken(jwt)
    Note over S: verifies signature against cached JWKS,<br/>checks iss, aud, exp; extracts email
    S->>S: check Config.setup_complete; Auth.resolveRoles(email)
    S-->>C: { principal, pageModel }
    C->>C: render Nav + page
    U->>C: navigate / click
    C->>S: rpc('<endpoint>', { jwt, args })
    S->>S: verifyIdToken + requireRole
    S-->>C: result
```

### Step-by-step

1. **`Main.doGet(e)`** returns `Layout.html`. The template is rendered with `gsi_client_id` (read from `Config.gsi_client_id`) injected into the `<head>` so the GSI script has what it needs. No user-identification happens here.
2. **Client checks `sessionStorage.jwt`.** If present and not expired (decoded JWT's `exp`), reuse. Otherwise show the GSI button on `Login.html` (or trigger One Tap) and store the resulting `id_token`.
3. **Client calls `rpc('bootstrap', { jwt, requestedPage })`.** This is the first authenticated call. Server-side:
   1. `Auth.verifyIdToken(jwt)` — retrieves Google's JWKS from `CacheService` (falls back to `UrlFetchApp.fetch('https://www.googleapis.com/oauth2/v3/certs')` with a ~6 h cache), finds the key matching the JWT's `kid`, verifies the RS256 signature, checks `iss ∈ {"accounts.google.com", "https://accounts.google.com"}`, `aud === Config.gsi_client_id`, and `exp > now`. Rejects otherwise.
   2. Read `Config.setup_complete`. If false and verified email matches `bootstrap_admin_email`, render `BootstrapWizard`; otherwise render "setup in progress".
   3. `Auth.resolveRoles(email)` returns `{ email, roles[] }`. No roles → `NotAuthorized`.
   4. `Router.pick(requestedPage, principal)` returns `{ template, model }`; role restrictions enforced here.
   5. Server returns `{ principal, pageModel, pageHtml }` to the client.
4. **Client renders.** `Nav.html` is emitted with role-aware links; the page template's model is hydrated in place.
5. **Subsequent calls** pass `{ jwt, ...args }` and re-verify. JWT verification is local crypto after the first JWKS fetch, so re-verification is cheap.

### Failure modes

| Failure | Client behaviour | Server behaviour |
| --- | --- | --- |
| JWT expired (exp in the past) | Clear `sessionStorage.jwt`; re-show GSI. | `Auth.verifyIdToken` throws `AuthExpired`. |
| JWT signature invalid | Clear JWT; show "something went wrong — please sign in again". | Throws `AuthInvalid`. Logged. |
| `aud` mismatch (wrong client_id) | Same as above. | Throws `AuthInvalid`; logged with aud/expected for debugging. |
| User has no roles | Show `NotAuthorized` explaining bishopric-import-lag possibility. | `principal.roles.length === 0`. |
| Client_id missing in Config | Block the page with an ops-facing error — only happens pre-bootstrap. | `Auth.verifyIdToken` throws `AuthNotConfigured`. |

## 5. Auth & role resolution

### Inputs

- A **GSI ID token (JWT)** presented by the client with every request. Source of truth for identity.
- `KindooManagers` rows with `active = true` — the manager set.
- `Access` rows — the bishopric and stake-presidency set.

(`Session.getActiveUser().getEmail()` is *not* used — it returns empty for consumer Gmail users when the script runs as the deployer.)

### JWT verification — `Auth.verifyIdToken(jwt)`

1. Decode the JWT header without verifying to extract `kid`.
2. Load Google's signing keys from `CacheService.getScriptCache()` under key `gsi_jwks`. If absent or expired (6 h TTL), `UrlFetchApp.fetch('https://www.googleapis.com/oauth2/v3/certs')` and repopulate.
3. Find the JWK whose `kid` matches the header; convert `n`/`e` to an RSA public key; verify the JWT's RS256 signature using `Utilities.computeRsaSha256Signature` or a tiny hand-rolled verifier.
4. Check claims:
   - `iss` ∈ `{"accounts.google.com", "https://accounts.google.com"}`
   - `aud === Config.gsi_client_id`
   - `exp > now` (with a small leeway, e.g., 30 s for clock skew)
   - `email_verified === true`
5. Return `{ email: claims.email.toLowerCase(), name: claims.name, picture: claims.picture }`. On any failure, throw a typed error — the caller does not distinguish between `AuthInvalid` / `AuthExpired` for security (both surface to the client as "please sign in again").

**Cache strategy:** JWKS under `CacheService` for 6 h (Google rotates daily but publishes early). The verified-claims result is **not** cached — every incoming JWT is re-checked. That's cheap: one RSA verify per call, no network. If the call rate ever gets loud, we can cache `jwt → claims` briefly keyed by a hash of the JWT.

### Output — a `Principal` object

```
{
  email: "jane@csnorth.org",
  roles: [
    { type: "manager" },
    { type: "stake" },
    { type: "bishopric", wardId: "cordera-1st" }
  ]
}
```

Multi-role is possible (one person can be a Kindoo Manager AND a bishopric counsellor AND in the stake presidency — rare but real; spec requires UI to show the union).

### Enforcement

- `Auth.principalFrom(jwt)` — verifies the token (see above), resolves roles, returns a `Principal`. Every `api/` function calls this before doing work.
- `Auth.requireRole(principal, roleMatcher)` — throws on mismatch.
- `Auth.requireWardScope(principal, wardId)` — throws if the user is not a bishopric for that ward and not a manager/stake. Used to prevent cross-ward data access.
- The client's `rpc(name, args)` helper automatically injects `sessionStorage.jwt` as the first argument, so call sites don't repeat it.

### Bishopric lag

Accepted per spec. A newly-called bishopric member cannot sign in until the next weekly import (or a manual "Import Now" run). `NotAuthorized` mentions this as a possible cause.

### Two identities — Apps Script execution vs. actor

With `executeAs: USER_DEPLOYING`, every Sheet write happens under the **deployer's** Google identity. That's what shows up in the Sheet's file-level revision history, and that's what `Session.getEffectiveUser().getEmail()` returns. That identity is **infrastructure** — it represents "the app", not the person who caused the change.

The **actor** on any change is whoever initiated it: the signed-in user whose GSI JWT we just verified, or the literal string `"Importer"` / `"ExpiryTrigger"` for automated runs. That's what we write to `AuditLog.actor_email`.

This distinction is deliberate and needs to be understood before debugging history:

- **Sheet revision history shows the deployer for every row** — this is correct and uninteresting. Don't use it to figure out who did what.
- **`AuditLog` is the authoritative record** of authorship. `actor_email` is truth; the Apps Script execution identity is plumbing.
- **We never read `Session.getActiveUser()` or `Session.getEffectiveUser()` for authorship** — the only source is the verified JWT.

Consequence for services: `AuditRepo.write({actor_email, ...})` requires the caller to pass the actor — there is no "pick it up from the environment" convenience fallback, because doing so would silently record the deployer.

## 6. LockService strategy

One helper, `Lock.withLock(fn, opts?)`:

```
function Lock_withLock(fn, opts) {
  opts = opts || {};
  var lock = LockService.getScriptLock();
  var timeout = opts.timeoutMs || 10000; // 10s default
  if (!lock.tryLock(timeout)) {
    throw new Error("Another change is in progress — please retry in a moment.");
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}
```

### Rules

- **Every** service function that writes to any tab wraps its work in `Lock_withLock`. No exceptions.
- Importer and Expiry wrap their full run (they're long — up to a few minutes — so we raise `timeoutMs` to, e.g., 30s of waiting). They also write a `start`/`end` row to `AuditLog` to bracket the run.
- Read paths do **not** take the lock. Sheet reads are snapshot-consistent enough for this workload, and locking reads would serialise the entire app.
- Within a single request, we acquire the lock once at the top of the write path and release at the end. Nested calls are avoided.

### Why script lock, not document lock

Script lock is per-script-instance and covers any user invocation, including triggers. Document lock covers the sheet only from the script's perspective but isn't stronger for our purposes, and script lock also serialises import-with-expiry concurrency.

## 7. Data access layer

One file per tab under `repos/`. Each exports pure functions that return plain JS objects (snake_case keys matching header names). No file talks to `SpreadsheetApp` except through a repo. A tiny shared `Sheet_getTab(name)` helper caches `getSheetByName` lookups within a single request.

### Patterns used across repos

- `Xxx_getAll()` — returns every row as an array of objects.
- `Xxx_getById(id)` / `Xxx_getByScope(scope)` — filtered reads.
- `Xxx_insert(obj)` / `Xxx_update(id, patch)` / `Xxx_delete(id)` — writes. All writes must be called from a `Lock_withLock` context. Each emits a corresponding `AuditRepo.write(...)` call **inside the same lock** so the log is always consistent with the data.
- Columns are defined once per repo as a `const COLUMNS = ['seat_id', 'scope', ...]` tuple. `setupSheet` reads these to build the headers. If a header mismatch is detected on any read, the repo throws with a loud error — prevents subtle column-drift bugs.

### Why not one monolithic `SheetService`

Tried it mentally — every function ends up switch-casing on tab name. Per-tab repos co-locate column knowledge and validation with the thing being validated. Testable by swapping the repo module.

## 8. HTML & page routing

- **Entry point**: `doGet(e)` returns an `HtmlOutput` built from `Layout.html` via `HtmlService.createTemplateFromFile('ui/Layout')`.
- **Includes**: a global `include(path)` helper returns `HtmlService.createHtmlOutputFromFile(path).getContent()` so templates can compose each other via `<?!= include('ui/Styles') ?>`.
- **Model injection**: the template's `evaluate()` is preceded by assigning properties on the template object (`t.principal = ...; t.model = ...`). Client code reads initial state from a `<script>var __init = <?= JSON.stringify(model) ?>;</script>` block at the bottom of the layout.
- **Client RPC**: `ClientUtils.html` wraps `google.script.run` into a `rpc(name, args)` that returns a Promise, with a toast/error UI on failure. All client-side calls go through it.
- **Role-based menus**: `Nav.html` is rendered with the current principal; it emits only the links the user's roles allow.
- **Deep links**: query-string `?p=<page-id>`. Deep links survive the Cloudflare Worker proxy as long as the worker preserves query strings.

### Page ID map

| `?p=` | Template | Allowed roles |
| --- | --- | --- |
| *(empty)* | role default (manager → dashboard, stake → stake/Roster, bishopric → bishopric/Roster) | any |
| `roster` | role default roster page | bishopric / stake |
| `new` | `ui/{role}/NewRequest` | bishopric / stake |
| `my` | `ui/{role}/MyRequests` | bishopric / stake |
| `ward-rosters` | `ui/stake/WardRosters` | stake, manager |
| `mgr/dashboard` | `ui/manager/Dashboard` | manager |
| `mgr/queue` | `ui/manager/RequestsQueue` | manager |
| `mgr/seats` | `ui/manager/AllSeats` | manager |
| `mgr/config` | `ui/manager/Config` | manager |
| `mgr/access` | `ui/manager/Access` | manager |
| `mgr/import` | `ui/manager/Import` | manager |
| `mgr/audit` | `ui/manager/AuditLog` | manager |

A user who hits a `p=` they can't access is redirected to their default page (not 403'd), with a toast explaining why.

## 9. Importer & Expiry triggers

### Importer

- Reads `Config.callings_sheet_id`, opens via `SpreadsheetApp.openById`.
- Loops sheets; matches tab name against `Wards.ward_code` or `"Stake"`. Other tabs skipped.
- Per tab, parses rows per the spec (prefix-strip, multi-email columns), builds `(calling, email)` pairs.
- Fetches current `Seats` (auto-only) and `Access` for that scope *once*, builds diffable sets keyed on `source_row_hash` and `(email, calling)`.
- Emits inserts, deletes, and AuditLog rows in a single write phase inside one lock acquisition.
- Writes `Config.last_import_at` and a summary string.
- Emits an over-cap email if any ward's or stake's final seat count > its cap.

### Expiry

- Runs daily at 03:00 local time (configurable, stored in `Config.expiry_hour`).
- Scans `Seats` for rows with `type=temp` and `end_date < today` (midnight, local time zone from `appsscript.json`).
- Deletes rows inside one lock; writes per-row AuditLog entries with action `auto_expire` and `before_json` preserving the row.

### Trigger management

`TriggersService.install()` idempotently creates both triggers if absent. Invoked from the bootstrap wizard's last step and from a manager-only "Reinstall triggers" button on the Configuration page, so operators can self-heal.

## 10. Bootstrap flow

1. `setupSheet()` (run once in the Apps Script editor, or via a custom menu added by `onOpen()`): creates every tab, writes headers, seeds empty `Config` rows for well-known keys, and a `setup_complete=FALSE` flag.
2. The Kindoo Manager sets `Config.bootstrap_admin_email` manually in the sheet, then deploys.
3. On first visit, `Main.doGet` sees `setup_complete=FALSE`; if the signed-in email matches `bootstrap_admin_email`, it renders the wizard. Everyone else gets a "setup in progress" page.
4. Wizard steps (single page, multi-step):
   1. Stake name + callings-sheet ID + stake seat cap.
   2. At least one Building.
   3. At least one Ward.
   4. Additional Kindoo Managers (optional — admin is already one).
5. On submit, writes the collected rows inside one lock, installs triggers, sets `setup_complete=TRUE`, redirects to the manager dashboard.

## 11. Cloudflare Worker

Final chunk. The Apps Script web app URL is `https://script.google.com/a/macros/<DOMAIN>/s/<SCRIPT_ID>/exec` (or the personal variant). A Worker bound to `kindoo.csnorth.org/*` does:

```js
export default {
  async fetch(request) {
    const src = new URL(request.url);
    const target = new URL('https://script.google.com/macros/s/<SCRIPT_ID>/exec');
    target.search = src.search; // preserve query string
    const proxied = new Request(target.toString(), request);
    return fetch(proxied, { redirect: 'follow' });
  }
}
```

**Known risk** (flagged in open-questions.md): Apps Script web apps perform OAuth redirects through `accounts.google.com` and expect to land back on the `script.google.com` URL. A transparent proxy may break the round trip. If we hit that, Chunk 11 likely pivots to just CNAME + a Cloudflare Redirect Rule (302) to the `/exec` URL — we lose the pretty URL in the address bar after the first hop, but auth still works.

## 12. What lives where, quick reference

| Concern | File |
| --- | --- |
| HTTP entry point | `core/Main.gs` |
| Decides what page to render | `core/Router.gs` |
| Verifies GSI JWTs; resolves roles | `core/Auth.gs` |
| JWKS fetch/cache helper | `core/Auth.gs` (private) |
| Guards against concurrent writes | `core/Lock.gs` |
| Reads/writes one Sheet tab | `repos/XxxRepo.gs` |
| Orchestrates a business workflow | `services/Xxx.gs` |
| Exposed to client via `google.script.run` | `api/ApiXxx.gs` (each endpoint takes `jwt` as first arg) |
| Rendered to the user | `ui/**.html` |
| GSI button + token capture | `ui/Login.html` + `ui/ClientUtils.html#rpc` |
