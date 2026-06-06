// Pure helpers for rendering a stake-fix callable's result GENERICALLY.
// Kept fix-agnostic: the result is a `Record<string, unknown>` — these
// helpers never reference a specific fix's output shape, so a new fix
// needs no changes here.
//
// A fix result is split into:
//   - `rows`: every scalar (string / number / boolean / null) field,
//     rendered as label / value pairs. A `warnings` array is pulled out
//     and rendered separately; any remaining non-scalar field (object /
//     array) is JSON-stringified so nothing is silently dropped.
//   - `warnings`: the `warnings[]` list, normalized to strings.
//
// `formatFixResultText` produces the plaintext the Copy button writes to
// the clipboard.

export interface FixResultRow {
  key: string;
  value: string;
}

export interface FixResultView {
  rows: FixResultRow[];
  warnings: string[];
}

/** Render a single scalar/JSON value as a display string. */
function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  // Objects / nested arrays: stringify so nothing is dropped from view.
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Project a fix result into display rows + a warnings list. The
 * `warnings` field (if an array) is extracted and excluded from `rows`;
 * every other field becomes a row in insertion order.
 */
export function toFixResultView(result: Record<string, unknown>): FixResultView {
  const warningsIsArray = Array.isArray(result.warnings);
  const warnings = warningsIsArray ? (result.warnings as unknown[]).map((w) => formatValue(w)) : [];
  const rows: FixResultRow[] = [];
  for (const [key, value] of Object.entries(result)) {
    // Only pull `warnings` out of the rows when it's the array we render
    // separately. A non-array `warnings` (an unexpected shape) stays a
    // row so nothing is silently dropped.
    if (key === 'warnings' && warningsIsArray) continue;
    rows.push({ key, value: formatValue(value) });
  }
  return { rows, warnings };
}

/**
 * Plaintext for the Copy button on a successful result. Lists each row
 * as `key: value`, then the warnings (if any) under a header.
 */
export function formatFixResultText(result: Record<string, unknown>): string {
  const { rows, warnings } = toFixResultView(result);
  const lines = rows.map((r) => `${r.key}: ${r.value}`);
  if (warnings.length > 0) {
    lines.push('', `warnings (${warnings.length}):`);
    for (const w of warnings) lines.push(`- ${w}`);
  }
  return lines.join('\n');
}

/** Normalize a thrown error into a `{ code, message }` pair. Firebase
 *  `HttpsError`s carry a `code` (e.g. 'permission-denied'); plain
 *  `Error`s have only a message. */
export function toFixError(err: unknown): { code: string; message: string } {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown };
    const code = typeof e.code === 'string' ? e.code : 'error';
    const message = typeof e.message === 'string' ? e.message : String(err);
    return { code, message };
  }
  return { code: 'error', message: String(err) };
}

/** Plaintext for the Copy button on an error result. */
export function formatFixErrorText(err: unknown): string {
  const { code, message } = toFixError(err);
  return `${code}: ${message}`;
}
