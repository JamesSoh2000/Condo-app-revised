# Condo Management App Milestones and Tickets

This plan assumes the product starts from the exported Base44 frontend now located in `frontend/`, with a minimal starter backend in `backend/`. Production backend modules, database, cloud infrastructure, CI/CD, and deployment pipeline are added through the tickets below.

The source-of-truth documents for this breakdown are:

- `docs/backend_requirements.md`
- `docs/BACKEND_INFRA.md`
- The Base44-exported frontend in `frontend/`

Use this file as the working ticket backlog. Each ticket is intentionally written as a concrete unit of work with dependencies so two developers can build the app one step at a time without losing the bigger map.

## Operating Model

Recommended board columns:

- Backlog
- Ready
- In Progress
- Review
- QA
- Done

Recommended labels:

- `backend`
- `frontend`
- `infra`
- `database`
- `realtime`
- `storage`
- `security`
- `qa`
- `blocked`
- `post-mvp`
- `ai`

Recommended owner model for two developers:

- Dev A starts on backend, database, auth, infrastructure, and shared services.
- Dev B starts on frontend cleanup, Base44 replacement, API integration, and route guards.
- After the foundation milestones, both developers switch to vertical feature slices. A vertical slice means schema, API, frontend wiring, freshness behavior, tests, and acceptance flow for one feature.

## Definition Of Done

Every ticket is done only when:

- Code is committed in a scoped PR.
- Local setup still starts cleanly from documented steps.
- Backend endpoints have request/response schemas and permission checks.
- Tenant-specific reads and writes use `building_id` from authenticated context, not from client input.
- Frontend loading, empty, success, validation, and error states are handled.
- Tests are added or a clear reason is documented for no tests.
- Any new environment variable is added to the relevant `.env.example`.
- Any schema change has an Alembic migration.
- Any user-visible workflow has been manually verified with at least one realistic account.

## Important Frontend Inventory

The Base44 export uses these entities or behaviors and they must be replaced, hidden, or explicitly deferred:

| Area | Base44 Entities / Calls |
|---|---|
| Auth and roles | `base44.auth.me`, `updateMe`, `logout`, `redirectToLogin`, `User` |
| Core resident data | `Profile`, `ResidentProfile`, `Unit` |
| Notices/feed | `BuildingUpdate`, `UpdateArchive`, `Notification` |
| Packages | `Package`, `Notification`, `UploadFile`, `SendEmail` |
| Maintenance | `MaintenanceTicket`, `MaintenanceNote`, `Notification`, `UploadFile` |
| Moves | `MoveRequest`, `MoveInspection`, `MoveInspectionPhoto`, `Notification`, `UploadFile` |
| Reports | `Report`, `ReportRead`, `MaintenanceNote`, `Notification`, `UploadFile` |
| Amenities | `GameroomRental`, `GameroomRentalEvent`, `SpeakeasyReservation`, `Notification`, `UploadFile` |
| Visitors | `VisitorAccessPass`, `VisitorParkingReservation` |
| Parking proof | `ParkingProofRequest`, `Profile`, `Notification`, `UploadFile` |
| Calendar/tasks | `CalendarEvent`, `SecurityTask`, `BuildingUpdate`, `MoveRequest`, `Report`, `SpeakeasyReservation` |
| Financials | `ResidentCharge`, `BuildingExpense`, `BudgetItem`, `BankStatement` |
| Base44 subscriptions | `Entity.subscribe(...)` for packages, notices, approval status, emergency alerts. Replace with API refetch/polling for MVP; reserve WebSockets for future live chat. |
| Future AI | `InvokeLLM` in `/Concierge` is shelved as future work |
| App logs | `base44.appLogs.logUserInApp` can be removed or replaced with backend audit logging |

## Milestone Overview

| Milestone | Goal | Depends On | Can Run In Parallel With |
|---|---|---|---|
| M0 | Align scope, repo ownership, and data inventory | None | None |
| M1 | Local development foundation | M0 | Early UX review |
| M2 | Database model and API contract foundation | M1 | Frontend Base44 inventory details |
| M3 | Auth, tenant isolation, RBAC, onboarding | M2 | Frontend shell cleanup |
| M4 | Frontend API migration foundation | M3 API contracts | Backend shared services |
| M5 | Notifications, files, background jobs | M3 | Feature design details |
| M6 | Resident core: profile, units, dashboard, notices, contacts | M3, M4, M5 partial | M7 after shared APIs |
| M7 | Packages and parking proof | M3, M4, M5 | M8, M9, M10 |
| M8 | Maintenance | M3, M4, M5 | M7, M9, M10 |
| M9 | Move requests and inspections | M3, M4, M5 | M7, M8, M10 |
| M10 | Security reports and daily operations calendar | M3, M4, M5 | M7, M8, M9 |
| M11 | Amenities: gameroom and speakeasy | M3, M4, M5 | M12, M13 |
| M12 | Visitor access and verification | M3, M4, M5 | M11, M13 |
| M13 | Financials and council oversight | M3, M4, M5 | M11, M12 |
| M14 | Production infrastructure and deployment | M1 | Can start early, finishes after app health |
| M15 | QA, security hardening, UAT, launch | All MVP milestones | None |
| M16 | Future / post-MVP work | MVP launch | Ongoing |

## Recommended Build Sequence

1. Finish M0 through M5 in order. These create the ground that every MVP feature stands on.
2. Build one thin vertical slice first: resident profile approval plus package logging. This proves auth, tenant scoping, CRUD, durable notifications, storage, and frontend API replacement.
3. After the thin slice works, split feature slices between developers:
   - Dev A: packages, maintenance, backend shared services, production infra.
   - Dev B: frontend API replacement, dashboard/notices, moves, amenities.
4. Do not start financials or council reporting until auth, tenant isolation, and report read tracking are solid.
5. Keep AI Concierge deferred until after the operational app is live.

---

## M0 - Scope, Repo, And Product Alignment

### M0-T01 - Confirm Source Of Truth And Repo Layout

- Labels: `project`, `frontend`, `backend`
- Depends on: None
- Parallel: None
- Work:
  - Confirm `frontend/` is the canonical frontend folder.
  - Decide whether any existing backend scaffold in the repo is kept, reset, or treated as experimental.
  - Document the final local folder layout in the README.
  - Remove or quarantine duplicate generated files only after the team agrees.
- Done when:
  - Both developers know which frontend folder to modify.
  - The repo has one documented frontend entrypoint and one documented backend entrypoint.

### M0-T02 - Convert Requirements Into MVP And Later Phases

- Labels: `project`
- Depends on: M0-T01
- Parallel: M0-T03
- Work:
  - Mark each feature as `MVP`, `MVP optional`, or `post-mvp`.
  - Confirm that AI Concierge is post-MVP.
  - Confirm whether resident Visitor Access is MVP or hidden until later, because it exists in the frontend but is not prominent in the requirements doc.
  - Confirm whether parking proof requests are MVP or part of resident profile phase.
  - Confirm whether financials are MVP or management/council phase after launch.
- Done when:
  - The tracker labels match the agreed phase for each feature.
  - Hidden/deferred frontend pages are listed so they do not accidentally ship half-wired.

### M0-T03 - Build A Base44 Usage Matrix

