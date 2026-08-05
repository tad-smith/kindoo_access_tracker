// SPIKE — offscreen realtime listener. Not production code, not wired
// into remote apply. See extension/docs/offscreen-listener-spike.md.
//
// Why: remote apply polls Firestore from the content script — two reads
// per tick at 10s foreground / 60s background, plus a 60s sweep read.
// That is ~18.7k reads/day per OPEN KINDOO TAB, and it scales with tabs
// and with wall-clock time rather than with request volume, which is the
// wrong shape. A realtime listener bills the initial result set plus one
// read per changed document, and the jobs collection is empty almost
// always.
//
// The service worker cannot host the listener: `onSnapshot` rides
// WebChannel, which needs `XMLHttpRequest` — undefined in an MV3 SW (a
// runtime finding already recorded in extension/CLAUDE.md) — and an MV3
// SW is suspended after ~30s idle, which a quiet listener is. An
// offscreen document has a full DOM and, per Chrome's docs, no automatic
// lifetime limit for any reason except AUDIO_PLAYBACK.
//
// This module is the spike's shared surface across the SW and the
// offscreen document: where the document lives, what we tell Chrome it
// is for, and a logger that writes to BOTH the context's console and a
// chrome.storage.local ring buffer.
//
// The ring buffer is the actual deliverable. The operator loads this
// unpacked and leaves it running for hours with no devtools attached,
// and a console that was never open has no history to show afterwards.

/** Path Chrome loads for the offscreen document, relative to the
 * extension root. Emitted by the extra Rollup HTML input in
 * `vite.config.ts` — @crxjs does not know about this file, because
 * offscreen documents are created at runtime rather than declared in
 * the manifest. */
export const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

/**
 * The `reasons` value handed to `chrome.offscreen.createDocument`.
 *
 * None of Chrome's fifteen enum values means "hold a long-lived
 * authenticated network listener", which is what this actually is. The
 * honest ranking of the near misses:
 *
 *   - LOCAL_STORAGE ("needs access to localStorage") — closest. Firebase
 *     Auth's document-context persistence chain really is
 *     [indexedDB, localStorage, sessionStorage], and the underlying need
 *     — DOM-backed storage an MV3 service worker does not have — is
 *     genuinely ours. It is still not why we are here.
 *   - TESTING ("used for testing purposes only") — the honest label for
 *     a spike, but unshippable, and survival evidence gathered under a
 *     reason we could never declare in production transfers less well.
 *   - DOM_SCRAPING — what Firebase's own Chrome-extension auth guide
 *     tells you to use, with the justification string 'authentication'.
 *     Flatly untrue for us (no iframe, no DOM scraped), but it is the
 *     precedent a Web Store reviewer has most likely already seen.
 *
 * LOCAL_STORAGE it is, so the evidence is gathered under the reason a
 * production build would actually declare. The justification string
 * below is the truthful half, and it is the half a human reviewer reads.
 * The mismatch is this approach's main Web Store risk.
 */
export const OFFSCREEN_REASON = 'LOCAL_STORAGE' as chrome.offscreen.Reason;

/** Free text Chrome shows a reviewer. Kept truthful even though the
 * enum above cannot be. */
export const OFFSCREEN_JUSTIFICATION =
  'Holds the authenticated Firestore realtime listener that watches for access-provisioning ' +
  'jobs. Firestore listeners need DOM-backed storage and XMLHttpRequest, neither of which ' +
  'exists in an MV3 service worker.';

/** chrome.storage.local slot for the durable event log. Namespaced
 * `sba.spike.*` so it is obvious this is not one of the owned keys in
 * `lib/messaging.ts` STORAGE_KEYS and can be deleted wholesale. */
export const SPIKE_LOG_KEY = 'sba.spike.offscreenLog';

/** Ring-buffer cap. At the 2-minute heartbeat below, 1000 entries is
 * ~33 hours of quiet running before the oldest events roll off — long
 * enough to cover an overnight run plus the working day around it. */
