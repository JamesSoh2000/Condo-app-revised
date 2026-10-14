# AI Project Context

Attach this file to AI IDE sessions along with the specific ticket being worked on. It gives the agent the project vocabulary, architecture decisions, role meanings, and non-negotiable implementation rules.

## Project Summary

We are building a multi-building condo management web app. One shared backend serves multiple condo buildings. Each building has its own residents, units, staff, amenities, feature entitlements, files, notifications, reports, and financial data.

The initial frontend was exported from Base44 and now lives in `frontend/`. It still contains Base44 SDK calls and legacy terminology. The backend, infrastructure, and frontend migration are being built incrementally.

Canonical planning docs:

- `docs/backend_requirements.md`
- `docs/BACKEND_INFRA.md`
- `docs/MILESTONES_AND_TICKETS.md`
- `docs/AI_AGENT_WORKFLOW.md`

## Current Technical Direction

- Local dev OS: WSL2 Ubuntu 24.04 LTS.
- Python: 3.12.13 for backend development.
- Node.js/npm: Node 24.16.0 with npm 11.x for frontend development.
- Backend: FastAPI REST API.
- Database: PostgreSQL 16.
- ORM: SQLAlchemy 2.0 async.
- Migrations: Alembic.
- Auth: JWT access token plus refresh strategy.
- File storage: AWS S3, private objects, presigned uploads/downloads.
- Notifications: durable in-app records in PostgreSQL, plus AWS SES email and AWS SNS SMS.
- Realtime/live chat: post-MVP only. Future FastAPI WebSockets plus Redis Pub/Sub.
- Deployment: Docker, AWS ECR, EC2, Caddy, blue/green backend deployment.
- Monitoring: structured logs and CloudWatch.

## Role Vocabulary

Use these role terms in all new code, API contracts, docs, and UI copy.

| Canonical Term | Role Slug | Meaning |
|---|---|---|
| Resident | `resident` | Person living in or associated with a unit. May start as `pending_approval` until property management approves them. |
| Security / Concierge | `security` | Building front-desk/security staff. This means guards/concierge operations, not cybersecurity. |
| Property Management | `property_management` | Building management staff who approve residents, manage maintenance, notices, moves, amenities, reports, and enabled financial workflows. |
| Council Member | `council` | Building governance/oversight user, not municipal government. This replaces the old term "Board Member". Council members review high-level operations and reports. |
| Financials View | `financials` | View mode or permission slice for financial dashboards. Do not treat this as a normal resident/staff role unless the ticket explicitly says so. |
| Platform Admin | `platform_admin` | Future cross-building operator for onboarding buildings, subscriptions, and support. Not an MVP building role. |

When discussing cybersecurity, use "app security", "auth/security", or "tenant isolation" so it is not confused with the `security` staff role.

## Legacy Terminology Mapping

The Base44 export still uses `board` in code and UI. Treat it as legacy.

| Legacy Term | New Term |
|---|---|
| Board Member | Council Member |
| board role slug | `council` |
| Board Overview | Council Overview |
| Board Oversight | Council Oversight |
| `/BoardOverview` | `/CouncilOverview` target route, with compatibility during migration if needed |
| `BoardOverview.jsx` | `CouncilOverview.jsx` target component name |
| `boardActiveViewRole` | `councilActiveViewRole` target local storage key |
| `require_board` | `require_council` |

When touching legacy frontend files, migrate terminology only within the ticket scope. Keep temporary compatibility aliases if old routes, query params, stored localStorage keys, or seed data still reference `board`.

## Core Product Concepts

### Building

A client condo building. Every tenant-specific record belongs to one building. Buildings can have different enabled features, amenity configuration, branding, timezone, units, staff, residents, and rules.

### Building Membership

The relationship between a user and a building. Use this for building-scoped roles. Do not assume a user's global account role is enough forever, because a staff member may eventually belong to multiple buildings.

### Unit

A physical condo unit or suite inside a building. Examples include tower, floor, and unit number. Unit data is building-scoped.

### Resident Profile

Building-scoped resident details: user, unit, approval status, full name, phone, emergency contact, occupants, vehicles, language, notification settings, and document/file metadata.

### Feature Entitlement / Paywall

Each building can enable or disable features using `BuildingFeature`. The frontend may hide unavailable features, but the backend must enforce feature access too.