- Labels: `frontend`, `backend`, `database`
- Depends on: M0-T01
- Parallel: M0-T02
- Work:
  - For every Base44 entity call in `frontend/src`, list page/component, operation, filters, sort fields, and expected returned fields.
  - Capture every `UploadFile`, `SendEmail`, `SendSMS`, `InvokeLLM`, and `Entity.subscribe` call.
  - Identify old/legacy frontend fields such as `unit_number`, `resident_unit`, and `resident_name` that should become derived display fields.
  - Identify client-side business logic that should move to backend services.
- Done when:
  - A data contract checklist exists for every frontend route.
  - Backend schema work can start without guessing at frontend field names.

### M0-T04 - Decide Naming And Role Vocabulary

- Labels: `backend`, `frontend`, `security`
- Depends on: M0-T02
- Parallel: M0-T03
- Work:
  - Standardize role values: `resident`, `security`, `property_management`, `council`, and any `financials` view mode.
  - Standardize account fields: `account_type`, `app_role`, `management_role`, and whether all are still needed.
  - Define council view switching behavior versus true impersonation.
  - Define approval states for residents.
- Done when:
  - Role names are documented and used consistently in API contracts and frontend route guards.

### M0-T05 - Establish AI Agent Workflow

- Labels: `project`, `ai`
- Depends on: M0-T04
- Parallel: M0-T06
- Work:
  - Use `docs/AI_PROJECT_CONTEXT.md` as the standard attachment for AI coding sessions.
  - Use `docs/AI_AGENT_WORKFLOW.md` as the team workflow for two-dev agentic coding.
  - Add the ticket prompt template from the workflow doc to the issue tracker.
  - Agree that every AI-generated PR must include the ticket ID, files changed, tests run, and open questions.
- Done when:
  - Both developers can start an AI coding session from the same shared context.

### M0-T06 - Create Ticket Board And Team Workflow

- Labels: `project`
- Depends on: M0-T02
- Parallel: None
- Work:
  - Create the issue tracker/project board.
  - Import this markdown backlog as tickets or link to it from the board.
  - Agree on branch naming, PR review expectations, and merge rules.
  - Agree that migrations and code changes ship together.
- Done when:
  - Both developers can pull a ready ticket with clear dependencies.

### M0-T07 - Rename Legacy Board Terminology To Council

- Labels: `frontend`, `backend`, `copy`
- Depends on: M0-T04
- Parallel: M4-T02
- Work:
  - Treat `board` and `BoardOverview` in the Base44 export as legacy names.
  - Use human-facing term `Council Member`.
  - Use backend role slug `council`.
  - Rename frontend text such as "Board Oversight" to "Council Oversight".
  - Rename route/component/storage keys during frontend migration where practical, such as `/BoardOverview` to `/CouncilOverview` and `boardActiveViewRole` to `councilActiveViewRole`.
  - Keep compatibility aliases during migration if existing code still references legacy values.
- Done when:
  - New code and UI copy use council terminology, and legacy board references are either removed or documented compatibility aliases.

---

## M1 - Local Development Foundation

### M1-T01 - Backend Skeleton

- Labels: `backend`
- Depends on: M0-T01
- Parallel: M1-T02
- Work:
  - Create FastAPI app entrypoint.
  - Add `/health` or `/api/health`.
  - Add CORS using environment configuration.
  - Add structured logging and request logging middleware.
  - Add app settings with Pydantic settings.
  - Add test harness with a health test.
- Done when:
  - `pytest` passes.
  - FastAPI docs are available locally.

### M1-T02 - Local Docker Compose

- Labels: `infra`, `backend`, `database`
- Depends on: M0-T01
- Parallel: M1-T01, M1-T03
- Work:
  - Add local services for FastAPI and PostgreSQL 16.
  - Include Redis 7 only if it is already simple in compose; it is for future live chat and should not block MVP backend startup.
  - Expose backend and database locally.
  - Add health checks.
  - Add `.env.example` with local defaults and no secrets.
  - Document first-time setup.
- Done when:
  - A fresh clone can start local backend and Postgres with one command.

### M1-T03 - Frontend Local Run Baseline

- Labels: `frontend`
- Depends on: M0-T01
- Parallel: M1-T01, M1-T02
- Work:
  - Install frontend dependencies.
  - Run Vite dev server.
  - Run frontend lint/build.
  - Record current failures caused by Base44 coupling.
  - Do not do major rewrites yet.
- Done when:
  - The team knows whether the exported frontend builds as-is.
  - Build/lint issues are logged as follow-up tickets.

### M1-T04 - Shared Development Documentation

- Labels: `project`, `infra`
- Depends on: M1-T01, M1-T02, M1-T03
- Parallel: None
- Work:
  - Add README sections for frontend run, backend run, migrations, tests, and seed data.
  - Add troubleshooting notes for Docker, ports, and env files.
  - Document required local tools.
- Done when:
  - A new developer can run frontend and backend from README instructions.

### M1-T05 - Baseline CI Checks

- Labels: `infra`, `qa`
- Depends on: M1-T01, M1-T03
- Parallel: M2-T01
- Work:
  - Add GitHub Actions for backend tests.
  - Add frontend build/lint check.
  - Keep CI independent of production deployment.
  - Cache dependencies where simple.
- Done when:
  - PRs show automated backend and frontend status checks.

---

## M2 - Database And API Contract Foundation

### M2-T01 - SQLAlchemy Async And Alembic Setup

- Labels: `backend`, `database`
- Depends on: M1-T01, M1-T02
- Parallel: M1-T05
- Work:
  - Add async SQLAlchemy engine and session dependency.
  - Configure Alembic for async migrations.
  - Add migration folder and first empty revision.
  - Document migration commands.
- Done when:
  - `alembic upgrade head` runs against local Postgres.

### M2-T02 - Shared Model Conventions

- Labels: `backend`, `database`
- Depends on: M2-T01
- Parallel: M2-T03
- Work:
  - Define UUID primary key convention.
  - Define `created_at`, `updated_at`, and soft delete fields.
  - Define enum strategy for status fields.
  - Define tenant scoping convention: every tenant-specific table includes `building_id`.
  - Define audit fields for `created_by_user_id`, `updated_by_user_id`, and operational events.
- Done when:
  - New models follow one consistent pattern.

### M2-T03 - Core Tenant Schema

- Labels: `backend`, `database`
- Depends on: M2-T01
- Parallel: M2-T02
- Work:
  - Create `buildings`.
  - Create `building_features`.
  - Create `units`.
  - Add indexes and uniqueness constraints such as unique unit per building.
  - Add migration.
- Done when:
  - Local DB has building, feature, and unit tables.

### M2-T04 - User And Profile Schema

- Labels: `backend`, `database`, `security`
- Depends on: M2-T02, M2-T03, M0-T04
- Parallel: M2-T05
- Work:
  - Create `users`.
  - Create `resident_profiles`.
  - Decide whether legacy `profiles` is a compatibility table or merged into `resident_profiles`.
  - Include fields used by frontend profile, language, vehicles, emergency contacts, documents, and notification settings.
  - Add migration and indexes for email, user/building, unit, approval status.
- Done when:
  - User and resident profile records can represent pending and approved residents.

### M2-T05 - API Response Shape Standards

