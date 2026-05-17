// Read Kindoo's session token + active site id from web.kindoo.tech.
// The content script runs in the page's same-origin context, so direct
// access is fine — no SW round-trip needed.
//
// Kindoo stores everything in `localStorage`:
//   - `kindoo_token`  — bearer UUID for the ASMX API on service89.kindoo.tech.
//   - `state`         — JSON blob; `sites.entities` maps EID → site
//                       metadata (including `EnvironmentName`).
//
// ACTIVE-SITE DETECTION (DOM scrape).
//
// `localStorage.state.sites.ids[0]` is NOT the active site — operator
// testing on multi-site accounts confirmed `ids[0]` is the access-list
// head, not the currently-rendered site. `user.object.EnvironmentID` is
// always `null`. The URL has no site discriminator. Kindoo tracks the
// active site only in React in-memory state — the one observable
// surface is the site name rendered in Kindoo's header.
//
// `readActiveEidFromDom` matches the visible header text against the
// `EnvironmentName` values in `localStorage.state.sites.entities` to
// recover the active EID. Single visible match → return that EID; zero
// or multiple matches (e.g. the "My Sites" listing page) → return null
// (`readKindooSession` collapses this into `{ ok: false, error:
// 'no-eid' }`).
//
// This is the single sanctioned exception to "don't reach into Kindoo's
// DOM" — documented in `extension/CLAUDE.md`. Brittle by construction:
// a Kindoo redesign that drops `[dir="auto"]` on the header text would
// break detection and require an update here.
//
// Failure modes the caller branches on:
//   - 'no-token'  → operator is signed out of Kindoo (or never signed in).
//   - 'no-eid'    → token exists but the active site couldn't be
//                   identified. Operator must open a specific Kindoo
//                   site (not the My Sites listing page) and refresh.

export interface KindooSession {
  token: string;
  eid: number;
}

export type KindooSessionError = 'no-token' | 'no-eid';

export type KindooSessionResult =
  | { ok: true; session: KindooSession }
  | { ok: false; error: KindooSessionError };

function readToken(storage: Storage): string | null {
  const raw = storage.getItem('kindoo_token');
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the active Kindoo site's EID by scanning the DOM for a text
 * node matching one of the known `EnvironmentName` values in
 * `localStorage.state.sites.entities`.
 *
 * Exported for testability (jsdom fixtures in `auth.test.ts`).
 *
 *  - Single visible match → return that EID.
 *  - Zero visible matches → `null` (header not found; possibly a Kindoo
 *    redesign).
 *  - Multiple visible matches → `null` (ambiguous; e.g. the "My Sites"
 *    listing page shows several sites at once).
 *  - Missing / malformed `localStorage.state` → `null`.
 *
 * Visibility filter: we walk up the ancestor chain and skip the
 * element if any ancestor has `display: none`. We can't use
 * `offsetParent === null` because jsdom never lays out elements, so
 * `offsetParent` is null even for visible elements. `getComputedStyle`
 * works in both jsdom and real browsers.
 */
export function readActiveEidFromDom(doc: Document = document): number | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem('state');
  } catch {
    return null;
  }
  if (!raw) return null;

  let state: unknown;
  try {
    state = JSON.parse(raw);
  } catch {
    return null;
  }
  const entities = (state as { sites?: { entities?: unknown } } | null)?.sites?.entities;
  if (typeof entities !== 'object' || entities === null) return null;

  const eidByName = new Map<string, number>();
  for (const [eidRaw, entity] of Object.entries(entities as Record<string, unknown>)) {
    const name =
      typeof entity === 'object' && entity !== null
        ? (entity as { EnvironmentName?: unknown }).EnvironmentName
        : undefined;
    if (typeof name !== 'string' || name.length === 0) continue;
    const eid = Number(eidRaw);
    if (!Number.isFinite(eid)) continue;
    eidByName.set(name.trim(), eid);
  }
  if (eidByName.size === 0) return null;

  const matches = new Set<number>();
  for (const el of doc.querySelectorAll('[dir="auto"]')) {
    if (!isVisible(el as HTMLElement, doc)) continue;
    const text = el.textContent?.trim();
    if (!text) continue;
    const eid = eidByName.get(text);
    if (typeof eid === 'number') matches.add(eid);
  }
  if (matches.size !== 1) return null;
  return Array.from(matches)[0]!;
}

/**
 * Visibility check via ancestor-chain `display: none` walk. Works
 * under both jsdom (no layout, so `offsetParent` is unreliable) and
 * real browsers. Detached nodes (no parent in `doc`) are treated as
 * hidden.
 */
function isVisible(el: HTMLElement, doc: Document): boolean {
  const root = doc.documentElement;
  let cur: HTMLElement | null = el;
  while (cur && cur !== root) {
    const style = doc.defaultView?.getComputedStyle(cur);
    if (style && style.display === 'none') return false;
    cur = cur.parentElement;
  }
  // Reached documentElement without hitting display: none. If we never
  // started inside the tree (parentElement chain didn't include root),
  // treat as hidden.
  return cur === root;
}

/**
 * Pull the Kindoo session from the given Storage (defaults to
 * `window.localStorage`). Returns a typed result so the caller can
 * `if (!result.ok)` and render the appropriate recovery state.
 *
 * `no-eid` covers all active-site-detection failures collapsed by
 * `readActiveEidFromDom` — the user-facing recovery is "open a
 * specific Kindoo site and refresh", regardless of which sub-reason
 * actually triggered.
 */
export function readKindooSession(storage: Storage = window.localStorage): KindooSessionResult {
  const token = readToken(storage);
  if (!token) return { ok: false, error: 'no-token' };
  const eid = readActiveEidFromDom();
  if (eid === null) return { ok: false, error: 'no-eid' };
  return { ok: true, session: { token, eid } };
}