export const SPIKE_LOG_MAX = 1000;

/**
 * Heartbeat period. Two minutes pins a reap to within two minutes while
 * keeping an overnight run readable at 30 lines/hour.
 *
 * Above Chrome's one-minute intensive-throttling floor for hidden pages
 * on purpose: an offscreen document is hidden by construction, so a
 * sub-minute timer would be at the mercy of throttling and a late beat
 * would read as a death that never happened.
 */
export const SPIKE_HEARTBEAT_MS = 120_000;

/** Which context emitted an event. Both write to the one buffer so the
 * operator reads a single interleaved timeline. */
export type SpikeContext = 'sw' | 'offscreen';

export interface SpikeEvent {
  /** ISO 8601, UTC. */
  at: string;
  ctx: SpikeContext;
  /** Dotted event name — `document.booted`, `listener.snapshot`, … */
  kind: string;
  detail?: Record<string, unknown>;
}

export interface SpikeSnapshotPush {
  type: 'spike.offscreen.snapshot';
  event: SpikeEvent;
}

export function isSpikeSnapshotPush(value: unknown): value is SpikeSnapshotPush {
  if (typeof value !== 'object' || value === null) return false;
  return (value as { type?: unknown }).type === 'spike.offscreen.snapshot';
}

/**
 * Appends are serialised through this chain because the buffer is a
 * read-modify-write over one storage slot: two overlapping appends from
 * the same context would silently drop one event, and dropped events are
 * exactly what this spike cannot afford.
 *
 * Cross-CONTEXT races (the SW appending while the offscreen document
 * does) are still possible and deliberately not solved — the SW writes
 * only on create/failure, which is rare and never concurrent with a
 * heartbeat in practice.
 */
let appendChain: Promise<void> = Promise.resolve();

/**
 * Log one event to the console and (unless `persist` is false) to the
 * ring buffer. Returns the event so a caller can forward it.
 *
 * `persist: false` exists for the one high-frequency call site: the SW
 * re-checks the offscreen document on EVERY wake, and the remote-apply
 * poll wakes it every 10s. Persisting "still there" would evict the
 * whole day's interesting events inside two hours.
 */
export function logSpike(
  ctx: SpikeContext,
  kind: string,
  detail?: Record<string, unknown>,
  options?: { persist?: boolean },
): SpikeEvent {
  const event: SpikeEvent = {
    at: new Date().toISOString(),
    ctx,
    kind,
    ...(detail ? { detail } : {}),
  };
  console.info(`[sba-ext] spike ${event.at} ${ctx} ${kind}`, detail ?? '');
  if (options?.persist === false) return event;
  appendChain = appendChain
    .then(() => appendToLog(event))
    .catch((err) => {
      console.warn('[sba-ext] spike could not persist an event', err);
    });
  return event;
}

async function appendToLog(event: SpikeEvent): Promise<void> {
  const stored = await chrome.storage.local.get(SPIKE_LOG_KEY);
  const raw: unknown = stored[SPIKE_LOG_KEY];
  const list: SpikeEvent[] = Array.isArray(raw) ? (raw as SpikeEvent[]) : [];
  list.push(event);
  await chrome.storage.local.set({ [SPIKE_LOG_KEY]: list.slice(-SPIKE_LOG_MAX) });
}

/** Last event already in the buffer, or `null` when it is empty. The
 * offscreen document reads this at boot so a fresh boot can report the
 * gap since the previous context died — which is the only durable
 * evidence of a reap, since a dying document cannot finish an async
 * storage write on its way out. */
export async function readLastSpikeEvent(): Promise<SpikeEvent | null> {
  const stored = await chrome.storage.local.get(SPIKE_LOG_KEY);
  const raw: unknown = stored[SPIKE_LOG_KEY];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return (raw as SpikeEvent[])[raw.length - 1] ?? null;
}

/** ms → a duration a human can read at a glance in a log line. */
export function humanDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
