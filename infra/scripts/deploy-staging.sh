#!/usr/bin/env bash
#
# deploy-staging.sh — operator-triggered deploy of the Firebase port to
# the `kindoo-staging` Firebase project.
#
# What it does:
#   1. Stamps the build version (writes apps/web/src/version.gen.ts and
#      functions/src/version.gen.ts — both gitignored) so the deployed
#      bundle reports its git short SHA + UTC build timestamp.
#   2. Runs typecheck across all workspaces (`tsc -b`).
#   3. Builds the web SPA (`pnpm --filter ./apps/web build`).
#   4. Builds the Cloud Functions (`pnpm --filter ./functions build`).
#   5. Deploys Hosting + Functions + Firestore (rules + indexes) via the
#      Firebase CLI, targeting the `staging` alias defined in .firebaserc.
#
# Steps were: stamp / typecheck / test / build-web / build-functions /
# firebase deploy. Step 3 (test) was removed because the local script
# doesn't boot emulators; CI is the test gate. The operator triggers
# deploys only after CI is green on `main`, and CI already runs
# lint + typecheck + unit + rules + integration + e2e + build against
# the same commit. An operator who wants belt-and-suspenders local
# verification can run `pnpm test` themselves before invoking this
# script.
#
# What it assumes:
#   - You're at the repo root (the script tolerates being invoked from
#     any cwd; it cds to repo root).
#   - pnpm + node 20+ + firebase-tools are installed.
#   - You're signed in: `firebase login`.
#   - The .firebaserc `staging` alias resolves to a real Firebase project
#     under your Google account.
#
# What it requires (default mode):
#   - You're on the `main` branch.
#   - Local `main` is up-to-date with `origin/main`.
#   - Working tree is clean. The stamper writes only to gitignored
#     `version.gen.ts` files, so the tree stays clean across runs.
#
# What it requires (`--from-pr <number>` mode):
#   - `gh` CLI installed and authenticated.
#   - Working tree is clean (we will swap branches under you).
#   - PR <number> exists and is OPEN.
#   The main-branch / up-to-date-with-origin guards are skipped — the
#   point of `--from-pr` is to deploy a non-main branch.
#
# What it leaves behind:
#   - Updated apps/web/src/version.gen.ts and functions/src/version.gen.ts
#     (gitignored; not committed).
#   - apps/web/dist/ and functions/lib/ build artifacts (gitignored).
#   - In `--from-pr` mode: the branch you started on is restored on exit
#     (success OR failure) via a `trap`.
#
# REQUIRES: Operator task **B1** in docs/firebase-migration.md must be
# complete before this script can run successfully against the cloud:
# real Firebase projects must exist, billing must be linked, service
# accounts must be provisioned. Until B1, this script can be exercised
# in --dry-run mode only.
#
# Usage:
#   bash infra/scripts/deploy-staging.sh                    # full deploy from main
#   bash infra/scripts/deploy-staging.sh --dry-run          # echo every command
#                                                           # without running
#   bash infra/scripts/deploy-staging.sh --from-pr 26       # check out PR #26 and
#                                                           # deploy its branch to
#                                                           # staging (no merge);
#                                                           # restores your branch
#                                                           # on exit
#   bash infra/scripts/deploy-staging.sh --from-pr 26 --dry-run
#   bash infra/scripts/deploy-staging.sh --web-only         # deploy hosting only;
#                                                           # skip the functions
#                                                           # build + skip functions
#                                                           # and firestore deploy
#                                                           # targets. Stamper
#                                                           # still runs (web bundle
#                                                           # needs the version).
#   bash infra/scripts/deploy-staging.sh --from-pr 26 --web-only
#
# `--web-only` composes with `--from-pr` in either order. It is
# intentionally staging-only — production must always ship the full
# stack so hosting + functions + rules stay in lockstep.

set -euo pipefail

DRY_RUN=0
FROM_PR=''
WEB_ONLY=0

