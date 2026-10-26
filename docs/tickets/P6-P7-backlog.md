# P6–P7 Backlog (stubs — detail during week 5)

These are deliberately **not** detailed yet (rolling wave). During week 5, after the packages slice has taught
you what the recipe looks like, turn each stub into a full ticket file with
[`/draft-ticket <ID>`](../../.claude/commands/draft-ticket.md), which uses
[../templates/TICKET.md](../templates/TICKET.md) and `docs/SLICE_RECIPE.md`. A human edits and accepts each
draft before it is framed. Each stub lists the goal, the key
interfaces and the decisions to make while framing.

## P6 — Notices, maintenance, dashboard (week 7)

### P6-01 — Notices backend · Lane B · Tier 2
Drafted and split into [P6-01a](./P6-01a-notice-schema-and-visibility.md) (schema, state machine, visibility,
attachment hook), [P6-01b](./P6-01b-notice-authoring-api.md) (manager API) and
[P6-01c](./P6-01c-notice-reads-and-fan-out.md) (reads, unread summary, publish fan-out). The stub's "Decide while
framing" items and its 600-recipient **Watch** are carried into those tickets.

### P6-02 — Notices frontend · Lane B · Tier 2
Drafted and split into [P6-02a](./P6-02a-notices-feed-and-detail.md) (feed, Markdown rendering, unread
badge, the P5-05 `buildingDenial` fitness follow-up), [P6-02b](./P6-02b-urgent-banner-and-attachments.md) (the notice at
`/notices/<id>`, urgent banner and its copy, attachment downloads), [P6-02c](./P6-02c-manager-notice-list-and-actions.md) (manager list,
publish, archive) and [P6-02d](./P6-02d-notice-editor.md) (editor, preview, `FileUpload` attachment, the P3-06
carry). The stub's "Decide while framing" items, its P6-01c carry (the `/notices/{id}` route, read state, creation
order) and the legacy files it replaces are carried into those tickets; its "Step 8" item (a row-lock test helper
for a time check) is for a backend ticket and moved to P6-03 below.

