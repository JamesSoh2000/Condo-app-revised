# 07 — Pilot Readiness

Real residents mean real personal data, real expectations and real consequences. This checklist is the bar
between "demo-ready" and "people depend on it".

- **When to start:** run it as its own phase (about 3–4 weeks) once a pilot building and date are named.
- **Order:** the order of sections below is roughly the order of work.
- **Evidence:** every item needs evidence (a link, a log, a test run or a signed note), not a tick.
- **Prerequisite:** milestone D is done, so staging is deployed and monitored
  ([ADR-0013](./adr/0013-local-first-deployment-milestone.md), [ROADMAP.md](./ROADMAP.md)). Production
  is built from the same Terraform and deploy pipeline.

Much of this was in the old M0-T09/T10, M3-T14, M14 and M15 tickets. It is not discarded; it is scheduled for
when it can actually be decided and verified.

## 1. Pilot agreement and product decisions

- [ ] Named pilot building, a building-side product owner, and a target date.
- [ ] Selected pilot options, if any (amenities, moves, visitors, reports, SMS), each detailed into tickets.
- [ ] Review the defaults in [PRODUCT_SCOPE.md §Product defaults](./PRODUCT_SCOPE.md#product-defaults-adopted-now-revisit-at-pilot)
      with the building and record changes as ADRs or scope edits:
  - package pickup authority
  - retention periods
  - council visibility
  - former-resident access
  - upload limits
- [ ] Workload numbers confirmed: units, residents, staff, peak concurrent users.
- [ ] Support model: who residents contact, response times, and how staff report bugs.
- [ ] Emergency-communication disclaimer agreed. The app is not a life-safety alert system; the building
      keeps its own emergency procedure.

## 2. Legal, privacy and language (confirm jurisdiction first)

Not legal advice. Get qualified advice for the specific building.

- [ ] **Jurisdiction confirmed.** The business schema's "Syndicate" and "NEQ" suggest Quebec.
- [ ] If Quebec, **Law 25** (Act respecting the protection of personal information in the private sector, as
      amended):
  - [ ] designate the person in charge of the protection of personal information, and publish their contact
  - [ ] publish a privacy policy in clear terms
  - [ ] keep a confidentiality-incident register and a breach-response procedure
  - [ ] complete a privacy impact assessment for the system, including where data is hosted
  - [ ] define retention and destruction rules per data category
- [ ] Federal **PIPEDA** obligations reviewed if applicable.
- [ ] **CASL** treatment of notification emails and SMS confirmed (transactional vs commercial), with the
      unsubscribe and identification requirements.
- [ ] **French language:** the UI, emails and legal texts are available in French if required. The Base44 app
      already has `src/lib/i18n.js`; migrated pages must keep using translatable strings.
- [ ] Terms of use accepted at signup, with an audited version and timestamp.
- [ ] Data residency: AWS `ca-central-1` for compute, DB, S3 and backups ([ADR-0008](./adr/0008-single-ec2-compose-caddy.md)).
      Sentry region and settings reviewed for personal data, with PII scrubbing on.
- [ ] Data-subject requests: an operator procedure to export and delete one person's data.

## 3. Security

- [ ] **Staff MFA:**
  - TOTP enrollment and challenge for every staff role, with hashed recovery codes
  - a reset procedure (operator CLI with audit) and attempt limits
  - session `mfa_verified_at` enforced on staff routes
- [ ] The pilot security review is complete:
  - ASVS L1 fully reviewed, with L2 for authentication and session sections
  - threat model updated
  - no open High findings
- [ ] Secrets rotated from staging values, and production secrets are only in SSM.
- [ ] IAM least privilege reviewed: the instance role can reach only its own buckets and parameters, and the
      deploy role only ECR push and SSM send-command on tagged instances.
- [ ] File uploads: decide on malware scanning (for example ClamAV in the worker, or an S3 scan service) and
      per-building storage quotas.
- [ ] Optionally, an external penetration test or a peer review by an experienced engineer.
- [ ] **Re-decide autonomous merging** ([ADR-0014](./adr/0014-autonomous-agent-workflow.md)): with real
      residents' data, decide whether Tier 1 PRs (auth, tenancy, files, deploy, deletion) need a human review
      before merge, and whether production deploys need a human trigger.

## 4. Environments, releases and recovery

- [ ] **Separate production environment** from the same Terraform, with different state, account or
      workspace, buckets, parameters and domain. Staging never touches production data.
- [ ] **Re-decide the database hosting** ([ADR-0009](./adr/0009-backups-staged.md)): self-hosted Postgres with
      pgBackRest and WAL archiving to S3, *or* RDS. Compare monthly cost and weekly maintenance hours and
      record the result as a new ADR.
- [ ] **Point-in-time recovery:**
  - Target RPO ≤ 15 min and RTO ≤ 4 h (proposed; confirm with the building).
  - **Drill:** restore to a replacement host from off-host backups.
  - Measure the actual RPO and RTO.
  - Reconcile S3 files against database rows.
  - Hold the job queue (pause the worker) until reconciled, so old emails are not resent.
- [ ] **Release safety:**
  - a deploy lock
  - a maintenance page (`503` + `Retry-After`) during migrations
  - pre-deploy backup freshness check
  - rollback = redeploy previous SHA, **rehearsed on staging**
  - expand/contract migrations verified against the previous release
- [ ] Interrupted deploy behaviour defined: stay in maintenance until a human verifies.
- [ ] Old browser tabs: keep the previous releases' hashed frontend assets.

## 5. Operations and monitoring

- [ ] Alerts go to a named on-call person, with a defined response window, for:
  - API 5xx rate
  - uptime failures
  - oldest due job > 5 min
  - dead jobs > 0
  - disk > 80%
  - backup age > 26 h
  - certificate expiry
- [ ] Runbooks in `docs/runbooks/`:
  - deploy
  - rollback
  - restore
  - worker stuck or dead jobs
  - disk full
  - suspected data leak / incident response
  - rotate secrets
  - reset staff MFA
  - offboard a resident
- [ ] Monthly budget with AWS budget alerts. Start at about $30/$40 for a `t3a.small` single host and revise
      after the load test.
- [ ] OS patching (unattended-upgrades) and a Postgres minor-version update plan.

## 6. Performance

- [ ] k6 load test at pilot workload on a production-sized instance with the worker and backups running:
  - 100 concurrent sessions with polling
  - bursts of 20 package creations per minute
  - one notice fanned out to 600 residents
- [ ] **Proposed thresholds** (confirm):
  - p95 ≤ 500 ms for reads and ≤ 1 s for writes
  - < 1% 5xx
  - oldest due email < 2 min
- [ ] Choose `t3a.small` vs `t3a.medium` from measured memory, CPU credits and latency.

## 7. Data and onboarding

- [ ] Decide **greenfield vs migration** from any live Base44 data. If migrating:
  - export
  - mapping
  - a validation script
  - a rehearsal on staging
  - row counts reconciled
  - a rollback plan
- [ ] Unit import (CSV → CLI with dry run), and staff provisioning via invitations.
- [ ] Resident onboarding plan: join link and QR poster, the manager approval workload, and a support script.
- [ ] Remove the Base44 SDK and plugin entirely. Runtime network traffic shows no `base44` calls, and
      deferred routes are unreachable.

## 8. Quality and acceptance

- [ ] UAT scripts per role (resident, security, manager, council), run by real building staff on staging with
      fake data. Record findings and fixes.
- [ ] Accessibility: the demo journeys meet WCAG 2.1 AA basics (keyboard, labels, contrast, focus), and work on
      a mid-range phone.
- [ ] A named person from the building signs off acceptance.
- [ ] Launch-day plan: a time window, a go/no-go checklist, a rollback trigger, and a communication to
      residents.

## Mapping from the old backlog

| Old tickets | Where they live now |
|---|---|
| M0-T09, M0-T10 (policy and targets) | §1, §6, plus ADR defaults now |
| M3-T14 (staff MFA) | §3 |
| M14-T05/T14, M15-T09 (backups, recovery drill) | §4 (demo: backup scripts + restore test, P7-01; staging: nightly to S3, D-05) |
| M14-T09, M15-T10 (maintenance releases, rollback drill) | §4 |
| M14-T11/T12 (alarms, uptime) | Basic in D-04; full alerting in §5 |
| M15-T04/T05 (security, privacy review) | §2, §3 (demo pass in P7-02) |
| M15-T06/T07 (UAT) | §8 |
| M15-T08 (load test) | §6 (laptop baseline in P7-03, staging re-run in D-06) |
| M4-T09 (Base44 exit, data cutover) | §7 |
| M15-T11–T13 (runbook, launch gate, launch) | §5, §8 |