# Two-token flag parsing: --from-pr <number>.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --from-pr)
      if [[ $# -lt 2 ]]; then
        echo "error: --from-pr requires a PR number argument." >&2
        echo "Usage: $0 [--dry-run] [--from-pr <number>] [--web-only]" >&2
        exit 2
      fi
      FROM_PR="$2"
      shift 2
      ;;
    --web-only)
      WEB_ONLY=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [--dry-run] [--from-pr <number>] [--web-only]" >&2
      exit 2
      ;;
  esac
done

# Validate --from-pr is a positive integer (no leading zeros, no signs, no spaces).
if [[ -n "$FROM_PR" ]]; then
  if ! [[ "$FROM_PR" =~ ^[1-9][0-9]*$ ]]; then
    echo "error: --from-pr value must be a positive integer. Got: '$FROM_PR'" >&2
    exit 2
  fi
fi

# cd to repo root regardless of where the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] $*"
  else
    echo "[run] $*"
    eval "$*"
  fi
}

if [[ -n "$FROM_PR" ]]; then
  echo "=== deploy-staging.sh — testing PR #$FROM_PR on staging ==="
else
  echo "=== deploy-staging.sh — target: kindoo-staging (alias: staging) ==="
fi
echo "    repo root: $REPO_ROOT"
echo "    dry run:   $DRY_RUN"
echo "    from PR:   ${FROM_PR:-<none>}"
echo "    web-only:  $WEB_ONLY"
echo ""

# Guard: deploys ship from `main`, full-stop.
#
# Triggered after the hello-on-staging incident (2026-04-28): operator
# deployed Phase 5 from a topic branch forked off main *before* a
# cleanup PR landed; the predeploy build hook ran against the topic
# branch's source, so a `hello` Cloud Function — already removed on
# main — was created on staging.
#
# Three checks, run before the stamper (which writes only to gitignored
# `version.gen.ts` files, so guard re-entry on the next deploy stays
# clean):
#   1. current branch == `main`
#   2. local HEAD == origin/main (after a fresh fetch)
#   3. working tree is clean
#
# No --force / --allow-dirty escape hatch. If the operator really
# needs to override, they can edit the script.
#
# `--from-pr` mode bypasses checks 1 and 2 (the whole point is to
# deploy a non-main branch). Check 3 still applies.
guard_main_clean() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] would: git symbolic-ref --short HEAD must == 'main'"
    echo "[dry-run] would: git fetch origin main"
    echo "[dry-run] would: git rev-parse HEAD must == git rev-parse origin/main"
    echo "[dry-run] would: git status --porcelain must be empty"
    return 0
  fi

  local current_branch
  current_branch="$(git symbolic-ref --short HEAD 2>/dev/null || echo '<detached>')"
  if [[ "$current_branch" != "main" ]]; then
    echo "error: deploy must run from \`main\`. You are on \`$current_branch\`." >&2
    echo "To deploy: \`git checkout main && git pull --ff-only\`" >&2
    exit 1
  fi

  git fetch origin main >/dev/null 2>&1 || {
    echo "error: \`git fetch origin main\` failed. Check your network and remote." >&2
    exit 1
  }

  local local_sha origin_sha
  local_sha="$(git rev-parse HEAD)"
  origin_sha="$(git rev-parse origin/main)"
  if [[ "$local_sha" != "$origin_sha" ]]; then
    echo "error: local main is not up-to-date with origin/main." >&2
    echo "local:  $local_sha" >&2
    echo "origin: $origin_sha" >&2
    echo "To deploy: \`git pull --ff-only\` (if behind) or push your local commits and merge upstream first (if ahead)." >&2
    exit 1
  fi

  local dirty
  dirty="$(git status --porcelain)"
  if [[ -n "$dirty" ]]; then
    echo "error: working tree has uncommitted changes. Stash or commit before deploying." >&2
    echo "$dirty" >&2
    exit 1
  fi
}

# Working-tree-clean check used in --from-pr mode (subset of
# guard_main_clean: branch + origin/main checks are intentionally
# skipped).
guard_clean_tree() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] would: git status --porcelain must be empty"
    return 0
  fi

  local dirty
  dirty="$(git status --porcelain)"
  if [[ -n "$dirty" ]]; then
    echo "error: working tree has uncommitted changes. Stash or commit before deploying." >&2
    echo "$dirty" >&2
    exit 1
  fi
}

