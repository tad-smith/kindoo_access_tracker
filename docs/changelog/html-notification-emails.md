# HTML parts for the five remaining notification emails

**Shipped:** 2026-08-03
**Commits:** PR #251 (`feat/html-notification-emails`).

## What shipped

Every notification email now ships an HTML part alongside its plain-text fallback. Until this PR only the welcome email did; new-request, completed, rejected, cancelled, and over-cap were plain text and looked it — padded `Label:    value` columns, raw request enums, and uppercased ward codes.

The five gained a shared layout: a lead sentence, a two-column table of detail rows, one centred call-to-action button. The text part keeps aligned rows carrying the same labels and the same content, so a text-only client loses styling and nothing else. Three copy problems went with the conversion: ward codes now resolve to ward names, `add_temp` / `edit_temp` now read as `Temporary access` / `Temporary-seat edit`, and the leads name the person instead of printing their address mid-sentence.

Every subject line changed format as a consequence — see the operator note below.

## Deviations from the pre-change spec

The spec was updated in the same PR; these are the behavioural deltas it now reflects.

- **All six emails ship HTML plus text, not one of six.** `spec.md` §9 had a sentence naming the five that were plain text and the one that wasn't; that sentence is now a statement that every email carries both parts and that the two must always say the same thing. Spec: §9; schema §7.
- **Ward names, not uppercased codes.** The file-local `scopeLabel()` in `EmailService.ts` — which returned `scope.toUpperCase()` for anything but `'stake'` — is deleted. All six emails resolve through the shared `scopeLabel(scope, wards)` (`@kindoo/shared`, the same resolver the SPA and extension use), fed by a new `loadScopeLabeller(db, stakeId)` that does one `stakes/{stakeId}/wards` read per send and returns a resolver. Unresolved codes still fall back to the raw code. Spec: §9; schema §4.2 / §7.
- **Five service functions now read `stakes/{stakeId}/wards`.** `notifyManagersNewRequest`, `notifyRequesterCompleted`, `notifyRequesterRejected`, `notifyManagersCancelled`, and `notifyManagersOverCap` read a collection they never touched before. `notifyMemberAccessGranted` already read it (through the deleted `resolveWardLabels`) and now shares the same helper. One read per send in every case. Spec: §9; schema §4.2 / §7.
- **Request types render as human labels.** New `TYPE_LABEL` maps the enum to `Manual access` / `Temporary access` / `Removal` / `Auto-seat edit` / `Manual-seat edit` / `Temporary-seat edit`; the raw enum appears in no email. `TYPE_NOUN`, which held a second hand-maintained set of the same strings for mid-sentence use, is deleted — `typeNoun()` now lower-cases `TYPE_LABEL`. Spec: §9.
- **Leads name the person; the address appears once.** New `personName()` returns `member_name` and falls back to the address only when the record carries no name. `displayPerson()`, which printed `Name (address)` inline, is deleted. The address now lives solely in the `Member` row, as a `mailto:` link in the HTML part. Spec: §9.
- **Every subject line has a new format.** New-request and cancelled swap the parenthesised scope for an em-dashed ward name; completed and rejected name the member; over-cap counts the pools. Spec: §9 table.
- **The over-cap subject counts.** `One seat pool is over its cap` / `Two seat pools are over their cap`, spelled out to twelve and numeric past that, replacing the fixed `Over-cap warning`. The lead sentence is the same string with a period, so subject and body cannot disagree about the count. Spec: §9; schema §7.
- **`TYPE_LEAD_VERB.add_manual` was ungrammatical and is fixed.** Every other verb in the map ended in `for`; `add_manual` read `submitted a new manual-add request` and the lead appended the subject person straight onto it. It now ends in `for` like the rest. Spec: §9.

## Decisions made during this change

- **One layout function, not five templates.** `htmlDocument({lead, rows, link, cta})` plus `htmlRow` is the whole HTML surface for the five; each builder contributes a lead, a row list, and a button label. The rows a given email carries are the only per-email code left. The alternative — five hand-written documents — puts five copies of the same table markup where one drifts silently the first time a style changes.
- **No template library, no MJML, no build step.** The primitives are string constants and two joining functions in the same module. The whole output is inline styles because mail clients drop `<style>` blocks; nothing in that constraint needs a dependency, and adding one would put email rendering behind a build artifact the functions deploy would have to carry.
- **Both parts are built from the same copy fragments.** `newRequestLead`, `cancelledLead`, `requestLeadStem`, `rejectionReason`, `memberLines` / `memberCell`, `dateRange` are shared, and `typeNoun` reads `TYPE_LABEL` rather than restating it. The invariant recorded at the top of `EmailService.ts` is that the two parts always say the same thing and the only permitted difference is markup; sharing the fragments is what makes that structural instead of a thing someone has to remember when editing one part.
- **One wards read per send, returned as a resolver.** `loadScopeLabeller` reads the collection once and hands back a `(scope) => string` closure. Over-cap labels every flagged pool from that one read; the two manager-bound emails issue it concurrently with the `resolveRequesterLabel` reads they already made, so the ward names cost no extra round-trip on those paths. The predecessor, `resolveWardLabels`, took a list of codes and could not serve a caller that discovers its scopes one at a time.
- **Chips are rationed to one value per email.** `Emergency: Yes` and the over-cap `+N` are the only chipped values; everything else is a plain table cell. The point of the chip is that a manager scanning the mail sees the one thing that changes what they do about it. Chipping more would spend that.
- **The rejected lead's "rejected" is red, at the operator's request.** Same `#9b2c1c` as the chips, so the palette stays two colours (blue for actions, red for attention). It is the one inline emphasis in any lead.
- **Over-cap figures are right-aligned and tabular.** `font-variant-numeric:tabular-nums` on the Seats / Cap / Over by columns; a manager comparing pools is reading columns of digits, and proportional figures make that harder than it needs to be.
- **A rejection with no reason renders `(not provided)` rather than dropping the row.** A missing row reads as a bug in the email; an explicit `(not provided)` reads as a fact about the rejection. Same reasoning as the App Access page rendering both access tiers rather than leaving Full blank.
- **No new `architecture.md` D-number.** This is a presentation change: same triggers, same recipients, same send conditions, same best-effort failure discipline, no new data. It opens no decision axis a future change would need to cite or override, and the standing email-send policy (`architecture.md` §9.5, preserved verbatim from the Apps Script era) is untouched by it. The rationale that would have gone in a D-row is in this entry instead.

