#!/usr/bin/env bash
#
# deploy-prod.sh — operator-triggered deploy of the Firebase port to the
# `kindoo-prod` Firebase project. Production deploy.
#
# What it does:
#   Same as deploy-staging.sh, but targets the `prod` alias defined in
#   .firebaserc. Both scripts now share the same `guard_main_clean`
#   pre-flight (branch == main, local == origin/main, working tree
#   clean). Additional prod-only gates are still TODOs until B1 lands:
#     - explicit operator confirmation (typed yes)
#     - staging deploy has already passed for this commit
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
#   - All the same assumptions as deploy-staging.sh.
#   - You've successfully run deploy-staging.sh on this commit and
#     verified the staging URL works.
#
# What it requires:
#   - You're on the `main` branch.
#   - Local `main` is up-to-date with `origin/main`.
#   - Working tree is clean. The stamper writes only to gitignored
#     `version.gen.ts` files, so the tree stays clean across runs.
#
# What it leaves behind:
#   - Same artifacts as staging.
#   - A deploy is now live in production.
#
# REQUIRES: Operator task **B1** in docs/firebase-migration.md must be
# complete. Additionally, do NOT run this until Phase 11 cutover has been
# scheduled and rehearsed against staging. Migration plan F12 (big-bang
# cutover during a maintenance window) means prod is empty until then.
#
# Usage:
#   bash infra/scripts/deploy-prod.sh                   # full deploy
#                                                       # (will prompt
#                                                       # for confirmation
#                                                       # once gates land)
#   bash infra/scripts/deploy-prod.sh --dry-run         # echo every
#                                                       # command
#                                                       # without running
#
# `--from-pr` is intentionally staging-only (deploy-staging.sh).
# Production must always ship from `main`; testing a PR on prod would
# defeat the staging rehearsal. Don't add it here.

set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--dry-run]" >&2
      exit 2
      ;;
  esac
done

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

echo "=== deploy-prod.sh — target: kindoo-prod (alias: prod) ==="
echo "    repo root: $REPO_ROOT"
echo "    dry run:   $DRY_RUN"
echo ""

# TODO (post-B1, pre-Phase-11): require explicit confirmation before
# proceeding when not in dry-run mode. Something like:
#   if [[ "$DRY_RUN" -eq 0 ]]; then
#     read -r -p "Deploy to PROD (kindoo-prod)? Type 'yes' to confirm: " CONFIRM
#     [[ "$CONFIRM" == "yes" ]] || { echo "aborted"; exit 1; }
#   fi

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

guard_main_clean

# Step 1: stamp version.
run "node infra/scripts/stamp-version.js"

# Step 2: typecheck.
run "pnpm typecheck"

# Step 3: build web.
run "pnpm --filter ./apps/web build"

# Step 4: build functions.
run "pnpm --filter ./functions build"

# Step 5: deploy via Firebase CLI.
run "firebase deploy --project prod --only hosting,functions,firestore"

echo ""
echo "=== deploy-prod.sh complete ==="
