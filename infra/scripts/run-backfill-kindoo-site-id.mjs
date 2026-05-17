#!/usr/bin/env node
// run-backfill-kindoo-site-id.mjs — T-42 one-shot migration driver.
//
// Invokes the `backfillKindooSiteId` callable in `kindoo-staging` or
// `kindoo-prod` for one stake. The callable backfills
// `Seat.kindoo_site_id`, every `Seat.duplicate_grants[].kindoo_site_id`,
// and the `Seat.duplicate_scopes` mirror; it is skip-if-equal so re-runs
// over an already-migrated stake produce zero writes (and zero audit
// rows). Counters are printed on completion so the operator can sanity-
// check the diff.
//
// Auth model. The operator authenticates the SPA via Google OAuth and
// has no email/password credential; this script can't use
// `signInWithEmailAndPassword`. Instead it uses the Admin SDK to mint
// a Firebase custom token for the operator's existing UID, then signs
// in via `signInWithCustomToken`. The callable's authority check reads
// `stakes/{stakeId}/kindooManagers/{canonicalEmail}` and requires
// `active: true`, so the `--as` user must be an active Kindoo Manager
// of the target stake (the bootstrap admin `admin@csnorth.org` is the
// safe default).
//
// Prerequisites:
//   - `gcloud auth application-default login` as a user with
//     `roles/firebaseauth.admin` on the target project (needed to mint
//     custom tokens via the Admin SDK).
//   - `apps/web/.env.staging` (for `--project kindoo-staging`) or
//     `apps/web/.env.production` (for `--project kindoo-prod`)
//     populated with the project's web SDK config (per
//     `apps/web/.env.example`).
//   - `pnpm install` has been run at the repo root so `infra/`'s
//     `firebase-admin` + `firebase` deps are resolvable.
//
// Usage:
//   node infra/scripts/run-backfill-kindoo-site-id.mjs \
//     --project kindoo-staging \
//     --stake csnorth \
//     --as admin@csnorth.org
//
// Exits 0 on success, 1 on any error (with the error printed).

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initializeApp as initAdminApp, getApps as getAdminApps } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';

import { initializeApp as initClientApp } from 'firebase/app';
import { getAuth as getClientAuth, signInWithCustomToken } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const KNOWN_PROJECTS = {
  'kindoo-staging': { envMode: 'staging' },
  'kindoo-prod': { envMode: 'production' },
};

// All 2nd-gen callables run in us-central1 unless overridden via
// `setGlobalOptions` or per-function. Functions in this project don't
// override, so us-central1 is correct.
const REGION = 'us-central1';