## Operator note — mail filters on the old subjects stop matching

Three of the five subjects no longer contain the string they used to. `Over-cap warning` and `Your request was rejected` do not appear anywhere in the new output; `Your request for <member_email> has been completed` now carries the member's **name** where it carried their address. A rule filtering, labelling, starring, or forwarding on any of those exact strings silently stops matching — mail rules fail quiet, so the first symptom is a manager who stops seeing a category of mail rather than an error.

The `[Stake Building Access]` prefix is unchanged on all six and is the only stable anchor for a filter. Managers and requesters who had rules on the old wording need to be told; nothing in the app tells them.

## What didn't change (load-bearing non-changes)

- **The welcome email's output is byte-identical.** Its builders moved onto the shared `WRAPPER` / `PARA` / `BUTTON` / `LINK` constants, which hold exactly the strings its local `wrapper` / `para` / `button` consts and its inline `color:#2b6cb0` held. It still composes its own prose body rather than going through `htmlDocument` — it goes to someone who may never have seen the app, so paragraphs beat a detail table. No heading element, still.
- **No Firestore rules change.** The five service functions read `wards` through the Admin SDK, which bypasses rules; nothing about who may read the collection from a client moved.
- **No new index.** `loadScopeLabeller` gets the whole `wards` collection with no `where` and no `orderBy`. §5.1 already treats `wards` as a load-fully-and-filter-client-side collection.
- **No new dependency, no new build step.** No MJML, no Handlebars, no HTML minifier. `functions/package.json` is untouched, so `functions/deploy-lock/package-lock.json` needed no relock.
- **No trigger, recipient, or send-condition change.** `notifyOnRequestWrite`, `notifyOnOverCap`, and `notifyOnAccessGranted` fire on exactly what they fired on before, to exactly the same recipients. `notifications_enabled` gates every send the same way, the no-active-managers short-circuit is unchanged, and a Resend failure still lands as one `email_send_failed` audit row and never re-throws.
- **`EmailPayload` is unchanged.** `html` was already optional on it from the welcome-email work; five more callers now set it. `buildPayload` needed no edit.
- **No push change.** Push (§9, Phase 10.5) still ships the new-request notification only and renders its own payload; nothing here reaches it.
- **No user-guide edits.** `docs/user-guide/` never described email formatting.
- **The `Note from the manager` content is unchanged.** The completion email still surfaces `request.completion_note` verbatim, including the R-1 system tag appended to a manager's note; only the row's label changed from `Note` to `Note from the manager`.

## Spec / doc edits in this PR

- `docs/spec.md` — §9: the notification table's Subject column rewritten for all five new formats and the over-cap count variants; the "five bodies are plain text" sentence replaced with the all-six HTML-plus-text statement and the two-parts-must-agree invariant; new paragraphs for the shared body shape, ward-name resolution and its one-read-per-send cost, the human type labels, the person-not-address leads, the chips / red word / over-cap figures, and the subject-format change with its mail-filter consequence; the requester-naming paragraph re-quoted against the new subjects and bodies; the welcome-email paragraph notes it is the one prose-rather-than-rows body. Also corrected the completed / rejected link-back column from `<base>/my` to `<base>/my-requests`, which is what `EmailService` has always built — pre-existing drift, unrelated to this PR (`/my` is a deep-link alias in `apps/web/src/lib/routing.ts`, not the route).
- `docs/firebase-schema.md` — §4.2 `wards` gains `EmailService` in its **Read by** line plus a paragraph on the one-read-per-send pattern, the resolver shape, and the raw-code fallback; §7's `notifyOnRequestWrite`, `notifyOnOverCap`, and `notifyOnAccessGranted` rows name the wards read (and the over-cap row the counting subject); the `notifyOnAccessGranted` row drops "the only email with an HTML part".
- `docs/architecture.md` — no edit. See the no-D-number decision above.
- `docs/changelog/html-notification-emails.md` — this entry.

## Known issues / deferred work

- **Nothing tells recipients their mail filters broke.** See the operator note. Announcing it is an operator action with no product surface.
- **No dark-mode handling.** The palette is fixed light — `#1a202c` on the client's default background. A client rendering in dark mode inverts the background but not the inline colours; the result is legible but not designed. Not addressed here.
- **No rendering matrix.** The layout follows the mail-client-safe rules (inline styles, table markup, no `<style>` block) but has not been checked against a client matrix. Gmail web and Apple Mail are what it was built against.
- **The text part's `Label:    value` alignment assumes a monospace client.** `textRow` pads to a fixed 10-column label field, which lines up in a monospace renderer and merely reads as extra spaces in a proportional one. Acceptable for a fallback part.
