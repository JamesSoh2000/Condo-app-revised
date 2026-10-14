# 01 — Product Scope

## Vision

A web app that runs the day-to-day life of a condo building. Residents get their packages, notices and
maintenance updates. Front-desk staff log what happens in the building. Property management runs operations
and approves residents. The council sees what is going on. One deployment serves many buildings, and each
building's data is strictly isolated.

## Users and roles

| Role (slug) | Who | Main jobs |
|---|---|---|
| `resident` | Owner or tenant living in, or owning, a unit | See own packages and notices, submit maintenance requests, manage profile |
| `security` | Concierge / front desk (not cybersecurity) | Log packages, hand them out, see building notices |
| `property_management` | Building manager(s) | Approve residents, publish notices, run maintenance, manage staff and units |
| `council` | Elected owners (syndicate board) | Read-only oversight: notices, maintenance summaries, later financials |

- One person can hold several roles in one building, for example council + resident.
- One person can belong to several buildings.
- `board` in the Base44 code is legacy wording for `council`.
- "Council view" is presentation only and never grants permissions.

How the occupant relates to a unit is separate from the role ([ADR-0010](./adr/0010-unit-occupancy-relationship.md)):

- `owner`
- `tenant`
- `household`: lives in the unit but is not the account holder of record

## Onboarding model (decision)

| Who | How they join | Resulting state |
|---|---|---|
| First property manager | Operator CLI bootstrap (`app.cli bootstrap-building`) | Active `property_management` |
| Staff (security, management, council) | Email invitation from a manager, roles preassigned | Active on acceptance |
| Residents | Building join link → create account → choose unit + relationship | **Pending** until a manager approves |

Why: it matches the existing Base44 UI (`ResidentSetup`, `PendingApprovalBlock`), and a building cannot
realistically collect 600 resident emails up front. Managers may also invite a resident directly, with the
unit pre-filled and the invitation pre-approved.

## Demo journeys (the week-8 definition of "it works")

Each journey is an end-to-end Playwright test that runs locally and in CI against the production-like
compose stack. No cloud account is needed. Milestone D later runs a smoke version of the journeys against
staging.

1. **Bootstrap.** An operator runs the bootstrap CLI. The manager receives a set-password email and logs in.
2. **Staff invite.** The manager invites a security guard. The guard accepts the invite link from email and
   lands on the security home page.
3. **Resident onboarding.**
   - A resident opens the building join link, signs up and picks unit `1205` as `tenant`, then sees "pending".
   - The manager approves.
   - The resident gets an in-app notification and an email, and on next load sees the resident home page.
   - The **deny** path shows the reason.
4. **Packages (reference slice).**
   - Security logs a package for unit 1205 with a photo, and the resident gets an in-app and email
     notification.
   - The resident sees it, with the photo, in "My packages".
   - Security marks it picked up.
   - A second resident in the same building sees nothing.
   - A user from building B gets 404 on every package URL.
5. **Notices.**
   - The manager publishes a normal notice and an urgent notice.
   - Residents see the feed, an unread badge, and an urgent banner.
   - Marking a notice read clears the badge.
6. **Maintenance.**
   - A resident submits a request with a photo.
   - The manager moves it through the states, adding a public comment and an internal note.
   - The resident sees the status changes and the public comment, never the internal note.
7. **Account recovery.** Forgot password → email → reset. All old sessions are logged out.
8. **Dashboard.** Each role's landing page shows correct counts (pending approvals, packages waiting, open
   maintenance, unread notices).

**Stretch (only if ahead of schedule):** amenity booking (gameroom or speakeasy). A database exclusion
constraint makes double-booking impossible, even under concurrent requests.

## Scope tiers

