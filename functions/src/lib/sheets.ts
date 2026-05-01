// Sheets API wrapper. The importer reads the LCR callings sheet via
// the function's service account; staging/prod inject creds via ADC,
// emulator + tests inject a mock fetcher.
//
// Returns a uniform shape: each tab's name plus a 2-D array of cell
// values (strings). The caller (Importer) parses headers + rows from
// this shape so the parser stays Sheets-API-decoupled.

import { google } from 'googleapis';

export type SheetTab = {
  /** Tab name (e.g. `'Stake'`, `'CO'`). */
  name: string;
  /** Row-major cell values; missing trailing cells trimmed by Sheets API. */
  values: string[][];
};

export type SheetFetcher = (sheetId: string) => Promise<SheetTab[]>;

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

/** Get the currently-active sheet fetcher. */
export function getSheetFetcher(): SheetFetcher {
  return activeFetcher;
}

/**
 * Test hook — replace the active fetcher. Returns a restore function.
 * Used by importer integration tests to feed fixture sheet data.
 */
export function _setSheetFetcher(fetcher: SheetFetcher): () => void {
  const prev = activeFetcher;
  activeFetcher = fetcher;
  return () => {
    activeFetcher = prev;
  };
}
