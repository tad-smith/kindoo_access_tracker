# docs — Claude Code guidance

Spec, architecture, decisions, runbooks-summaries, changelog. The narrative layer over the code.

**Owner agent:** `docs-keeper`. Owns the structure of `TASKS.md` and `BUGS.md` (any agent appends content). Owns root `CLAUDE.md` and per-workspace `CLAUDE.md` *structure* (each workspace's content is owned by the workspace's agent).

## File layout

```
docs/
├── spec.md                        # live source of truth for runtime behaviour
├── architecture.md                # numbered design decisions (D1, D2, ...)
├── data-model.md                  # data shape (current); cross-refs firebase-alt-schema.md post-cutover
├── firebase-migration.md          # ACTIVE migration plan
├── firebase-alt-schema.md         # data + rules reference for the migration
├── open-questions.md              # active ambiguities + [RESOLVED] trail
├── build-plan.md                  # Apps Script chunk plan (historical post-cutover)
├── sheet-setup.md                 # Apps Script Sheet schema (historical post-cutover)
├── TASKS.md                       # cross-cutting work-in-flight
├── BUGS.md                        # cross-cutting defects
├── changelog/                     # per-chunk and per-phase entries
│   ├── README.md
│   ├── template.md
│   └── chunk-N-*.md / phase-N-*.md
└── runbooks/                      # per-procedure operator playbooks (summaries; full ones in infra/runbooks/)
```

## Conventions

- **Spec changes happen in lockstep with code changes.** Same commit. Never let `spec.md` describe yesterday's design.
- **Architecture decisions are numbered** (D1, D2, ...). Cite them in commit messages when overriding one.
- **Per-phase changelog entries** follow `changelog/template.md`. Migration phase entries: `phase-N-<slug>.md`.
- **Cross-doc references are explicit** — e.g., "see `firebase-alt-schema.md` §6". Avoid vague pointers like "see the architecture doc."
- **Open questions get [RESOLVED YYYY-MM-DD] trails** when closed; original wording preserved.

## Don't

- **Don't write code.** You don't own `apps/`, `functions/`, `firestore/`, `infra/`. You convert their decisions into doc updates.
- **Don't create new top-level docs without checking** if existing ones cover the topic.
- **Don't let `firebase-migration.md` and `firebase-alt-schema.md` drift.** They reference each other; updates to one often need a corresponding update.
- **Don't archive resolved items prematurely.** Resolved-and-recent stays in the doc with a [RESOLVED] tag; archived only when stale.

## Boundaries

- **Engineering agent changes behaviour** → you update `spec.md` in lockstep.
- **Engineering agent makes a decision worth recording** → you add to `architecture.md` (next D-number).
- **Engineering agent ships a phase** → you write the `changelog/phase-N-*.md` entry.
- **TASKS.md / BUGS.md** structure is yours; content is appended by any agent. You archive resolved entries weekly.

## Migration-period special handling

During Phases 1–11, both worlds (Apps Script in `src/`, Firebase monorepo) coexist. The docs reflect this:

- `spec.md` describes Apps Script reality until Phase 11. Behaviour-preserving Phases 4–7 don't change `spec.md`. Phase 11 cutover commits update `spec.md` to describe Firebase reality.
- `architecture.md` gets new D-numbers for migration-era decisions; old D1–D10 retained as historical record.
- `firebase-migration.md` is the live plan; updates as phases ship.
- Per-phase changelog entries land alongside each phase's final commit.
