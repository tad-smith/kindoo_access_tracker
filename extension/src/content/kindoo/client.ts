// Multipart/form-data POST helper for Kindoo's ASMX API on
// service89.kindoo.tech. Every Kindoo call uses the same envelope:
//
//   - Content-Type: multipart/form-data; boundary=...
//   - SessionTokenID, EID, AppVersion=6.1.0, PlatformOS=web fields
//     (plus call-specific fields).
//
// We let the browser pick the boundary by building a `FormData` and
// passing it to `fetch` — no Content-Type header set explicitly, which
// triggers the standard `multipart/form-data; boundary=…` UA default.
// That matches what Kindoo's own admin UI sends.
//
// On non-2xx or malformed JSON we throw a typed `KindooApiError` so
// callers can pattern-match on `.code`.

const KINDOO_API_ORIGIN = 'https://service89.kindoo.tech/WebService.asmx';
const APP_VERSION = '6.1.0';
const PLATFORM_OS = 'web';

/**
 * Ceiling on a single Kindoo request, headers through body.
 *
 * `fetch` has no timeout of its own, and a hung Kindoo call is not a
 * local problem: the remote-apply tick is serialised, so while one is
 * outstanding the tab publishes no heartbeat, runs no stranded sweep,
 * and — for a manager with one Kindoo tab — leaves the job it claimed
 * `running` with nothing left alive to finalise it. Without a bound that
 * is permanent.
 *
 * Thirty seconds, from three constraints:
 *
 *   - Far outside any working call. Healthy ASMX responses land in well
 *     under a second; the panel's whole UX assumes near-instant.
 *   - Inside the phone's `REMOTE_APPLY_STALE_MS` (150s), so ONE hung
 *     call is absorbed by the staleness window rather than dropping the
 *     desktop off the phone.
 *   - Small enough to keep a wholly-degraded RUN near
 *     `REMOTE_APPLY_STRANDED_MS` (5 min) rather than far past it. This is
 *     a per-CALL bound and a provision is sequential: the worst shape we
 *     issue is a stake-scope add — environments, user lookup, one call
 *     per building rule (four at csnorth), the user's doors, the invite /
 *     edit, the access rule — around nine, so ~270s of Kindoo. Kindoo is
 *     not the whole run, though: the same job also makes two SBA
 *     callables, `getMyPendingRequests` (the runner's re-resolve) and
 *     `markRequestComplete`, and neither passes a `timeout` option, so
 *     each carries the Functions SDK's own 70s default. Worst case is
 *     therefore ~410s — PAST five minutes, not inside it, so a sibling
 *     tab on the same site could sweep a run that is still live. That is
 *     the residual D27(k) already accepts, and reaching it needs every
 *     term maximal at once.
 *
 *     Don't "fix" it by cutting this constant. The 140s of callable is
 *     fixed, so getting back inside five minutes means under ~17s a
 *     call, which starts aborting Kindoo calls that would have returned
 *     — failing live provisions to spare a sweep that only misfires when
 *     a second tab is open on the same site. Raising it is the move that
 *     actually costs: at 60s the Kindoo half alone is 540s and the worst
 *     case reaches ~680s, more than twice the threshold, turning an
 *     accepted worst case into the ordinary shape of a degraded run.
 */
export const KINDOO_REQUEST_TIMEOUT_MS = 30_000;

import type { KindooSession } from './auth';

export type KindooApiErrorCode = 'http-error' | 'bad-json' | 'network-error' | 'unexpected-shape';

export class KindooApiError extends Error {
  readonly code: KindooApiErrorCode;
  readonly status: number | undefined;
  constructor(code: KindooApiErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'KindooApiError';
    this.code = code;
    this.status = status;
  }
}

/** Extra form fields beyond the standard envelope. */
export type KindooFormFields = Record<string, string>;

/**
 * POST `{endpoint}` with the standard envelope plus the given fields.
 * Returns the parsed JSON body. The ASMX endpoints return JSON despite
 * the .asmx suffix (verified live).
 */
export async function postKindoo(
  endpoint: string,
  session: KindooSession,
  fields: KindooFormFields = {},
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const body = new FormData();
  body.append('SessionTokenID', session.token);
  body.append('EID', String(session.eid));
  for (const [k, v] of Object.entries(fields)) {
    body.append(k, v);
  }
  body.append('AppVersion', APP_VERSION);
  body.append('PlatformOS', PLATFORM_OS);

  const url = `${KINDOO_API_ORIGIN}/${endpoint}`;
  // Armed across the body read too, not just the headers: a response
  // whose stream stalls mid-body hangs the caller exactly as hard as one
  // whose headers never arrive.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KINDOO_REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, { method: 'POST', body, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) throw timedOut(endpoint);
      const message = err instanceof Error ? err.message : String(err);
      throw new KindooApiError('network-error', `fetch ${endpoint} failed: ${message}`);
    }

    if (!response.ok) {
      throw new KindooApiError(
        'http-error',
        `${endpoint} returned HTTP ${response.status}`,
        response.status,
      );
    }

    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      if (controller.signal.aborted) throw timedOut(endpoint);
      const message = err instanceof Error ? err.message : String(err);
      throw new KindooApiError('bad-json', `${endpoint} body read failed: ${message}`);
    }

    try {
      return JSON.parse(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new KindooApiError('bad-json', `${endpoint} returned non-JSON: ${message}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A timeout under the existing `network-error` code rather than a code
 * of its own.
 *
 * The distinction callers act on is "did the request reach Kindoo", and
 * a timeout answers that the same way a dropped connection does —
 * unknowably. Both surface through `describeKindooError` as operator
 * copy, so what has to be clear is the MESSAGE; a new code would only
 * force every consumer to learn a fourth case to treat identically.
 */
function timedOut(endpoint: string): KindooApiError {
  return new KindooApiError(
    'network-error',
    `${endpoint} timed out after ${KINDOO_REQUEST_TIMEOUT_MS}ms with no response from Kindoo`,
  );
}
