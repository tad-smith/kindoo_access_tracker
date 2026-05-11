// Unit tests for `getStakeIds` — focus on cache semantics and the
// shape contract. The end-to-end "claims get seeded across every
// stake" assertions live in the emulator-driven
// `tests/onAuthUserCreate.test.ts` suite; here we lean on a mock
// Firestore handle so we can count `listDocuments` calls precisely.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { getStakeIds, resetStakeIdsCache } from './stakeIds.js';

type FakeRef = { id: string };

function makeFakeDb(stakeIds: string[]): {
  db: Firestore;
  listDocumentsSpy: ReturnType<typeof vi.fn>;
} {
  const refs: FakeRef[] = stakeIds.map((id) => ({ id }));
  const listDocumentsSpy = vi.fn().mockResolvedValue(refs);
  const collection = vi.fn().mockReturnValue({ listDocuments: listDocumentsSpy });
  const db = { collection } as unknown as Firestore;
  return { db, listDocumentsSpy };
}

describe('getStakeIds', () => {
  afterEach(() => {
    resetStakeIdsCache();
  });

  it('returns every stake doc ID under stakes/', async () => {
    const { db } = makeFakeDb(['csnorth']);
    const ids = await getStakeIds(db);
    expect(ids).toEqual(['csnorth']);
  });

  it('returns multiple stake IDs in the order Firestore reports them', async () => {
    const { db } = makeFakeDb(['csnorth', 'south', 'west']);
    const ids = await getStakeIds(db);
    expect(ids).toEqual(['csnorth', 'south', 'west']);
  });

  it('returns an empty list when no stake docs exist', async () => {
    const { db, listDocumentsSpy } = makeFakeDb([]);
    const ids = await getStakeIds(db);
    expect(ids).toEqual([]);
    expect(listDocumentsSpy).toHaveBeenCalledTimes(1);
  });

  it('caches the result: repeated calls do not re-query Firestore', async () => {
    const { db, listDocumentsSpy } = makeFakeDb(['csnorth', 'south']);
    const first = await getStakeIds(db);
    const second = await getStakeIds(db);
    const third = await getStakeIds(db);
    expect(first).toEqual(['csnorth', 'south']);
    expect(second).toEqual(['csnorth', 'south']);
    expect(third).toEqual(['csnorth', 'south']);
    expect(listDocumentsSpy).toHaveBeenCalledTimes(1);
  });

  it('resetStakeIdsCache forces the next call to re-query', async () => {
    const { db, listDocumentsSpy } = makeFakeDb(['csnorth']);
    await getStakeIds(db);
    expect(listDocumentsSpy).toHaveBeenCalledTimes(1);
    resetStakeIdsCache();
    await getStakeIds(db);
    expect(listDocumentsSpy).toHaveBeenCalledTimes(2);
  });
});
