// Manager Access data hooks. One live subscription over the access
// collection; rendering is split into per-user cards (each card has an
// importer block + a manual block — see firebase-schema.md §4.5).

import { useMemo } from 'react';
import type { Access } from '@kindoo/shared';
import { useFirestoreCollection } from '../../../lib/data';
import { db } from '../../../lib/firebase';
import { accessCol } from '../../../lib/docs';
import { STAKE_ID } from '../../../lib/constants';

export function useAccessList() {
  const q = useMemo(() => accessCol(db, STAKE_ID), []);
  return useFirestoreCollection<Access>(q);
}
