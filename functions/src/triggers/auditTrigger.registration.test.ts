// Invariant tests for the audit trigger's registration surface. Unit
// lane — no emulator; everything here reads the deploy manifest the
// exports carry plus the rules file on disk.
//
// The gap this closes is the one retries can't see: a NEW client-writable
// collection added without a matching `onDocumentWritten` registration
// writes no audit row at all, and nothing fails. So we derive the
// expected collection set from `firestore/firestore.rules` — the one
// place a client-writable collection MUST appear — and set-compare it
// against the registered triggers.
//
// Two blind spots, both deliberate. A rules block alone is NOT enough
// to be covered here:
//
//   - The scan is sliced to `match /stakes/{stakeId}`, so top-level
//     collections are outside it — `userIndex`, `platformSuperadmins`,
//     `platformAuditLog` and `remoteApply` all have rules blocks and no
//     audit trigger, by design (per-stake `auditLog` is what this fans).
//   - A collection written only via the Admin SDK needs no rules block
//     at all, so it is invisible either way.
//
// If either ever needs auditing, that's a hand-decision at the time.

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import {
  auditAccessWrites,
  auditBuildingWrites,
  auditKindooSiteWrites,
  auditManagerWrites,
  auditOrganizationWrites,
  auditRequestWrites,
  auditSeatWrites,
  auditStakeWrites,
  auditWardWrites,
  emitAuditRow,
  isPermanentAuditWriteError,
} from './auditTrigger.js';

/**
 * Collections with a rules block that deliberately get NO audit trigger.
 * `auditLog` is the audit sink itself — a trigger on it would recurse.
 * A future deliberately-unaudited collection has to be added here by
 * hand, and that forced edit is the point: it's the review moment.
 */
const UNAUDITED = new Set(['auditLog']);

/**
 * Every audit trigger export, as the deploy manifest sees them.
 *
 * Hand-maintained, and checked against `src/index.ts` below — a trigger
 * that exists here but isn't re-exported for deploy is never deployed
 * and writes no audit rows, which is the same silent outcome this file
 * exists to prevent.
 */
const TRIGGERS = {
  auditStakeWrites,
  auditWardWrites,
  auditBuildingWrites,
  auditKindooSiteWrites,
  auditOrganizationWrites,
  auditManagerWrites,
  auditAccessWrites,
  auditSeatWrites,
  auditRequestWrites,
};

type Endpoint = {
  eventTrigger?: {
    eventFilterPathPatterns?: { document?: string };
    retry?: boolean;
  };
};

/** Read a trigger's `(document, retry)` off its deploy manifest. */
function endpointOf(name: string, fn: unknown): { document: string; retry: boolean | undefined } {
  const endpoint = (fn as { __endpoint?: Endpoint }).__endpoint;
  const eventTrigger = endpoint?.eventTrigger;
  expect(eventTrigger, `${name} has no eventTrigger on __endpoint`).toBeDefined();
  // Wildcard paths land in `eventFilterPathPatterns`, not `eventFilters`.
  const document = eventTrigger?.eventFilterPathPatterns?.document;
  expect(typeof document, `${name} has no document path pattern`).toBe('string');
  return { document: document as string, retry: eventTrigger?.retry };
}

/**
 * Sub-collection names declared under `match /stakes/{stakeId}`.
 *
 * Region-sliced first: `remoteApply`'s `desktops` / `jobs` blocks sit at
 * the same six-space indent under a different parent, so an unsliced
 * scan would pull them in.
 */
function ruleSubCollections(): string[] {
  const rulesPath = fileURLToPath(new URL('../../../firestore/firestore.rules', import.meta.url));
  const lines = readFileSync(rulesPath, 'utf8').split('\n');

  const start = lines.findIndex((l) => l === '    match /stakes/{stakeId} {');
  expect(start, 'could not find the four-space `match /stakes/{stakeId} {` block').toBeGreaterThan(
    -1,
  );
  const relativeEnd = lines.slice(start + 1).findIndex((l) => l === '    }');
  expect(relativeEnd, 'could not find the stakes block closing brace').toBeGreaterThan(-1);

  const slice = lines.slice(start + 1, start + 1 + relativeEnd);
  const matched: string[] = [];
  for (const line of slice) {
    const m = /^ {6}match \/(\w+)\/\{\w+\} \{/.exec(line);
    if (m?.[1]) matched.push(m[1]);
  }
  return matched;
}

/** Names re-exported from `src/index.ts` — the deploy surface. */
function deployedExports(): string[] {
  const indexPath = fileURLToPath(new URL('../index.ts', import.meta.url));
  const src = readFileSync(indexPath, 'utf8');
  const names: string[] = [];
  for (const block of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const raw of (block[1] ?? '').split(',')) {
      // `export { a as b }` deploys under `b`.
      const name = raw
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) names.push(name);
    }
  }
  expect(names.length, 'parsed no exports out of src/index.ts').toBeGreaterThan(0);
  return names;
}

