// Manager Import data hooks. Reads `last_import_at`,
// `last_import_summary`, and `last_over_caps_json` from the stake doc.
// The "Import Now" callable is `runImportNow` — Phase 8 wires the
// function; Phase 7 wires the UI. The wrapper in
// `features/bootstrap/callables.ts` handles a graceful "not deployed
// yet" message.

import { useMemo } from 'react';
import type { Stake } from '@kindoo/shared';
import { useFirestoreDoc } from '../../../lib/data';
import { db } from '../../../lib/firebase';
import { stakeRef } from '../../../lib/docs';
import { STAKE_ID } from '../../../lib/constants';

export function useStakeDoc() {
  const ref = useMemo(() => stakeRef(db, STAKE_ID), []);
  return useFirestoreDoc<Stake>(ref);
}