# --from-pr cleanup. Restores the branch the operator started on. The
# stamper writes only to gitignored `version.gen.ts` files (see
# .gitignore lines 53–56), so we don't need `git checkout --` to
# discard them. Idempotent: safe to call from a trap even if we never
# left the original branch.
ORIGINAL_BRANCH=''
restore_original_branch() {
  if [[ -z "$ORIGINAL_BRANCH" ]]; then
    return 0
  fi
  local current
  current="$(git symbolic-ref --short HEAD 2>/dev/null || echo '<detached>')"
  if [[ "$current" == "$ORIGINAL_BRANCH" ]]; then
    return 0
  fi
  echo ""
  echo "=== restoring original branch: $ORIGINAL_BRANCH (was on: $current) ==="
  git checkout "$ORIGINAL_BRANCH" || {
    echo "warn: could not restore branch '$ORIGINAL_BRANCH'. You are on '$current'." >&2
    return 0
  }
}

if [[ -n "$FROM_PR" ]]; then
  # `gh` auth precheck. Read-only; safe to run in dry-run too.
  if ! gh auth status >/dev/null 2>&1; then
    echo "error: \`gh\` CLI is not authenticated. Run \`gh auth login\` and retry." >&2
    exit 1
  fi

  # Fetch PR metadata. Aborts if the PR doesn't exist.
  PR_JSON="$(gh pr view "$FROM_PR" --json title,headRefName,author,commits,state 2>/dev/null)" || {
    echo "error: could not fetch PR #$FROM_PR. Does it exist? Are you in the right repo?" >&2
    exit 1
  }

  PR_STATE="$(printf '%s' "$PR_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("state",""))')"
  if [[ "$PR_STATE" != "OPEN" ]]; then
    echo "error: PR #$FROM_PR is not OPEN (state: $PR_STATE). Refusing to deploy a closed/merged PR's branch." >&2
    exit 1
  fi

  PR_TITLE="$(printf '%s' "$PR_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("title",""))')"
  PR_BRANCH="$(printf '%s' "$PR_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("headRefName",""))')"
  PR_AUTHOR="$(printf '%s' "$PR_JSON" | python3 -c 'import json,sys;d=json.load(sys.stdin).get("author") or {};print(d.get("login",""))')"
  PR_COMMITS="$(printf '%s' "$PR_JSON" | python3 -c 'import json,sys;print(len(json.load(sys.stdin).get("commits",[])))')"

  echo "PR title: $PR_TITLE"
  echo "PR branch: $PR_BRANCH"
  echo "PR author: $PR_AUTHOR"
  echo "Commits ahead of main: $PR_COMMITS"
  echo ""

  # Capture original branch BEFORE checkout so the trap can restore it.
  ORIGINAL_BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo '')"
  if [[ -z "$ORIGINAL_BRANCH" ]]; then
    echo "error: could not determine current branch (detached HEAD?). Refusing to proceed." >&2
    exit 1
  fi

  # Install cleanup trap. Fires on success, error, or signal.
  trap restore_original_branch EXIT

  guard_clean_tree

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] would: gh pr checkout $FROM_PR"
    echo "[dry-run] on exit (trap): would restore branch '$ORIGINAL_BRANCH'"
    echo "[dry-run] note: version.gen.ts files are gitignored (.gitignore lines 53-56);"
    echo "[dry-run]       no \`git checkout --\` needed to discard stamper output."
  else
    run "gh pr checkout $FROM_PR"
  fi
else
  guard_main_clean
fi

# Step 1: stamp version. Always runs — the web bundle reads
# version.gen.ts at build time, so even --web-only needs it.
run "node infra/scripts/stamp-version.js"

# Step 2: typecheck across workspaces.
run "pnpm typecheck"

# Step 3: build web.
run "pnpm --filter ./apps/web build"

# Step 4: build functions. Skipped under --web-only since we won't
# deploy them.
if [[ "$WEB_ONLY" -eq 1 ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] skip: pnpm --filter ./functions build (--web-only)"
  else
    echo "[skip] pnpm --filter ./functions build (--web-only)"
  fi
else
  run "pnpm --filter ./functions build"
fi

# Step 5: deploy via Firebase CLI.
# Note on what gets deployed:
#   Default: --only hosting,functions,firestore covers everything
#   Phase 1 produces. firestore deploy = rules + indexes (firebase.json
#   points at firestore/firestore.rules and firestore/firestore.indexes.json).
#   --web-only: --only hosting — narrows to the SPA bundle. Functions
#   and rules+indexes already on staging keep their current revision.
if [[ "$WEB_ONLY" -eq 1 ]]; then
  run "firebase deploy --project staging --only hosting"
else
  run "firebase deploy --project staging --only hosting,functions,firestore"
fi

echo ""
echo "=== deploy-staging.sh complete ==="