- Labels: `backend`, `frontend`
- Depends on: M0-T03
- Parallel: M2-T04
- Work:
  - Define pagination style.
  - Define filtering and sorting style to replace Base44 `list(order, limit)` and `filter(criteria, order, limit)`.
  - Define error response format.
  - Define timestamp format.
  - Define naming convention between snake_case API fields and frontend usage.
- Done when:
  - Frontend and backend can implement clients without one-off response parsing per page.

### M2-T06 - Seed Data Framework

- Labels: `backend`, `database`
- Depends on: M2-T03, M2-T04
- Parallel: M3-T01 after auth schema
- Work:
  - Add seed script for one building, units, users, roles, profiles, and sample feature flags.
  - Seed security, property management, council, approved resident, and pending resident accounts.
  - Make script idempotent.
  - Include sample unit numbers and towers.
- Done when:
  - Developers can reset local DB and seed useful demo data.

---

## M3 - Auth, Tenant Isolation, RBAC, And Onboarding

### M3-T01 - Password Auth And JWT Session Flow

- Labels: `backend`, `security`
- Depends on: M2-T04, M2-T05
- Parallel: M3-T02
- Work:
  - Add password hashing.
  - Add login endpoint.
  - Add access token and refresh token issuance.
  - Add refresh endpoint.
  - Add logout behavior if refresh tokens are stored server-side.
  - Add rate limiting plan for auth endpoints.
- Done when:
  - Users can log in locally and receive valid tokens.

### M3-T02 - Current User And Update-Me API

- Labels: `backend`
- Depends on: M2-T04, M2-T05
- Parallel: M3-T01
- Work:
  - Add `GET /auth/me`.
  - Add `PATCH /auth/me` for fields currently set by onboarding.
  - Return role, account type, building context, profile status, and display name fields.
  - Keep response compatible with what the frontend shell needs.
- Done when:
  - Frontend can replace `base44.auth.me()` and `base44.auth.updateMe()`.

### M3-T03 - Auth Dependencies And Role Guards

- Labels: `backend`, `security`
- Depends on: M3-T01, M3-T02, M0-T04
- Parallel: M3-T04
- Work:
  - Add `get_current_user`.
  - Add `require_resident`, `require_security`, `require_management`, `require_council`.
  - Add feature flag guard.
  - Ensure building context is derived from token/session.
  - Add tests for forbidden cross-role access.
- Done when:
  - Protected endpoints can reject unauthenticated and unauthorized requests.

### M3-T04 - Resident Onboarding And Approval API

- Labels: `backend`, `frontend`, `security`
- Depends on: M3-T02, M3-T03, M2-T04
- Parallel: M3-T05
- Work:
  - Add endpoint to choose account type.
  - Add resident setup endpoint to create pending profile.
  - Add management endpoint to list pending residents.
  - Add approve, deny, and soft-delete operations.
  - Create an in-app notification when approval status changes.
- Done when:
  - A pending resident can be approved by management and becomes an approved resident.

### M3-T05 - Unit APIs

- Labels: `backend`, `database`
- Depends on: M2-T03, M3-T03
- Parallel: M3-T04
- Work:
  - Add unit list/search endpoints.
  - Add management-only unit CRUD.
  - Add active/inactive flag support.
  - Add unit lookup by tower and unit number for package and profile flows.
- Done when:
  - Frontend unit comboboxes and setup pages can load real units.

### M3-T06 - Feature Flags API

- Labels: `backend`, `frontend`
- Depends on: M2-T03, M3-T03
- Parallel: M4-T01
- Work:
  - Add `GET /buildings/me/features`.
  - Add management/admin endpoint to toggle feature flags.
  - Gate financials, amenities, visitor access, and AI Concierge where appropriate.
- Done when:
  - Frontend can hide disabled nav items from backend state.

### M3-T07 - Council View Switching

- Labels: `backend`, `frontend`, `security`
- Depends on: M3-T03, M0-T04
- Parallel: M4-T02
- Work:
  - Decide whether role switching is frontend-only view mode or backend-scoped assumed role.
  - If backend-scoped, add an endpoint to request an allowed view role.
  - Ensure view switching never grants access beyond the user's real permissions.
  - Add tests for council and property management view modes.
- Done when:
  - Council users can inspect resident and management views without compromising permissions.

---

## M4 - Frontend API Migration Foundation

### M4-T01 - Frontend Environment And API Client

- Labels: `frontend`
- Depends on: M1-T03, M2-T05
- Parallel: M3-T06
- Work:
  - Add `VITE_API_URL`.
  - Create a fetch/axios API client.
  - Add auth token handling.
  - Add response/error normalization.
  - Add helpers for query params, pagination, and file uploads.
- Done when:
  - New frontend code can call the FastAPI backend without Base44 SDK.

### M4-T02 - Replace Base44 Auth In Frontend Shell

- Labels: `frontend`, `security`
- Depends on: M3-T01, M3-T02, M4-T01
- Parallel: M3-T07
- Work:
  - Replace `base44.auth.me`, `updateMe`, `logout`, and login redirects.
  - Update `AuthContext`, `Layout`, `Onboarding`, `ResidentSetup`, `RouteProtection`, and `ProtectedRoute`.
  - Preserve pending approval experience.
  - Preserve council/property management role switcher behavior.
- Done when:
  - Frontend shell loads current user from backend and no longer needs Base44 auth.

### M4-T03 - Entity API Modules

- Labels: `frontend`
- Depends on: M4-T01, M2-T05
- Parallel: M5-T01
- Work:
  - Create domain API modules for auth, users, profiles, units, packages, maintenance, moves, reports, amenities, notices, visitors, financials, files, notifications.
  - Avoid rebuilding a generic Base44 clone unless a compatibility shim is intentionally chosen.
  - Update React Query keys to use domain-specific API calls.
- Done when:
  - New feature slices can import stable API modules.

### M4-T04 - Base44 SDK Removal Plan

- Labels: `frontend`
- Depends on: M4-T02, M4-T03
- Parallel: Feature migration work
- Work:
  - Track every remaining `base44` import.
  - Remove `@base44/sdk` and `@base44/vite-plugin` after all usages are replaced.
  - Remove Base44 app param storage code if no longer needed.
  - Decide how to handle Base44-hosted static images.
- Done when:
  - Frontend builds without Base44 packages.

### M4-T05 - Frontend Route And Feature Flag Guarding

- Labels: `frontend`, `security`
- Depends on: M3-T03, M3-T06, M4-T02
- Parallel: M6-T01
- Work:
  - Gate routes by role.
  - Gate nav items by feature flags.
  - Show pending approval block for pending residents.
  - Hide deferred pages such as AI Concierge if disabled.
  - Handle 403 and 404 states.
- Done when:
  - Users cannot navigate into views they are not permitted to use.

---

## M5 - Notifications, Files, And Background Jobs

### M5-T01 - Notification Event Contract

- Labels: `backend`, `notifications`
- Depends on: M3-T03
- Parallel: M4-T03
- Work:
  - Define notification event types for resident approvals, packages, maintenance, moves, reports, notices, amenities, visitor access, and financials.
  - Define audience targets: user, unit, role, building-wide.
  - Define event payload shape and link targets for frontend navigation.
  - Add logging and best-effort failure behavior.
- Done when:
  - Feature slices can create notifications without inventing one-off payloads.

### M5-T02 - Badge And Polling Strategy

