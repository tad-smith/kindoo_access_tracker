# Chunk 0 — Planning

**Shipped:** 2026-04-19
**Commits:** initial commit (pre-git planning bundle).

## What shipped

No running code. The repo was scaffolded (clasp-ready layout, empty stubs), the original brief was reformatted into `docs/spec.md`, design and data model were documented, and the 11-chunk build plan was expanded with per-chunk acceptance criteria. Several ambiguities in the brief were resolved with the project owner in-session.

## Deviations from the original brief

All now reflected in the live `docs/spec.md`; rationale trails linked per item.

- **Auth model: GSI + server-side JWT verification, not `Session.getActiveUser().getEmail()`.** Every user signs in with consumer Gmail, so the original approach returns empty cross-customer. See [`architecture.md` D10](../architecture.md) and [`open-questions.md` A-1](../open-questions.md).
- **Gmail address canonicalisation baked in from day 1.** LCR data has mixed dot and `+suffix` variants for the same account. `Utils.normaliseEmail` lowercases, strips local-part dots for `@gmail.com` / `@googlemail.com`, strips `+suffix`, and collapses `googlemail.com` → `gmail.com`. Applied at every email boundary. See [`architecture.md` D4](../architecture.md) and [`open-questions.md` I-8](../open-questions.md).
- **OAuth consent screen Published, not Testing.** `openid`/`email`/`profile` scopes don't require Google verification, so publication is immediate and the test-users list is irrelevant. See [`open-questions.md` A-7](../open-questions.md).
- **New Config key `gsi_client_id`** seeded manually pre-deploy; verified as the JWT `aud` claim on every request. Editing it invalidates every issued token (expected). See [`data-model.md`](../data-model.md), [`open-questions.md` A-4](../open-questions.md).
- **Manager self-approval is allowed.** A Kindoo Manager who's also in a bishopric or the stake presidency may complete/reject requests they themselves submitted. No server-side guard. See [`open-questions.md` R-6](../open-questions.md).
- **`Forwarding Email` in the callings sheet is out of scope for this app.** Used for other tooling; the importer reads `Personal Email` + rightward cells only. See [`open-questions.md` I-4](../open-questions.md).
- **Chunk 1 scope reframed around six concrete proofs** (login-page loads / JWT crosses client→server / server verifies JWT / roles resolve / hello renders / failure modes). Same one-chunk shape as the original brief's "hello world" but with the GSI handshake in front. See [`build-plan.md` Chunk 1](../build-plan.md#chunk-1--scaffolding).

## Decisions made during planning

Not brief deviations; design choices made to keep moving. Full rationale in `architecture.md`.

- **Container-bound Apps Script** (not standalone). [D1](../architecture.md).
- **`executeAs: USER_DEPLOYING`, `access: ANYONE_WITH_GOOGLE_ACCOUNT`.** [D2](../architecture.md).
- **UUIDs for `seat_id` / `request_id`; slugs for `ward_id` / `building_id`.** [D3](../architecture.md).
- **Per-tab repos (`src/repos/*.gs`)**, not a monolithic `SheetService`. [D6](../architecture.md).
- **Single `setupSheet()` helper + Sheet `onOpen()` admin menu** for tab creation and trigger re-installation. [D7](../architecture.md).
- **Importer atomicity: full per-tab diff in memory, abort the tab's mutations on any parse error, lock acquired once.** Confirmed with owner. [I-1 resolved](../open-questions.md).
- **Two identities — Apps Script execution vs. actor.** Sheet file revision history will show the deployer for every write; `AuditLog.actor_email` is the authoritative record of authorship. `AuditRepo.write` requires the actor explicitly — no environment fallback. [architecture.md §5](../architecture.md).

## Scale confirmed

12 wards, ~250 active seats, 1–2 manual/temp requests per week. Low-traffic; v1 avoids pagination, polling, and batching until evidence says otherwise.

## Spec / doc edits in this chunk

- `docs/spec.md` — created from original brief; Auth bullet rewritten for GSI + JWT; front matter rewritten as "live source of truth" convention.
- `docs/architecture.md` — created; 12 sections including a Mermaid sequence diagram of the GSI handshake.
- `docs/data-model.md` — created; every tab, exact columns, example rows, canonical-email rule.
- `docs/build-plan.md` — created; 11 chunks with acceptance criteria; Chunk 1 restructured to six proofs; explicit "deferred to later chunks" fence.
- `docs/open-questions.md` — created; 8 items resolved with date trails; remaining items tagged P0 / P1 / P2.
- `docs/sheet-setup.md` — created; two paths (`setupSheet()` helper vs. manual) + OAuth 2.0 Client ID setup.
- `docs/changelog/` — created; README explains convention; this file + `template.md`.
- `README.md` — created; first-time setup flow including `.clasp.json.example` copy and OAuth client ID step.
- `src/` — 46 empty placeholder files with one-line comments describing what will live in each.

## Deferred

Everything implementation. Chunks 1–11 are the roadmap. See [`build-plan.md`](../build-plan.md).

## Next

**Chunk 1 (Scaffolding)** — no writes, read-only role resolution proven against the six-proof acceptance contract. Prerequisites that need to happen outside the repo:

- Create the backing Google Sheet and bind an Apps Script project via Extensions → Apps Script.
- Copy `.clasp.json.example` → `.clasp.json`; paste the script ID.
- Create an OAuth 2.0 Client ID in Google Cloud Console; publish the consent screen; seed `Config.gsi_client_id` and `Config.bootstrap_admin_email` by hand in the Sheet.
- First `clasp push`; run `setupSheet()` once to populate tab headers; deploy the web app.