describe('audit trigger registrations', () => {
  it('covers every client-writable sub-collection declared in the rules', () => {
    const fromRules = ruleSubCollections();
    // Canary: proves the regex read real blocks rather than matching
    // nothing and passing vacuously.
    expect(fromRules).toContain('auditLog');

    const expected = fromRules.filter((c) => !UNAUDITED.has(c)).sort();

    const registered = Object.entries(TRIGGERS)
      .map(([name, fn]) => endpointOf(name, fn).document)
      .filter((doc) => doc !== 'stakes/{stakeId}')
      .map((doc) => {
        const m = /^stakes\/\{stakeId\}\/(\w+)\//.exec(doc);
        return m?.[1] ?? doc;
      })
      .sort();

    expect(registered).toEqual(expected);
  });

  it('registers exactly one trigger on the stake parent doc', () => {
    // The rules can't attest this one — `match /stakes/{stakeId}` is the
    // slice boundary itself, so it's hand-asserted.
    const parentDocs = Object.entries(TRIGGERS)
      .map(([name, fn]) => endpointOf(name, fn).document)
      .filter((doc) => doc === 'stakes/{stakeId}');
    expect(parentDocs).toEqual(['stakes/{stakeId}']);
  });

  it('re-exports every audit trigger from index.ts so it actually deploys', () => {
    // Without this, a tenth trigger added here and to `auditTrigger.ts`
    // but not to the export block passes every other assertion in this
    // file while never being deployed. `verify-deploy.sh` can't catch it
    // either — it treats `index.ts` as the source of truth for what
    // should exist.
    const exported = deployedExports();
    const missing = Object.keys(TRIGGERS).filter((name) => !exported.includes(name));
    expect(missing, 'audit triggers missing from src/index.ts').toEqual([]);
  });

  it('sets retry on every registration', () => {
    for (const [name, fn] of Object.entries(TRIGGERS)) {
      expect(endpointOf(name, fn).retry, `${name} must opt into retries`).toBe(true);
    }
  });
});

describe('permanent audit-write failures', () => {
  it('classifies gRPC INVALID_ARGUMENT as permanent', () => {
    expect(isPermanentAuditWriteError({ code: 3 })).toBe(true);
  });

  it.each([
    ['PERMISSION_DENIED', 7],
    ['UNAVAILABLE', 14],
    ['DEADLINE_EXCEEDED', 4],
    ['RESOURCE_EXHAUSTED', 8],
    ['ABORTED', 10],
  ])('classifies %s (%i) as retryable', (_name, code) => {
    expect(isPermanentAuditWriteError({ code })).toBe(false);
  });

  it('classifies a code-less error as retryable', () => {
    expect(isPermanentAuditWriteError(new Error('serializer blew up'))).toBe(false);
    expect(isPermanentAuditWriteError(null)).toBe(false);
    expect(isPermanentAuditWriteError('boom')).toBe(false);
  });

  const CTX = {
    stakeId: 'teststake',
    collection: 'seats' as const,
    docId: 'member@example.com',
    entityType: 'seat' as const,
    before: null,
    after: { lastActor: { email: 'a@example.com', canonical: 'a@example.com' } },
    eventTime: '2026-08-18T12:00:00.000Z',
  };

  /** Firestore handle whose only `set()` rejects with `err`. */
  function makeFakeDb(err: unknown): Firestore {
    const set = vi.fn().mockRejectedValue(err);
    const doc = vi.fn().mockReturnValue({ set });
    return { doc } as unknown as Firestore;
  }

  it('drops the row and logs its coordinates on a permanent rejection', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      await expect(emitAuditRow(CTX, makeFakeDb({ code: 3, message: 'too big' }))).resolves.toBe(
        undefined,
      );
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [message, payload] = errorSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(message).toContain('permanently rejected');
      expect(payload).toMatchObject({
        stakeId: 'teststake',
        collection: 'seats',
        docId: 'member@example.com',
        action: 'create_seat',
        actorCanonical: 'a@example.com',
        code: 3,
        // `message` is reserved by the logger; the rejection reason has
        // to travel under a non-colliding key or it's dropped.
        errorMessage: 'too big',
      });
      expect(payload).not.toHaveProperty('message');
      expect(typeof payload['auditDocId']).toBe('string');
      expect(typeof payload['approxRowBytes']).toBe('number');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('rethrows a retryable rejection so Eventarc redelivers', async () => {
    const err = { code: 14, message: 'unavailable' };
    await expect(emitAuditRow(CTX, makeFakeDb(err))).rejects.toBe(err);
  });
});
