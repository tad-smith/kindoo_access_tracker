# docs — Claude Code guidance

Spec, architecture, decisions, runbooks-summaries, changelog. The narrative layer over the code.

**Owner agent:** `docs-keeper`. Owns the structure of `TASKS.md` and `BUGS.md` (any agent appends content). Owns root `CLAUDE.md` and per-workspace `CLAUDE.md` *structure* (each workspace's content is owned by the workspace's agent).

## File layout

```
docs/
├── spec.md                        # live source of truth for runtime behaviour
├── architecture.md                # numbered design decisions (D1, D2, ...)
├── firebase-schema.md             # authoritative data model + rules + indexes
├── firebase-migration.md          # phase plan (Phase A complete; Phase 12 deferred)
├── open-questions.md              # active ambiguities + [RESOLVED] trail
├── navigation-redesign.md         # Phase 10.1 nav redesign design doc
├── TASKS.md                       # cross-cutting work-in-flight
├── BUGS.md                        # cross-cutting defects
├── changelog/                     # per-phase entries
│   ├── README.md
│   ├── template.md
│   └── phase-N-*.md
└── runbooks/                      # per-procedure operator playbooks (summaries; full ones in infra/runbooks/)
```

## Conventions

- **Spec changes happen in lockstep with code changes.** Same commit. Never let `spec.md` describe yesterday's design.
- **Architecture decisions are numbered** (D1, D2, ...). Cite them in commit messages when overriding one.
- **Per-phase changelog entries** follow `changelog/template.md`. Migration phase entries: `phase-N-<slug>.md`.
- **Cross-doc references are explicit** — e.g., "see `firebase-schema.md` §6". Avoid vague pointers like "see the architecture doc."
- **Open questions get [RESOLVED YYYY-MM-DD] trails** when closed; original wording preserved.

## Don't

- **Don't write code.** You don't own `apps/`, `functions/`, `firestore/`, `infra/`. You convert their decisions into doc updates.
- **Don't create new top-level docs without checking** if existing ones cover the topic.
- **Don't let `firebase-migration.md` and `firebase-schema.md` drift.** They reference each other; updates to one often need a corresponding update.
- **Don't archive resolved items prematurely.** Resolved-and-recent stays in the doc with a [RESOLVED] tag; archived only when stale.

## Boundaries

- **Engineering agent changes behaviour** → you update `spec.md` in lockstep.
- **Engineering agent makes a decision worth recording** → you add to `architecture.md` (next D-number).
- **Engineering agent ships a phase** → you write the `changelog/phase-N-*.md` entry.
- **TASKS.md / BUGS.md** structure is yours; content is appended by any agent. You archive resolved entries weekly.

## Migration history

Phase 11 cutover landed 2026-05-03. From that point forward `spec.md` describes Firebase reality; the Apps Script-era D-numbers (D1-D10) in `architecture.md` are retained as historical record alongside the Firebase decisions (D11+). Apps Script source and its per-chunk changelogs (`chunk-N-*.md`) were removed from the repo in 2026-05-11 as a post-cutover cleanup; the per-chunk history is preserved in git history. See [`changelog/phase-11-cutover.md`](changelog/phase-11-cutover.md).
