# Tasks

Deferred work items surfaced in session but not yet scheduled into a phase. These are smaller follow-ups and design questions the user has flagged. Check this file at the start of a session along with the other "start each session by reading" docs so ongoing work isn't dropped.

Format per task: `## [T-NN]` header with `Status:`, `Owner:`, optional `Phase:` lines, then a body. Status: `pending` / `open` / `in progress` / `done (YYYY-MM-DD)` / `done (YYYY-MM-DD — context)` / `obsolete (YYYY-MM-DD — why)` for a task closed without being done. Closed entries — `done`, `closed`, `obsolete` — move to [`TASKS-archive.md`](TASKS-archive.md) when they close, so this file holds only live work and stays small enough to read whole. The trail is preserved there verbatim; an obsolete entry keeps its original body, since the premise that turned out not to hold is the part worth reading. Never renumber and never reuse a number — `git grep T-NN` finds an entry in either file.

---

## [T-106] Sync reminders — case (1): no Sync in seven days
Status: in progress
Owner: @extension-engineer (heartbeat) + @backend-engineer (reminder) + @docs-keeper
Phase: cross-cutting

The other half of the reminder pair. [T-103] shipped case (2) — expired temp seats — because it needed no new recorded state. This is case (1): tell the Kindoo Managers when nobody has run Sync in seven days. It was the condition the operator named first, and it is the one that catches the failure case (2) can only catch a symptom of.

**The blocker, unchanged since it was first scoped: nothing records that a Sync ran.** The drift report is computed entirely in the extension (`extension/src/panel/SyncPanel.tsx`) and only *fixes* reach the server, through `syncApplyFix`. So a manager who syncs every morning and finds no drift writes nothing at all. Two shortcuts were considered and rejected:

- **Derive it from `auditLog` rows stamped with the Sync actor.** Fails on the case that matters most — a clean Sync writes no rows, so the diligent manager is exactly who gets nagged.
- **Infer it from seat staleness.** That is case (2) wearing a hat; it cannot see seven quiet days.

**So the extension must write a heartbeat** when a scan completes — which puts this behind a Chrome Web Store release, and is the whole reason the two cases were split.

**Key it by Kindoo site, not by stake.** Sync is scoped to the *active* Kindoo site (spec §15), so a stake operating a foreign site has two things to keep synced. One stake-level timestamp would mark the foreign site fresh whenever anyone synced home — silently, and in the direction that suppresses the reminder. `remoteApply/{canonical}/desktops/{siteKey}` is the shape to copy: whole-document `setDoc`, exact key set enforced in rules, written by the extension under manager auth.

**Semantics to settle:** the heartbeat means *someone looked*, not *drift is clear* — a manager who scans, sees five rows, and applies none has still synced. That is the right meaning for "it has been seven days", and it is why case (2) has to stay an independent check rather than being folded in.

**Settled 2026-09-06.** An absent heartbeat is **silent**: a stake that has never written one is never chased, and only a stake that has heartbeated and then gone quiet for seven days is mailed. Firing on absence is more literally truthful, but it would mail every stake during the extension rollout and teach managers to ignore the reminder — the one thing it cannot afford. And **one job, not two**: the existing `syncReminder` registry entry grows a second condition rather than gaining a sibling, so there is one toggle, one backoff and one email naming whichever condition fired. The two checks stay independent internally — a heartbeat means someone looked, not that drift is clear. There is **no** "last sync" display; the heartbeat is read by the handler only.

**Rollout has a sharp edge.** A manager on an older extension build writes no heartbeat, so every stake reads as never-synced until everyone updates. Decide before shipping whether an absent heartbeat fires the reminder immediately (truthful, self-clearing, noisy during rollout) or stays silent until the first heartbeat ever appears (quiet, but a stake that genuinely never syncs is never chased).

**Most of the delivery already exists.** [T-103] built the email/push machinery, the `syncReminder` push category, the manager recipient resolution, and the backoff. This adds a condition and a data source, not a new notification system. The trigger should come from the scheduled-task system ([T-104]) rather than a dedicated job — **and that path now exists**: [T-104] shipped 2026-09-05, so this reminder is a `taskRegistry` entry plus a handler of the shape `(stakeId, now) => Promise<unknown>`, with no Cloud Scheduler job and no new function of its own (`spec.md` §17). The handler must be idempotent within its own window; dispatch is at-least-once.

**Bonus the heartbeat unlocks:** a "Last sync" line per site on the manager Configuration page, which is the same data and costs nothing extra.

## [T-105] Expired temp grants on multi-grant seats have no reaper and no reminder
Status: pending
Owner: unassigned
Phase: cross-cutting

A temp grant that expires on a seat carrying **other** grants is stranded. Sync cannot clear it — the `sba-only` fix fires only when the member has no Kindoo user on the site at all (`extension/src/content/kindoo/sync/detector.ts`), and a seat with another live grant keeps them present — which is exactly why D34 keeps the Remove control on that shape instead of withholding it. So the grant sits in SBA until somebody files a remove request by hand.

[T-103]'s sync reminder deliberately **excludes** these seats (operator decision, 2026-09-04): it lists only seats `syncWillClearSeat` says Sync will actually clear, because its one instruction is "run Sync" and a recurring email that says that about a row Sync cannot touch teaches managers to ignore the email. Correct for that feature, but it means nothing now surfaces this shape proactively — the roster badge is the only signal, and only to whoever happens to look.

Worth deciding what, if anything, should chase it: a distinct reminder naming the remove-request remedy, a manager-facing list, or nothing at all on the grounds that the badge plus a leader's own request flow is sufficient. `syncWillClearSeat` (`packages/shared/src/tempExpiry.ts`) already isolates the shape, so whichever way it goes the predicate exists.

## [T-89] E2E coverage for Complete Setup against real emulators + rules
Status: pending
Owner: @web-engineer
Phase: cross-cutting

No E2E exercises the Complete Setup button at all. `e2e/tests/manager-admin/bootstrap-wizard.spec.ts` covers the setup-complete gate's routing decision (bootstrap admin sees the wizard, non-admin sees SetupInProgress, all four step tabs render) but never clicks Complete Setup or asserts on `stake.setup_complete` flipping. `apps/web/src/features/bootstrap/hooks.test.tsx` mocks `firebase/firestore` and `../../lib/firebase` (which wraps `auth`) wholesale, so `useCompleteSetupMutation`'s claim-verification gate — `canAdministerStakePostFlip` / `waitForPostFlipAdminAccess` — never runs against real custom claims or real `firestore.rules`; the unit tests can only assert what the mocked claims object says, not whether that predicate actually matches what the rules require.

This is why the gate's predicate was wrong in both directions on PR #260: first narrower than the rule (`manager` claim alone, correct as it turned out, but justified at the time only by a hand-reading of the rules), then widened to mirror the post-flip stake-doc read rule exactly (`isAnyMember || isPlatformSuperadmin`) on the reasoning that anything narrower would block a principal the read rule admits — also argued from a hand-reading, and wrong, because the read rule isn't the invariant that matters (see `architecture.md` D30). Both times, nothing in CI actually exercised the gate against emulated rules to catch the error; both times a reviewer caught it by re-reading `firestore.rules` a third time. An E2E that signs in as the bootstrap admin, drives the wizard through all four steps, clicks Complete Setup, and asserts `setup_complete` flips true — plus a case that starts with no qualifying claim on the token and asserts the retry-toast path fires and `setup_complete` stays `false` — would verify the gate's actual behavior against the emulator's real rule evaluation instead of resting on argument.

## [T-86] Remote apply: steady-state read volume per open Kindoo tab
Status: pending
Owner: @extension-engineer
Phase: remote apply (D27)