Examples: packages, maintenance, moves, visitor access, custom amenities, gameroom, speakeasy, notices, financials, AI Concierge, SMS notifications.

### Amenities

Amenities are building-defined data, not universal assumptions. A building may have zero, one, or many amenities. Management can eventually add custom amenities with name, description, photos, availability, booking rules, approval rules, fees/deposits, and active state.

Gameroom and speakeasy are optional specialized amenity workflows. Do not assume every building has them.

### Packages

Security logs package arrivals for a unit or resident. Residents see ready packages and history. Package events create durable notifications and badge counts.

### Maintenance

Residents submit maintenance tickets. Property management updates status, assigns staff, adds notes, schedules work, and notifies residents.

### Move Requests And Inspections

Residents submit move-in/out requests. Security and property management review them. Security can perform pre/post inspections with uploaded photos.

### Reports

Security submits shift and incident reports. Management and council users review reports. `ReportRead` tracks unread/read state for management/council users.

### Notices And Emergency Updates

Building updates are notices, maintenance alerts, amenity updates, and emergency messages. In MVP they are surfaced through database records, API refetch, and polling rather than WebSockets.

### Notifications

Notifications are durable database records. WebSockets are not required for MVP notification delivery. Email and SMS are best-effort side effects and must not fail the main operation.

### Visitor Access

Residents can create visitor passes if the feature is enabled. The backend generates visitor codes. Security verifies visitor passes and parking reservations.

### Parking Proof

Residents can submit proof documents/photos for parking or vehicle-related approval. Property management reviews and approves/rejects.

### Financials

Financials are paywalled and role-gated. They include resident charges, building expenses, budget items, and bank statement uploads.

### AI Concierge

Post-MVP. Do not implement unless the ticket explicitly targets it.

### Live Chat

Post-MVP and low priority. When built, store messages in PostgreSQL before broadcasting over Redis/WebSockets. Clients reconnect with backoff and fetch missed messages by `last_seen_message_id` or timestamp.

## Non-Negotiable Rules

- Never trust `building_id` from request bodies for tenant isolation. Derive it from authenticated building context.
- Every tenant-specific table needs `building_id`.
- Backend feature flags/paywalls are security controls, not just frontend navigation controls.
- Store file bytes in S3, not PostgreSQL.
- Store S3 keys and metadata in PostgreSQL.
- Email/SMS failures must not roll back primary data changes.
- MVP workflows must not depend on WebSockets.
- Keep migrations backward compatible for blue/green deploys.
- Add/update Alembic migrations with model changes.
- Add or update the relevant `.env.example` when introducing env vars.
- Do not commit secrets.
- Prefer domain API modules over rebuilding generic Base44 behavior.
- Keep changes scoped to the ticket.

## Frontend Migration Notes

The frontend currently contains direct Base44 calls:

- `base44.auth.me`, `updateMe`, `logout`, login redirect behavior.
- Entity list/filter/create/update/delete operations.
- `Entity.subscribe(...)`.
- `UploadFile`.
- `SendEmail` and `SendSMS`.
- `InvokeLLM`.
- `base44.appLogs.logUserInApp`.

Target frontend shape:

- `authApi`
- `buildingApi`
- `profileApi`
- `amenitiesApi`
- `packagesApi`
- `maintenanceApi`
- `movesApi`
- `reportsApi`
- `notificationsApi`
- `filesApi`
- `financialsApi`

Replace `Entity.subscribe(...)` with API refetch/polling for MVP. Add WebSockets only for future live chat.

## Agent Checklist

Before coding:

- Read the ticket and this context file.
- Identify dependencies and blockers.
- Search existing code before inventing new patterns.
- Name which files are likely to change.
- Confirm whether the ticket touches shared contracts, migrations, auth, or frontend shell.

While coding:

- Keep changes scoped.
- Preserve tenant isolation.
- Preserve role and feature guards.
- Use `council`, not new `board` terminology.
- Add migrations for schema changes.
- Add tests proportional to risk.
- Update docs or the relevant `.env.example` if the implementation changes setup or behavior.

Before handoff:

- Run relevant tests or builds.
- Summarize changed files.
- Summarize behavior changes.
- List migrations and env vars.
- List known gaps or follow-up tickets.