- Labels: `backend`, `frontend`, `notifications`
- Depends on: M5-T01, M4-T01
- Parallel: M5-T03
- Work:
  - Decide polling intervals for badges that must feel fresh, such as packages, pending residents, unviewed move requests, unread reports, and urgent notices.
  - Add lightweight summary endpoints where polling full lists would be wasteful.
  - Define which views refetch after local mutations.
  - Keep WebSockets out of MVP notification behavior.
- Done when:
  - The team knows how the app stays fresh before live chat exists.

### M5-T03 - Frontend Notification And Badge Polling Provider

- Labels: `frontend`, `notifications`
- Depends on: M4-T01, M5-T02
- Parallel: M5-T04
- Work:
  - Add shared hooks for notification list, unread count, and role-specific badge counts.
  - Use React Query refetch intervals only where needed.
  - Add query invalidation helpers after local create/update/delete mutations.
  - Replace Base44 `Entity.subscribe` behavior with API refetch/polling for MVP.
- Done when:
  - Frontend badges and notifications update without WebSockets.

### M5-T04 - Notification Tables And In-App Notification API

- Labels: `backend`, `database`, `notifications`
- Depends on: M2-T04, M3-T03
- Parallel: M5-T03
- Work:
  - Create `notifications`.
  - Create `notification_preferences`.
  - Support recipient user, target unit, target role, and building-wide notifications.
  - Add list, mark read, mark all read, and create internal notification service.
  - Add unread count and role-specific badge summary endpoints.
- Done when:
  - Notification center can be wired to real backend data.

### M5-T05 - Frontend Notification Center

- Labels: `frontend`, `notifications`
- Depends on: M5-T03, M5-T04
- Parallel: Feature slices
- Work:
  - Replace notification queries and mark-read mutations.
  - Wire polling/refetch behavior for unread counts.
  - Preserve badge counts in layout.
  - Support building feed notifications and user-specific notifications.
- Done when:
  - Notification center works for resident, security, management, and council accounts.

### M5-T06 - File Storage Backend

- Labels: `backend`, `storage`, `security`
- Depends on: M3-T03
- Parallel: M5-T07
- Work:
  - Add S3 client configuration.
  - Add presigned upload endpoint.
  - Add presigned download endpoint.
  - Validate file type, size, context, and authorization.
  - Store S3 key, original filename, mime type, and size in related records.
- Done when:
  - Frontend can upload and view private files without sending file bytes through the backend.

### M5-T07 - Frontend File Upload Replacement

- Labels: `frontend`, `storage`
- Depends on: M4-T01, M5-T06
- Parallel: M5-T06
- Work:
  - Replace `UploadFile` calls with presigned upload flow.
  - Update shared upload helpers.
  - Update attachment viewers to use presigned download URLs.
  - Handle upload progress, retry, and failure states.
- Done when:
  - Existing upload components can upload to S3-compatible storage.

### M5-T08 - Outbound Email And SMS Service

- Labels: `backend`, `notifications`
- Depends on: M5-T04
- Parallel: Feature slices
- Work:
  - Add AWS SES email service.
  - Add AWS SNS SMS service.
  - Add event templates for packages, maintenance updates, move approvals, reports, amenity approvals, and resident approvals.
  - Respect notification preferences.
  - Ensure outbound notification failures do not fail main API operations.
- Done when:
  - Local/staging can send test email and SMS where credentials are configured.

### M5-T09 - Background Job Replacement For Base44 Functions

- Labels: `backend`, `infra`
- Depends on: M5-T04, M7-T01, M6-T02
- Parallel: Later feature work
- Work:
  - Replace `seedUnits` with local seed script and/or management unit import.
  - Replace `cleanupOldPackages`.
  - Replace `cleanupArchivedUpdates`.
  - Replace `migrateResidentsToUnits` with a one-time migration script if needed.
  - Decide whether jobs run as cron, container command, or admin-triggered task.
- Done when:
  - No production workflow depends on Base44 serverless functions.

---

## M6 - Resident Core: Profile, Units, Dashboard, Notices, Contacts

### M6-T01 - Profile Frontend Integration

- Labels: `frontend`
- Depends on: M3-T04, M3-T05, M4-T02, M5-T07
- Parallel: M6-T02
- Work:
  - Replace Base44 calls in `/Profile`.
  - Support edit profile, email update, vehicles, additional occupants, emergency contacts, and document uploads.
  - Support soft delete/deactivate account flow if retained.
  - Persist preferred language.
- Done when:
  - Approved residents can manage their profile end to end.

### M6-T02 - Building Updates And Emergency Notices Backend

- Labels: `backend`, `database`, `notifications`
- Depends on: M5-T04, M5-T06
- Parallel: M6-T01
- Work:
  - Create `building_updates`.
  - Create `update_archives`.
  - Support attachments.
  - Support type, priority, active/resolved/expired state, location, start/end time.
  - Create high-priority notifications for emergency and important update changes.
- Done when:
  - Backend can create, list, update, resolve, archive, and expire notices.

### M6-T03 - Building Updates Feed Frontend

- Labels: `frontend`, `notifications`
- Depends on: M6-T02, M5-T03
- Parallel: M6-T04
- Work:
  - Replace Base44 calls in `BuildingUpdatesFeed`, `EmergencyListener`, `EmergencyAlertPopup`, and `ArchivedUpdatesModal`.
  - Wire API refetch/polling behavior for urgent updates.
  - Preserve archive/unarchive behavior per user.
  - Preserve emergency popup behavior.
- Done when:
  - Residents see active notices and urgent emergency alerts without WebSockets.

### M6-T04 - Dashboard Data API And Frontend

- Labels: `backend`, `frontend`
- Depends on: M3-T04, M5-T04, M6-T02
- Parallel: M6-T03
- Work:
  - Add dashboard summary endpoint for current user's role.
  - Include profile status, unit info, active notices, package count, maintenance count, move request status, and council unread report count where relevant.
  - Replace `/Dashboard` Base44 calls.
  - Remove debug notice creation code from dashboard if present.
- Done when:
  - Each role lands on a dashboard with useful real data.

### M6-T05 - Contacts Directory

- Labels: `backend`, `frontend`, `security`
- Depends on: M3-T04, M3-T05
- Parallel: Feature slices
- Work:
  - Add contacts endpoint for security/management/council.
  - Decide which profile fields are visible by role.
  - Replace `/Contacts` Base44 calls.
  - Add search and unit filtering backed by API.
- Done when:
  - Security and management can search resident contacts without seeing unauthorized data.

### M6-T06 - Language Preference Integration

- Labels: `frontend`, `backend`
- Depends on: M6-T01
- Parallel: Later features
- Work:
  - Replace Base44 calls in `LanguageContext`.
  - Persist preferred language to profile.
  - Ensure language loads before main shell renders where possible.
- Done when:
  - Language switcher persists across login sessions.

---

## M7 - Packages And Parking Proof

### M7-T01 - Package Schema And Backend API

- Labels: `backend`, `database`
- Depends on: M3-T04, M3-T05, M5-T04, M5-T06
- Parallel: M7-T02
- Work:
  - Create `packages`.
  - Include unit, recipient profile, status, delivery/pickup timestamps, photo attachments, notes, created by, picked up by.
  - Add security endpoints to log packages.
  - Add resident endpoint to list packages for own unit/profile.
  - Add pickup/mark-delivered endpoint.
  - Create in-app notifications for package events.
