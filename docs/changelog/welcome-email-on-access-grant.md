# Welcome email on first app-access grant

**Shipped:** 2026-08-02
**Commits:** PR #243 (`feat/welcome-email-on-access-grant`).

## What shipped

A sixth notification type. The first time a member's `stakes/{stakeId}/access/{memberCanonical}` doc carries any scope, a new `notifyOnAccessGranted` trigger emails them: they can now request building access for their scope(s), here is the app, here is how to sign in, here is the requester guide. Until now nothing told them — they found out when a manager pinged them by hand.

It ships alongside a hidden per-stake `web_base_url_override` string that repoints **all** of that stake's email links at a different host, because the app is dual-hosted and a stake's members may live on the legacy domain.

## Deviations from the pre-change spec

The spec was updated in the same PR; these are the behavioural deltas it now reflects.

- **Six notification types, not five.** New row: App access granted → the granted member, subject `[Stake Building Access] You can now request building access for <scope list>`, linking the app root and `/help/requesting-access.html`. Spec: §9; schema §7.
- **The fire condition is a transition, not a state.** `notifyOnAccessGranted` fires iff the before-doc has zero scopes and the after-doc has at least one, computed by `scopesFromAccessDoc` over `importer_callings` and `manual_grants` together. A scope added to an existing holder is silent, a revoke to zero is silent, a delete never fires, and a re-grant after a full revoke fires again. Spec: §9; schema §4.5 / §7.
- **The trigger hangs off the document, not off the callables.** Third trigger on the access path, alongside `syncAccessClaims` and `auditAccessWrites`. The document is the only hook that sees every grant path — including the manager Access page's raw client write to `manual_grants`, which goes through no callable. Spec: §9; schema §4.5.
- **First email with an HTML part.** `EmailPayload` gained an optional `html`; the welcome email sends HTML plus the always-required `text`, which Resend delivers as the multipart fallback. The other five emails are still plain text, and §9 now says so field-by-field rather than blanket. Spec: §9.
- **Sign-in copy branches on the recipient's address.** New shared `isGmailAddress` (exact domain compare after `canonicalEmail`, so `googlemail.com` folds in and `a@b@gmail.com` is false): Gmail addresses are told to click "Continue with Google"; everyone else is told to enter their address and click "Send me a sign-in link". Spec: §9.
- **New hidden stake field `web_base_url_override?: string`.** Operator-only, console-set, no UI. A value starting `http://` or `https://` becomes the base URL for all six of that stake's email templates; absent, empty, or scheme-less is ignored with a `logger.warn` and the `WEB_BASE_URL` param applies. Spec: §9; schema §4.1 / §6.

## Decisions made during the phase

- **The transition — not "has access" — is the send condition.** The alternative, a dedupe ledger of who has been welcomed, buys idempotency the transition already approximates and adds a collection to keep consistent. The accepted cost: a full revoke followed by a re-grant sends a second welcome. That is the rarer event and a second welcome is harmless.
- **No `setup_complete` gate, deliberately.** See the operator note below. Gating on it would silence exactly the send that is most useful — the one that tells a whole stake the app exists.
- **The override validates the scheme and nothing else.** It is operator-only and typed into the Firestore console, so heavyweight validation is misplaced; but it drives every link in every email that stake sends, so a value that could never produce a working link is rejected loudly (`logger.warn`) rather than silently concatenated into a broken href.
- **The override lives in `buildLink`, so it applies to all six emails.** The five existing service functions already thread the full `BaseDeps` (which carries the stake doc) into `safeBuildLink`, so they picked it up with no call-site changes. A welcome-email-only override would have been the odd one out: a stake on the legacy host wants *its* links there, not one template's.
- **Google Workspace addresses get the magic-link copy.** They can sign in with Google too, but the address alone doesn't say so, and instructions for a button that may not be the right one are worse than instructions for the path that always works.
- **The requester-guide path moved to `@kindoo/shared`.** Functions can't import from `apps/web`, and the guide URL now appears in both the SPA and an email body. `apps/web/src/lib/links.ts` re-exports it as `REQUESTER_GUIDE_URL`, keeping the existing name so no consumer changed.

