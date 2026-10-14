# P1-02 — Users, memberships and roles schema

| Field | Value |
|---|---|
| Phase / lane | P1 / A |
| Risk tier | 1 |
| Depends on | P1-01 |
| Replaces old | M2-T04, M0-T04 (vocabulary) |
| Status | todo |

## Goal

Global users, per-building memberships with a status, and per-membership roles exist. The database prevents
a role from belonging to a membership in a different building.

## Why

This is the identity model the whole authorization system rests on ([ADR-0004](../adr/0004-path-scoped-tenancy.md)).
Roles live on the membership, never on the user.

## Scope

- In:
  - **`users`** (`app/users/models.py`):
    - `email` String(320), not null
    - `password_hash` String(255), nullable (null until set via invitation or reset)
    - `full_name` String(200), `phone` String(32) nullable
    - `locale` String(10), default `'en'`
    - `is_active` bool, default true
    - `email_verified_at` timestamptz nullable
    - Unique **functional index** on `lower(email)`. A Pydantic `EmailStr` in later schemas normalizes the
      email to lower case on write.
  - **`building_memberships`** (`app/memberships/models.py`):
    - `building_id` FK, `user_id` FK
    - `status` via `database_enum(MembershipStatus)`: `pending`, `active`, `denied`, `suspended`,
      `deactivated`; default `pending`
    - `status_changed_at` timestamptz
    - `status_changed_by_user_id` FK users, nullable
    - `UniqueConstraint(building_id, user_id)`, `UniqueConstraint(building_id, id)`, index `(user_id)`
  - **`membership_roles`:**
    - `building_id`, `membership_id`
    - `role` via `database_enum(Role)`: `resident`, `security`, `property_management`, `council`
    - PK `(membership_id, role)`
    - **composite FK** `(building_id, membership_id) → building_memberships(building_id, id)` ON DELETE CASCADE
  - Enums in `app/memberships/enums.py`, plus `STAFF_ROLES = {security, property_management, council}`.
  - The migration (hand-checked: functional index and composite FK).
- Out:
  - `resident_profiles` (not needed; name and phone live on `users`; per-building profile data is deferred)
  - occupancies (P1-03)
  - sessions (P2-01)
  - any API

## Interfaces

Tables as above. Enums `MembershipStatus`, `Role`; constant `STAFF_ROLES`.

## Acceptance criteria

1. **Given** user `Alice@Example.com`, **when** inserting `alice@example.com`, **then** `IntegrityError`.
2. **Given** a user with a membership in A, **when** a second membership in A is inserted, **then**
   `IntegrityError`. A membership in B succeeds.
3. **Given** membership M in building A, **when** a `membership_roles` row `(building_id=B, membership_id=M)`
   is inserted, **then** `IntegrityError` (composite FK).
4. **Given** M has role `resident`, **when** `resident` is inserted again, **then** `IntegrityError`.
   `council` succeeds (multi-role).
5. **Given** status `'approved'` (not in the enum), **then** the check constraint rejects it.
6. **Given** a membership is deleted, **then** its roles are deleted (cascade). The user remains.
7. `users` has no role or building column (a test inspects the table columns).

## Test plan

- `tests/test_schema_identity.py`, one test per criterion.
- Commands: `make test`; `uv run alembic check`.

## Likely files

`backend/app/users/models.py`, `backend/app/memberships/{models,enums}.py`, `backend/app/models/registry.py`,
`backend/migrations/versions/<new>.py`, `backend/tests/test_schema_identity.py`.

## Must explain (learning checkpoint)

1. Why are roles attached to a building membership instead of to the user?
2. What exactly does the composite FK on `membership_roles` prevent that a plain FK on `membership_id` does not?
3. `lower(email)` unique index vs the `citext` extension: trade-offs?
4. Why is `password_hash` nullable?

## Frame notes (filled by the human in step 1)

- Design prediction:
- Extra cases added:
