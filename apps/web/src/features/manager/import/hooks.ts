// Manager Import data hooks.
//   - `useStakeDoc` — live stake doc subscription for `last_import_at`,
//     `last_import_summary`, and `last_over_caps_json`.
//   - `useRunImportNowMutation` — TanStack mutation wrapping the
//     `runImportNow` callable. Returns the typed `ImportSummary`. The
//     manager-only role gate sits at the route layer; the rule check
//     for "is this caller a manager of this stake?" runs server-side
//     inside the callable.

import { useMemo } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { ImportSummary, Stake } from '@kindoo/shared';
import { useFirestoreDoc } from '../../../lib/data';
import { db } from '../../../lib/firebase';
import { stakeRef } from '../../../lib/docs';
import { STAKE_ID } from '../../../lib/constants';
import { invokeRunImportNow } from '../../bootstrap/callables';

export function useStakeDoc() {
  const ref = useMemo(() => stakeRef(db, STAKE_ID), []);
  return useFirestoreDoc<Stake>(ref);
}

export function useRunImportNowMutation() {
  return useMutation<ImportSummary, Error, void>({
    mutationFn: () => invokeRunImportNow(STAKE_ID),
  });
}
