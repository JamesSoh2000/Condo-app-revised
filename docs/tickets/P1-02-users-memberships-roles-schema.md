# P1-02 — Users, memberships and roles schema

| Field | Value |
|---|---|
| Phase / lane | P1 / A |
| Risk tier | 1 |
| Depends on | P1-01 |
| Replaces old | M2-T04, M0-T04 (vocabulary) |
| Status | in progress |

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
   *(sharpened)* Both rows are inserted with raw SQL, so the database's unique index on `lower(email)`
   (`uq_users_lower_email`), not Python, is what rejects it; `ALICE@example.COM` vs `alice@EXAMPLE.com` is
   rejected too, and `bob@example.com` succeeds.
2. **Given** a user with a membership in A, **when** a second membership in A is inserted, **then**
   `IntegrityError`. A membership in B succeeds.
3. **Given** membership M in building A, **when** a `membership_roles` row `(building_id=B, membership_id=M)`
   is inserted, **then** `IntegrityError` (composite FK). *(sharpened)* `(building_id=A, membership_id=M)`
   succeeds (positive control), and so does the same check for a row inserted through the model.
4. **Given** M has role `resident`, **when** `resident` is inserted again, **then** `IntegrityError`.
   `council` succeeds (multi-role).
5. **Given** status `'approved'` (not in the enum), **then** the check constraint rejects it.
   *(sharpened)* Inserted with raw SQL (bypassing SQLAlchemy's enum validation); the same holds for a role
   outside `Role` (`'admin'`). The check constraints in the database list exactly the enums' values.
6. **Given** a membership is deleted, **then** its roles are deleted (cascade). The user remains.
7. `users` has no role or building column (a test inspects the table columns).
8. *(added)* Defaults, from the model and from a raw SQL insert: a user gets `locale = 'en'`,
   `is_active = true`, `password_hash` and `email_verified_at` NULL; a membership gets `status = 'pending'`
   and a non-null `status_changed_at`.
9. *(added)* History is kept: deleting a user who has a membership, or a building that has memberships, gives
   `IntegrityError` (RESTRICT) and both rows remain. `status_changed_by_user_id` must name an existing user
   (FK) and may be NULL.
10. *(added, missed case)* Moving a membership that has roles to another building
    (`UPDATE building_memberships SET building_id = B`) gives `IntegrityError`: its roles can't silently stay
    in A.
11. *(added)* Setting `User.email` through the model stores it lower-cased (`Alice@Example.COM` →
    `alice@example.com`), before any SQL runs.
12. *(added)* `alembic upgrade` to this revision, `downgrade` to P1-01's (`891dd631e5a1`), then `upgrade head`
    succeeds with revision ids pinned; after the downgrade none of the three tables exists; `alembic check`
    is clean. The new models modules are registered (the P1-01 registry fitness test covers them).
13. *(added)* `MembershipStatus`, `Role` and `STAFF_ROLES` hold exactly the ticket's lowercase values;
    `STAFF_ROLES` is immutable and excludes `resident`.

## Test plan

- `tests/test_schema_identity.py`, one test per criterion, using the `db` fixture with model and raw SQL
  inserts.
- Commands: `make test`; `uv run alembic check`.

## Likely files

`backend/app/users/models.py`, `backend/app/memberships/{models,enums}.py`, `backend/app/models/registry.py`,
`backend/migrations/versions/<new>.py`, `backend/tests/test_schema_identity.py`.

## Must explain (learning checkpoint)

1. Why are roles attached to a building membership instead of to the user?
2. What exactly does the composite FK on `membership_roles` prevent that a plain FK on `membership_id` does not?
3. `lower(email)` unique index vs the `citext` extension: trade-offs?
4. Why is `password_hash` nullable?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: 1 (raw SQL so the index is tested, more spellings, positive control),
  3 (positive control), 5 (raw SQL; `Role` too; DB check matches the enums); new 8 (defaults), 9 (RESTRICT
  and the `status_changed_by_user_id` FK), 10 (moving a membership with roles), 11 (email lower-cased on
  write), 12 (migration round-trip), 13 (enum values).
- Tenant table (ENGINEERING_PRACTICES §7): no row applies; this ticket has no endpoint. Criterion 3 is the
  storage-level counterpart of row 7.
- Criteria loosened (with reason; also listed in the inbox): none.
- Corrected: the Scope said Pydantic `EmailStr` lower-cases the email on write. It doesn't: email-validator
  lower-cases only the domain, so `Alice@x.com` would be stored as written. The model lower-cases instead
  (criterion 11), and the `lower(email)` index stays the database's backstop.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - `User.email` is lower-cased by a `@validates("email")` on the model, like `Building.timezone` (P1-01).
    Lookups (P2-01 login, P4-02, P4-05) compare `lower(email)` so they use the index. Basis: autonomous;
    reversible. A DB `CHECK (email = lower(email))` was rejected: it contradicts criterion 1's given.
  - The functional index is named `uq_users_lower_email` (the naming convention can't name an expression
    index). Basis: autonomous.
  - `full_name` is NOT NULL: every flow that creates a user (P4-02 invitation accept, P4-05 signup, P4-03
    bootstrap, P1-06 seed) requires a name. Basis: downstream tickets; reversible with an expand migration.
  - `building_memberships.building_id` and `user_id`, and `status_changed_by_user_id`, are
    `ON DELETE RESTRICT`: memberships carry history (occupancies, packages, audit), so a user or building is
    deactivated, not deleted. Basis: matches `units` (P1-01); deletion/retention is a later ticket.
  - `status_changed_at` is NOT NULL with a `now()` default: it answers "in this status since when" from the
    first insert. Basis: autonomous; reversible.
  - `membership_roles.building_id` also has a plain FK to `buildings` (ADR-0005: every tenant-owned table
    has one), besides the composite FK. Basis: ADR-0005.
  - Composite FK `ON UPDATE` is left at the default (NO ACTION), which gives criterion 10. Basis: autonomous.
  - `users`, `building_memberships` and `membership_roles` use `TimestampMixin`; users and memberships also
    the uuid7 PK. `membership_roles` has the ticket's composite PK. Basis: existing pattern
    (`building_features`).
  - `STAFF_ROLES` is a `frozenset`. Basis: autonomous (the ticket's "set", made immutable).
  - The column is `status_changed_by_user_id` (ticket), not ARCHITECTURE §5's `status_changed_by`. Basis:
    ticket.
- Split: none. Estimate ~250 non-test lines (two models modules, enums, registry, migration).
