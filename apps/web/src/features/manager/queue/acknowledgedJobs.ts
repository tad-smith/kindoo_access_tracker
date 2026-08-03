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
// acknowledgements fall off first — an id old enough to be evicted
// belongs to a job whose request left the queue long ago, so its card
// no longer renders and it can't re-raise anything.
//
// Every access is wrapped: Safari in Lockdown Mode and a full quota
// both throw on plain `localStorage` calls. A failed read reports "not
// acknowledged" and a failed write is dropped, which degrades to a
// dialog that reappears after a reload — annoying, and still better
// than a queue page that throws.

const STORAGE_KEY = 'kindoo:remoteApplyAckedJobs';

/**
 * How many acknowledgements to keep. At 1–2 requests a week this is
 * years of history; the cap exists so an unbounded list can't be the
 * thing that fills a phone's storage quota.
 */
const MAX_REMEMBERED = 50;

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