- Done when:
  - Backend supports the full package lifecycle.

### M7-T02 - Security Package Log Frontend

- Labels: `frontend`
- Depends on: M7-T01, M5-T07
- Parallel: M7-T03
- Work:
  - Replace Base44 calls in `/SecurityPackages`.
  - Wire unit selection, recipient selection, package photo upload, package creation, and pickup flow.
  - Replace direct `SendEmail` call with backend notification behavior.
  - Handle no-recipient package notifications to all residents in a unit.
- Done when:
  - Security can log and complete package pickup from the frontend.

### M7-T03 - Resident Packages Frontend

- Labels: `frontend`, `notifications`
- Depends on: M7-T01, M5-T03
- Parallel: M7-T02
- Work:
  - Replace Base44 calls in `/Packages`.
  - Show ready packages and history.
  - Wire package badge count through the shared polling/refetch strategy.
  - Remove old client-side resident/unit migration behavior.
- Done when:
  - Residents see current packages and badge counts update.

### M7-T04 - Package Cleanup Job

- Labels: `backend`, `infra`
- Depends on: M7-T01, M5-T09
- Parallel: Later features
- Work:
  - Define retention period for delivered packages and related notifications.
  - Implement cleanup job or admin task.
  - Add logging and dry-run mode.
- Done when:
  - Old delivered package data can be cleaned up safely.

### M7-T05 - Parking Proof Request Backend

- Labels: `backend`, `database`, `storage`
- Depends on: M3-T04, M5-T04, M5-T06
- Parallel: M7-T06
- Work:
  - Create `parking_proof_requests`.
  - Support resident request with uploaded proof.
  - Support management review, approve, reject, reviewer metadata, and rejection reason.
  - On approval, update profile vehicle/parking data as needed.
  - Emit notification to resident.
- Done when:
  - Parking proof requests can be submitted and reviewed.

### M7-T06 - Parking Proof Frontend

- Labels: `frontend`
- Depends on: M7-T05, M5-T07
- Parallel: M7-T05
- Work:
  - Replace Base44 calls in `ParkingProofRequestSection`.
  - Replace Base44 calls in `ParkingProofReviewPanel`.
  - Add upload progress and review states.
- Done when:
  - Resident and management parking proof workflows work end to end.

---

## M8 - Maintenance

### M8-T01 - Maintenance Schema And Backend API

- Labels: `backend`, `database`, `storage`
- Depends on: M3-T04, M5-T04, M5-T06
- Parallel: M8-T02
- Work:
  - Create `maintenance_tickets`.
  - Create `maintenance_notes`.
  - Support ticket type, category, title, description, location, priority, status, assigned staff, schedule time, resolution notes, photos, archive state.
  - Add resident create/list/update limited actions.
  - Add management list, assign, status update, note, archive, and delete/soft-delete actions.
  - Emit notification on ticket creation and management updates.
- Done when:
  - Backend supports resident and management maintenance workflows.

### M8-T02 - Resident Maintenance Frontend

- Labels: `frontend`
- Depends on: M8-T01, M5-T07
- Parallel: M8-T03
- Work:
  - Replace Base44 calls in `/Maintenance`.
  - Support ticket creation, attachment upload, list/history, and status display.
  - Handle validation and empty states.
- Done when:
  - Residents can submit and track maintenance tickets.

### M8-T03 - Management Maintenance Frontend

- Labels: `frontend`
- Depends on: M8-T01
- Parallel: M8-T02
- Work:
  - Replace Base44 calls in `/ManagementMaintenance`.
  - Support filtering by status/priority/type.
  - Support adding notes, assigning staff, updating status, archiving, and deletion behavior.
  - Wire notifications through backend service.
- Done when:
  - Management can process maintenance tickets end to end.

### M8-T04 - Maintenance Notification Templates

- Labels: `backend`, `notifications`
- Depends on: M8-T01, M5-T08
- Parallel: M8-T02
- Work:
  - Add templates for new ticket, status changed, note added, scheduled, completed, and closed.
  - Respect resident notification preferences.
  - Add tests for best-effort dispatch.
- Done when:
  - Maintenance events produce correct in-app and outbound notifications.

---

## M9 - Move Requests And Move Inspections

### M9-T01 - Move Request Schema And Backend API

- Labels: `backend`, `database`, `notifications`
- Depends on: M3-T04, M5-T04
- Parallel: M9-T02
- Work:
  - Create `move_requests`.
  - Include resident user, unit, move type, requested date/time, elevator/parking needs, status, viewed flags for security and management.
  - Add resident create/list/cancel endpoints.
  - Add security/property management review endpoints.
  - Emit notifications on submission, approval, denial, completion.
- Done when:
  - Backend supports the move request lifecycle.

### M9-T02 - Move Request Frontend

- Labels: `frontend`
- Depends on: M9-T01
- Parallel: M9-T03
- Work:
  - Replace Base44 calls in `/MoveRequest`.
  - Support resident submit/cancel/history.
  - Wire management/security approval view in `/SecurityMoveRequests`.
  - Preserve viewed-by-security and viewed-by-management badge behavior.
- Done when:
  - Residents submit moves and staff process them.

### M9-T03 - Move Inspection Schema And Backend API

- Labels: `backend`, `database`, `storage`
- Depends on: M9-T01, M5-T06
- Parallel: M9-T02
- Work:
  - Create `move_inspections`.
  - Create `move_inspection_photos`.
  - Support pre/post inspection phases, areas, condition notes, completion state, submitted metadata, and photo deletion.
  - Enforce security/management permissions.
- Done when:
  - Backend supports inspection creation, updates, submission, and photo management.

### M9-T04 - Move Inspection Frontend

- Labels: `frontend`, `storage`
- Depends on: M9-T03, M5-T07
- Parallel: M9-T05
- Work:
  - Replace Base44 calls in `/MoveInspection`.
  - Wire pre/post photo uploads by area.
  - Preserve upload progress and batch uploads.
  - Support photo viewer and delete.
  - Support read-only history for management/council as allowed.
- Done when:
  - Security can complete a move inspection with photos.

### M9-T05 - Move Notification Templates

- Labels: `backend`, `notifications`
- Depends on: M9-T01, M5-T08
- Parallel: M9-T04
- Work:
  - Add templates for new request, viewed/reviewed, approved, denied, completed, inspection submitted.
  - Notify security, property management, and resident audiences appropriately.
- Done when:
  - Move events generate correct notifications and badges.

---

## M10 - Security Reports And Daily Operations Calendar

### M10-T01 - Reports Schema And Backend API

- Labels: `backend`, `database`, `storage`
- Depends on: M3-T03, M5-T04, M5-T06
- Parallel: M10-T02
- Work:
  - Create `reports`.
  - Create `report_reads`.
  - Support incident and shift report types.
  - Support structured content, attachments, status, soft delete, submitted by, and timestamps.
  - Add security create endpoints.
  - Add management/council inbox endpoints.
  - Add report read tracking.
- Done when:
  - Backend supports creating, reading, soft deleting, restoring, and marking reports as read.

### M10-T02 - Security Report Creation Frontend