On the record before more managers opt in. Since PR #253 the poll makes **two** reads (`queued`, then `running`) at 10s while a Kindoo tab is visible — ~17k a day per always-open, always-visible tab, plus ~1.4k from the 60s sweep — against collections that are almost always empty, which is the minimum-one-read case. The sweep is a **third** read of `running` on the tick it happens to fall on (it rides the same tick, ahead of the poll, and does not reuse the poll's page), so one tick in six peaks at three reads rather than two. Comfortably inside the free tier today at one opted-in manager.

What makes it worth a note rather than nothing: the volume scales with **open tabs**, not with request volume, so it does not shrink at 1–2 requests/week and it grows with every manager who opts in and every second Kindoo window they leave open. Nothing needs doing yet. If it ever does, the cheap moves in order are a longer visible poll period; then folding the two reads into one `status in ['queued','running']` query, which also removes the hazard the fixed read order exists to dodge (one snapshot cannot miss a job mid-transition) but needs the gate's and the claim's differing uses of the two pages untangled first; and only then anything push-shaped, which D27 rejected for reasons that have not changed.

## [T-82] Extension: adopt the shared add-onto-existing-seat gate
Status: open
Owner: @extension-engineer
Phase: remote apply (D27)

`packages/shared/src/existingSeatGate.ts` now holds the single definition of whether an `add_*` request is blocked by the member's existing seat — `seatHasStakeGrant`, `existingSeatFacts`, `addBlockedByExistingSeat`. The web queue consumes it (T-81); the extension still carries its own copy in two places:

- `extension/src/panel/QueuePanel.tsx` — a local `seatHasStakeGrant`, used by `fetchSeatMap`.
- `extension/src/panel/RequestCard.tsx` — `applyableStakeAdd` / `blockedByExistingSeat`, expressed inline.

Swapping both for the shared helpers is mechanical and needs no prop-shape change: `addBlockedByExistingSeat(request, { hasSeat: memberHasSeat, hasStakeGrant: memberHasStakeGrant })` takes the booleans the card already receives. Left to the extension owner rather than done here because `extension/` isn't `web-engineer`'s, and several extension branches were in flight.

