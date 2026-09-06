// Shared copy for the Elders Quorum President app-access setting. Two
// surfaces carry the same toggle — the bootstrap wizard (Step 1) and
// Configuration → Config — and they must read identically.
//
// Drift here is not hypothetical. The label was renamed once and had to
// be hand-edited in both files; the second was caught by a grep rather
// than by anything structural. Nothing about the two call sites forces
// them to agree, so the agreement lives here instead.
//
// `test/eqPresidentAccessCopy.test.ts` fails if either surface
// re-inlines one of these strings, which is what keeps this module the
// only copy rather than merely the first one.

/**
 * Names the switch on both surfaces.
 *
 * "EQ" rather than "Elders Quorum" spelled out: at 375px the longer
 * form wrapped the row to two lines, which broke the alignment the
 * Config tab's indent depends on. Prose that is not a control label —
 * the backfill dialog's title and description — deliberately keeps
 * "Elders Quorum Presidents" written out, and is NOT read from here.
 */
export const EQ_PRESIDENT_ACCESS_LABEL = 'EQ Presidents Have SBA Access';

/**
 * The setting's explanation, shown behind the "i" affordance beside the
 * switch on both surfaces.
 *
 * States what the setting does and nothing about how to change it: the
 * wizard has no backfill offer (a stake still in setup has no seats to
 * reconcile) and the Config tab raises one on flip, so any sentence
 * about the reconcile pass would be wrong on one of the two.
 */
export const EQ_PRESIDENT_ACCESS_TIP =
  'When on, Sync grants app access to whoever holds the Elders Quorum President calling in ' +
  'each ward, and drops it again when the calling moves on.';
