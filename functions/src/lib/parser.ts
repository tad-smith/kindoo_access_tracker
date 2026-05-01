// Pure parsing helpers for the LCR callings sheet — no Firestore, no
// Sheets API, no clock. The Importer feeds tab values in and reads
// `ParsedRow[]` out, then resolves desired Firestore state from the
// rows in a separate step. Unit tests cover this surface in detail.
//
// Ported from `src/services/Importer.gs` per `docs/spec.md` §8 with
// the schema-driven differences noted in §Phase 8 (no source_row_hash;
// callings collapse to one seat per email; split-ownership of
// importer_callings vs manual_grants).

/** One parsed row — either a calling assignment or a skip warning. */
export type ParsedRow = {
  /** `'stake'` or a ward_code. Same as the tab's resolved scope. */
  scope: string;
  /** Calling name, with the ward prefix already stripped. */
  calling: string;
  /** Typed display email (preserved as cells render it). */
  email: string;
  /** Display name; may be empty if the cell had fewer names than emails. */
  name: string;
  /** `give_app_access` from the matched template. Drives Access doc. */
  giveAppAccess: boolean;
};

export type ParseWarning = {
  tab: string;
  row: number;
  message: string;
};

export type ParseResult = {
  rows: ParsedRow[];
  warnings: ParseWarning[];
};

/** Build a per-template lookup index from a list of templates. */
export type TemplateRow = {
  calling_name: string;
  give_app_access: boolean;
  sheet_order: number;
};

export type TemplateIndex = {
  exact: Map<string, TemplateRow>;
  /** Wildcards in sheet_order ascending; first match wins. */
  wildcards: Array<TemplateRow & { regex: RegExp }>;
};

export function buildTemplateIndex(rows: TemplateRow[]): TemplateIndex {
  const exact = new Map<string, TemplateRow>();
  const wildcards: Array<TemplateRow & { regex: RegExp }> = [];
  for (const row of rows) {
    const name = row.calling_name;
    if (!name) continue;
    if (name.indexOf('*') === -1) {
      exact.set(name, row);
    } else {
      wildcards.push({ ...row, regex: wildcardToRegex(name) });
    }
  }
  wildcards.sort((a, b) => a.sheet_order - b.sheet_order);
  return { exact, wildcards };
}

/** Match a calling-name against the index. Exact wins; among wildcards, sheet_order. */
export function matchTemplate(index: TemplateIndex, callingName: string): TemplateRow | null {
  const e = index.exact.get(callingName);
  if (e) return e;
  for (const w of index.wildcards) {
    if (w.regex.test(callingName)) return w;
  }
  return null;
}

/** Turn a wildcard pattern (with `*`) into an anchored regex. */
export function wildcardToRegex(pattern: string): RegExp {
  const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const rx = escaped.replace(/\*/g, '.*');
  return new RegExp('^' + rx + '$');
}

/**
 * Locate the header row — within the first 5 rows that has a `Position`
 * cell anywhere AND `Name` (exact, case-insensitive) at column D AND a
 * `Personal Email`-bearing cell at column E. Returns the header row's
 * index plus the `Position` column index, or `null` on failure.
 */
export function findHeaderRow(values: string[][]): { headerIdx: number; posIdx: number } | null {
  const NAME_IDX = 3;
  const EMAIL_IDX = 4;
  const scanLimit = Math.min(values.length, 5);
  for (let r = 0; r < scanLimit; r++) {
    const row = values[r] ?? [];
    const posIdx = findHeaderCol(row, 'Position');
    if (posIdx === -1) continue;
    if (row.length <= EMAIL_IDX) continue;
    if (!looksLikeNameHeader(row[NAME_IDX])) continue;
    if (!looksLikePersonalEmailHeader(row[EMAIL_IDX])) continue;
    return { headerIdx: r, posIdx };
  }
  return null;
}

function findHeaderCol(headers: string[], name: string): number {
  for (let i = 0; i < headers.length; i++) {
    if (String(headers[i] ?? '').trim() === name) return i;
  }
  return -1;
}

function looksLikeNameHeader(cell: string | undefined): boolean {
  if (cell == null) return false;
  return String(cell).trim().toLowerCase() === 'name';
}

function looksLikePersonalEmailHeader(cell: string | undefined): boolean {
  if (cell == null) return false;
  return String(cell).trim().toLowerCase().indexOf('personal email') !== -1;
}

