# D-05 — Nightly backups to S3 and the staging restore test

| Field | Value |
|---|---|
| Phase / lane | D / A |
| Risk tier | 1 |
| Depends on | D-02 (host), P7-01 (backup and restore scripts), D-04 (uptime service, for the heartbeat alert) |
| Replaces old | M14-T05/T14 (demo subset), the staging half of the first draft's P7-01 |
| Status | todo |

> **Milestone D ([ADR-0013](../adr/0013-local-first-deployment-milestone.md)).** P7-01 built and tested the
> backup and restore scripts against the local stack. This ticket schedules them on the staging host
> against real S3, as [ADR-0009](../adr/0009-backups-staged.md) describes.

## Goal

The staging database is backed up every night to the versioned, encrypted backups bucket. A weekly restore
test proves the backups are usable, and both developers get an email if a backup is missing or a restore
fails.

## Why

Once staging hosts the demo and is shared with other people, losing its data costs real time. "A backup you
have never restored is not a backup", so the restore test runs on a schedule, not once.

## Scope

- In:
  - **systemd units** installed by cloud-init (D-02):
    - `condo-backup.service` + `condo-backup.timer` (nightly, `Persistent=true`) run the P7-01
      `scripts/backup.sh` against the staging `db` container. It uploads to the backups bucket from D-01,
      using the instance role, with no endpoint override.
    - `condo-restore-test.service` + `.timer` (weekly) download the newest dump from S3 and run the P7-01
      `scripts/restore-test.sh` in a throwaway `postgres:16` container on the host. It prints
      `alembic current` and the key row counts.
  - **Retention:** 14 dailies ([ADR-0009](../adr/0009-backups-staged.md)), enforced by the bucket lifecycle
    from D-01 or by the script. Say which in the runbook.
  - **Alert:** a heartbeat (dead-man's switch) monitor in the uptime service from D-04. `backup.sh` and
    `restore-test.sh` ping it only on success. If no ping arrives within 26 h (backup) or 8 days (restore
    test), both devs get an email.
  - **Runbook `docs/runbooks/restore.md`:** extend the local version from P7-01 with "restore staging from
    S3 onto the host or a replacement host". Each developer rehearses it once and notes the time it took
    (the measured RTO).
- Out:
  - PITR, WAL archiving and the RDS re-decision (pilot; [07](../PILOT_READINESS.md) §4)
  - EBS snapshots (pilot extra)

## Interfaces

systemd units `condo-backup.{service,timer}` and `condo-restore-test.{service,timer}`. Env
`BACKUP_BUCKET`, `BACKUP_HEARTBEAT_URL`, `RESTORE_HEARTBEAT_URL` (rendered into `/srv/app/.env` from SSM by
`deploy.sh`).

## Acceptance criteria

1. **Given** the host, **then** `systemctl list-timers` shows both timers with their next run times.
2. **Given** `systemctl start condo-backup`, **then** a new dump appears in the backups bucket with a
   version ID. The journal shows its size and duration, and no secrets.
3. **Given** `systemctl start condo-restore-test`, **then** the latest dump restores into a throwaway
   container, the row counts and `alembic current` are printed, and the container is removed.
4. **Given** the backup timer is disabled, **when** the heartbeat window passes (or a shortened window is
   used for the test), **then** both devs receive an alert email.
5. **Given** the runbook, **then** both developers have restored staging from S3 once, and the PR records
   each measured restore time.

## Test plan

Manual verification on staging with the journal output and the S3 listing in the PR. `shellcheck` on any new
script, and `systemd-analyze verify` on the units.

## Likely files

`deploy/systemd/condo-backup.{service,timer}`, `deploy/systemd/condo-restore-test.{service,timer}`,
`infra/host/cloud-init.yaml`, `scripts/backup.sh`, `scripts/restore-test.sh`, `docs/runbooks/restore.md`.

## Must explain (learning checkpoint)

1. What are our staging RPO and RTO, and how did you measure the RTO?
2. Why does the alert use a heartbeat that must arrive, rather than a check that fires on failure?
3. Why is `pg_dump --format=custom` enough for staging but not for real residents?

## Frame notes (filled by the human in step 1)

- Design prediction:
- Extra cases added:
