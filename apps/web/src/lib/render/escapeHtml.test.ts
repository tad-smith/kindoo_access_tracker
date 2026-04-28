// Unit tests for the HTML-escape helper. Mirrors the escape contract
// from Apps Script's `ClientUtils.html#escapeHtml` so byte-level
// output stays compatible with audit-log diffs written by the legacy
// app.

import { describe, expect, it } from 'vitest';
import { escapeHtml } from './escapeHtml';

describe('escapeHtml', () => {
  it('returns the empty string for null and undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('passes through plain text unchanged', () => {
    expect(escapeHtml('Alice')).toBe('Alice');
    expect(escapeHtml('alice@example.com')).toBe('alice@example.com');
  });

  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('escapes a script-injection payload completely', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it('escapes ampersands first so subsequent entities are preserved', () => {
    // If `&` were escaped after `<`, the pre-escaped `&lt;` would
    // become `&amp;lt;`. Order matters; Apps Script Tests this too.
    expect(escapeHtml('<&>')).toBe('&lt;&amp;&gt;');
  });

  it('coerces non-string values to strings', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(true)).toBe('true');
    expect(escapeHtml({ toString: () => 'a&b' })).toBe('a&amp;b');
  });

  it('escapes interpolated values inside a tagged template', () => {
    const name = '<Alice & Bob>';
    expect(escapeHtml.tagged`<p>Hello, ${name}</p>`).toBe('<p>Hello, &lt;Alice &amp; Bob&gt;</p>');
  });

  it('passes literal segments of a tagged template through unchanged', () => {
    expect(escapeHtml.tagged`<b>${'x'}</b>`).toBe('<b>x</b>');
  });

  it('handles a tagged template with no interpolations', () => {
    expect(escapeHtml.tagged`<i>hi</i>`).toBe('<i>hi</i>');
  });
});
