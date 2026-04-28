// Tests for `auditId`. The agent definition for Phase 3 names three
// properties to lock in: deterministic, sortable by reverse-lex, no
// collisions on distinct inputs. Each gets its own block.
import { afterEach, describe, expect, it } from 'vitest';
import { _setSuffixSource, auditId } from './auditId.js';

describe('auditId', () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  describe('deterministic', () => {
    it('produces the same ID for the same (Date, suffix) inputs', () => {
      const t = new Date('2026-04-28T14:23:45.123Z');
      const a = auditId(t, 'seats_alice@gmail.com');
      const b = auditId(t, 'seats_alice@gmail.com');
      expect(a).toBe(b);
    });

    it('embeds the ISO timestamp verbatim as the leading component', () => {
      const t = new Date('2026-04-28T14:23:45.123Z');
      const id = auditId(t, 'x');
      expect(id.startsWith('2026-04-28T14:23:45.123Z_')).toBe(true);
    });

    it('uses the provided suffix verbatim', () => {
      const t = new Date('2026-04-28T14:23:45.123Z');
      const id = auditId(t, 'seats_alice@gmail.com');
      expect(id.endsWith('_seats_alice@gmail.com')).toBe(true);
    });
  });

  describe('sortable by reverse-lex', () => {
    it('reverse-lex order yields newest-first', () => {
      const ids = [
        auditId(new Date('2026-01-01T00:00:00.000Z'), 'a'),
        auditId(new Date('2026-04-28T14:23:45.123Z'), 'b'),
        auditId(new Date('2026-04-28T14:23:45.124Z'), 'c'),
        auditId(new Date('2027-01-01T00:00:00.000Z'), 'd'),
      ];
      const sorted = [...ids].sort().reverse();
      expect(sorted).toEqual([ids[3], ids[2], ids[1], ids[0]]);
    });

    it('orders by timestamp before suffix (suffix is only a tie-breaker)', () => {
      // A later timestamp with an alphabetically-smaller suffix still
      // sorts after an earlier timestamp with a larger suffix.
      const earlier = auditId(new Date('2026-04-28T14:23:45.123Z'), 'zzzz');
      const later = auditId(new Date('2026-04-28T14:23:45.124Z'), 'aaaa');
      expect([earlier, later].sort()).toEqual([earlier, later]);
    });

    it('breaks per-millisecond ties by suffix lex order', () => {
      const t = new Date('2026-04-28T14:23:45.123Z');
      const ids = [auditId(t, 'b'), auditId(t, 'a'), auditId(t, 'c')];
      const sorted = [...ids].sort();
      expect(sorted).toEqual([auditId(t, 'a'), auditId(t, 'b'), auditId(t, 'c')]);
    });
  });

  describe('no collisions', () => {
    it('distinct (Date, suffix) inputs yield distinct IDs', () => {
      const seen = new Set<string>();
      for (let h = 0; h < 24; h++) {
        for (const suffix of ['seat_a@x', 'access_a@x', 'request_uuid-1', 'request_uuid-2']) {
          const t = new Date(Date.UTC(2026, 3, 28, h, 0, 0, 0));
          seen.add(auditId(t, suffix));
        }
      }
      expect(seen.size).toBe(24 * 4);
    });

    it('the default UUID suffix produces distinct IDs at the same timestamp', () => {
      // Drive the default randomUUID() path many times at one
      // timestamp; collisions on UUIDv4 at this volume are
      // astronomically improbable.
      const t = new Date('2026-04-28T14:23:45.123Z');
      const seen = new Set<string>();
      for (let i = 0; i < 200; i++) {
        seen.add(auditId(t));
      }
      expect(seen.size).toBe(200);
    });

    it('respects the test-only suffix source override', () => {
      let n = 0;
      restore = _setSuffixSource(() => `n${n++}`);
      const t = new Date('2026-04-28T14:23:45.123Z');
      expect(auditId(t)).toBe('2026-04-28T14:23:45.123Z_n0');
      expect(auditId(t)).toBe('2026-04-28T14:23:45.123Z_n1');
    });
  });
});