- Labels: `frontend`, `storage`
- Depends on: M10-T01, M5-T07
- Parallel: M10-T03
- Work:
  - Replace Base44 calls in `/security-reports`, `/CreateIncidentReport`, `/CreateShiftReport`, and `/SecurityReport`.
  - Support attachment uploads.
  - Notify management and council via backend.
- Done when:
  - Security can submit incident and shift reports.

### M10-T03 - Management Reports Inbox Frontend

- Labels: `frontend`
- Depends on: M10-T01
- Parallel: M10-T02
- Work:
  - Replace Base44 calls in `/ManagementReports`.
  - Support filtering, read tracking, delete/restore, status updates, and notes if retained.
  - Wire council unread badge count.
- Done when:
  - Management and council can review reports with accurate unread counts.

### M10-T04 - Calendar Events And Security Tasks Backend

- Labels: `backend`, `database`
- Depends on: M6-T02, M9-T01, M10-T01
- Parallel: M10-T05 after API contract
- Work:
  - Create `calendar_events`.
  - Create `security_tasks`.
  - Support linked notice IDs, all-day events, start/end dates, time ranges, status, assignment, completion metadata.
  - Support agenda aggregation from move requests, reports, building updates, and tasks.
  - Leave a documented extension point for speakeasy reservations, then connect it during M11.
- Done when:
  - Backend can power the Daily Notices calendar and task agenda.

### M10-T05 - Daily Notices Calendar Frontend

- Labels: `frontend`
- Depends on: M10-T04
- Parallel: M10-T06
- Work:
  - Replace Base44 calls in `/ManagementNotices`.
  - Replace calendar modal calls in `CreateEventModal`, `CreateTaskModal`, `EventDetailModal`, and `EventSyncPrompt`.
  - Preserve linked notice creation/update/delete behavior.
  - Preserve agenda filters for moves, tasks, incidents, events, and speakeasy.
- Done when:
  - Security and property management can manage daily notices and task calendar.

### M10-T06 - Report And Task Notification Templates

- Labels: `backend`, `notifications`
- Depends on: M10-T01, M10-T04, M5-T08
- Parallel: M10-T05
- Work:
  - Add templates for new incident report, new shift report, task assignment, task completed, notice created.
  - Route notifications by role and building.
- Done when:
  - Daily ops events notify the correct users.

---

## M11 - Amenities: Gameroom And Speakeasy

### M11-T01 - Amenity Foundation Schema

- Labels: `backend`, `database`
- Depends on: M3-T06
- Parallel: M11-T02
- Work:
  - Create `amenities`.
  - Decide whether gameroom equipment rentals use generic `amenity_bookings` or dedicated tables.
  - Include building-specific rules, active flags, room/equipment names, durations, fees, and conflict settings.
  - Seed gameroom equipment and speakeasy rooms.
- Done when:
  - Building-specific amenity configuration is stored in the database.

### M11-T02 - Gameroom Rental Backend

- Labels: `backend`, `database`, `storage`
- Depends on: M11-T01, M5-T04, M5-T06
- Parallel: M11-T03
- Work:
  - Create `gameroom_rentals`.
  - Create `gameroom_rental_events`.
  - Support item conflicts for pool cues, ping pong, and combined rentals.
  - Support statuses: requested, accepted, denied, active, return_pending, completed, cancelled.
  - Support start, cancel, accept, deny, return, condition edit, lost/damaged condition, notes, and photos.
  - Emit notifications to security and residents.
- Done when:
  - Backend supports the full gameroom rental lifecycle.

### M11-T03 - Speakeasy Reservation Backend

- Labels: `backend`, `database`, `storage`
- Depends on: M11-T01, M5-T04, M5-T06
- Parallel: M11-T02
- Work:
  - Create `speakeasy_reservations` or map into a generic reservation table with room type.
  - Support room type, date, start/end times, status, payment status, pre/post photos, session start/end, archive state, approval metadata, decline reason.
  - Prevent overlapping bookings per room.
  - Support management approval/decline and security operations.
  - Emit notifications.
- Done when:
  - Backend supports resident requests, management approvals, and security operations.

### M11-T04 - Resident Gameroom Frontend

- Labels: `frontend`
- Depends on: M11-T02
- Parallel: M11-T05
- Work:
  - Replace Base44 calls in `/Gameroom`.
  - Preserve item availability and conflict logic using backend data.
  - Support request, start if allowed, cancel, active timers, and history.
- Done when:
  - Residents can request gameroom equipment and see current availability.

### M11-T05 - Security Gameroom Frontend

- Labels: `frontend`, `storage`
- Depends on: M11-T02, M5-T07
- Parallel: M11-T04
- Work:
  - Replace Base44 calls in `/SecurityGameroom`.
  - Support accepting/denying requests, pre-use photos, returns, post-use photos, condition editing, and history.
  - Replace notification mark-read behavior.
- Done when:
  - Security can operate gameroom rentals end to end.

### M11-T06 - Resident Speakeasy Frontend

- Labels: `frontend`
- Depends on: M11-T03
- Parallel: M11-T07
- Work:
  - Replace Base44 calls in `/Speakeasy`.
  - Preserve room availability, reservation request, archive history, and notifications.
  - Keep virtual tour assets working or replace Base44-hosted media.
- Done when:
  - Residents can request and view speakeasy reservations.

### M11-T07 - Management And Security Speakeasy Frontend

- Labels: `frontend`, `storage`
- Depends on: M11-T03, M5-T07
- Parallel: M11-T06
- Work:
  - Replace Base44 calls in `/ManagementSpeakeasy`.
  - Replace Base44 calls in `/SecuritySpeakeasy`.
  - Support approval, decline, paid status, active/completed states, pre/post photos, force close, and notices.
- Done when:
  - Management and security can operate speakeasy reservations end to end.

### M11-T08 - Amenity Notification Templates

- Labels: `backend`, `notifications`
- Depends on: M11-T02, M11-T03, M5-T08
- Parallel: M11-T04
- Work:
  - Add templates for request submitted, approved, denied, active, return requested, completed, damaged/lost, and force-closed events.
  - Notify security, management, and resident audiences as appropriate.
- Done when:
  - Amenity workflows generate correct notifications and badges.

---

## M12 - Visitor Access And Verification

### M12-T01 - Visitor Access Schema And Backend API

- Labels: `backend`, `database`, `security`
- Depends on: M3-T04, M5-T04
- Parallel: M12-T02
- Work:
  - Create `visitor_access_passes`.
  - Create `visitor_parking_reservations`.
  - Support code generation on backend, uniqueness, expiry, revocation, verification, and status transitions.
  - Support one-time and recurring/time-bounded access if retained.
  - Support optional visitor parking reservation and license plate.
- Done when:
  - Backend can create, revoke, expire, and verify visitor passes.

### M12-T02 - Resident Visitor Access Frontend

- Labels: `frontend`
- Depends on: M12-T01, M4-T05
- Parallel: M12-T03
- Work:
  - Decide whether `/VisitorAccess` is enabled in nav for MVP.
  - Replace Base44 calls in `/VisitorAccess`.
  - Move code generation from client to backend.
  - Show active, expired, revoked, and used passes.
  - Support parking reservation creation/cancellation if enabled.
- Done when:
  - Residents can create and manage visitor access passes if the feature is enabled.

### M12-T03 - Security Visitor Verification Frontend