| Tier | Contents |
|---|---|
| **Demo (weeks 1–8, local)** | Journeys 1–8 above; operator CLI for bootstrap and audit lookup; production-like local stack checked in CI; backup scripts + tested restore |
| **Deployed (milestone D, after week 8)** | AWS staging with continuous deployment, HTTPS, SES email, real S3, logs/errors/uptime monitoring, nightly backups to S3; the journeys re-verified there |
| **Pilot-ready (months 3–6, before real residents)** | Staff MFA (TOTP); PITR backups; separate production; privacy programme (Law 25 if Quebec); French UI; UAT with real staff; unit/resident import; runbooks; load test at pilot size. See [PILOT_READINESS.md](./PILOT_READINESS.md) |
| **Pilot options (choose with the building)** | Amenity bookings; move requests + elevator reservation; visitor passes; security incident/shift reports; parking proof; SMS |
| **Later** | Financial tracking (contributions, expenses, reserve fund); council overview; owner documents; AI concierge; live chat; platform admin; audit analytics; RLS |
| **Not planned** | Card payment processing; general ledger accounting; native mobile apps (the web app should be mobile-friendly) |

## Base44 page → scope map

The 30 exported pages. Pages outside the demo are **hidden from routing** in P0-03, not deleted.

| Page(s) | Tier | Slice |
|---|---|---|
| `Home`, `Dashboard` | Demo | P6 dashboard |
| `Onboarding`, `ResidentSetup`, `Residents` | Demo | P4 onboarding |
| `Packages`, `SecurityPackages` | Demo | P5 packages |
| `ManagementNotices` (+ `BuildingUpdatesFeed`, `EmergencyAlertPopup`) | Demo | P6 notices |
| `Maintenance`, `ManagementMaintenance` | Demo | P6 maintenance |
| `Profile`, `Contacts` | Demo (minimal) | P6 profile/contacts |
| `Gameroom`, `SecurityGameroom`, `Speakeasy`, `ManagementSpeakeasy`, `SecuritySpeakeasy` | Stretch / pilot option | Amenities epic |
| `MoveRequest`, `SecurityMoveRequests`, `MoveInspection` | Pilot option | Moves epic |
| `VisitorAccess`, `VisitorVerification` | Pilot option | Visitors epic |
| `SecurityReport`, `security-reports`, `CreateIncidentReport`, `CreateShiftReport`, `ManagementReports` | Pilot option | Reports epic |
| `Financials`, `BoardOverview` | Later | Financials / council epic |
| `Concierge` (AI) | Later | AI epic |

## Non-goals for the demo

- **Perfect visual redesign.** Reuse the Base44 UI components (shadcn/Radix) and fix only what the migration
  touches.
- **Supporting every Base44 field.** Each slice defines its own API contract. Do not build a "Base44-compatible"
  generic API.
- **Real-time push.** Polling every 30–60 s while the tab is visible is the product promise.
- **Multi-building UI polish.** The data model and API are multi-tenant from day one. The UI needs only a
  simple building picker when a user has more than one membership.

## Product defaults adopted now (revisit at pilot)

These replace the unassigned M0-T09 and M0-T10 decision gates. Each lives in an ADR or in this file. The
pilot building may change them.

- One current unit per resident; many residents per unit.
- Unit turnover never exposes previous occupants' packages, requests or files. History stays with the person,
  not the unit.
- Residents see only their own records. Staff see building records needed for their job.
- Council gets read-only summaries and no personal documents.
- Package pickup: the recipient or any active resident of the same unit at pickup time, verified by staff.
  This is a stated default; the building may tighten it.
- Former residents lose building access at move-out (membership deactivated). Their personal account remains.
- Retention: delivered packages and their photos kept 12 months. Everything else is kept until the pilot
  defines policy. Nothing is deleted automatically in the demo.
- Uploads: images (JPEG, PNG, WebP, HEIC) up to 10 MiB and PDF up to 20 MiB.
- Planning workload: 1 building, 300 units, 600 residents, 20 staff, 100 concurrent sessions. This is a
  planning number, not a measured one.