The point of doing it is that these two gates drifting apart is what produced T-81: a divergence in a predicate neither surface can see the other's copy of. The long comment on `RequestCard`'s carve-out should move to the shared module (it's already there) rather than being maintained twice.

## [T-79] A server-side remote-apply job writer must stamp `target_site_key` itself
Status: open
Owner: @backend-engineer
Phase: remote apply (D27)

Pre-emptive. Nothing to do today — this exists so the assumption is written down before someone unknowingly invalidates it.

A `remoteApply/{canonicalEmail}/jobs/{jobId}` doc with no `target_site_key` is **permanently stuck**, not merely malformed. The rules' `jobCoreUnchanged` reads `before.target_site_key` bare; a missing-key read errors, and an erroring condition denies — and that helper gates `allow update` ahead of all three transition branches. So such a doc can't be claimed by a desktop, can't be cancelled by the phone's no-pickup timeout, and can't be reported on. `allow delete: if false` means no client can clear it either: Console or Admin SDK only.

This is unreachable today, and only for one reason: **every writer of that collection is a client**, gated by a create rule requiring `target_site_key is string && .size() > 0`. Nothing in `functions/src` writes it.

If a Cloud Function ever queues remote-apply jobs server-side — an auto-provision trigger, a retry sweep, a backfill — it **bypasses rules entirely** and can mint fieldless docs for real. Such a writer must derive and stamp `target_site_key` at the write. The derivation is settled and already implemented twice (`extension/src/content/kindoo/siteCheck.ts` → `checkRequestSite`, and the phone's queue-job writer): `request.scope === 'stake'` → the home site unconditionally; a ward scope → `resolveWardSite(ward, buildings)`, where `null` also means home. Run the result through `remoteApplySiteKey` (`@kindoo/shared`).

**Call `resolveWardSite`; do not hand-roll the lookup.** It delegates to `resolveWardBuilding`, which is id-first with a **name fallback on an id MISS** — a ward whose `building_id` points at a deleted or un-migrated building still resolves via its `building_name` snapshot. An id-only reimplementation (`buildings.find(b => b.building_id === ward.building_id)?.kindoo_site_id ?? null`) returns `undefined` for that ward, which collapses to `null`, which means home. A foreign-site ward would then be silently stamped as home work, claimed by a home tab, and refused by that tab's own `checkRequestSite` — which resolves the expected site through the correct helper — with "switch Kindoo sites and try again". That is precisely the bad-advice failure the multi-site work removed, reintroduced one layer up. Same discipline as routing keys through `remoteApplySiteKey`.

The extension defends by dropping such docs from both its queued and running queries with a warning rather than guessing a site — guessing would buy a doomed claim every poll that `claimRemoteApplyJob` misreports as "already claimed elsewhere", and would provision real Kindoo access against a guessed site if the freeze were ever lifted. That defence is deliberately inert; don't treat its existence as licence to write fieldless docs.

Noted in `extension/CLAUDE.md` (remote apply bullets) and on the create rule in `firestore/firestore.rules`. Surfaced during PR #250 by `extension-engineer` and `backend-engineer` working the rules.

## [T-76] Wire the deploy-lock drift check into CI and cover it with tests
Status: open
Owner: @infra-engineer
Phase: cross-cutting

Follow-up to T-73, split out so its deferrals have a tracking home rather than sitting inside a `done` entry.

The drift check that keeps `functions/deploy-lock/package-lock.json` honest is enforced today only as a side effect of `functions/scripts/build.mjs` running it — which happens to be gated by CI's "Build functions for emulator" step and by `firebase deploy`'s predeploy hook. Two gaps:

1. **No explicit CI step.** `pnpm deps:check` should run next to Lint / Typecheck in `infra/ci/workflows/test.yml` with `continue-on-error: true`, and its outcome added to the "Verify all checks passed" list. A dedicated step names the failure instead of burying it in a build step. Deferred from PR #245 because CI workflow changes tag every engineering agent.
2. **No committed tests for load-bearing logic.** `parsePnpmFunctionsDeps` (a hand-rolled pnpm lockfileVersion-9 parser) and `findDeployLockDrift` in `functions/scripts/deploy-deps.mjs` carry the guarantee. Both throw rather than return partial results when they meet something structurally unfamiliar, so a future pnpm layout change fails loudly rather than making the check vacuous — but that defence is itself untested in the repo. The nine cases exercised during PR #245 (dep added / removed, pnpm-lock floated, range bumped without `pnpm install`, `lockfileVersion` too old, upstream-published-nothing-changed staying green, and two parser-rejects-unknown-format cases) were run ad-hoc and should be a vitest fixture suite.

Also outstanding from T-73, and not a CI concern: confirm on the next staging deploy that Cloud Build's buildpack actually installs via `npm ci` from the copied lockfile. `infra/runbooks/deploy.md` → "Manual verification of the deploy dependency pinning" step 6 has the exact check.

## [T-71] Organizations v1 deferrals — per-org pending bars + duplicate-grant inline edit
Status: open
Owner: @web-engineer
Phase: cross-cutting

Two intentional scope cuts from the Organizations feature (PR #224 / D21), tracked so they aren't mistaken for bugs:

1. **Per-organization PENDING utilization bars.** The Stake Roster's per-org bars (`RosterUtilization` / `StakeRosterPage.orgRows`) are committed-only — pending adds/removes are split into the "Pending" stake bar but are NOT attributed per org. A future version could partition pending requests by their `organization_id` and show projected per-org bars, mirroring the stake bar's committed/projected pair.

2. **Inline org editing for parallel-site stake DUPLICATE grants.** The roster org chip (`OrganizationChip`) is editable only on the **primary** stake grant (`grant.isPrimary`); a parallel-site stake *duplicate* grant renders the chip read-only, and its org is set through the request form (`EditSeatDialog`). A future version could make the duplicate's chip editable too, which would need a direct-write path that targets a `duplicate_grants[]` entry's `organization_id` (the current `seats.update` rule allowlists only the top-level `organization_id`, so the rule + mutation would both need extending).

Both are deliberate v1 simplifications at target scale, not defects. See `docs/changelog/stake-organizations.md` "Deferred".

## [T-26] Phase 11 SA hardening pass
Status: open (runbook fold-in landed)
Owner: @infra-engineer (verify SA roles, deploy) + @backend-engineer (function options)
Phase: 11

Pin the remaining Cloud Functions (audit fan-in × 9, claim sync × 4, `onAuthUserCreate`, `removeSeatOnRequestComplete`) to `kindoo-app@` for single-identity audit traces and to allow revoking the project-default `roles/editor` from the default compute SA. (`installScheduledJobs` was on this list; it was deleted in PR #214 — see `architecture.md` D20 — so there is nothing to pin.) Phase 8 pinned only the four Sheets-touching functions (`runImporter`, `runExpiry`, `reconcileAuditGaps`, `runImportNow`) because the LCR sheet is shared with `kindoo-app@` and the importer was 403'ing on the default compute SA; the rest stayed on default to defer the IAM review to cutover.

**Pre-req:** confirm via `gcloud projects get-iam-policy` that `roles/editor` is still bound to `<projectnum>-compute@developer.gserviceaccount.com`, and that `kindoo-app@` has the roles needed for Auth Admin SDK calls (claim-sync triggers + `onAuthUserCreate` write `customClaims` + revoke refresh tokens; `removeSeatOnRequestComplete` writes Firestore; the audit fan-in functions write Firestore).

**Runbook fold-in landed (2026-05-03):** PR `infra/runbook-kindoo-app-eventarc-fcm-roles` added `roles/eventarc.eventReceiver` and `roles/firebasecloudmessaging.admin` to step 1.8 of `infra/runbooks/provision-firebase-projects.md`. These are the two roles surfaced during the Phase 9/10.5 staging deploy and re-confirmed during prod bring-up (the codebase pins `kindoo-app` for the email + FCM push triggers, both Firestore-Eventarc consumers; FCM admin is needed for `messaging.send()`). The runbook now grants five roles instead of three. The remaining T-26 work — pinning the rest of the functions to `kindoo-app@`, the `gcloud projects get-iam-policy` audit, and revoking project-default `roles/editor` — remains open and tracked here.

## [T-38] SBA temp grant expiry doesn't downgrade Kindoo permanent users (one-way temp→permanent sync)
Status: open — deferred future work, not blocking
Owner: TBD (depends on chosen fix path — `@web-engineer` for A/B, `@backend-engineer` for C)
Phase: post v2.2 design scoping

Originally filed as B-9; reclassified as a task on 2026-05-12 because this is deferred future feature work, not a defect against currently-shipping behavior. The v2.2 extension design explicitly adopts a one-way temp→permanent promotion rule and accepts the sync gap described below as a known consequence — operator decision when the rule was locked in.

**Mechanism note (2026-06-05).** This entry was written against the old SBA-side expiry trigger, which was removed in PR #210 (`architecture.md` D19, `docs/changelog/remove-temp-seat-expiry-scheduler.md`). The body below still says "SBA's existing expiry trigger removes the temp grant" — that trigger no longer exists. Under the current model Kindoo expires the temp user and the extension's Sync removes the orphaned SBA seat via the `sba-only` path (`spec.md` §7 / §8). The underlying drift this task describes is unchanged in substance — Sync removing the SBA seat still doesn't demote a permanent Kindoo user — so the task stays open; only the trigger mechanism it cites is now stale. Fix path A ("expiry-time push from the SBA trigger") is moot; B / C / D still apply.

**The rule (operator wording).** If v2.2 is processing a manual (permanent) request and finds the Kindoo user is temporary, it promotes them to permanent; if v2.2 is processing a temp request and finds the user already permanent, it leaves them permanent (does not demote):

> If we're adding a manual role to a user and we find they are temporary in Kindoo, then we need to make them a permanent user in Kindoo. If they are a permanent user and we are processing a temporary request, then we have to leave the user as a permanent user.

The accepted consequence: once a Kindoo user is permanent, v2.2 never demotes them — even when the SBA grant that triggered the original temp processing later expires. SBA's view of who has temp vs. permanent access drifts from Kindoo's view over time.

**Observed behaviour.** An SBA `add_temp` grant expires server-side (SBA's existing expiry trigger removes it from the seat's `duplicate_grants[]`), but the corresponding Kindoo user retains the rules + permanent status that v2.2 set when the request was originally processed. Nothing pushes an update to Kindoo at the expiry boundary, so the Kindoo record drifts out of sync with SBA's current state.

**Concrete example:**
1. User A has a permanent SBA seat (e.g. auto-derived from a calling).
2. An `add_temp` request is submitted and approved for User A on the same building.
3. v2.2 sees Kindoo already permanent — per the rule, leaves Kindoo's permanent flag alone, updates rules + description.
4. The temp grant's `end_date` passes.
5. SBA's expiry trigger fires and removes the temp grant from the seat in SBA.
6. Kindoo still shows User A as permanent with the temp grant's rules assigned; nothing pushed the update.

**Impact.** No day-to-day operational impact (the user retains access, the conservative failure mode). Hurts data hygiene + audit traceability over time, and is worse if the original temp grant was a time-limited high-trust access (e.g. a contractor visiting the building) — they keep that access indefinitely until manually revoked. Low-medium severity if a fix is eventually scoped.

**Root cause.** v2.2 is request-driven. There is no scheduled job or expiry-time trigger that reconciles Kindoo against SBA when an SBA temp grant expires server-side.

**Repro (for whoever picks this up):**
1. Find / create a Kindoo user who is permanent.
2. Submit and complete an SBA `add_temp` request for the same user (any building).
3. After v2.2 provisions, confirm Kindoo user is still permanent (correct per the rule).
4. Wait past `end_date` (or simulate by editing the request's `end_date` to the past).
5. SBA expires the temp grant server-side via the existing expiry trigger.
6. Inspect Kindoo: the access rules from the temp grant remain in place; nothing changed.

**Proposed fix paths (not committing to one — surface them for prioritization):**

- **A. Expiry-time push to the extension.** When the SBA expiry trigger removes a temp grant, fire an event the extension reacts to. Hard to wire — the extension is browser-side; the function would need to push to a service the manager has open. Probably not practical.
- **B. Manual reconciliation panel in the extension.** New view that surfaces "Kindoo users with access SBA no longer grants" — manager clicks to revoke. Operator-driven, no server complexity.
- **C. Nightly reconciliation job.** Server-side, lists out-of-sync users for the manager to review (email digest, dashboard widget, audit collection).
- **D. Accept the gap permanently.** Permanent-in-Kindoo is a one-way door by design; revocation always requires an explicit SBA remove request.

**Not blocking anything.** v2.2 ships with the gap by design. Future work only — pick up when someone wants to close the loop.

## [T-40] Enforce Firebase App Check on user-callable Cloud Functions
Status: open
Owner: @backend-engineer + @infra-engineer
Phase: cross-cutting

Surfaced by the 2026-05-14 callable-permission security review: none of the five user-callable Cloud Functions (`getMyPendingRequests`, `runImportNow`, `markRequestComplete`, `syncApplyFix`, `installScheduledJobs`) currently enforce App Check. Any signed-in Firebase Auth user can invoke them from any origin (web, mobile, curl, scripts). The existing per-callable `kindooManagers` doc check is the only authorization gate.

Add App Check enforcement so calls without a valid App Check token are rejected at the Functions runtime. Defense-in-depth against bot / scripted / MITM invocation — does not replace the per-callable manager auth check. Web app (Firebase Hosting) registers via reCAPTCHA Enterprise; Chrome extension needs a separate App Check provider (custom debug provider during development; production attestation TBD — operator decision).

## [T-41] Enable Firestore TTL on `platformAuditLog`
Status: open (re-opened 2026-05-19 — Phase 12.3 shipped, see `docs/changelog/phase-12.3-create-stake.md`)
Owner: @infra-engineer (operator runs gcloud) + @tad
Phase: cross-cutting

T-15 closed 2026-04-29 by enabling Firestore TTL on the `auditLog` collection-group. The sibling `platformAuditLog` collection (superadmin records — see Q20) was originally deferred at operator's discretion.

**2026-05-18: no production code writes to `platformAuditLog` today.** The type, zod schema, doc-ref helpers (`platformAuditLogRef` / `platformAuditLogCol` in `apps/web/src/lib/docs.ts`), and Firestore rules all exist as scaffolding, but no caller invokes them — `grep -rn 'platformAuditLogRef\|platformAuditLogCol'` returns only the definitions. The collection is empty in production; enabling TTL now would expire zero rows. The Phase 12 `createStake` callable (sub-deliverable 12.3) will be the first production writer; re-open this task when 12.3 lands.

**2026-05-19: 12.3 has shipped.** The `createStake` callable writes `platformAuditLog` rows in production (one row per stake create, with `ttl` = 365 days from write time stamped at write). The collection is no longer scaffolding-only — every new stake provision now lands a row. Run the gcloud command below against staging then production to wire Firestore's TTL deletion against the `ttl` field.

When Phase 12's `createStake` lands, the work needed:

```
gcloud firestore fields ttls update ttl \
  --collection-group=platformAuditLog \
  --enable-ttl \
  --project=<staging-project>
```

Repeat for production. Decide retention duration before enabling (the in-code default for `auditLog` is 365 days; superadmin records may warrant longer — operator decision). Add a corresponding subsection to `infra/runbooks/provision-firebase-projects.md` next to the existing TTL setup notes.

## [T-47] Extension panel doesn't re-resolve on mid-session EID change
Status: open
Owner: @extension-engineer
Phase: post-12.5

`extension/src/panel/App.tsx`'s `resolveStake` only fires on `authState.status` transitions. If the operator navigates within Kindoo from one EID to another without closing the slide-over panel, the previously resolved stake is reused and writes go to the wrong stake. Pre-existing limitation that 12.5 doesn't make worse (the old code was hardcoded to `csnorth`, so navigating EIDs already routed all reads/writes incorrectly), but in a multi-stake world the consequence is more impactful. Reviewer's recommendation on PR #159: revisit if a multi-stake operator reports confusion.

## [T-58] Sync: temp-vs-non-temp divergence no longer detected (deferred)
Status: open
Owner: @extension-engineer
Phase: extension Sync — Grant-derived seat type (Stage 1)

The grant-derived `type-mismatch` (T-57) intentionally skips temp seats (`sbaBlock.type === 'temp'`) and any row where `directGrantBuildings === null`. Consequence: a divergence between Kindoo's `IsTempUser` flag and the SBA seat's `temp` type — in either direction (SBA-temp vs Kindoo-permanent, or SBA-auto/manual vs Kindoo-temp) — is no longer surfaced. The pre-Stage-1 classifier-based check (`intended.type !== sbaBlock.type`) caught these.

**Accepted as a known Stage-1 limitation** (operator decision, 2026-05-30): temp is an `IsTempUser` + expiry concept orthogonal to grant provenance, so folding it into the grant-based promote/demote would conflate two axes. Deferred rather than fixed. If temp drift becomes a real operational gap, add a dedicated `temp-mismatch` discrepancy row keyed on `seat.type === 'temp'` XOR `kuser.isTempUser` (independent of the grant-based type check), with its own fix semantics (Kindoo `IsTempUser` + expiry-date reconcile vs SBA seat-type change). Not in scope for Stage 1.

