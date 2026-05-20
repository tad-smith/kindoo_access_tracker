#!/usr/bin/env bash
set -euo pipefail

PR="$1"

gh pr ready "$PR" && gh pr merge "$PR" --squash --delete-branch
