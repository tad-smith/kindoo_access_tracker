// Unit tests for the fix-result formatting helpers. These keep the
// Result dialog fix-agnostic — they project an arbitrary callable result
// into rows + warnings and produce the clipboard plaintext.

import { describe, expect, it } from 'vitest';
import { formatFixErrorText, formatFixResultText, toFixError, toFixResultView } from '../fixResult';

describe('toFixResultView', () => {
  it('projects every scalar field into a row and pulls warnings out separately', () => {
    const view = toFixResultView({
      ok: true,
      seats_total: 42,
      seats_updated: 3,
      warnings: ['seat a: skipped', 'seat b: skipped'],
    });
    expect(view.rows).toEqual([
      { key: 'ok', value: 'true' },
      { key: 'seats_total', value: '42' },
      { key: 'seats_updated', value: '3' },
    ]);
    expect(view.warnings).toEqual(['seat a: skipped', 'seat b: skipped']);
  });

  it('renders null and stringifies nested objects/arrays so nothing is dropped', () => {
    const view = toFixResultView({
      primary_kindoo_site_id: null,
      detail: { nested: 1 },
      list: [1, 2],
    });
    expect(view.rows).toEqual([
      { key: 'primary_kindoo_site_id', value: 'null' },
      { key: 'detail', value: '{"nested":1}' },
      { key: 'list', value: '[1,2]' },
    ]);
    expect(view.warnings).toEqual([]);
  });

  it('treats an absent or non-array warnings field as no warnings', () => {
    expect(toFixResultView({ ok: true }).warnings).toEqual([]);
    expect(toFixResultView({ ok: true, warnings: 'oops' }).warnings).toEqual([]);
    // A non-array `warnings` is an unexpected shape — keep it as a row so
    // nothing is silently dropped from view.
    expect(toFixResultView({ ok: true, warnings: 'oops' }).rows).toContainEqual({
      key: 'warnings',
      value: 'oops',
    });
  });
});

describe('formatFixResultText', () => {
  it('formats rows as key: value and appends a warnings block', () => {
    const text = formatFixResultText({
      ok: true,
      seats_updated: 2,
      warnings: ['w1', 'w2'],
    });
    expect(text).toBe(
      ['ok: true', 'seats_updated: 2', '', 'warnings (2):', '- w1', '- w2'].join('\n'),
    );
  });

  it('omits the warnings block when there are none', () => {
    expect(formatFixResultText({ ok: true, seats_updated: 0 })).toBe('ok: true\nseats_updated: 0');
  });
});

describe('toFixError / formatFixErrorText', () => {
  it('extracts code + message from a Firebase-style HttpsError', () => {
    const err = Object.assign(new Error('platform superadmin required'), {
      code: 'permission-denied',
    });
    expect(toFixError(err)).toEqual({
      code: 'permission-denied',
      message: 'platform superadmin required',
    });
    expect(formatFixErrorText(err)).toBe('permission-denied: platform superadmin required');
  });

  it('falls back to a generic code for a plain Error', () => {
    expect(toFixError(new Error('boom'))).toEqual({ code: 'error', message: 'boom' });
  });

  it('handles a non-Error thrown value', () => {
    expect(toFixError('weird')).toEqual({ code: 'error', message: 'weird' });
  });
});
