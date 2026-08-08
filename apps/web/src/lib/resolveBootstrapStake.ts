// Client wrapper for the `resolveBootstrapStake` callable.
//
// Server contract (`backend-engineer`, `fix/bootstrap-stake-discovery`):
//   - name: `resolveBootstrapStake`
//   - request: none
//   - response: `{ stakeIds: string[] }` — every stake, sorted
//     ascending by doc id, that the caller is the designated
//     `bootstrap_admin_email` of AND whose `setup_complete !== true`.
//     Empty array when none. Requires only that the caller is signed
//     in — no role claims needed.
//
// Imported via dynamic `import()` from `useActiveStake.ts` so this
// module — and the `./firebase` SDK-init module it pulls in — only
// loads once discovery actually fires (on a signed-in principal with a
// resolvable email). Route-gate unit tests that don't register a
// QueryClient never trigger discovery and so never pay the cost of
// loading real Firebase SDK singletons.

import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';

export interface ResolveBootstrapStakeResult {
  stakeIds: string[];
}

export async function resolveBootstrapStake(): Promise<ResolveBootstrapStakeResult> {
  const fn = httpsCallable<void, ResolveBootstrapStakeResult>(functions, 'resolveBootstrapStake');
  const res = await fn();
  return res.data;
}