No new `architecture.md` D-number. Nothing here supersedes or narrows an existing decision — the trigger follows the established best-effort email discipline (§9, `architecture.md` §9.5) and the override is an operator escape hatch, not a design axis.

## Operator note — the first-Sync send burst

The welcome email is **not** gated on `setup_complete`. A new stake's first extension Sync creates access docs in bulk, so it sends one email per newly-granted member — roughly one per member at the ~250-seat target scale. That is intended: the burst doubles as the launch announcement.

It can exceed a low Resend daily quota. Overflow lands as `email_send_failed` audit rows (`entity_id: 'email:accessGranted'`) and those members are never welcomed — there is no retry sweep. An operator who wants a quiet onboarding sets `notifications_enabled: false` on the stake for the duration of the initial Sync and flips it back afterwards.

## What didn't change (load-bearing non-changes)

- **No Firestore rules change.** The stake-doc `update` rule carries no per-field allowlist, so the new config field needs no rules edit (`firestore/firestore.rules`, schema §6). The `access` rules are untouched — the trigger only reads.
- **No new index.** The trigger reads one stake doc by path and one `wards` collection; nothing is queried.
- **No UI anywhere.** No form field, no config-tab row, no bootstrap step for `web_base_url_override`. The Firestore console is the interface, and that is the whole point of the field.
- **The five existing emails are still plain text.** `EmailPayload.html` is optional and only the welcome path sets it; the other five payloads are byte-identical to before.
- **No new email kill-switch.** `notifications_enabled` already gates every send, and it gates this one the same way — one log line, no API call.
- **`kindooManagers` grants send nothing.** The trigger watches the `access` collection only. Making someone a Kindoo Manager is not an app-access grant in this sense and does not welcome them.
- **No dedupe ledger, no send record.** Delivery stays at-least-once with no bookkeeping, matching the other five triggers: a retried invocation sends a second copy, accepted at this scale.
- **`createStake` does not write `web_base_url_override`.** Absent is the default, unlike `eq_president_app_access`, which `createStake` writes as `false` because it has a form field to populate.
- **Audit and claims stay automatic.** `auditTrigger` fans the access rows and `syncAccessClaims` re-mints claims from the same writes; the new trigger writes neither (its only write is the `email_send_failed` row on a Resend error, via the existing `EmailService` path).

## Spec / doc edits in this PR

- `docs/spec.md` — §9 five → six notification types, new table row, `<WEB_BASE_URL>` in the table generalised to `<base>`; the "bodies are plain text" claim corrected to name the five that are and the one that isn't; new paragraphs for the welcome email (fire condition, scope list, sign-in branch, recipient / greeting fallbacks), the first-Sync send burst, and the per-stake base URL; push paragraph notes the welcome email has no push counterpart.
- `docs/firebase-schema.md` — §4.1 the new `web_base_url_override` field and its written-by line; §4.5 a "Triggers on this path" note covering all three access-doc triggers; §6 the stake-doc rule comment names the new field alongside `eq_president_app_access`; §7 the `notifyOnAccessGranted` row.
- `functions/CLAUDE.md` — the trigger file layout gains `notifyOnAccessGranted.ts`.
- `docs/changelog/welcome-email-on-access-grant.md` — this entry.

## Known issues / deferred work

- **A failed welcome is never retried.** The `email_send_failed` audit row is the only record; nothing sweeps it. A member who was granted access during a quota overflow stays unwelcomed until someone tells them by hand.
- **The override is unvalidated beyond the scheme.** A well-formed URL pointing at the wrong host produces working-looking links to the wrong app. Operator-only field, accepted.
- **No user-guide edits.** `docs/user-guide/` still describes sign-in without reference to the welcome email; the email itself carries the instructions and links the guide, so the guide needs no forward reference.
