// Unit tests for the Kindoo session-reading helper. Mock a Storage so
// the happy path + each error arm round-trips deterministically.

import { describe, expect, it } from 'vitest';
import { readKindooSession } from './auth';

function mkStorage(items: Record<string, string>): Storage {
  const map = new Map(Object.entries(items));
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    key(i: number) {
      return Array.from(map.keys())[i] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

describe('readKindooSession', () => {
  it('returns ok with token + eid when both are present', () => {
    const storage = mkStorage({
      kindoo_token: '5e94a57a-3f08-4681-a01a-4d7ef6b28b9c',
      state: JSON.stringify({ sites: { ids: [27994], entities: {} } }),
    });
    const result = readKindooSession(storage);
    expect(result).toEqual({
      ok: true,
      session: { token: '5e94a57a-3f08-4681-a01a-4d7ef6b28b9c', eid: 27994 },
    });
  });

  it('returns no-token when kindoo_token is missing', () => {
    const storage = mkStorage({
      state: JSON.stringify({ sites: { ids: [27994] } }),
    });
    expect(readKindooSession(storage)).toEqual({ ok: false, error: 'no-token' });
  });

  it('returns no-token when kindoo_token is empty / whitespace', () => {
    const storage = mkStorage({
      kindoo_token: '   ',
      state: JSON.stringify({ sites: { ids: [27994] } }),
    });
    expect(readKindooSession(storage)).toEqual({ ok: false, error: 'no-token' });
  });

  it('returns no-eid when state key is missing', () => {
    const storage = mkStorage({ kindoo_token: 'tok' });
    expect(readKindooSession(storage)).toEqual({ ok: false, error: 'no-eid' });
  });

  it('returns no-eid when state is malformed JSON', () => {
    const storage = mkStorage({ kindoo_token: 'tok', state: '{not-json' });
    expect(readKindooSession(storage)).toEqual({ ok: false, error: 'no-eid' });
  });

  it('returns no-eid when sites.ids is missing', () => {
    const storage = mkStorage({
      kindoo_token: 'tok',
      state: JSON.stringify({ sites: {} }),
    });
    expect(readKindooSession(storage)).toEqual({ ok: false, error: 'no-eid' });
  });

  it('returns no-eid when sites.ids is empty', () => {
    const storage = mkStorage({
      kindoo_token: 'tok',
      state: JSON.stringify({ sites: { ids: [] } }),
    });
    expect(readKindooSession(storage)).toEqual({ ok: false, error: 'no-eid' });
  });

  it('returns no-eid when the first id is not a number', () => {
    const storage = mkStorage({
      kindoo_token: 'tok',
      state: JSON.stringify({ sites: { ids: ['27994'] } }),
    });
    expect(readKindooSession(storage)).toEqual({ ok: false, error: 'no-eid' });
  });
});