### P6-03 — Maintenance backend · Lane A · Tier 2
Drafted and split into [P6-03a](./P6-03a-maintenance-schema-and-visibility.md) (schema, photos, state machine,
`visible_maintenance`, photo hook), [P6-03b](./P6-03b-maintenance-submit-and-read-api.md) (submit, list, read,
cancel, the emergency phone), [P6-03c](./P6-03c-maintenance-manager-actions.md) (start, hold, resolve, reopen
within 14 days, status notifications, and the stub's "Step 8" row-lock test helper) and
[P6-03d](./P6-03d-maintenance-comments.md) (public and internal comments, comment notifications). The stub's
"Decide while framing" items and its P5-05 recipe-check questions are each carried into the ticket whose table,
query or endpoint they shape.

### P6-04 — Maintenance frontend · Lane A · Tier 2
Drafted and split into [P6-04a](./P6-04a-resident-maintenance-list.md) (hooks and the resident's list),
[P6-04b](./P6-04b-maintenance-submit-and-cancel.md) (submit with photos, the emergency copy, cancel, the legacy
`Maintenance` page), [P6-04c](./P6-04c-maintenance-request-view.md) (one request, its timeline, comments and the
"internal" toggle) and [P6-04d](./P6-04d-manager-maintenance-list-and-actions.md) (the manager's list, filters,
transition dialog, the legacy `ManagementMaintenance` page). The stub's "board or list" is an open decision in
P6-04d.

### P6-05 — Dashboard summary API and role landing pages · Lane A · Tier 2
Drafted and split into [P6-05a](./P6-05a-dashboard-summary-api.md) (`GET /dashboard`, reusing the summary
queries, enabled features only) and [P6-05b](./P6-05b-role-landing-pages.md) (the landing pages, the legacy
`Dashboard` and `Home` pages). The P2-06c council "view as" carry is in P6-05b.

### P6-06 — Minimal profile and staff contacts · Lane B · Tier 2
Drafted and split into [P6-06a](./P6-06a-minimal-profile.md) (`PATCH /api/auth/me`, the profile page, the legacy
`Profile` page) and [P6-06b](./P6-06b-staff-contacts.md) (the staff directory, the work phone, the legacy
`Contacts` page; residents not listed).

### P6-07 — E2E for notices, maintenance and dashboard · Lane B · Tier 2
Drafted and split by journey, since each waits for a different slice: [P6-07a](./P6-07a-notices-e2e.md) (J5),
[P6-07b](./P6-07b-maintenance-e2e.md) (J6, with the internal-note privacy check) and
[P6-07c](./P6-07c-dashboard-e2e-and-smoke-list.md) (J8, and the completed staging smoke list for D-06).

## P7 — Demo hardening (week 8)

### P7-01 — Backup and restore scripts with an automated restore test · Lane A · Tier 1
- `scripts/backup.sh`: `pg_dump -Fc` from the compose `db`, uploaded to a backups bucket in the S3 emulator
  (the endpoint and bucket come from settings, so D-05 only changes configuration)
- `scripts/restore-test.sh`: restore the newest dump into a throwaway `postgres:18` container, check
  `alembic current` and the row counts of key tables, report
- CI runs backup + restore test on a weekly schedule (and on `workflow_dispatch`) against a seeded stack; a
  failure is visible on the Actions tab
- runbook `docs/runbooks/restore.md` (local restore), rehearsed once by the agent (the PR records the steps and timings)
- the nightly timer on the host, real S3 and the backup-age alert are [D-05](./D-05-nightly-backups-to-s3.md)
- [ADR-0009](../adr/0009-backups-staged.md)

### P7-02 — Security pass · Lane A · Tier 1
- verify the Caddy headers and CSP on the prod-like stack (`make prodlike`); D-06 re-checks them on the real
  domain over HTTPS
- gitleaks, pip-audit, npm audit and a Trivy image scan all clean or triaged
- walk the OWASP ASVS L1 checklist (record results in `docs/security/asvs-l1.md`)
- a one-page STRIDE threat model (`docs/security/threat-model.md`)
- fix the High findings

### P7-03 — k6 load baseline · Lane A · Tier 2
- k6 script: 100 virtual users with the polling pattern, a package-create burst, one notice fan-out to 600
  seeded residents
- run against the prod-like stack (`make prodlike`); record p50/p95/p99 per route, the error rate, the job
  backlog age, and container CPU/memory (`docker stats`)
- label it a **laptop baseline**: it shows regressions and bottlenecks, not staging capacity. D-06 re-runs it
  on the `t3a.small`
- results in `docs/perf/baseline-<date>.md`
- compare against the proposed pilot thresholds in [07](../PILOT_READINESS.md)

### P7-04 — Accessibility and mobile pass · Lane B · Tier 2
- axe scans on every demo page
- keyboard-only run-through of journeys 3–6
- a 375 px width check
- fix the issues; record the remaining ones as tickets

### P7-05 — Demo dataset, script and recording · Lane B · Tier 3
- a demo seed with believable names and photos (D-06 loads the same seed on staging)
- `docs/DEMO_SCRIPT.md`: an 8-minute walkthrough of the journeys
- a recorded video of the demo on the prod-like stack, linked from the README

### P7-06 — Portfolio README and architecture docs · Lane B · Tier 3
- README: problem, features, architecture diagram, tech stack, "how we ensure tenant isolation", test strategy,
  CI and the prod-like stack, ADR index, demo video, and what's next (milestone D adds the hosted demo
  link)
- 2–3 polished explanations as writing samples

### P7-07 — Retro and detailed pilot-readiness plan · Both · Tier 3
- a whole-project retro
- convert [PILOT_READINESS.md](../PILOT_READINESS.md) into tickets with estimates
- milestone D kickoff: confirm its dates, start the human prerequisites in [D-01](./D-01-terraform-base.md)
  (AWS account, domain, SES), and re-frame the D tickets
- re-decide [ADR-0009](../adr/0009-backups-staged.md) (pgBackRest vs RDS) with numbers, or note that it
  waits for a pilot date

## Stretch — only if P6 finished early

### S-01 — Amenity booking backend · Tier 1
- tables `amenities` and `bookings` with `during tstzrange`
- `CREATE EXTENSION btree_gist`
- `EXCLUDE USING gist (amenity_id WITH =, during WITH &&) WHERE (status IN ('pending','confirmed'))`
- booking rules (slot length, max per unit per week, buffer) in Python
- `Idempotency-Key` on create
- concurrency test: 10 simultaneous bookings for one slot give exactly 1 success
- DST test around November's clock change in `America/Toronto`

### S-02 — Amenity booking frontend · Tier 2
- a resident calendar view of free slots and a booking flow
- a manager view with approvals if `approval_required`
- replace one of the legacy `Gameroom` / `Speakeasy` pages
