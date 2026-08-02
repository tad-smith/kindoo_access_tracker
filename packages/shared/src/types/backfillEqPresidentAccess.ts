// Input / output shapes for the `backfillEqPresidentAccess` HTTPS
// callable. Flipping a stake's `eq_president_app_access` changes which
// callings grant app access, but it does not by itself touch the
// `access` docs already derived from existing seats. This callable
// reconciles them in one pass: it sweeps the stake's auto ward-scope
// seats whose `callings[]` include Elders Quorum President and grants or
// revokes the corresponding access.
//
// `direction` mirrors the config flip that preceded it — `'grant'` after
// switching the flag on, `'revoke'` after switching it off. It is an
// explicit parameter rather than something read off the stake doc so a
// retry is unambiguous and so the two paths can be tested in isolation.
//
// Only the auto side is in scope: an Elders Quorum President who also
// holds a manual grant keeps it on revoke.

export interface BackfillEqPresidentAccessInput {
  stakeId: string;
  direction: 'grant' | 'revoke';
}

export interface BackfillEqPresidentAccessOutput {
  ok: true;
  /** Auto ward-scope seats whose callings include Elders Quorum President. */
  seats_matched: number;
  /** Access docs created or updated. */
  docs_written: number;
  /** Access docs deleted (revoke only; 0 on grant). */
  docs_deleted: number;
}