/**
 * Split a Name cell into an ordered list. LCR writes multi-person
 * callings as a comma-delimited list; trim each, drop empties.
 */
export function splitNames(cell: string | undefined): string[] {
  if (cell == null) return [];
  const s = String(cell).trim();
  if (!s) return [];
  return s
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Extract sign-in email from a Personal Email cell. LCR's
 * `[GoogleAccount: foo@gmail.com]` override syntax wins; otherwise
 * return the trimmed cell. Empty / malformed → ''.
 */
export function extractEmailFromCell(v: string | undefined): string {
  if (v == null) return '';
  const s = String(v).trim();
  if (!s) return '';
  const m = s.match(/\[\s*GoogleAccount\s*:\s*([^\]]+?)\s*\]/i);
  if (m && m[1]) {
    const inner = cleanEmail(m[1]);
    if (inner) return inner;
  }
  const stripped = s
    .replace(/\s*\[\s*GoogleAccount\s*:[^\]]*\]\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleanEmail(stripped);
}

/** Trim only - preserves dots, +suffix, casing on the typed display form. */
function cleanEmail(s: string): string {
  return String(s).trim();
}

/** Tab-to-scope resolution. */
export type TabScope =
  | { kind: 'stake'; scope: 'stake'; prefix: '' }
  | { kind: 'ward'; scope: string; prefix: string }
  | { kind: 'skip'; reason: 'unknown' };

export function resolveTabScope(tabName: string, wardCodes: ReadonlySet<string>): TabScope {
  if (tabName === 'Stake') return { kind: 'stake', scope: 'stake', prefix: '' };
  if (wardCodes.has(tabName)) return { kind: 'ward', scope: tabName, prefix: tabName };
  return { kind: 'skip', reason: 'unknown' };
}

/**
 * Parse one tab's worth of values. Returns matched rows + warnings.
 * Skips rows with non-template callings, blank emails, or prefix
 * mismatches. Warnings are advisory; the importer still completes.
 */
export function parseTab(opts: {
  tabName: string;
  values: string[][];
  scope: string;
  prefix: string;
  templateIndex: TemplateIndex;
}): ParseResult {
  const rows: ParsedRow[] = [];
  const warnings: ParseWarning[] = [];
  const { tabName, values, scope, prefix, templateIndex } = opts;

  if (values.length < 2) return { rows, warnings };
  const header = findHeaderRow(values);
  if (!header) {
    const preview = (values[0] ?? [])
      .slice(0, 10)
      .map((v) => JSON.stringify(v))
      .join(', ');
    warnings.push({
      tab: tabName,
      row: 1,
      message: `header row not found (expected within top 5 rows: "Position" anywhere, "Name" col D, "Personal Email" col E). Row 1: [${preview}]. Skipping tab.`,
    });
    return { rows, warnings };
  }

  const NAME_IDX = 3;
  const EMAIL_IDX = 4;
  const prefixToken = prefix ? `${prefix} ` : '';

  for (let r = header.headerIdx + 1; r < values.length; r++) {
    const row = values[r] ?? [];
    const positionRaw = row[header.posIdx];
    if (positionRaw == null || positionRaw === '') continue;
    const position = String(positionRaw).trim();
    if (!position) continue;

    let callingName: string;
    if (!prefixToken) {
      callingName = position;
    } else if (position.indexOf(prefixToken) === 0) {
      callingName = position.substring(prefixToken.length).trim();
    } else if (position === prefix) {
      continue;
    } else {
      warnings.push({
        tab: tabName,
        row: r + 1,
        message: `Position "${position}" does not start with expected prefix "${prefixToken}" — skipped.`,
      });
      continue;
    }
    if (!callingName) continue;

    const tpl = matchTemplate(templateIndex, callingName);
    if (!tpl) continue;

    const names = splitNames(row[NAME_IDX]);
    const emails: string[] = [];
    for (let c = EMAIL_IDX; c < row.length; c++) {
      const e = extractEmailFromCell(row[c]);
      if (e) emails.push(e);
    }
    if (emails.length === 0) continue;

    for (let i = 0; i < emails.length; i++) {
      const email = emails[i]!;
      const name = i < names.length ? names[i]! : '';
      rows.push({
        scope,
        calling: callingName,
        email,
        name,
        giveAppAccess: tpl.give_app_access === true,
      });
    }
  }
  return { rows, warnings };
}
