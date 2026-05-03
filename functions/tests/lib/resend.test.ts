// Unit tests for the Resend wrapper. Tests the test-injection hook
// (`_setResendSender`) round-trips and that the default sender errors
// cleanly when `RESEND_API_KEY` is unset. The default sender's success
// path itself is exercised indirectly by the EmailService integration
// tests (which inject a fake sender).

import { afterEach, describe, expect, it } from 'vitest';
import { _setResendSender, getResendSender, type ResendSender } from '../../src/lib/resend.js';

describe('lib/resend', () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    if (restore) restore();
    restore = undefined;
  });

  it('_setResendSender swaps the active sender and returns a restore function', async () => {
    const calls: string[] = [];
    const fake: ResendSender = {
      send: async (p) => {
        calls.push(p.subject);
        return { ok: true, id: 'mid-1' };
      },
    };
    restore = _setResendSender(fake);

    const result = await getResendSender().send({
      from: 'Foo <noreply@example.com>',
      to: ['x@example.com'],
      subject: 'hi',
      text: 'body',
    });
    expect(result).toEqual({ ok: true, id: 'mid-1' });
    expect(calls).toEqual(['hi']);

    restore();
    restore = undefined;
    // Default sender is restored — without RESEND_API_KEY it errors
    // cleanly inside the wrapper instead of throwing.
    const original = process.env['RESEND_API_KEY'];
    delete process.env['RESEND_API_KEY'];
    const fallback = await getResendSender().send({
      from: 'Foo <noreply@example.com>',
      to: ['x@example.com'],
      subject: 'hi',
      text: 'body',
    });
    expect(fallback.ok).toBe(false);
    if (!fallback.ok) expect(fallback.error.message).toMatch(/RESEND_API_KEY/);
    if (original !== undefined) process.env['RESEND_API_KEY'] = original;
  });

  it('returns a structured error result when RESEND_API_KEY is unset', async () => {
    const original = process.env['RESEND_API_KEY'];
    delete process.env['RESEND_API_KEY'];
    try {
      const result = await getResendSender().send({
        from: 'Foo <noreply@example.com>',
        to: ['x@example.com'],
        subject: 'hi',
        text: 'body',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toMatch(/RESEND_API_KEY/);
      }
    } finally {
      if (original !== undefined) process.env['RESEND_API_KEY'] = original;
    }
  });
});
