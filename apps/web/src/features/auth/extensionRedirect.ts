// Which extension may receive a minted session token.
//
// The trust boundary for `/auth/extension` (spec §4.1, D33). Shape
// alone is NOT a boundary: every Chrome extension's callback origin has
// the same shape, so validating only the shape trusts every extension
// installed in the manager's profile. Any of them holding just the
// `identity` permission could call `launchWebAuthFlow` against this
// route and harvest a token. The allowlist is what makes the set
// "our extension" rather than "any extension".
//
// Composition: the published extension, always, plus whatever
// `VITE_EXTENSION_IDS` adds for the build. Additive rather than
// replacing, so a missing / empty env var degrades to "only the
// published extension" — the safe direction — instead of either
// trusting everything or breaking production sign-in outright. Local
// dev lists its unpacked ID there; unpacked IDs differ per machine and
// per profile, so they cannot be baked in.

import { CHROME_EXTENSION_ID } from '../../lib/links';

/**
 * A Chrome extension callback origin: the 32-character extension ID
 * (alphabet `a`–`p`) under `chromiumapp.org`, no path, no query,
 * optional trailing slash.
 *
 * A cheap precondition, not the boundary — see `isAllowedRedirectUri`.
 */
export const REDIRECT_URI_PATTERN = /^https:\/\/([a-p]{32})\.chromiumapp\.org\/?$/;

/** Extension IDs are 32 chars from `a`–`p`; anything else is not one. */
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

/**
 * Extension IDs this build will hand a token to.
 *
 * Read at call time rather than at module load so tests can drive the
 * env var; the value is a build-time constant in a real bundle, so
 * there is no cost to re-deriving it.
 */
export function allowedExtensionIds(): ReadonlySet<string> {
  const ids = new Set<string>([CHROME_EXTENSION_ID]);
  const configured = import.meta.env.VITE_EXTENSION_IDS;
  if (typeof configured === 'string') {
    for (const raw of configured.split(',')) {
      const id = raw.trim().toLowerCase();
      // Silently drop malformed entries. A typo in the env var must not
      // be able to widen the trust set — and must not take the build
      // down either, since the published ID above still works.
      if (EXTENSION_ID_PATTERN.test(id)) ids.add(id);
    }
  }
  return ids;
}

/**
 * Whether `uri` is the callback origin of an extension this build
 * trusts. The only sanctioned way to decide whether the handoff may
 * proceed — callers must never test the shape alone.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  const match = REDIRECT_URI_PATTERN.exec(uri);
  if (!match) return false;
  const id = match[1];
  return id !== undefined && allowedExtensionIds().has(id);
}
