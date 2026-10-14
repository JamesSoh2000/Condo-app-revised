# Condo Management App - Backend Requirements

This document defines the backend, data, and integration requirements for the condo management app. It aligns with `docs/BACKEND_INFRA.md` and the Base44-exported frontend in `frontend/`.

The backend must support multiple buildings from one shared platform. Each building can have different enabled features, different amenities, different branding/content, and different operational rules. The frontend must never assume every building has a gameroom, speakeasy, financials, visitor access, or AI Concierge.

## 1. Architecture Decisions

The backend and infrastructure direction is now decided:

* **API:** FastAPI REST API with OpenAPI docs.
* **Backend runtime:** Python 3.12.13.
* **Frontend runtime:** Node.js 24.16.0 with npm 11.x.
* **Database:** PostgreSQL 16 with SQLAlchemy 2.0 async and Alembic migrations.
* **Tenancy:** Single shared database, single schema, `building_id` on every tenant-specific table.
* **Future live chat:** FastAPI WebSockets plus Redis Pub/Sub when chat is implemented.
* **File storage:** AWS S3 with private objects and presigned upload/download URLs.
* **Notifications:** In-app notifications plus AWS SES for email and AWS SNS for SMS.
* **Deployment:** Docker images in AWS ECR, EC2 runtime, Caddy reverse proxy, blue/green backend deployment.
* **Monitoring:** Structured JSON logs and CloudWatch alarms.

GraphQL, Socket.io, Supabase Realtime, and Cloudflare R2 are not the current plan unless the team later revisits the architecture.

## 2. Multi-Tenancy, Features, And Paywalls

### Building Isolation

All resident, unit, amenity, package, maintenance, report, financial, notification, visitor, and file records must be scoped to a building.

Requirements:

* Every tenant-specific table includes `building_id`.
* Backend queries must derive `building_id` from the authenticated user's active building context.
* The API must never trust `building_id` from a request body for tenant isolation.
* Users may eventually belong to more than one building, so the schema should support building membership rather than assuming one global role per user forever.
* Cross-building platform administration should be treated as a future capability, not as normal management access.

### Feature Entitlements And Paywalls

Not every building has the same paid features. Feature access must be enforced by the backend, not only hidden in the frontend.

Required entity:

* **`BuildingFeature`:** `building_id`, `feature_slug`, `enabled`, `subscription_tier`, `config`, timestamps.

Example `feature_slug` values:

* `packages`
* `maintenance`
* `moves`
* `visitor_access`
* `custom_amenities`
* `gameroom`
* `speakeasy`
* `notices`
* `financials`
* `ai_concierge`
* `sms_notifications`

Requirements:

* Frontend calls `GET /buildings/me/features` after login.
* Frontend hides unavailable routes/nav items based on feature data.
* Backend guards protected endpoints with feature checks.
* Feature config can hold building-specific limits and rules, such as max booking hours, SMS enabled, max attachments, approval requirements, or paid amenity fees.
* Disabled/paywalled features return `403` from the backend even if a user manually opens the route.

## 3. User Roles And Authentication

The system uses RBAC with building-scoped permissions.

Roles:

* **Resident:** Can be in `pending_approval` until verified by management. Approved residents gain access to enabled resident features for their building.
* **Security / Concierge:** Operational staff for packages, visitor verification, move inspections, security reports, contacts, and enabled amenity operations.
* **Property Management:** Administrative staff for resident approvals, notices, maintenance, reports, move approvals, amenities, and enabled financial workflows.
* **Council Member:** Building governance/oversight role with council reporting and the ability to switch view context where allowed. This replaces the older `board` terminology.

Requirements:

* User registration/login and session management.
* JWT access token plus refresh strategy.
* `GET /auth/me` returns user, active building, role, feature visibility, and resident approval state.
* Role-based API protection.
* Building-scoped role membership support.
* Council/property-management view switching without granting permissions beyond the user's real role.
* Auth endpoints need rate limiting before production.

## 4. Core Entities And Database Requirements

### Building And Access Control

