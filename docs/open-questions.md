# Open questions

Things in the spec that are ambiguous, underspecified, or likely to bite us during implementation. Ordered by severity. Each entry lists: the uncertainty, why it matters, and my best-guess answer so we can proceed if we have to.

Tagged `[P0]` = would block or need to reopen a decision inside Chunk 1–3; `[P1]` = answerable during the relevant chunk; `[P2]` = low-risk, answerable at build time.

---

## Auth and identity

### A-1 `[RESOLVED 2026-04-19]` Users sign in with consumer Gmail accounts, not a shared Workspace domain.

Confirmed by the project owner. Downstream consequences:

- `Session.getActiveUser().getEmail()` can't be used — it returns empty cross-customer. It has been removed from the auth plan.
- Auth pivots to **Google Sign-In (GSI) with server-side JWT verification**. See architecture.md D10 and §§4–5.
- `webapp.access` is `ANYONE_WITH_GOOGLE_ACCOUNT` (D2 updated).
- A one-time OAuth 2.0 Client ID setup in Google Cloud Console is added to the deployment steps (sheet-setup.md).
- `Config.gsi_client_id` is a new required key; seeded manually before first deploy.
- Chunk 1 scope grows to include: `Login.html`, `verifyIdToken` with JWKS caching, token-plumbing through `rpc`, and every `api/` endpoint taking the JWT as its first argument.

New open questions created by the GSI pivot are tracked as A-3, A-4, A-5 below.

### A-3 `[P1]` Token lifetime and re-login UX

GSI ID tokens are valid for 1 hour. Our plan stores the JWT in `sessionStorage`; when it expires mid-session, the next `rpc` call will fail and the client will prompt re-login.

**Best guess:** Acceptable. This is internal, weekly-use software — a re-login prompt once per session is fine. If it becomes annoying, we can move to the full GSI OAuth flow with a refresh token, or use the JavaScript library's silent token refresh.

### A-4 `[P1]` `aud` verification with a Config-held client_id

Verification requires `aud === Config.gsi_client_id`. If a manager edits that key mid-session, everyone's tokens are rejected until they re-sign-in. Not a bug — just behaviour to document for the Configuration page.

**Best guess:** Add an inline warning on the Config page next to `gsi_client_id`: "Changing this value will log out every user." Soft-UX guard, no code-level lock needed.

### A-5 `[P1]` GSI on a Cloudflare-Workered custom domain

The Google OAuth Client ID needs the exact origin allowlisted. If we proxy through `kindoo.csnorth.org`, that's the origin GSI sees — even though the server hop ends at `script.google.com`. The Client ID must therefore list:

- `https://kindoo.csnorth.org` (the user-visible origin)
- `https://script.google.com` (the Apps Script execution domain)

And any intermediate redirect URIs if we ever move beyond the popup/One-Tap flow.

**Best guess:** Straightforward; add to the Cloudflare Worker runbook in Chunk 11. The interaction with the OAuth-redirect concern in CF-1 is independent — GSI is popup/JS-based and doesn't use the server-side OAuth redirect that Apps Script's "Sign in to run this" uses.

### A-2 `[P1]` What email address sends the notifications?

`MailApp.sendEmail()` always sends from the effective user — which, with `executeAs: USER_DEPLOYING`, is the deployer. Replies go back to the deployer's inbox.

**Best guess:** Acceptable; deployer is a Kindoo Manager and will forward or triage replies.

**If wrong:** We'd need to add a shared mailbox or use `GmailApp` with delegation, which changes the OAuth scope surface.

### A-6 `[RESOLVED 2026-04-19]` Personal Email column = user's Gmail sign-in address

Confirmed. The `Personal Email` column in the callings sheet is the Gmail the person actually signs in with. The importer writes it (lowercased) into `Access`; role resolution matches the GSI-verified email claim against that same value. One possible wrinkle noted in I-8 below.

### A-7 `[RESOLVED 2026-04-19]` OAuth consent screen publishing status

**Publish the app** (not Testing). The `openid`/`email`/`profile` scopes don't require Google verification, so publication is immediate. Test-users list is irrelevant and removed from the deployment checklist.

---

## Importer

### I-1 `[RESOLVED 2026-04-19]` Importer atomicity on partial failure — agreed

Approach confirmed: build the full per-tab diff in memory before applying anything. If parse fails for a tab, skip that tab's mutations and emit an `import_error` audit row with actor `Importer`. Lock is acquired once and covers all applies. Other tabs in the same run proceed.

### I-2 `[P1]` Missing tab in the callings sheet

If a ward in `Wards` has a `ward_code` that doesn't correspond to any tab in the callings spreadsheet, do we delete every auto-seat for that ward (since we "didn't see" any rows) or skip the ward?

