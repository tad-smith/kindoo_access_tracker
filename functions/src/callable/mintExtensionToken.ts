// Sign-in handoff for the Chrome MV3 extension. The extension's own
// auth path is Google-only (`chrome.identity.getAuthToken`), which
// locks out a Kindoo Manager with no Google account — the SPA has
// offered magic link since T-44 (spec §4.1) but the extension had no
// way to reach it. It now opens the SPA's `/auth/extension` route in
// `chrome.identity.launchWebAuthFlow`; that route signs the manager in
// with either SPA provider and calls this callable with the resulting
// session. The token comes back through the auth-flow redirect and the
// extension exchanges it via `signInWithCustomToken`.
//
// Custom token, not ID token. An ID token expires in an hour and the
// extension holds no refresh path of its own, so handing one back
// would buy a session that dies mid-shift. A custom token exchanges
// into a real session with its own refresh token.
//
// Auth: any signed-in caller, nothing more. The token is minted for
// the caller's OWN uid, so it conveys exactly the authority they
// arrived with — a caller who can invoke this already holds a valid
// session for that uid. Role gating stays where it belongs: rules, and
// the per-callable manager checks on `getMyPendingRequests` /
// `markRequestComplete`. A roleless caller gets a token that resolves
// to the same NotAuthorized state the SPA shows them.
//
// No `developerClaims` — deliberately. Claims written by
// `setCustomUserClaims` (the `applyClaims` helpers) live on the user
// record and land in every ID token minted for that uid, custom-token
// sign-ins included, so the `stakes` block survives the exchange
// untouched. `developerClaims` are a separate mechanism: the Admin SDK
// nests them under the custom token's own `claims` field rather than
// merging them with the user record, so passing a `stakes` block there
// would fork the source of truth that every `claims.stakes[...]` read
// in rules and `usePrincipal()` depends on — and fork it to a snapshot
// taken at mint time.
//
// No audit row. Minting a session token is not an entity write;
// `auditTrigger` owns that surface.
//
// Deployment prerequisite: with ADC (no key file), `createCustomToken`
// signs through the IAM `signBlob` API, so `APP_SA` needs
// `roles/iam.serviceAccountTokenCreator` ON ITSELF. Without it this
// fails at runtime, not at deploy. The emulator substitutes an
// unsigned token and needs no grant.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { MintExtensionTokenOutput } from '@kindoo/shared';
import { APP_SA, getAdminAuth } from '../lib/admin.js';

export const mintExtensionToken = onCall(
  { serviceAccount: APP_SA },
  async (req): Promise<MintExtensionTokenOutput> => {
    if (!req.auth) {
      throw new HttpsError('unauthenticated', 'sign in required');
    }
    return { token: await getAdminAuth().createCustomToken(req.auth.uid) };
  },
);