* **`Building`:** Client building record, name, address, timezone, branding, status, subscription tier.
* **`BuildingFeature`:** Feature entitlement/paywall state and feature-specific config.
* **`BuildingMembership`:** User-to-building relationship, role, status, active flag. This is important for future multi-building staff/admin users.
* **`User`:** Global user account, email, password hash, account metadata.
* **`ResidentProfile`:** Building-scoped resident profile, user, unit, approval status, full name, phone, language, emergency contacts, additional occupants, vehicles, notification settings, document keys.
* **`Unit`:** Building-scoped unit, unit number, tower/section, floor, active flag.

### Custom Amenities

Amenities must be building-configured, not hard-coded globally.

Required entities:

* **`Amenity`:** Building-scoped amenity definition. Includes name, type, description, cover photo/file key, gallery photos, location, capacity, active flag, booking rules, approval rules, fee/deposit rules, and sort order.
* **`AmenityBooking`:** Generic reservation/booking record for amenity usage. Includes amenity, resident, start/end, status, payment status if needed, approval metadata, cancellation metadata, notes, and attachments.
* **`AmenityAsset`** or attachment metadata: Stores S3 keys for amenity photos and documents.

Specialized amenity workflows may still need dedicated tables:

* **`GameroomRental`:** Equipment/rental workflow for buildings that enable a gameroom-style rental feature.
* **`GameroomRentalEvent`:** Audit/history events, return events, damage/lost condition, and photos for gameroom rentals.
* **`SpeakeasyReservation`:** Reservation workflow for buildings that enable speakeasy-style rooms and need the current approval/payment/session behavior.

Requirements:

* A building can have zero, one, or many amenities.
* A building can add custom amenities with photo, description, availability, and booking rules.
* The frontend should eventually render amenities from backend configuration instead of assuming fixed gameroom/speakeasy nav everywhere.
* Existing `/gameroom` and `/speakeasy` pages can be treated as specialized frontend experiences for buildings that enable those feature slugs.
* Backend must prevent bookings for inactive, disabled, or paywalled amenities.
* Booking overlap rules must be enforced on the backend.

### Resident And Building Services

* **`Package`:** Tracks packages delivered to units/residents, status, delivery/pickup timestamps, photos, notes, created by, picked up by.
* **`MoveRequest`:** Tracks resident move-in/move-out requests, requested dates/times, status, viewed-by-security/management flags, approval metadata.
* **`MoveInspection`:** Pre/post move inspection records linked to move requests.
* **`MoveInspectionPhoto`:** Inspection photo metadata and S3 keys.
* **`MaintenanceTicket`:** Resident or common-area maintenance request, title, type, category, description, location, priority, status, schedule, assigned staff, resolution notes, photos, archived state.
* **`MaintenanceNote`:** Internal or resident-facing notes attached to a maintenance ticket.
* **`ParkingProofRequest`:** Resident proof upload and management approval/rejection flow.

### Notices, Notifications, And Communication

* **`BuildingUpdate`:** Notices, maintenance alerts, emergency updates, amenity updates, attachments, active/resolved/expired state.
* **`UpdateArchive`:** Per-user archive/hide state for notices and notification feed items.
* **`Notification`:** In-app notification records for users, units, roles, or building-wide broadcasts.
* **`NotificationPreference`:** Per-resident channel preferences for in-app, email, and SMS by event type.

Requirements:

* In-app notifications are the durable source of truth.
* Clients must be able to reload state from the database. MVP notifications should not depend on WebSockets.
* Email/SMS dispatch is best-effort and must not roll back the primary database operation.
* Emergency notices must create high-priority records and be surfaced through fast refetch/polling in MVP; WebSocket push can be added later if needed.

### Security And Reporting

* **`Report`:** Incident and shift reports created by security, including structured content, attachments, status, soft delete, and author metadata.
* **`ReportRead`:** Tracks which council/management users have read which reports.
* **`SecurityTask`:** Operational task records for the daily notices/calendar workflow.
* **`CalendarEvent`:** Building operations calendar events, optionally linked to building notices.

