// Which remote-apply outcomes this device has already been shown.
//
// The result dialog raises for a terminal job THIS device queued, on
// sight — it cannot wait to witness the transition, because the phone
// is usually asleep when it happens (see `RemoteApply.tsx`). "On sight"
// means the raise condition is true on every mount until something
// records that the manager has read it, so the acknowledgement has to
// outlive the component, the page, and the browser session. Component
// state would re-pop the dialog on every reload; localStorage is the
// same storage `getDeviceId()` already uses for the id these jobs are
// matched against, and shares its `kindoo:` key namespace.
//
// Bounded, because jobs are never deleted: a manager who applies for
// years would otherwise carry every job id they ever dismissed. Oldest
// acknowledgements fall off first.
//
// **Eviction is not free, and the cap is sized so it never happens.**
// The original bound was justified by the dialog being mounted inside a
// pending request's card: an id old enough to be evicted belonged to a
// job whose request had long since left the queue, so nothing rendered
// to re-raise it. That is no longer true — the dialog is mounted at page
// level and selects across the entire mailbox, precisely so that an
// outcome survives its request leaving `pending`. Evicting an id now
// means the outcome it acknowledged raises again; worse, dismissing that
// re-raise evicts the next-oldest, which raises in turn, and the manager
// is in a modal loop with a year of their own history.
//
// So the cap is a storage-quota backstop, not a working limit, and it
// has to sit well beyond the number of remote applies one device can
// accumulate in the life of the install. At 1–2 requests a week — the
// whole stake's volume, of which only some are applied from a phone —
// 500 is decades, and costs about 20KB against a 5MB quota. A device
// that somehow exceeds it re-raises one old outcome per new dismissal,
// which is bad; a device that clears its storage loses its
// `getDeviceId()` at the same moment, so those jobs stop matching and
// nothing raises at all, which is fine.
//
// Every access is wrapped: Safari in Lockdown Mode and a full quota
// both throw on plain `localStorage` calls. A failed read reports "not
// acknowledged" and a failed write is dropped, which degrades to a
// dialog that reappears after a reload — annoying, and still better
// than a queue page that throws.

const STORAGE_KEY = 'kindoo:remoteApplyAckedJobs';

/**
 * How many acknowledgements to keep. Sized to be unreachable rather than
 * to be a working limit — see the module note on why eviction now
 * re-raises an outcome instead of being harmless.
 */
const MAX_REMEMBERED = 500;

function read(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** True when this device has already shown and dismissed this job's outcome. */
export function isJobAcknowledged(jobId: string): boolean {
  return read().includes(jobId);
}

/**
 * Record that the manager dismissed this job's result dialog here.
 * Idempotent — re-acknowledging an id already stored leaves the list
 * untouched rather than promoting it, so eviction order stays "oldest
 * acknowledgement first".
 */
export function acknowledgeJob(jobId: string): void {
  const current = read();
  if (current.includes(jobId)) return;
  const next = [...current, jobId].slice(-MAX_REMEMBERED);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable — the dialog will raise again after a reload.
  }
}

/** Test seam. Not called by app code. */
export function clearAcknowledgedJobs(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored to clear.
  }
}
