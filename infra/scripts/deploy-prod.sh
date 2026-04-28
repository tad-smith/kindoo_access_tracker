#!/usr/bin/env bash
#
# deploy-prod.sh — operator-triggered deploy of the Firebase port to the
# `kindoo-prod` Firebase project. Production deploy.
#
# What it does:
#   Same as deploy-staging.sh, but targets the `prod` alias defined in
#   .firebaserc and (eventually) gates on stricter pre-flight checks:
#     - explicit operator confirmation (typed yes)
#     - clean git working tree
#     - HEAD is a commit on main
#     - staging deploy has already passed for this commit
#   Those gates are TODOs until B1 lands.
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
# TODO (post-B1, pre-Phase-11): require clean working tree:
#   git diff-index --quiet HEAD -- || { echo "dirty working tree"; exit 1; }

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
