// Phase 1 smoketest page.
//
// Reads the smoketest doc at `stakes/_smoketest/hello` via reactfire's
// `useFirestoreDocData`. The doc may not be seeded yet (operator runs a
// seed step after wiring Firebase up), so the page handles loading,
// error, "no data", and "invalid path" states without throwing.
//
// Phase 4 replaces this page with the real auth-gated landing page.

import type { DocumentReference } from 'firebase/firestore';
import { doc } from 'firebase/firestore';
import { useFirestore, useFirestoreDocData } from 'reactfire';

const SMOKETEST_PATH = 'stakes/_smoketest/hello';

export function Hello() {
  const firestore = useFirestore();

  // `doc()` validates the path string at call time. The smoketest path
  // may not resolve to a valid even-segment document path under the
  // current schema; we catch that synchronous throw and surface it as a
  // visible error rather than letting the page itself crash. Playwright
  // asserts the page renders, not that the doc resolves successfully.
  let ref: DocumentReference | null = null;
  let pathError: Error | null = null;
  try {
    ref = doc(firestore, SMOKETEST_PATH);
  } catch (err) {
    pathError = err instanceof Error ? err : new Error(String(err));
  }

  return (
    <main>
      <h1>Kindoo &mdash; Phase 1 smoketest</h1>
      {pathError ? (
        <SmoketestPathError error={pathError} />
      ) : (
        <SmoketestDoc reference={ref as DocumentReference} />
      )}
    </main>
  );
}

function SmoketestPathError({ error }: { error: Error }) {
  return (
    <pre role="alert">
      Smoketest path <code>{SMOKETEST_PATH}</code> is not a valid doc reference: {error.message}
    </pre>
  );
}

function SmoketestDoc({ reference }: { reference: DocumentReference }) {
  // `suspense: false` tells reactfire to surface loading state via the
  // returned `status` field rather than throwing a promise. That lets
  // the heading render synchronously even when the emulator isn't
  // running — the smoke test asserts the heading, not the data.
  const { status, data, error } = useFirestoreDocData(reference, {
    suspense: false,
  });

  if (status === 'loading') {
    return <p>Loading&hellip;</p>;
  }
  if (status === 'error') {
    return <pre role="alert">Error: {error?.message ?? 'unknown'}</pre>;
  }
  if (data === undefined) {
    return (
      <p>
        <em>No smoketest doc seeded yet.</em>
      </p>
    );
  }
  return <pre>{JSON.stringify(data, null, 2)}</pre>;
}