- Labels: `frontend`
- Depends on: M12-T01
- Parallel: M12-T02
- Work:
  - Replace Base44 calls in `/VisitorVerification`.
  - Support code lookup, active pass list, parking validation, and mark-used behavior.
  - Handle expired/revoked/used pass states.
- Done when:
  - Security can verify visitors and parking reservations.

### M12-T04 - Visitor Cleanup Job

- Labels: `backend`, `infra`
- Depends on: M12-T01, M5-T09
- Parallel: Later work
- Work:
  - Add job to expire old active passes.
  - Add retention policy for old passes and parking reservations.
  - Add audit logging for verification attempts.
- Done when:
  - Visitor pass statuses stay accurate without client-side polling logic doing all the work.

---

## M13 - Financials And Council Oversight

### M13-T01 - Financial Schema And Backend API

- Labels: `backend`, `database`, `security`
- Depends on: M3-T03, M3-T06
- Parallel: M13-T02
- Work:
  - Create `resident_charges`.
  - Create `building_expenses`.
  - Create `budget_items`.
  - Create `bank_statements`.
  - Support amount, category, month/date, status, payment date, created by, notes, and attachments.
  - Gate all endpoints to management/council/financial roles.
- Done when:
  - Backend can create, list, update, and summarize financial records.

### M13-T02 - Financial Dashboard Frontend

- Labels: `frontend`
- Depends on: M13-T01
- Parallel: M13-T03
- Work:
  - Replace Base44 calls in `/Financials`.
  - Wire resident charges, building expenses, budget items, bank statements.
  - Preserve charts, insights, overdue alerts, resident charges table, and charge detail panel.
  - Add permission and empty states.
- Done when:
  - Financial dashboard displays real backend data for authorized users.

### M13-T03 - Council Overview Backend

- Labels: `backend`, `database`
- Depends on: M10-T01, M9-T01, M8-T01, M7-T01, M13-T01
- Parallel: M13-T02
- Work:
  - Add council overview summary endpoint.
  - Include unread report counts, open maintenance counts, move pipeline, package counts, amenity activity, and financial summary if enabled.
  - Enforce council permissions.
- Done when:
  - Council overview data can be fetched in one or a few efficient calls.

### M13-T04 - Council Overview Frontend

- Labels: `frontend`
- Depends on: M13-T03, M3-T07
- Parallel: M13-T05
- Work:
  - Replace Base44 calls in legacy `/BoardOverview` and rename the target route to `/CouncilOverview`.
  - Wire unread report counts and operational summaries.
  - Preserve council role switching paths.
- Done when:
  - Council users can monitor high-level operations.

### M13-T05 - Bank Statement Uploads

- Labels: `backend`, `frontend`, `storage`
- Depends on: M13-T01, M5-T07
- Parallel: M13-T04
- Work:
  - Add bank statement file upload through S3.
  - Store metadata and private S3 key.
  - Decide whether parsing/import is manual post-MVP or supported now.
  - Add secure document viewer/download behavior.
- Done when:
  - Authorized users can upload and view bank statement files.

---

## M14 - Production Infrastructure And Deployment

### M14-T01 - AWS Account, Regions, And IAM Plan

- Labels: `infra`, `security`
- Depends on: M1-T02
- Parallel: App feature work
- Work:
  - Confirm AWS account and region.
  - Define IAM roles for EC2, GitHub Actions, S3, SES, SNS, ECR, CloudWatch, and SSM.
  - Avoid long-lived credentials on EC2.
  - Document least-privilege policies.
- Done when:
  - Production infrastructure can be provisioned without ad hoc credentials.

### M14-T02 - S3 Buckets

- Labels: `infra`, `storage`, `security`
- Depends on: M14-T01
- Parallel: M14-T03
- Work:
  - Create dev and prod buckets.
  - Block public access.
  - Enable server-side encryption.
  - Add lifecycle rules for older inspection photos.
  - Configure CORS for presigned uploads if needed.
- Done when:
  - File uploads work against private S3 buckets.

### M14-T03 - SES And SNS Setup

- Labels: `infra`, `notifications`
- Depends on: M14-T01
- Parallel: M14-T02
- Work:
  - Verify sending domain in SES.
  - Request SES production access.
  - Configure SNS SMS permissions and spending limits.
  - Add sender email to env/SSM.
- Done when:
  - Staging/prod can send outbound notifications.

### M14-T04 - RDS PostgreSQL

- Labels: `infra`, `database`, `security`
- Depends on: M14-T01
- Parallel: M14-T05
- Work:
  - Provision PostgreSQL 16 RDS.
  - Make it private.
  - Allow access only from EC2 security group.
  - Configure backups.
  - Store connection string in SSM Parameter Store.
- Done when:
  - Production backend can connect to RDS without hardcoded secrets.

### M14-T05 - EC2, Docker, Optional Redis, And Caddy

- Labels: `infra`
- Depends on: M14-T01
- Parallel: M14-T04
- Work:
  - Provision EC2.
  - Install Docker and Docker Compose plugin.
  - Configure security group for 80, 443, and restricted SSH or Session Manager.
  - Configure Redis container private to Docker network if included now for future live chat.
  - Configure Caddy for SSL and reverse proxy.
- Done when:
  - EC2 can run backend containers behind HTTPS.

### M14-T06 - ECR And CI Image Build

- Labels: `infra`, `ci`
- Depends on: M1-T05, M14-T01
- Parallel: M14-T04
- Work:
  - Create ECR repository.
  - Add lifecycle policy to keep recent images.
  - Add GitHub Actions workflow to build and push `linux/amd64` images.
  - Store GitHub AWS secrets or use OIDC if configured.
- Done when:
  - Merging to `main` builds and pushes a Docker image to ECR.

### M14-T07 - Production Compose And Blue/Green Deploy Script

- Labels: `infra`, `deployment`
- Depends on: M14-T04, M14-T05, M14-T06
- Parallel: App QA
- Work:
  - Add `docker-compose.prod.yml`.
  - Add deploy script that fetches SSM secrets, pulls image, runs migrations, starts inactive color, checks health, switches Caddy, and leaves rollback path.
  - Track active port/color in a file.
  - Document rollback command.
- Done when:
  - A test deploy can switch between blue and green safely.

### M14-T08 - CloudWatch Logging And Alarms

- Labels: `infra`, `monitoring`
- Depends on: M14-T05, M14-T07
- Parallel: M15
- Work:
  - Configure Docker awslogs driver.
  - Create log group.
  - Add structured JSON log output.
  - Add high CPU and error-rate alarms.
  - Add SNS email topic for alarms.
- Done when:
  - Production logs and alarms are visible in CloudWatch.

### M14-T09 - Frontend Deployment

- Labels: `infra`, `frontend`
- Depends on: M4-T04, M14-T07
- Parallel: Backend deployment
- Work:
  - Choose frontend hosting: Vercel, Netlify, or S3/CloudFront.
  - Configure production `VITE_API_URL`.
  - Configure allowed origins on backend.
  - Add build/deploy workflow.
  - Configure custom domain and HTTPS.
- Done when:
  - Production frontend can reach production backend securely.

---

## M15 - QA, Security Hardening, UAT, And Launch

### M15-T01 - Backend Unit And Integration Test Coverage