**Best guess:** Skip and log a per-ward warning audit row. Deleting all auto-seats when someone simply renamed a tab would be catastrophic.

### I-3 `[P1]` Multi-person callings: multiple rows vs. extra email columns

Spec says multi-person callings use extra columns to the right of `Personal Email`. But what if the source sheet instead has multiple rows with the same `Position`? (e.g., "CO Elders Quorum Counselor" on two separate rows.)

**Best guess:** Treat both representations identically — union all `(calling, email)` pairs from all rows. No harm in being permissive.

### I-4 `[RESOLVED 2026-04-19]` `Organization` and `Forwarding Email` columns

Confirmed — **`Forwarding Email` is used for other (non-Kindoo) purposes and we never read it in this app.** `Organization` likewise ignored. Importer reads `Personal Email` + rightward cells only.

### I-5 `[P1]` Prefix mismatches

A row in the `CO` tab whose `Position` starts with `ST ` (wrong prefix) — skip it, warn, or error?

**Best guess:** Skip with a warning audit row. The import loops by tab, and a mis-prefixed row is almost certainly a human typo, not a legitimate assignment.

### I-6 `[P1]` Row-with-no-matching-template

A `(calling, email)` pair where `calling` isn't in the template — spec says filter out. Confirmed.

### I-7 `[P2]` Empty rows at the bottom of the callings sheet

The callings sheet may have trailing blank rows. Need a "stop at first blank" heuristic vs. iterating to the last filled row.

**Best guess:** Iterate to `getLastRow()` and skip any row with a blank `Position`. Trivial.

### I-8 `[RESOLVED 2026-04-19]` Gmail address canonicalisation — apply from day 1

Confirmed to be a real problem in the LCR data. **Ship v1 with Gmail canonicalisation baked in, not as a reactive fix.**

**Rule** — `Utils.normaliseEmail(email)`:

1. Trim; lowercase; if no `@`, return as-is.
2. Split into `local@domain`.
3. If `domain ∈ {"gmail.com", "googlemail.com"}`:
   - Strip everything from the first `+` onward in `local`.
   - Remove every `.` from `local`.
   - Force `domain = "gmail.com"` (canonicalise the googlemail alias).
4. Return `local + "@" + domain`.

**Applies to every email column**: `KindooManagers.email`, `Access.email`, `Seats.person_email`, `Requests.target_email`/`requester_email`/`completer_email`, `AuditLog.actor_email`, `Config.bootstrap_admin_email`, and the `email` claim extracted from GSI JWTs. Canonical form is what we **store and compare**; there's no separate display-form column (D4 updated).

**Workspace addresses** are preserved literally — dots there are significant and the rule only fires for `@gmail.com` / `@googlemail.com`.

**Source-row hash** (`SHA-256(scope|calling|email)`) uses the canonical email. Since no production data exists yet, no migration is needed.

---

## Request lifecycle

### R-1 `[P1]` Race: complete a `remove` when the seat is already gone

Two managers, or a temp-seat expiry trigger, could delete the seat between the bishopric submitting `remove` and a manager completing it.

**Best guess:** If the seat is already gone at completion time, auto-complete the request with a `reason`-suffixed note ("seat no longer present — nothing to do") rather than erroring. Requester email should still go out.

### R-2 `[P1]` Race: complete `add_manual` when the target already has a manual seat

Between submission and completion, another manager might complete a duplicate request. When the second request is completed, should we insert a second `Seats` row, merge, or reject?

**Best guess:** At completion time, if an active seat already exists for `(scope, target_email)`, flip the request to `complete` but skip the `Seats` insert, and note "already present — request closed without change" in an audit row. Emailing the requester that it's "done" is truthful.

### R-3 `[P1]` Can you request a `remove` against an `auto` seat?

The spec hides the X button for auto rows, so the UI path is closed. But a determined user could craft an API call.

**Best guess:** Server-side reject — only manual/temp seats are removable via request. Auto seats update via LCR.

### R-4 `[P1]` Requester-scoped "My Requests"

Is "My Requests" only the requests *you* submitted, or all pending requests for your ward?

**Best guess:** Strictly what you submitted. A bishopric counsellor's page shows their own requests, not the bishop's.

### R-5 `[P1]` `building_ids` on a new request

Requester form has a `comment` field for multi-building notes; `building_ids` is set to the ward default on insert. Managers adjust after the fact via inline edit on the All Seats page. Confirm this is the intended flow.

**Best guess:** Yes, exactly that. The bishopric form intentionally doesn't expose a building picker (per the spec's out-of-scope list).

### R-6 `[RESOLVED 2026-04-19]` Manager self-approval

A Kindoo Manager who is also a bishopric member (or in the stake presidency) may complete/reject requests they themselves submitted. No code guard required; the requests queue treats every active manager equally.

