# ADR-0009: Staged backups — pg_dump for the demo, PITR (or RDS) before the pilot

- Status: Accepted
- Date: 2026-10-13
- Amended by [ADR-0013](./0013-local-first-deployment-milestone.md): the backup and restore scripts are
  built and tested locally in P7-01. The nightly schedule on the host comes with staging in milestone D
  (D-05).

## Context

The adopted plan specifies pgBackRest with continuous WAL archiving to S3, RPO ≤ 15 min, RTO ≤ 4 h, and
off-host restore drills. That is the right target for real residents. Before the pilot, though, the database
holds only seed and demo data, and the operations work would delay the product by weeks.

## Decision

- **Demo, local (P7-01):**
  - `scripts/backup.sh` runs `pg_dump --format=custom` and uploads the dump to a backups bucket. Locally,
    that bucket is in the S3 emulator.
  - `scripts/restore-test.sh` restores the latest dump into a throwaway container and runs sanity queries (row
    counts, `alembic current`). CI runs it weekly.
- **Staging (D-05):**
  - The same `backup.sh` runs nightly via a systemd timer on the host, uploading to the versioned, encrypted
    backups bucket. Keep 14 dailies.
  - The weekly restore test pulls the latest dump from S3. An alert fires if it fails or if the newest
    backup is older than 26 h.
  - Staging RPO is about 24 h. Staging RTO is about 1 h (manual).
- **Before pilot** (re-decision recorded as a new ADR):
  - **Option A:** pgBackRest + WAL archiving to S3 on the existing host, with a measured restore drill onto
    a replacement host.
  - **Option B:** move to RDS PostgreSQL (`db.t4g.micro`/`small`) with automated PITR. It costs more, but there
    is no backup tooling to operate.
  - Choose with real numbers: monthly cost, setup hours, ongoing hours, and drill results.

## Consequences

- Backup and restore are scripted and *tested* from week 8, which is the property that matters, and they
  run nightly once staging exists (milestone D).
- Demo data loss of up to a day is acceptable. It is never acceptable with real residents, hence the pilot gate.

## Alternatives considered

- **pgBackRest now:** the correct end state, but premature.
- **EBS snapshots only:** crash-consistent, not application-consistent, and still need restore testing. They
  are a useful *extra* (AWS Data Lifecycle Manager) at pilot.

## Revisit when

A pilot date is set. This ADR must be superseded before any real resident data is stored.
