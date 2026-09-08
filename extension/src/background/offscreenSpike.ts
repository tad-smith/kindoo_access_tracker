// SPIKE — service-worker half of the offscreen realtime-listener probe.
// Not wired into remote apply; see extension/docs/offscreen-listener-spike.md.
//
// Two jobs, both deliberately small:
//
//   1. Make sure the offscreen document exists. Every SW wake re-checks,
//      because the SW is the only context that can create one and it has
//      no persistent loop of its own. In practice that is frequent
//      cover: with a Kindoo tab open, the existing remote-apply poll
//      wakes the SW every 10–60s, so a reaped document is re-created
//      within about a minute. With no Kindoo tab open nothing wakes the
//      SW at all — a real gap, and one a production version would have
//      to close (see the notes file).
//
//   2. Receive the offscreen document's snapshot pushes and log them.
//      That is all. The point of the spike is evidence, so the SW must
//      not claim, provision, or finalise anything on the strength of a
//      snapshot.
//
// The message listener never calls `sendResponse` and never returns
// true. `background/messages.ts` already has a listener that answers
// every object carrying a string `type`, and two listeners racing to
// respond to one message is a bug where the faster one silently wins.
// Nothing here needs a reply, so nothing here competes.

import {
  isSpikeSnapshotPush,
  logSpike,
  OFFSCREEN_DOCUMENT_PATH,
  OFFSCREEN_JUSTIFICATION,
  OFFSCREEN_REASON,
} from '../lib/spike';

export type EnsureOutcome =
  /** Chrome has no `chrome.offscreen` — too old, or the permission is missing. */
  | 'unavailable'
  /** A document was already up; nothing to do. */
  | 'existing'
  /** We created one just now. */
  | 'created'
  /** `createDocument` rejected for a reason other than "already exists". */
  | 'failed';

/**
 * Dedupes concurrent creates within ONE service-worker lifetime.
 *
 * This is not the mutable SW state the workspace conventions ban: it is
 * an in-flight promise, worthless after a suspend, and re-derived from
 * `getContexts` on the next wake. Chrome rejects a second
 * `createDocument` while the first is still landing, and two wake
 * triggers arriving together (an action click plus a poll tick) is
 * ordinary.
 */
let creating: Promise<void> | null = null;

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  });
  return contexts.length > 0;
}

/** Chrome's "you already have one" rejection. Racing to create is
 * expected, not a fault — treat it as success. */
function isAlreadyExistsError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes('only a single offscreen');
}

/**
 * Create the offscreen document if it is not already up.
 *
 * Logs `offscreen.created` / `offscreen.createFailed` to the durable
 * buffer, but logs the "already there" case to the console only. The SW
 * calls this on every wake; persisting a no-op would evict the day's
 * real events inside a couple of hours.
 */
export async function ensureOffscreenDocument(): Promise<EnsureOutcome> {
  if (typeof chrome.offscreen === 'undefined') {
    logSpike('sw', 'offscreen.unavailable', {
      why: 'chrome.offscreen is undefined — missing `offscreen` permission or a Chrome older than 109',
    });
    return 'unavailable';
  }

  if (await hasOffscreenDocument()) {
    logSpike('sw', 'offscreen.existing', undefined, { persist: false });
    return 'existing';
  }

  if (creating) {
    await creating.catch(() => undefined);
    return 'existing';
  }

  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [OFFSCREEN_REASON],
    justification: OFFSCREEN_JUSTIFICATION,
  });

  try {
    await creating;
    logSpike('sw', 'offscreen.created', {
      url: OFFSCREEN_DOCUMENT_PATH,
      reason: OFFSCREEN_REASON,
    });
    return 'created';
  } catch (err) {
    if (isAlreadyExistsError(err)) {
      logSpike('sw', 'offscreen.existing', { note: 'lost the create race' }, { persist: false });
      return 'existing';
    }
    logSpike('sw', 'offscreen.createFailed', {
      reason: OFFSCREEN_REASON,
      message: err instanceof Error ? err.message : String(err),
    });
    return 'failed';
  } finally {
    creating = null;
  }
}

/**
 * Wire up the spike: listen for the offscreen document's pushes, then
 * make sure it is running.
 *
 * `onStartup` and `onInstalled` are belt-and-braces on top of the
 * top-level call — both fire into a SW that is already executing this
 * module, so they cost one `getContexts` each.
 */
export function registerOffscreenSpike(): void {
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!isSpikeSnapshotPush(message)) return undefined;
    // Console only. The offscreen document already persisted this exact
    // event before sending it; writing it again would double every
    // snapshot in the timeline.
    console.info('[sba-ext] spike sw saw a snapshot push', message.event);
    return undefined;
  });

  chrome.runtime.onStartup?.addListener(() => {
    void ensureOffscreenDocument();
  });
  chrome.runtime.onInstalled?.addListener(() => {
    void ensureOffscreenDocument();
  });

  void ensureOffscreenDocument();
}
