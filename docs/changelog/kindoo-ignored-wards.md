# Kindoo Sites Phase 6 — Wards to Ignore in Kindoo

**Shipped:** 2026-08-08
**Commits:** `feat/kindoo-ignored-wards` (T-88)

## What shipped

A manager can list ward names that appear in one of their Kindoo sites but are managed by a **different SBA stake**, and Sync skips them. Configuration → Kindoo Config carries the new list under the existing sites list; the extension's Sync strips the description segments naming those wards and reports how many users it dropped.

## Why

Kindoo Sites (§15 Phases 1–5) solved one half of building-sharing: wards of ours that live in someone else's Kindoo site. This is the other half.

Two wards of stake A meet in a building governed by stake B's Kindoo site. A configures that site as a foreign Kindoo Site and provisions its own members into it — which works, and has been working. When B is later set up in SBA, those same members show up in B's **home** Kindoo site carrying descriptions like `Aspen Grove Ward (Bishop)` — wards B has never heard of. Sync's home-site branch deliberately keeps users whose description resolves to nothing, so that genuine `kindoo-only` rows still surface; the consequence is that every one of A's members reads as drift in B's report, inviting B to mint seats for another stake's people.

The reciprocal shape is why the new list lives on the Kindoo Sites tab rather than somewhere of its own: one tab, two directions of the same arrangement.

## Decisions made during the phase

- **Match on the segment's scope-name, exact and case-insensitive** — not a substring of the whole description. `Maple Ward` matches `Maple Ward (Bishop)` and the multi-segment form, but not `Maple Ward Annex (Bishop)` and not a calling that contains the phrase (`Aspen (Maple Ward Liaison)`). A substring rule would swallow that last case. The cost is that a malformed non-parens description (`Maple Ward - Bishop`) is not matched — acceptable, because the extension writes these descriptions and the `Scope (Calling)` shape is reliable.
- **Only unresolved segments are ignore-eligible.** A ward this stake owns resolves against the wards catalogue, so the list cannot hide our own scope even if an entry collides with a ward name — including a collision created by a rename *after* the entry was added. The Configuration UI's own-ward guard is therefore a better error message rather than the only defence.
- **Segment-level, not user-level.** A member holding callings in both an ignored ward and one of ours still syncs, on our segment alone. They drop out entirely only when nothing survives.
- **An ignored member reads as absent from Kindoo, not as absent from the diff.** A seat we still hold for them is an orphan and gets the ordinary `sba-only` row with **Remove From SBA**. See below.
- **Stored on the parent stake doc, not a sub-collection.** A handful of strings, and the extension already reads the stake doc on every Sync run — so the filter costs zero extra reads.
- **No Firestore rules change.** Managers can already update the parent stake doc (`firestore.rules:686`) and the SBA UI is the only writer, so a dedicated field validator would be defence-in-depth against nothing.

## Implementation notes

`ParsedDescription` gained `ignoredCount`. It is not cosmetic: stripping every segment leaves `segments: []`, which is exactly what a **blank** description produces, and a blank description is a real review row. `isFullyIgnored` is `ignoredCount > 0 && segments.length === 0` — without the counter, a wholly-ignored user would fall through to the `kindoo-no-description` / `kindoo-only` branches and land as the very drift the list exists to remove.

`detect` drops fully-ignored users ahead of the active-site filter and independently of it — a ward that is not ours is not ours on any site. Segment-level stripping happens inside `parseDescription`, so all three call sites see the survivors with no extra plumbing.

## What an ignored member's SBA seat does

The original cut said nothing about this, and review caught it: a seat held for a fully-ignored member fell into `sba-only` with the generic reason *"the user is not present in Kindoo"* and the danger-variant **Remove From SBA**. It is reachable on the feature's own rollout — every seat minted from the pre-feature `kindoo-only` rows surfaces at once the first time Sync runs with the list configured.

Two wrong turns before landing on the rule, both worth recording because the reasoning is easy to repeat.

The first was to drop the seat along with the Kindoo user, on the argument that the operator "can't distinguish this from a genuine orphan." That distinction buys nothing: the remedy is identical either way. A seat for a member of a ward the stake has declared isn't its own is consuming one of its licences, and it should go. Suppressing the row hides a real license leak from the one tool whose job is reconciliation.

The second was to weigh a boundary-realignment scenario — a ward moving between stakes while still on the ignore list — as a reason to withhold the action, described as risking a "one-click bulk delete." There is no bulk apply. Fixes are per-row, deliberate clicks on a visible row, and a misconfigured ignore entry is something the operator fixes by editing the list.

**The rule: an ignored member reads as absent from Kindoo, not as absent from the diff.** Same code, same severity, same action as a genuine orphan — only the reason differs, naming the ignore list instead of asserting an absence that isn't true. The false wording was the only actual defect; the rest of the row was already right.

## Spec / doc edits in this phase

- `docs/spec.md` — §15: phase count five → six, new Phase 6 bullet, new "Wards to ignore in Kindoo" subsection with the four matching rules; §232 Configuration tabs notes the second list on the Kindoo Sites tab.
- `docs/firebase-schema.md` — §4.1: `kindoo_ignored_wards?: string[]` on the stake doc, and the Kindoo Sites tab added to the "Written by" line.
- `docs/TASKS.md` — T-88.

## Deferred

- **Nothing per-site.** The list is flat across the stake's Kindoo sites. An entry names a ward that is not ours, which is true on every site — per-site scoping would be state without a question behind it. If a stake ever needs to ignore a ward on one site while tracking it on another, that is a real change, not a config knob.
