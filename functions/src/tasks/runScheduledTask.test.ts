// Unit lane for the generic task runner. No emulator: resolution and
// error classification are all this function does.
//
// The queue's OIDC auth on the callback and real Cloud Tasks retry
// behaviour have no local equivalent and are first exercised on staging.

import { describe, expect, it, vi } from 'vitest';
import { logger } from 'firebase-functions';
import type { JobRegistry } from '../lib/taskRegistry.js';
import { runScheduledTask, runScheduledTaskHandler } from './runScheduledTask.js';

const NOW = new Date('2026-09-05T14:00:00.000Z');

function registryWith(handler: JobRegistry[string]['handler']): JobRegistry {
  return {
    demo: { handler, defaultSchedule: { type: 'hourly' }, defaultEnabled: false },
  };
}

describe('runScheduledTaskHandler', () => {
  it('resolves the handler from the registry and passes stake + instant through', async () => {
    const handler = vi.fn(async () => ({ status: 'sent' }));
    const outcome = await runScheduledTaskHandler(
      { stakeId: 'csnorth', job: 'demo' },
      { registry: registryWith(handler), now: NOW },
    );

    expect(outcome).toBe('ran');
    expect(handler).toHaveBeenCalledWith('csnorth', NOW);
  });

  it('logs at ERROR and returns for an unknown job rather than burning retries', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const outcome = await runScheduledTaskHandler(
        { stakeId: 'csnorth', job: 'retired' },
        { registry: registryWith(async () => undefined), now: NOW },
      );

      expect(outcome).toBe('unknown-job');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('no handler registered');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.each([
    ['missing stakeId', { job: 'demo' }],
    ['missing job', { stakeId: 'csnorth' }],
    ['empty stakeId', { stakeId: '', job: 'demo' }],
    ['non-string job', { stakeId: 'csnorth', job: 7 }],
    ['no payload at all', undefined],
  ])('logs at ERROR and returns on a malformed payload (%s)', async (_label, payload) => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const handler = vi.fn(async () => undefined);
    try {
      const outcome = await runScheduledTaskHandler(payload, {
        registry: registryWith(handler),
        now: NOW,
      });

      expect(outcome).toBe('invalid-payload');
      expect(handler).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('propagates a handler throw so Cloud Tasks retries it', async () => {
    const boom = new Error('Firestore unavailable');
    await expect(
      runScheduledTaskHandler(
        { stakeId: 'csnorth', job: 'demo' },
        {
          registry: registryWith(async () => {
            throw boom;
          }),
          now: NOW,
        },
      ),
    ).rejects.toBe(boom);
  });
});

describe('runScheduledTask registration', () => {
  type Endpoint = {
    taskQueueTrigger?: { retryConfig?: { maxAttempts?: number } };
    secretEnvironmentVariables?: Array<{ key: string }>;
  };

  it('is a task-queue function with a bounded retry budget', () => {
    const endpoint = (runScheduledTask as unknown as { __endpoint?: Endpoint }).__endpoint;
    expect(endpoint?.taskQueueTrigger).toBeDefined();
    expect(endpoint?.taskQueueTrigger?.retryConfig?.maxAttempts).toBe(3);
  });

  it('has RESEND_API_KEY mounted, since registered jobs (e.g. the sync reminder) can send email', () => {
    const endpoint = (runScheduledTask as unknown as { __endpoint?: Endpoint }).__endpoint;
    expect(endpoint?.secretEnvironmentVariables?.map((s) => s.key)).toContain('RESEND_API_KEY');
  });
});