### Visitor Access

* **`VisitorAccessPass`:** Resident-created or staff-created visitor passes, code, validity window, status, verification metadata.
* **`VisitorParkingReservation`:** Optional visitor parking reservation linked to an access pass, license plate, time window, status.

Requirements:

* Visitor codes must be generated by the backend.
* Verification attempts should be auditable.
* Expired passes should be handled by backend logic or scheduled cleanup, not only client polling.

### Financials

Financials are a paywalled/role-gated feature.

* **`ResidentCharge`:** Charges billed to residents, amount, charge type, status, due/payment dates, created by.
* **`BuildingExpense`:** Building expenses, amount, category, expense date, status, vendor/notes if needed.
* **`BudgetItem`:** Monthly budget allocations and spent amounts.
* **`BankStatement`:** Uploaded bank statement metadata and private S3 key.

Requirements:

* Financial endpoints are available only to enabled buildings and authorized management/council/financial users.
* Bank statements and financial attachments must never be public.

## 5. Feature Breakdown By Role

### Resident Features

* **Dashboard:** Aggregated view of unit status, notices, packages, maintenance, moves, and enabled amenities.
* **Profile Management:** Personal details, occupants, vehicles, parking proof, notification preferences, documents, language.
* **Move In/Out:** Submit and track move requests.
* **Packages:** View packages awaiting pickup and package history when the packages feature is enabled.
* **Maintenance:** Submit and track tickets when the maintenance feature is enabled.
* **Amenities:** Browse and request building-specific enabled amenities. Gameroom and speakeasy are examples, not universal assumptions.
* **Visitor Access:** Create visitor passes and optional parking reservations when enabled.
* **Multi-Language Support:** Switch UI language and persist preference.

### Security Features

* **Package Log:** Log packages, attach photos, notify residents, and mark packages picked up.
* **Visitor Verification:** Verify guests against active passes and visitor parking reservations.
* **Move Requests:** Review upcoming move requests and mark security review/view state.
* **Move Inspection:** Perform pre/post-move damage inspections with photo uploads.
* **Reports:** Submit shift and incident reports with attachments.
* **Amenities Ops:** Operate only the amenities/features enabled for that building.
* **Contacts:** View role-appropriate resident directory.
* **Daily Notices/Tasks:** View and complete assigned building operations tasks where enabled.

### Property Management Features

* **Resident Approvals:** Approve, deny, or deactivate residents.
* **Contacts:** Search resident directory with management-level fields.
* **Reports Inbox:** Read, review, restore/delete, and track security reports.
* **Maintenance Management:** Update tickets, add notes, assign staff, schedule work, archive tickets, and notify residents.
* **Move Approvals:** Approve/deny move requests and monitor inspections.
* **Notices:** Broadcast building updates and emergency notices, including attachments.
* **Amenities Management:** Create and configure building amenities, upload photos, set descriptions/rules, activate/deactivate amenities, and manage reservations.
* **Financial Dashboard:** View and manage financial data when the feature is enabled.
* **Feature Visibility:** Use backend-provided feature flags to determine available modules. Platform-level subscription changes may be handled by a future admin console.

### Council Member Features

* **Council Overview:** High-level operational and financial view where enabled.
* **Reports Oversight:** Unread/read report tracking.
* **View Switching:** Ability to view resident/management experiences where allowed without bypassing permissions.

### Future Features

* **AI Concierge:** Deferred. When implemented, it should be a backend-mediated feature gated by `ai_concierge`, with usage limits, logging, and building-specific knowledge controls.
* **Platform Admin Console:** Future cross-building administration for onboarding buildings, subscriptions, feature flags, and support.

## 6. Infrastructure And Integration Requirements

### API

* REST API with Pydantic request/response schemas.
* OpenAPI docs available locally and in non-production environments.
* Consistent filtering, sorting, and pagination to replace Base44 `list` and `filter` calls.
* Consistent error response format.

### Future Live Chat And Realtime

