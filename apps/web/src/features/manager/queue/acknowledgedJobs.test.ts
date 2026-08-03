import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acknowledgeJob, clearAcknowledgedJobs, isJobAcknowledged } from './acknowledgedJobs';

const STORAGE_KEY = 'kindoo:remoteApplyAckedJobs';

beforeEach(() => {
  clearAcknowledgedJobs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('acknowledgedJobs', () => {
  it('reports an unseen job as not acknowledged', () => {
    expect(isJobAcknowledged('job-1')).toBe(false);
  });

  it('remembers a dismissed job across a fresh read', () => {
    acknowledgeJob('job-1');
    expect(isJobAcknowledged('job-1')).toBe(true);
    expect(isJobAcknowledged('job-2')).toBe(false);
  });

  it('survives a reload — the whole reason this is not component state', () => {
    acknowledgeJob('job-1');
    // A reload keeps localStorage and nothing else; reading it back is
    // exactly what a remounted row does.
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    expect(stored).toEqual(['job-1']);
  });

  it('keeps the list from growing without bound, evicting oldest first', () => {
    for (let i = 0; i < 60; i += 1) acknowledgeJob(`job-${i}`);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as string[];
    expect(stored).toHaveLength(50);
    // The 10 oldest fell off; the newest are what could still re-raise.
    expect(isJobAcknowledged('job-9')).toBe(false);
    expect(isJobAcknowledged('job-10')).toBe(true);
    expect(isJobAcknowledged('job-59')).toBe(true);
  });

  it('does not re-add a job already acknowledged', () => {
    acknowledgeJob('job-1');
    acknowledgeJob('job-1');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')).toEqual(['job-1']);
  });

  it('treats unparseable storage as no acknowledgements rather than throwing', () => {
    localStorage.setItem(STORAGE_KEY, 'not json');
    expect(isJobAcknowledged('job-1')).toBe(false);
    // …and a write recovers the key to a valid list.
    acknowledgeJob('job-1');
    expect(isJobAcknowledged('job-1')).toBe(true);
  });

  it('ignores non-string entries left by an older or corrupted write', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['job-1', 42, null]));
    expect(isJobAcknowledged('job-1')).toBe(true);
  });

  it('degrades to "not acknowledged" when storage refuses to be read', () => {
    // Safari Lockdown Mode and a full quota both throw outright.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(isJobAcknowledged('job-1')).toBe(false);
  });

  it('swallows a failed write rather than breaking the queue page', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => acknowledgeJob('job-1')).not.toThrow();
  });
});