function parseArgs(argv) {
  const args = { project: null, stake: null, as: 'admin@csnorth.org' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const eat = () => argv[i + 1];
    if (a === '--project') {
      args.project = eat();
      i += 1;
    } else if (a === '--stake') {
      args.stake = eat();
      i += 1;
    } else if (a === '--as') {
      args.as = eat();
      i += 1;
    } else if (a === '-h' || a === '--help') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function printUsage() {
  // eslint-disable-next-line no-console
  console.log(
    [
      'Usage:',
      '  node infra/scripts/run-backfill-kindoo-site-id.mjs \\',
      '    --project <kindoo-staging|kindoo-prod> \\',
      '    --stake <stakeId> \\',
      '    [--as <operator-email>]',
      '',
      'Defaults: --as admin@csnorth.org',
    ].join('\n'),
  );
}

// Minimal dotenv parser. `apps/web/.env.{staging,production}` is a plain
// KEY=VALUE file (no quoting, no interpolation, no export prefix) — see
// `apps/web/.env.example`. We don't pull `dotenv` as a dep just for this.
function readDotenv(path) {
  const text = readFileSync(path, 'utf8');
  const out = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadFirebaseWebConfig(project) {
  const { envMode } = KNOWN_PROJECTS[project];
  const envPath = join(REPO_ROOT, 'apps', 'web', `.env.${envMode}`);
  if (!existsSync(envPath)) {
    throw new Error(
      `Missing ${envPath}. Populate it from apps/web/.env.example with the ${project} web SDK config.`,
    );
  }
  const env = readDotenv(envPath);
  const required = ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_PROJECT_ID'];
  for (const key of required) {
    if (!env[key]) {
      throw new Error(`${envPath} is missing ${key}. Re-populate from apps/web/.env.example.`);
    }
  }
  if (env.VITE_FIREBASE_PROJECT_ID !== project) {
    throw new Error(
      `${envPath} has VITE_FIREBASE_PROJECT_ID='${env.VITE_FIREBASE_PROJECT_ID}', expected '${project}'. Mismatched env file for the target project.`,
    );
  }
  return {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    appId: env.VITE_FIREBASE_APP_ID,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  };
}

function formatCounters(out, durationMs, stake, project) {
  const pad = (v, w) => String(v).padStart(w);
  const lines = [
    `Backfill complete for stake '${stake}' on project '${project}':`,
    `  Seats total:                        ${pad(out.seats_total, 6)}`,
    `  Seats updated:                      ${pad(out.seats_updated, 6)}`,
    `  Primary kindoo_site_id skipped:     ${pad(out.primary_kindoo_site_id_skipped, 6)}  (missing ward)`,
    `  Duplicate grants updated:           ${pad(out.duplicates_updated, 6)}`,
    `  Duplicate grants skipped:           ${pad(out.duplicates_skipped_missing_ward, 6)}  (missing ward)`,
    `  Duration:                           ${pad(durationMs, 6)}ms`,
  ];
  if (Array.isArray(out.warnings) && out.warnings.length > 0) {
    lines.push('', `Warnings (${out.warnings.length}):`);
    for (const w of out.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (!args.project) throw new Error('--project is required');
  if (!KNOWN_PROJECTS[args.project]) {
    throw new Error(
      `Unknown --project '${args.project}'. Expected one of: ${Object.keys(KNOWN_PROJECTS).join(', ')}`,
    );
  }
  if (!args.stake) throw new Error('--stake is required');
  if (!args.as) throw new Error('--as is required');

  const webConfig = loadFirebaseWebConfig(args.project);

  // Admin SDK: app-default credentials. `gcloud auth application-default
  // login` writes a usable ADC; CI service-account JSONs work too via
  // GOOGLE_APPLICATION_CREDENTIALS. The Admin SDK picks the project from
  // ADC by default; we pin it explicitly so a mismatched ADC fails loud.
  if (getAdminApps().length === 0) {
    initAdminApp({ projectId: args.project });
  }
  const adminAuth = getAdminAuth();

  let uid;
  try {
    const user = await adminAuth.getUserByEmail(args.as);
    uid = user.uid;
  } catch (err) {
    throw new Error(
      `Could not look up '${args.as}' in ${args.project}: ${err?.message ?? err}. ` +
        `Confirm the user has signed in to the SPA at least once and that ADC has roles/firebaseauth.admin on ${args.project}.`,
    );
  }

  const customToken = await adminAuth.createCustomToken(uid);

  // Client SDK: sign in with the minted custom token and call the
  // callable. `getFunctions(app, region)` pins the region; the callable
  // lives in us-central1.
  const clientApp = initClientApp(webConfig, `infra-backfill-${Date.now()}`);
  const clientAuth = getClientAuth(clientApp);
  await signInWithCustomToken(clientAuth, customToken);

  const functions = getFunctions(clientApp, REGION);
  const callable = httpsCallable(functions, 'backfillKindooSiteId');

  const startedAt = Date.now();
  const res = await callable({ stakeId: args.stake });
  const durationMs = Date.now() - startedAt;

  // eslint-disable-next-line no-console
  console.log(formatCounters(res.data, durationMs, args.stake, args.project));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err?.stack ?? err);
  process.exit(1);
});