Live chat is a low-priority add-on and should be implemented after the core operational app is stable. The MVP should not require WebSockets for packages, approvals, reports, notices, or badges.

When live chat is implemented:

* Add an authenticated WebSocket endpoint.
* Use Redis Pub/Sub to broadcast chat events across app workers.
* Store chat conversations and messages in PostgreSQL before broadcasting.
* Include conversation ID, message ID, sender, building, payload, and timestamp in event envelopes.
* Frontend reconnects with simple exponential backoff.
* On reconnect, frontend re-joins the conversation and sends `last_seen_message_id` or timestamp.
* Backend returns missed messages from PostgreSQL.
* A dropped socket during blue/green deployment should cause a brief reconnect, not message loss.

### File Storage

* S3 private bucket.
* Presigned PUT for uploads and presigned GET for downloads.
* Store only file metadata and S3 keys in PostgreSQL.
* Validate MIME type, size, and upload context before issuing upload URLs.
* File access must verify building, role, and record ownership.

Stored file types include:

* Profile and resident documents.
* Amenity photos and galleries.
* Package photos.
* Move inspection photos.
* Maintenance attachments.
* Report attachments.
* Bank statements.

### Notifications

* In-app notification creation is part of the app's database transaction where appropriate.
* Notification center, badges, and operational alerts use normal API fetches, React Query invalidation, and limited polling for MVP.
* SES/SNS delivery runs best-effort after the primary operation.
* SMS can be paywalled through `sms_notifications`.
* Notification preferences are respected per event type.

### Background Jobs

The Base44 serverless functions need backend replacements:

* Unit seeding/import.
* Old package cleanup.
* Archived update cleanup.
* One-time resident-to-unit migration if importing legacy data.
* Visitor pass expiry.

Jobs can start as admin-triggered scripts or scheduled container/cron tasks. Add a dedicated job queue only when the workload justifies it.

## 7. Frontend Migration Requirements

The frontend currently imports Base44 directly. The backend must provide replacements for:

* `base44.auth.me`, `updateMe`, `logout`, login redirect behavior.
* Entity list/filter/create/update/delete operations.
* `Entity.subscribe(...)` usages replaced initially with API refetch/polling. WebSocket subscriptions are only needed later for live chat.
* `UploadFile`.
* `SendEmail` and `SendSMS` through backend notification services.
* `InvokeLLM` only when AI Concierge is implemented.
* `base44.appLogs.logUserInApp`, either removed or replaced with backend audit/activity logging.

The frontend should migrate from direct entity-style calls to domain API modules, such as:

* `authApi`
* `profileApi`
* `buildingApi`
* `amenitiesApi`
* `packagesApi`
* `maintenanceApi`
* `movesApi`
* `reportsApi`
* `notificationsApi`
* `filesApi`
* `financialsApi`

## 8. Implementation Priorities

1. Confirm canonical frontend/backend folder structure.
2. Implement local FastAPI, PostgreSQL, Alembic, and seed data. Redis can be included in local compose early but is not MVP-critical until live chat.
3. Implement tenant model: buildings, memberships, users, profiles, units, features.
4. Implement auth, RBAC, feature guards, and `GET /buildings/me/features`.
5. Replace Base44 auth in the frontend.
6. Build durable notifications, polling/refetch badge behavior, and S3 upload foundations.
7. Build one thin vertical slice first: resident approval plus packages.
8. Build remaining operational slices: maintenance, moves, reports, notices, amenities, visitor access.
9. Build financials and council oversight after core RBAC/reporting is stable.
10. Set up production AWS infrastructure, CI image builds, blue/green deploy, monitoring, and launch runbooks.

## 9. Key Rules

* Backend feature flags are security controls, not just UI controls.
* Amenities are data-driven per building.
* Gameroom and speakeasy are optional specialized amenities/features, not universal product assumptions.
* Never trust `building_id` from client input.
* Never store file bytes in PostgreSQL.
* Never let failed email/SMS delivery fail the main user action.
* Keep migrations backward compatible for blue/green deployments.
* Keep AI Concierge out of MVP unless explicitly re-prioritized.
