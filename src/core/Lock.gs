// Single helper used by every write path. Per architecture.md §6:
// 10 s default tryLock; on contention, throw a user-friendly message that
// the client's rpc helper surfaces as a toast.
//
// Read paths do NOT take the lock — Sheet reads are snapshot-consistent
// enough for this workload, and lockingreads would serialise the whole app.
//
// Importer / Expiry (Chunks 3 / 8) raise timeoutMs because their work is
// longer; everything else uses the default.

const LOCK_DEFAULT_TIMEOUT_MS_ = 10000; // 10 s

function Lock_withLock(fn, opts) {
  opts = opts || {};
  var timeoutMs = opts.timeoutMs || LOCK_DEFAULT_TIMEOUT_MS_;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(timeoutMs)) {
    throw new Error('Another change is in progress — please retry in a moment.');
  }
  try {
    return fn();
  } finally {
    try { lock.releaseLock(); } catch (e) { /* best-effort release */ }
  }
}
