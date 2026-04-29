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
# What it requires:
#   - You're on the `main` branch.
#   - Local `main` is up-to-date with `origin/main`.
#   - Working tree is clean. The stamper writes only to gitignored
#     `version.gen.ts` files, so the tree stays clean across runs.
#
# What it leaves behind:
#   - Updated apps/web/src/version.gen.ts and functions/src/version.gen.ts
#     (gitignored; not committed).
#   - apps/web/dist/ and functions/lib/ build artifacts (gitignored).
#
# REQUIRES: Operator task **B1** in docs/firebase-migration.md must be
# complete before this script can run successfully against the cloud:
# real Firebase projects must exist, billing must be linked, service
# accounts must be provisioned. Until B1, this script can be exercised
# in --dry-run mode only.
#
# Usage:
#   bash infra/scripts/deploy-staging.sh                # full deploy
#   bash infra/scripts/deploy-staging.sh --dry-run      # echo every
#                                                       # command
#                                                       # without running

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

echo "=== deploy-staging.sh — target: kindoo-staging (alias: staging) ==="
echo "    repo root: $REPO_ROOT"
echo "    dry run:   $DRY_RUN"
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

# Step 2: typecheck across workspaces.
run "pnpm typecheck"

# Step 3: build web.
run "pnpm --filter ./apps/web build"

# Step 4: build functions.
run "pnpm --filter ./functions build"

# Step 5: deploy via Firebase CLI.
# Note on what gets deployed:
#   --only hosting,functions,firestore covers everything Phase 1 produces.
#   firestore deploy = rules + indexes (firebase.json points at firestore/
#   firestore.rules and firestore/firestore.indexes.json).
run "firebase deploy --project staging --only hosting,functions,firestore"

echo ""
echo "=== deploy-staging.sh complete ==="
