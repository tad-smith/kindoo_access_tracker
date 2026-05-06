// Sheets API wrapper. The importer reads the LCR callings sheet via
// the function's service account; staging/prod inject creds via ADC,
// in-process integration tests inject a fixture via `_setSheetFetcher`,
// and out-of-process E2E tests (Playwright driving the live Functions
// emulator) seed a fixture into Firestore that the emulator-only fetcher
// reads on each call. The Firestore-backed fixture path is gated by the
// `FUNCTIONS_EMULATOR=true` env var that the Firebase emulator sets on
// every callable + trigger invocation, so production never touches it.
//
// Returns a uniform shape: each tab's name plus a 2-D array of cell
// values (strings). The caller (Importer) parses headers + rows from
// this shape so the parser stays Sheets-API-decoupled.

import { google } from 'googleapis';
import { getDb } from './admin.js';

export type SheetTab = {
  /** Tab name (e.g. `'Stake'`, `'CO'`). */
  name: string;
  /** Row-major cell values; missing trailing cells trimmed by Sheets API. */
  values: string[][];
};

export type SheetFetcher = (sheetId: string) => Promise<SheetTab[]>;

/**
 * Doc path the emulator-only fetcher reads its fixture from. Tests seed
 * `{ tabs: SheetTab[] }` at this path before invoking the importer.
 * Firestore doc IDs cannot contain '/' so we use the encoded sheet id.
 */
function emulatorFixturePath(sheetId: string): string {
  return `_e2eFixtures/sheets__${encodeURIComponent(sheetId)}`;
}

/**
 * Emulator-only fetcher — reads the fixture seeded by the e2e test from
 * `_e2eFixtures/sheets__{sheetId}`. Throws if the fixture is missing so
 * the test fails loud rather than silently exercising the real Sheets
 * API path (which would 401 against the emulator).
 */
const emulatorSheetFetcher: SheetFetcher = async (sheetId) => {
  const db = getDb();
  const snap = await db.doc(emulatorFixturePath(sheetId)).get();
  if (!snap.exists) {
    throw new Error(
      `Sheets emulator fixture missing for sheetId="${sheetId}". ` +
        `Seed _e2eFixtures/sheets__${encodeURIComponent(sheetId)} { tabs: SheetTab[] } before invoking the importer.`,
    );
  }
  const data = snap.data() as { tabs?: SheetTab[] } | undefined;
  return data?.tabs ?? [];
};

/**
 * Default fetcher — uses `google.sheets({version: 'v4'})` against ADC.
 * In Cloud Functions the runtime exposes the function's service account
 * automatically; locally `gcloud auth application-default login` works.
 */
export const defaultSheetFetcher: SheetFetcher = async (sheetId) => {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // First call: list all tab names so we can request their values.
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: 'sheets(properties(title))',
  });
  const tabNames =
    meta.data.sheets
      ?.map((s) => s.properties?.title)
      .filter((n): n is string => typeof n === 'string') ?? [];
  if (tabNames.length === 0) return [];

  // Second call: batchGet over each tab. `valueRenderOption=FORMATTED_VALUE`
  // returns the same strings the operator sees (we don't need raw
  // numerics — the importer reads names + emails as text).
  const ranges = tabNames.map((n) => `'${n.replace(/'/g, "''")}'`);
  const batch = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: sheetId,
    ranges,
    valueRenderOption: 'FORMATTED_VALUE',
  });

  const result: SheetTab[] = [];
  const ranges_ = batch.data.valueRanges ?? [];
  for (let i = 0; i < tabNames.length; i++) {
    const name = tabNames[i]!;
    const values = (ranges_[i]?.values ?? []) as string[][];
    result.push({ name, values });
  }
  return result;
};

let activeFetcher: SheetFetcher = defaultSheetFetcher;
let activeFetcherOverridden = false;

/**
 * Get the currently-active sheet fetcher. Under the Functions emulator
 * (`FUNCTIONS_EMULATOR=true`), if no in-process override is registered
 * via `_setSheetFetcher`, we route to the Firestore-doc-backed fixture
 * fetcher so out-of-process Playwright tests can drive deterministic
 * runs. Production + integration tests with `_setSheetFetcher` set keep
 * their existing behaviour.
 */
export function getSheetFetcher(): SheetFetcher {
  if (!activeFetcherOverridden && process.env['FUNCTIONS_EMULATOR'] === 'true') {
    return emulatorSheetFetcher;
  }
  return activeFetcher;
}

/**
 * Test hook — replace the active fetcher. Returns a restore function.
 * Used by importer integration tests to feed fixture sheet data.
 * Setting an override also disables the emulator-fixture short-circuit
 * in `getSheetFetcher` so the existing in-process integration tests
 * keep their semantics unchanged when run under `emulators:exec`.
 */
export function _setSheetFetcher(fetcher: SheetFetcher): () => void {
  const prev = activeFetcher;
  const prevOverridden = activeFetcherOverridden;
  activeFetcher = fetcher;
  activeFetcherOverridden = true;
  return () => {
    activeFetcher = prev;
    activeFetcherOverridden = prevOverridden;
  };
}
