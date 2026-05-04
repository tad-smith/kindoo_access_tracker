// Shared helper: list active managers' typed emails for a stake.
// Used by both notification triggers (push + email) so they pick the
// same recipient set. Reading `member_email` (typed) rather than the
// canonical doc id matches `KindooManagers` tab semantics — the
// person's display address — and is what the email service hands to
// Resend.

import type { Firestore } from 'firebase-admin/firestore';
import type { KindooManager } from '@kindoo/shared';

export type ActiveManager = {
  /** Typed email — what we hand to Resend / show to a recipient. */
  email: string;
  /** Canonical email — keyed userIndex lookup, etc. */
  canonical: string;
};

/** Active managers for a stake, in doc-id (canonical) order. */
export async function activeManagers(db: Firestore, stakeId: string): Promise<ActiveManager[]> {
  const snap = await db
    .collection(`stakes/${stakeId}/kindooManagers`)
    .where('active', '==', true)
    .get();
  return snap.docs.map((d) => {
    const data = d.data() as KindooManager;
    const canonical = data.member_canonical ?? d.id;
    const email = data.member_email ?? canonical;
    return { canonical, email };
  });
}

/** Convenience: just the typed emails. */
export async function activeManagerEmails(db: Firestore, stakeId: string): Promise<string[]> {
  const list = await activeManagers(db, stakeId);
  return list.map((m) => m.email);
}