- Labels: `qa`, `backend`
- Depends on: Feature milestones
- Parallel: M15-T02
- Work:
  - Add tests for auth, role guards, tenant isolation, CRUD, notifications best-effort behavior, and file authorization.
  - Add transaction rollback or test database isolation.
  - Add representative tests for every MVP domain.
- Done when:
  - Backend tests cover major workflow risks and run in CI.

### M15-T02 - Frontend Workflow Tests

- Labels: `qa`, `frontend`
- Depends on: Feature milestones
- Parallel: M15-T01
- Work:
  - Add Playwright or equivalent E2E tests for login, resident approval, packages, maintenance, moves, reports, notices, and amenities.
  - Add role-based navigation checks.
  - Add mobile viewport checks for critical pages.
- Done when:
  - Core user journeys pass locally and in CI/staging.

### M15-T03 - Security Hardening Pass

- Labels: `security`, `backend`, `infra`
- Depends on: M14-T07, Feature milestones
- Parallel: M15-T04
- Work:
  - Verify CORS production origins.
  - Add auth rate limiting.
  - Review every endpoint for tenant isolation.
  - Validate file MIME and size rules.
  - Ensure secrets are in SSM or environment only.
  - Ensure Redis is not exposed publicly.
  - Ensure RDS is private.
  - Ensure S3 public access is blocked.
- Done when:
  - Security checklist in `docs/BACKEND_INFRA.md` is satisfied.

### M15-T04 - Data Migration And Import Plan

- Labels: `database`, `project`
- Depends on: M2-T06, Feature schemas
- Parallel: M15-T03
- Work:
  - Decide whether any Base44 production data exists to migrate.
  - If yes, export data and map it to new schemas.
  - Write import scripts with dry-run mode.
  - Validate counts and sample records.
  - If no, document clean launch seed/import path.
- Done when:
  - Launch data source and migration steps are clear and repeatable.

### M15-T05 - Staging Environment

- Labels: `infra`, `qa`
- Depends on: M14-T07, M14-T09
- Parallel: M15-T01
- Work:
  - Create staging env variables and resources.
  - Deploy backend and frontend to staging.
  - Seed realistic staging data.
  - Give team and client testers access.
- Done when:
  - UAT can happen without touching local or production data.

### M15-T06 - UAT Scripts By Role

- Labels: `qa`, `project`
- Depends on: M15-T05
- Parallel: M15-T07
- Work:
  - Write test scripts for resident, security, property management, council, and financials roles.
  - Include expected outcomes and sample data.
  - Include negative permission checks.
  - Track UAT feedback as tickets.
- Done when:
  - Testers can validate the app without needing developer guidance.

### M15-T07 - Performance And Load Smoke Test

- Labels: `qa`, `infra`
- Depends on: M15-T05
- Parallel: M15-T06
- Work:
  - Test concurrent logins and normal page loads.
  - Test normal page load and refetch behavior after backend deploy.
  - Test file upload size limits.
  - Check dashboard/report query performance with realistic data volume.
  - Add indexes where needed.
- Done when:
  - App handles expected one-building traffic with comfortable headroom.

### M15-T08 - Launch Runbook And Rollback Plan

- Labels: `deployment`, `project`
- Depends on: M14-T07, M15-T05
- Parallel: M15-T06
- Work:
  - Document release steps.
  - Document migration commands.
  - Document health checks.
  - Document rollback steps.
  - Document how to view logs and alarms.
  - Document emergency contact and ownership.
- Done when:
  - The team can deploy or roll back without improvising.

### M15-T09 - Production Launch

- Labels: `deployment`
- Depends on: M15-T01, M15-T02, M15-T03, M15-T04, M15-T06, M15-T08
- Parallel: None
- Work:
  - Freeze release branch.
  - Run migrations.
  - Deploy backend.
  - Deploy frontend.
  - Smoke test every role.
  - Monitor logs and alarms.
  - Keep rollback window open.
- Done when:
  - Production is live and core workflows pass smoke tests.

---

## M16 - Future And Post-MVP

### M16-T01 - AI Concierge

- Labels: `post-mvp`, `frontend`, `backend`
- Depends on: Production launch
- Parallel: Future roadmap
- Work:
  - Define approved knowledge sources.
  - Decide OpenAI model and retrieval architecture.
  - Add backend AI endpoint with role and building context.
  - Replace `InvokeLLM` in `/Concierge`.
  - Add usage limits and logging.
- Done when:
  - AI Concierge can answer building-specific questions safely.

### M16-T02 - Advanced Financial Imports

- Labels: `post-mvp`, `financials`
- Depends on: M13-T05
- Parallel: Future roadmap
- Work:
  - Parse uploaded bank statements.
  - Reconcile transactions against expenses and charges.
  - Add review queue for imported transactions.
- Done when:
  - Management can import and reconcile bank statements with human review.

### M16-T03 - Push Notifications

- Labels: `post-mvp`, `notifications`
- Depends on: M5-T04, M5-T08
- Parallel: Future roadmap
- Work:
  - Decide web push or mobile push strategy.
  - Store device subscriptions.
  - Add user preference controls.
  - Add delivery failure cleanup.
- Done when:
  - Users can receive push notifications outside the app.

### M16-T04 - Multi-Building Admin Console

- Labels: `post-mvp`, `backend`, `frontend`
- Depends on: Stable multi-tenant backend
- Parallel: Future roadmap
- Work:
  - Add platform-admin role.
  - Add building creation/configuration UI.
  - Add feature flag management UI.
  - Add cross-building health and usage metrics.
- Done when:
  - The product can onboard additional buildings without manual database work.

### M16-T05 - Analytics And Audit Log Dashboard

- Labels: `post-mvp`, `monitoring`, `security`
- Depends on: Production launch
- Parallel: Future roadmap
- Work:
  - Add audit events for sensitive actions.
  - Add admin dashboard for activity.
  - Add export capability for reports and audit data.
- Done when:
  - Management can review operational history and sensitive actions.

### M16-T06 - Live Chat With WebSocket Reconnect

- Labels: `post-mvp`, `backend`, `frontend`, `realtime`
- Depends on: Production launch, M5-T04
- Parallel: Future roadmap
- Work:
  - Create chat conversation, participant, and message tables.
  - Store every chat message in PostgreSQL before broadcasting.
  - Add Redis Pub/Sub for live delivery across app workers.
  - Add authenticated chat WebSocket endpoint.
  - Add frontend chat client that connects only when chat is open.
  - Add simple reconnect with exponential backoff.
  - On reconnect, re-join the conversation and fetch missed messages using `last_seen_message_id` or timestamp.
  - Make blue/green deploys produce at worst a brief chat reconnect, not message loss.
- Done when:
  - Users can chat live, refresh/reconnect safely, and recover missed messages after a deploy.

---

## First Sprint Recommendation

Sprint 1 should stay small and prove the foundation:

1. M0-T01 through M0-T07
2. M1-T01 through M1-T04
3. M2-T01 through M2-T05
4. Start M3-T01 and M4-T01 only after the API conventions are agreed

The first vertical slice after foundation should be:

1. M3-T04 resident onboarding and approval
2. M5-T01 through M5-T05 durable in-app notification and polling basics
3. M7-T01 through M7-T03 packages

That slice touches the most important system risks early: auth, roles, tenant scoping, frontend Base44 replacement, database CRUD, durable notifications, badge freshness, and role-specific UX.