---

## Temp seats

### T-1 `[P1]` Future-dated temp seats

Can `start_date > today`? If so, does the seat count against the cap before its start date?

**Best guess:** Allow future start dates; count them against the cap from the moment they exist, since Kindoo needs the provisioning now.

### T-2 `[P1]` Same-day expiry semantics

Spec says delete when `end_date < today`. So a seat with `end_date = today` is still alive on its end date and disappears the following morning. Confirm with stakeholders so the UX text is right.

---

## Roles

### AR-1 `[P1]` Manager who is also a bishopric member

A Kindoo Manager appointed from within a ward's bishopric holds both roles. The spec says "UI shows the union". Should the manager-tab role-switcher offer "view as bishopric of ward X" mode, or is the nav-union enough?

**Best guess:** Nav-union is enough for v1. No "view as" switcher.

### AR-2 `[P1]` Access row with `give_app_access=true` but no matching active `Seats` row

Importer upserts `Access` independently of `Seats`. In practice these should align, but a template change (flipping `give_app_access` on) would create an `Access` row even if the `Seats` row was manually deleted.

**Best guess:** Importer owns both; the next run reconciles. Don't try to enforce pairing in code.

---

## Concurrency and runtime limits

### C-1 `[RESOLVED 2026-04-19]` Weekly import execution time

Target scale confirmed: 12 wards, ~250 seats, 1–2 manual changes/week. Well inside the 6-minute budget — no batching or continuation-token scheme needed for v1.

### C-2 `[P1]` Lock timeouts during import

Import holds the script lock for its full run. User-initiated writes during that window will time out (10 s default). UX: the error toast should say "sync in progress, retry in a minute".

**Best guess:** Tolerable. Imports are rare and short.

### C-3 `[P2]` MailApp quota

100 emails/day for consumer, 1500 for Workspace. Not a risk for this workload.

---

## Over-cap

### OC-1 `[P1]` Email frequency on persistent over-cap

Spec implies an email after every import. If a ward sits over cap for weeks, that's a weekly email.

**Best guess:** Email only when the over-cap *state* changes (newly over, or newly resolved). Keep the dashboard warning always visible.

### OC-2 `[P1]` Zero active managers

If `KindooManagers` has no `active=true` rows, over-cap emails silently go nowhere. Add a loud AuditLog entry as a backstop.

---

## Cloudflare Worker

### CF-1 `[P0]` OAuth redirect through the Worker

Apps Script web apps redirect through `accounts.google.com` and expect to land back on `script.google.com/.../exec`. Transparent proxy (as in our planned Worker) may cause the round trip to break, landing the user on the `script.google.com` URL instead of `kindoo.csnorth.org`. Numerous reports of this happening on Stack Overflow.

**Best guess:** Try the full-proxy approach first. If broken, fall back to a Redirect Rule (302) — the address bar shows `script.google.com` after the first hop, but auth works. Alternative: wait for OAuth sign-in completes and then server-side rewrite redirects — complex and fragile.

### CF-2 `[P2]` Deep-link preservation

Worker must forward query strings. Trivial — covered in the Worker code sketched in architecture.md.

---

## Sheet drift

### SD-1 `[P2]` Human edits to the Sheet

Nothing prevents a human from editing `Seats` directly, bypassing lock and audit. Accepted per the spec's "sheet is source of truth" model.

### SD-2 `[P2]` Header drift

If a header gets renamed manually, repos will throw loud errors on next read. `setupSheet()` can repair, but only if we detect the rename — we can't. Treat as "open the sheet and fix by hand".

---

## Decisions I made to keep moving

These aren't ambiguities — I made a choice. Flagging here in case you disagree.

- **D1 (architecture.md) Container-bound script.** Simpler than standalone; one sheet per deployment. If a test/prod separation is wanted, we'd flip this to standalone with a `callings_sheet_id`-style `app_sheet_id` config key.
- **D2** `executeAs: USER_DEPLOYING`, `access: ANYONE_WITH_GOOGLE_ACCOUNT` — updated 2026-04-19 after A-1 resolved. Identity is handled by GSI (D10), not by `Session.getActiveUser()`.
- **D3** UUIDs for `seat_id` and `request_id`; slugs for `ward_id` and `building_id`. Slugs make audit logs readable. Generated automatically from `name` on insert unless specified.
- **D8** Dates stored as ISO `YYYY-MM-DD` strings (not Sheet date objects). Sorts lexically, avoids tz confusion. Timestamps remain as Sheet Date objects.
- **D10** Google Sign-In + JWT verification for identity, added 2026-04-19. One-time OAuth 2.0 Client ID creation in Google Cloud Console; `Config.gsi_client_id` seeded manually.
