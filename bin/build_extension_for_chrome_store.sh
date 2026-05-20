#!/usr/bin/env bash
set -euo pipefail

# Build the production extension for Chrome Web Store upload.
# Strips the manifest `key` field (Chrome rejects packages carrying it
# on Web Store uploads) and zips the result.
#
# Prerequisite: extension/.env.production exists with
# VITE_GOOGLE_OAUTH_CLIENT_ID bound to the Web Store extension ID's
# OAuth client. See infra/runbooks/extension-deploy.md.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

VITE_OMIT_KEY=true pnpm --filter @kindoo/extension build

DIST="extension/dist/production"
VERSION=$(node -e "console.log(require('./$DIST/manifest.json').version)")
ZIP="extension/dist/sba-$VERSION.zip"

rm -f "$ZIP"
( cd "$DIST" && zip -rq "../sba-$VERSION.zip" . )

echo "Built: $ZIP"
