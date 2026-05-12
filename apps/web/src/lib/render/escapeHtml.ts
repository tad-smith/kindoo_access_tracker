// Pure HTML-escape helper. Used by callers that build raw HTML strings
// (the manager audit-log diff renderer is the main consumer; React's
// JSX auto-escapes by default and almost never needs this).
//
// Tagged-template form is offered as `escapeHtml.tagged` so call sites
// can write `escapeHtml.tagged\`<p>${name}</p>\`` and get the
// interpolations escaped without touching the static portions.
//
// Replaces five characters: `& < > " '`.

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const ESCAPE_RE = /[&<>"']/g;

/**
 * HTML-escape a value for safe interpolation into raw HTML strings.
 * `null` and `undefined` collapse to the empty string. Non-string
 * values are stringified first.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(ESCAPE_RE, (ch) => ESCAPE_MAP[ch] ?? ch);
}

/**
 * Tagged-template form. Static parts pass through as-is; every
 * interpolation is escaped via {@link escapeHtml}. Use when building
 * a small fragment of raw HTML where JSX isn't an option.
 *
 * @example
 *   const html = escapeHtml.tagged`<p>Hello, ${name}</p>`;
 */
escapeHtml.tagged = function tagged(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = '';
  for (let i = 0; i < strings.length; i += 1) {
    out += strings[i] ?? '';
    if (i < values.length) {
      out += escapeHtml(values[i]);
    }
  }
  return out;
};
