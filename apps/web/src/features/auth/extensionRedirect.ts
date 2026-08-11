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
// THERE IS NO SINGLE "OUR EXTENSION" ID. Chrome strips the manifest
// `key` from Web Store builds and assigns its own ID at first upload,
// while every unpacked build keeps the deterministic ID derived from
// its own per-environment keypair. So the IDs in play are:
//
//   - production origin: the Web Store ID (`CHROME_EXTENSION_ID`), plus
//     the prod-mode keypair ID during the pre-upload smoke test;
//   - staging origin: the staging keypair ID, and nothing else;
//   - local dev: whatever ID that developer's unpacked build carries.
//
// Only the first of those is knowable at compile time, which is why the
// rest come from `VITE_EXTENSION_IDS` per build.
//
// `CHROME_EXTENSION_ID` is trusted implicitly ONLY in production
// builds. The Web Store extension hard-codes its `VITE_WEB_BASE_URL` at
// the production origin, so it cannot be the caller on staging or
// localhost; trusting it there would widen the set to an identity that
// cannot legitimately appear. It also leaves non-production builds with
// an allowlist of exactly `VITE_EXTENSION_IDS`, which is what lets
// `vite.config.ts` reject an unset var at build time instead of
// shipping a page that refuses every real caller.

import { CHROME_EXTENSION_ID } from '../../lib/links';
import { parseExtensionIds } from '../../lib/extensionIds';

/**
 * A Chrome extension callback origin: the 32-character extension ID
 * (alphabet `a`–`p`) under `chromiumapp.org`, no path, no query,
 * optional trailing slash.
 *
 * A cheap precondition, not the boundary — see `isAllowedRedirectUri`.
 */
export const REDIRECT_URI_PATTERN = /^https:\/\/([a-p]{32})\.chromiumapp\.org\/?$/;

/**
 * Extension IDs this build will hand a token to.
 *
 * Read at call time rather than at module load so tests can drive the
 * env; the values are build-time constants in a real bundle, so there
 * is no cost to re-deriving.
 */
export function allowedExtensionIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  // Production only — see the module header.
  if (import.meta.env.MODE === 'production') ids.add(CHROME_EXTENSION_ID);
  for (const id of parseExtensionIds(import.meta.env.VITE_EXTENSION_IDS)) ids.add(id);
  return ids;
}

/**
 * True when this build trusts no extension at all, so every handoff
 * will be refused.
 *
 * Non-production builds reach this state by omitting
 * `VITE_EXTENSION_IDS`. `vite build --mode staging` fails outright on
 * it (see `vite.config.ts`), so in practice this is the dev server,
 * where failing every `pnpm dev` would punish developers who never
 * touch the extension. The route says so explicitly instead — the
 * alternative is a refusal that reads as a mystery, which is exactly
 * what this route's error copy exists to prevent.
 */
export function extensionAllowlistIsEmpty(): boolean {
  return allowedExtensionIds().size === 0;
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
