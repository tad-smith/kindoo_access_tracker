// Parsing for `VITE_EXTENSION_IDS`, the build's list of Chrome
// extension IDs allowed to receive a session token from
// `/auth/extension`.
//
// Deliberately pure — no `import.meta.env`, no DOM, no imports. Both
// the runtime allowlist (`features/auth/extensionRedirect.ts`) and the
// build-time prerequisite check in `vite.config.ts` parse the var, and
// the config file is loaded by esbuild in a plain Node context where
// `import.meta.env` does not exist. One implementation, so the build
// can never accept a value the runtime would drop.

/** A Chrome extension ID: 32 characters from the `a`–`p` alphabet. */
export const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

/**
 * Parse a comma-separated `VITE_EXTENSION_IDS` value into normalised
 * IDs, dropping anything malformed.
 *
 * Dropping rather than throwing is deliberate: this list is a trust
 * set, so a typo must fail closed (that ID simply isn't trusted) rather
 * than widen it. Callers that need "was anything configured at all"
 * check the returned length — that is what the build-time prerequisite
 * check keys on.
 */
export function parseExtensionIds(raw: string | undefined | null): string[] {
  if (typeof raw !== 'string') return [];
  const ids: string[] = [];
  for (const entry of raw.split(',')) {
    const id = entry.trim().toLowerCase();
    if (EXTENSION_ID_PATTERN.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}
