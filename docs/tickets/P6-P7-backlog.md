# P6–P7 Backlog (stubs — detail during week 5)

These are deliberately **not** detailed yet (rolling wave). During week 5, after the packages slice has taught
you what the recipe looks like, turn each stub into a full ticket file with
[`/draft-ticket <ID>`](../../.claude/commands/draft-ticket.md), which uses
[../templates/TICKET.md](../templates/TICKET.md) and `docs/SLICE_RECIPE.md`. A human edits and accepts each
draft before it is framed. Each stub lists the goal, the key
interfaces and the decisions to make while framing.

## P6 — Notices, maintenance, dashboard (week 7)

### P6-01 — Notices backend · Lane B · Tier 2
- **Goal:** managers create, edit, publish and archive notices with priority `normal`/`urgent`, an optional
  expiry and an optional PDF or image attachment. Residents and staff list published notices and mark them
  read.
- **Interfaces:**
  - tables `notices` and `notice_reads`
  - `POST /notices`, `PATCH /notices/{id}` (draft only), `POST /notices/{id}/publish`, `/archive`
  - `GET /notices?status=published&cursor=`, `GET /notices/summary` `{unread, urgent_unread}`
  - `POST /notices/{id}/read`
  - on publish, `notify(notice.published)` to every active member (one bulk insert); email only for
    `urgent`
  - audit
- **Decide while framing:**
  - Can security author notices? (default: no)
  - Does editing after publish create a new version, or is it blocked? (default: blocked; archive and
    republish instead)
- **Watch:** the 600-recipient fan-out must stay a single insert plus bulk job enqueue. Measure it.
- Replaces old M6-T03 and M6-T09 (backend part).

### P6-02 — Notices frontend · Lane B · Tier 2
- **Goal:** a resident feed with an unread state; an **urgent banner** shown on every page until acknowledged;
  a manager editor (rich text limited to Markdown, attachment upload, preview, publish).
- Replace the legacy `ManagementNotices`, `BuildingUpdatesFeed`, `EmergencyAlertPopup` and
  `ArchivedUpdatesModal`, and lower the ratchet.
- **Decide while framing:** sanitizing Markdown rendering (no raw HTML); the banner copy for "this is not an
  emergency alert system".
- **First follow-up (playbook step 8, from P5-05 review round 3, open Medium):** `frontend/src/test/buildingDenial.test.ts`
  resolves hook names with its own tables, not by lexical scope: a function-local alias (`const read =
  useBuildingDenied` in one function), a declaration shadowing a module-level hook, and `useBuilding!(…)`,
  `(useBuilding)(…)`, `useBuilding.call(…)` can make it pass a passive reader that reads no denial (no current code
  has these shapes). Resolve each callee with the TypeScript checker (`ts.createProgram` over `src/app` and
  `src/features`, `getSymbolAtLocation`, following aliases) and keep the round-1 to round-3 cases as tests (the
  reviewers' proofs are listed in PR #121's "Independent review").
- **Carried from P3-06:** replace `NoticeAttachmentUpload.jsx` (Base44 `UploadFile`, public `attachment_url`)
  with `FileUpload purpose="notice_attachment"` and the notice's `file_id` claimed by P6-01's API; show
  attachments through the files download URL, not a public link.

### P6-03 — Maintenance backend · Lane A · Tier 2
- **Goal:** residents submit requests (category, description, location: unit or common area, photos). Managers
  transition them through `submitted → in_progress → on_hold → resolved` (or `cancelled` by the resident
  while `submitted`). Comments are public or **internal**.
- **Interfaces:**
  - tables `maintenance_requests` and `maintenance_comments`
  - action endpoints `/start`, `/hold`, `/resolve`, `/cancel`, `/reopen` (manager, within 14 days)
  - `visible_maintenance(ctx)`: residents see their own requests plus their unit's requests during their
    occupancy window, **never** internal comments
  - notify on status changes and public comments; audit
- **Decide while framing:**
  - Can security see or act on maintenance? (default: read and comment only)
  - Emergency category behaviour: show the building's emergency phone, and never rely on the app.
- **From the P5-05 recipe check** (a fresh agent planned this ticket from `docs/SLICE_RECIPE.md` and this stub only,
  PR #121): decide while framing what the recipe can't say: a "common area" location (a table, a fixed list, free
  text?) and who sees a common-area request; whether `cancel` is the requester only or any occupant who can see it;
  what `reopen` leads to (`in_progress`?) and whether it clears `resolved_at`; which `*_at` column each status has;
  who is notified for each kind (requester, occupants, managers on a new request or a resident's comment) and which
  send email; several photos per request (a join table, a limit) and whether comments take photos; whether a moved-out
  resident still sees later comments on a request from their occupancy.

### P6-04 — Maintenance frontend · Lane A · Tier 2
- **Goal:** resident pages for submit (with photos), list and detail with a timeline. A manager board or list
  with filters, a transition dialog and comments with an "internal" toggle.
- Replace the legacy `Maintenance` and `ManagementMaintenance` pages.

### P6-05 — Dashboard summary API and role landing pages · Lane A · Tier 2
- **Goal:** `GET /dashboard` returns counts per role, reusing the existing summary queries (packages waiting,
  pending onboarding, open maintenance by status, unread and urgent notices). Each role gets a landing page
  with cards linking to the slices.
- Show only enabled features, and only domains that exist. No cards for deferred domains.
- Replace the legacy `Dashboard` and `Home` pages.
- Carried from P2-06c: council "view as" (`useBuildingContext().viewAs`, applied only when
  `useCanViewAs(building)` is true) changes only the nav today. The landing page may use it to pick the council
  member's cards; it must never reach the API or a guard (PR #65 D3).

### P6-06 — Minimal profile and staff contacts · Lane B · Tier 2
- **Goal:** `PATCH /api/auth/me` (full_name, phone, locale) with a profile page, plus
  `GET /api/buildings/{b}/contacts`: the staff directory with name, role and work phone, visible to all
  active members. Residents are **not** listed by default.
- Replace the legacy `Profile` (minimal) and `Contacts` pages.

### P6-07 — E2E for notices, maintenance and dashboard · Lane B · Tier 2
- **Goal:** Playwright journeys J5 (notices, including the urgent banner), J6 (maintenance, including the
  internal-note privacy check) and J8 (dashboard counts per role) pass locally and in CI, including on the
  prod-like stack. List the smoke steps for these journeys so D-06 can add them to the staging smoke.

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
