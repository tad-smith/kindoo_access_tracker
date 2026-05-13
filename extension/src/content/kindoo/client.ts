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
  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'POST', body });
  } catch (err) {
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
    const message = err instanceof Error ? err.message : String(err);
    throw new KindooApiError('bad-json', `${endpoint} body read failed: ${message}`);
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new KindooApiError('bad-json', `${endpoint} returned non-JSON: ${message}`);
  }
}
