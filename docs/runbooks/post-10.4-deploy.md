# Post-deploy runbook — Phase 10.4 Auto Kindoo Access

**Audience:** the Kindoo Manager who deploys Phase 10.4. Not for code reading.

**One-line warning:** Phase 10.4 changes how the importer decides whether to create an auto seat for a calling. Run through this runbook **before triggering the next import** or you may silently lose every auto seat in the system.

## 1. Why this runbook exists

Before Phase 10.4, the importer's rule for "should this calling get an auto seat?" was simply: "is the calling listed in the Auto Ward Callings or Auto Stake Callings tab?" Every listed calling created a seat.

Phase 10.4 splits that into two independent flags on each calling-template row:

| Flag | What it controls |
|---|---|
| **Auto Kindoo Access** *(new)* | Whether the importer auto-creates a seat for holders of this calling. |
| **Can Request Access** *(rename of `give_app_access`)* | Whether holders of this calling can request app access. (Same field as before; UI label only.) |

**The destructive bit:** existing calling-template rows have no `Auto Kindoo Access` flag yet. The importer treats a missing flag as `false`. So on the **first import after the Phase 10.4 deploy**, every auto seat tied to a calling whose template hasn't yet been flagged `Auto Kindoo Access = true` will be **deleted**.

This runbook walks you through flagging every template that should keep producing seats — before you trigger that import.

## 2. Pre-flight

- [ ] Phase 10.4 has deployed to **staging**. Verify by visiting the staging Configuration → Auto Ward Callings tab and confirming you see a table with three columns: Calling Name, Auto Kindoo Access, Can Request Access.
- [ ] You have a recent snapshot of prod data restored into staging (PITR restore from `infra/runbooks/restore.md`, or a recent backup). The point is to rehearse this procedure against realistic data first.
- [ ] You're logged in to staging as a Kindoo Manager.
- [ ] You have a notepad / spreadsheet handy. You'll be making one decision per template (≤ 50 decisions; usually 10–20).

## 3. Step-by-step

### 3a. (Strongly recommended) Rehearse on staging first

Walk all of §3b–§3e on staging end-to-end. The first run will surface every gotcha. You can revert by doing nothing — the staging Firestore is your sandbox.

### 3b. Open Auto Ward Callings

1. Sign in to the production app as a Kindoo Manager.
2. Click **Configuration** in the nav.
3. Click the **Auto Ward Callings** tab.

You'll see a table of every ward-level calling template. Two columns of checkboxes:
- **Auto Kindoo Access** — currently empty (unchecked) on every row, because the field was just added.
- **Can Request Access** — preserves whatever `give_app_access` was before; checked on the rows that previously gave app access.

### 3c. Decide and tick per row

For each row, decide: **should every person currently holding this calling get an auto seat after the next import?**

The pre-Phase-10.4 answer was always "yes" (because being listed in this tab was sufficient). The simplest, safest mass action is:

> **Tick `Auto Kindoo Access` on every row that you want to preserve current behaviour for.**

If there are rows where you've decided you actually don't want auto seats anymore (e.g. you added a template just for the `Can Request Access` side of things), leave `Auto Kindoo Access` unchecked on those.

To toggle: click the row's **Edit** button on the right → check **Auto Kindoo Access** → click **Save Changes**.

Tip: the sheet position survives the edit; you don't have to re-set anything else.

### 3d. Repeat for Auto Stake Callings

Click the **Auto Stake Callings** tab. Walk every row the same way.

### 3e. Trigger the next import

1. Click **Import** in the nav.
2. Click **Run Import Now**.
3. Wait ~10–60s for the import summary banner to update.

## 4. What to expect

- **Seats whose calling templates you ticked `Auto Kindoo Access` on:** untouched. Counts unchanged in All Seats; no audit churn.
- **Seats whose calling templates you left unticked:** **deleted**. One `delete_seat` audit row per deletion.
- **Seats unrelated to any template (manual + temp seats):** unaffected, regardless. The importer never touches manual / temp seats.
- **Access rows (Access page):** untouched by this change. The `Can Request Access` flag governs those, and you didn't touch it.

## 5. Verify

- [ ] Open the **Audit Log** page. Filter by `delete_seat` and read the latest entries from the import. Are these the deletions you expected?
- [ ] Open the **All Seats** page. Spot-check 3–5 callings: were the right seats deleted, were the right ones preserved?
- [ ] Open the **Access** page. The grants should be unchanged — the `Can Request Access` semantic didn't move.
- [ ] Save a screenshot of the Audit Log filter view as a snapshot of what changed in this import. (Compliance + future-you will appreciate it.)

## 6. Roll back if it looks wrong

There are two roll-back paths.

### 6a. Cheap (recommended unless damage is mass / structural)

If you only missed a few templates that should have been ticked:

1. Go back to Configuration → Auto Ward Callings (or Stake).
2. Edit the missed rows → tick **Auto Kindoo Access** → save.
3. Re-trigger Import.
4. The importer reads the calling sheet fresh and re-creates the seats.

This works because the source of truth (the LCR callings sheet) is unchanged. Rebuilding seats from a source-of-truth re-read is the importer's normal operating mode.

### 6b. Heavy (mass unexpected deletions, or you can't tell what happened)

Restore Firestore from PITR — see `infra/runbooks/restore.md`. PITR has a 7-day window so you have time, but don't dawdle.

## 7. Sign-off checklist

Before declaring "Phase 10.4 closed":

- [ ] Rehearsed in staging with a representative data snapshot.
- [ ] Reviewed every template in Auto Ward Callings.
- [ ] Reviewed every template in Auto Stake Callings.
- [ ] Triggered the import.
- [ ] Verified Audit Log deletions match expectations.
- [ ] Spot-checked All Seats counts.
- [ ] Saved a screenshot of the Audit Log view.
- [ ] No support tickets in the 24h after import. (1–2 requests/week scale; if there's a regression a manager will notice quickly.)
