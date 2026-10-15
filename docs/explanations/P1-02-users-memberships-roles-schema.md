# Explanation — P1-02 Users, memberships and roles schema

> Code at the head of PR #44 (2026-10-15), built autonomously
> ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it. The branch is rebased onto
> the latest `main` (`git merge-base --is-ancestor origin/main HEAD` passes), so the merged tree will equal
> the PR head. The PR's commits stay reachable at `refs/pull/44/head`. Snapshot: if the code changes later,
> write a new explanation; lasting decisions live in ADRs.
> Form: full (Tier 1). Walkthrough variant: C (process: `alembic upgrade`, then writes hitting each
> constraint, and one ORM flush).

**Findings for the implementer (code vs PR):** the code matches the PR's plan and decisions table. Every
claim I checked holds in the code and in the rendered DDL (`alembic upgrade 891dd631e5a1:2b2e5bcaf6b4
--sql`): the `lower(email)` unique index, the hand-named composite FK with `ON DELETE CASCADE` and default
`ON UPDATE`, one named CHECK per enum, RESTRICT on the three user/building FKs, the three `lazy="raise"`
relationships with `cascade="all, delete-orphan", passive_deletes=True` on `roles`. `make test
DB_PORT=55432` gives **115 passed** (37 in this ticket's file), as the PR says. The PR text has these gaps:

1. **Claimed bookkeeping commit is missing.** Round 3, L-C says the email-normalisation follow-ups are
   "Now in the P2-01 ticket (bookkeeping commit)". No such commit exists on the branch (local or
   `origin`; head is `22b04c4`, the round-2 fix), and
   `docs/tickets/P2-01-sessions-login-logout-csrf.md` says nothing about `lower()`, non-ASCII emails,
   collation or length after lowering. Today those follow-ups (L1, L2, L4, L5) live only in the PR body.
2. **Merge-gate bookkeeping not done yet.** Ticket and index still say `in progress`;
   `docs/HUMAN_INBOX.md` has no P1-02 rows although the Frame notes and PR mark six decisions
   "autonomous" (marked in §2). Pending, not a contradiction; it must land before merge.
3. **Ticket Scope not corrected.** The Scope still says "A Pydantic `EmailStr` in later schemas normalizes
   the email to lower case on write". The Frame notes say this is wrong (it lowers only the domain), and
   the code follows the Frame notes, but the Scope text was left as it was.
4. **Stale line count.** The PR header says "Non-test lines changed: 294"; the head has 309 non-test
   backend lines (the review-round relationships, likely). Still under the ~400 limit.

## 1. What was built and why

The identity tables everything in authorization rests on ([ADR-0004](../adr/0004-path-scoped-tenancy.md)):
global `users`, per-building `building_memberships` with a status, and `membership_roles` per membership.
The database itself rejects a role whose `building_id` differs from its membership's building.

## 2. Decisions

| Decision | Alternative rejected | Why | Basis |
|---|---|---|---|
| `User.email` lower-cased by `@validates("email")` on the model; the `lower(email)` unique index is the database backstop | Rely on Pydantic `EmailStr` (the ticket's Scope) | `EmailStr` (email-validator) lower-cases only the domain: `Alice@Example.COM` → `Alice@example.com` | Ticket corrected in framing; **autonomous** |
| Functional unique index, no `CHECK (email = lower(email))` | DB check + plain unique index | The check would contradict criterion 1's given (a stored `Alice@Example.com`). The index gives case-insensitive uniqueness to raw SQL writers too | Ticket |
| Index named `uq_users_lower_email` by hand | Naming-convention name | The convention (`backend/app/models/base.py::NAMING_CONVENTION`) has no column to name an expression index after | **Autonomous** |
| `full_name` NOT NULL | Nullable | Every flow that creates a user (P4-02, P4-05, P4-03, P1-06) asks for a name | Downstream tickets |
| `ON DELETE RESTRICT` on `building_memberships.building_id`, `.user_id`, `.status_changed_by_user_id` | CASCADE / SET NULL | Memberships will carry history (occupancies, packages, audit); users and buildings are deactivated, not deleted | Matches `units` (P1-01) |
| `status_changed_at` NOT NULL, `server_default now()` | NULL until the first change | Always answers "in this status since when" | **Autonomous** |
| `membership_roles.building_id` also has a plain FK to `buildings` | Composite FK only | ADR-0005: every tenant-owned table's `building_id` references `buildings` | [ADR-0005](../adr/0005-tenant-integrity-in-the-database.md) |
| Composite FK `ON UPDATE` left at NO ACTION | `ON UPDATE CASCADE` | Moving a membership that has roles to another building must fail, not drag the roles along (criterion 10) | **Autonomous** |
| Composite FK named `fk_membership_roles_building_id_membership_id` by hand | Convention name | The convention name is 66 characters; Postgres truncates identifiers at 63 | **Autonomous** |
| `TimestampMixin` on all three; uuid7 PK on users/memberships; composite PK `(membership_id, role)` on roles | uuid PK on roles | Matches `building_features` (P1-01); the PK itself enforces "one row per role" | Existing pattern |
| Relationships `BuildingMembership.user`, `.status_changed_by`, `.roles`, all `lazy="raise"`; no back-references on `User` | No relationships (the original plan) | Without them SQLAlchemy's unit of work orders tables by class name, so it inserted `building_memberships` before `users` and deleted a membership before its roles | Review round 1 (M1) |
| `roles` has `cascade="all, delete-orphan"` and `passive_deletes=True` | No delete cascade (the round-1 fix) | With roles loaded, deleting the membership made the ORM try to set `membership_roles.membership_id` (part of the PK) to NULL | Review round 2 (M) |
| `STAFF_ROLES` is a `frozenset` | A mutable `set` | A module constant used by authorization should not be changeable at run time | **Autonomous** |
| Column `status_changed_by_user_id` | ARCHITECTURE §5's `status_changed_by` | The ticket names it; the suffix says what it points at | Ticket |

Interview angles: the composite FK's `UNIQUE (building_id, id)` target; `citext` vs a functional index;
`lazy="raise"` under asyncio; `passive_deletes` with `delete-orphan`.

**Framing changes:** sharpened 1 (raw SQL, more spellings, positive control), 3 (positive control, model
path), 5 (raw SQL, `Role` too, DB check lists exactly the enum values). Added 8 (defaults), 9 (RESTRICT
and the `status_changed_by_user_id` FK), 10 (moving a membership with roles), 11 (lower-casing before SQL),
12 (pinned migration round-trip), 13 (enum values). Corrected the `EmailStr` claim. Loosened: none.

## 3. How it is implemented

### Overview

- `backend/app/users/models.py::User`, with the lower-casing validator and the module-level
  `uq_users_lower_email` index.
- `backend/app/memberships/models.py::BuildingMembership` and
  `backend/app/memberships/models.py::MembershipRole`; enums in `backend/app/memberships/enums.py`.
- `backend/app/models/registry.py` imports both new models modules, so autogenerate and `alembic check`
  see them (P1-01's fitness test fails if one is missing).
- One migration, `2b2e5bcaf6b4` (down: P1-01's `891dd631e5a1`), autogenerated then hand-edited.
- `backend/tests/test_schema_identity.py`: 37 tests against the migrated `condo_test` database.

### Walkthrough (Variant C)

1. **Trigger:** `make migrate` (or the test session's upgrade to `head`) runs
   `backend/migrations/versions/2b2e5bcaf6b4_users_memberships_roles.py::upgrade`. It creates `users` and
   its expression index, then `building_memberships`, then `membership_roles`. The key DDL (offline
   `--sql` render):

   ```sql
   CREATE UNIQUE INDEX uq_users_lower_email ON users (lower(email));
   -- building_memberships ...
       CONSTRAINT uq_building_memberships_building_id_id UNIQUE (building_id, id),
   -- membership_roles ...
       CONSTRAINT ck_membership_roles_role CHECK (role IN ('resident', 'security', 'property_management', 'council')),
       CONSTRAINT fk_membership_roles_building_id_membership_id FOREIGN KEY(building_id, membership_id)
           REFERENCES building_memberships (building_id, id) ON DELETE CASCADE,
   ```

2. **An ORM flush of a new user and their membership.** Captured with `echo=True`, membership added to
   the session *before* the user. The relationships make the unit of work insert `users` first:

   ```sql
   INSERT INTO users (email, password_hash, full_name, phone, locale, is_active, email_verified_at, id) VALUES (...)
   INSERT INTO building_memberships (building_id, user_id, status, status_changed_by_user_id, id) VALUES (...)
       RETURNING building_memberships.status_changed_at, building_memberships.created_at, ...
   ```

   The email was given as `Alice@Example.com`; `_lower_email` changed it to lower case at construction,
   before any SQL.
3. **A write hitting the composite FK:** a raw
   `INSERT INTO membership_roles (building_id, membership_id, role) VALUES (B, M, 'resident')` where M is
   in A fails with `insert or update on table "membership_roles" violates foreign key constraint
   "fk_membership_roles_building_id_membership_id"`: no row `(B, M)` exists in
   `building_memberships(building_id, id)`.
4. **Other failures:** each constraint fails with an `IntegrityError` naming it (`uq_users_lower_email`,
   `pk_membership_roles`, `ck_membership_roles_role`, …), so tests match on the name.
5. **Downgrade / recover:** `downgrade` drops children first (roles, memberships, users), or the FKs block
   the drops. Create-only, so `downgrade 891dd631e5a1` then `upgrade head` is safe on disposable dev data.

### Data model changes

- **`users`:** `email` VARCHAR(320) NOT NULL + `uq_users_lower_email` (prevents two accounts that differ
  only in case: a login-confusion and takeover risk); `password_hash` NULL (no login until one is set);
  `full_name` NOT NULL; `phone` NULL; `locale` default `'en'`; `is_active` default true;
  `email_verified_at` NULL. No role or building column (roles are per building).
- **`building_memberships`:** FKs to `buildings` and `users`, both RESTRICT (history must not vanish);
  `status` VARCHAR + CHECK, default `'pending'` (a typo like `'approved'` can't reach the table);
  `status_changed_at` NOT NULL default `now()`; `status_changed_by_user_id` FK RESTRICT, nullable;
  `UNIQUE (building_id, user_id)` (one membership per person per building); `UNIQUE (building_id, id)`
  (the target composite FKs need: Postgres only lets an FK reference columns with a unique constraint);
  index on `user_id` ("all my buildings" lookups; `building_id` is already the leading column of both
  unique constraints).
- **`membership_roles`:** PK `(membership_id, role)` (no duplicate role, several roles allowed); CHECK on
  `role`; plain FK `building_id → buildings` RESTRICT; composite FK `(building_id, membership_id) →
  building_memberships(building_id, id)` ON DELETE CASCADE (roles die with their membership and can't
  disagree with it about the building).

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/users/models.py` | new: `User`, email validator, `uq_users_lower_email` | +32 |
| `backend/app/memberships/enums.py` | new: `MembershipStatus`, `Role`, `STAFF_ROLES` | +23 |
| `backend/app/memberships/models.py` | new: `BuildingMembership`, `MembershipRole` | +70 |
| `backend/app/models/registry.py` | registers the two models modules (plus two empty `__init__.py`) | +2 |
| `backend/migrations/versions/2b2e5bcaf6b4_users_memberships_roles.py` | new migration | +182 |
| `backend/tests/test_schema_identity.py` | new: 37 tests | +591 |
| `docs/tickets/P1-02-users-memberships-roles-schema.md`, `docs/tickets/README.md` | framing, status | +59 / −7 |

**Key excerpts**

`backend/app/users/models.py::User`

```python
class User(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A person, across buildings. Roles live on their memberships, never here (ADR-0004)."""

    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(320))
    # NULL until the user sets one (invitation accept, password reset); until then, no login.
    password_hash: Mapped[str | None] = mapped_column(String(255))
    # ...
    @validates("email")
    def _lower_email(self, _key: str, value: str) -> str:
        # Pydantic's EmailStr lower-cases only the domain, so the model does the whole address.
        return value.lower()


# Case-insensitive uniqueness, also for rows written without the model. Look users up with
# `func.lower(User.email) == ...` so the query can use this index.
Index("uq_users_lower_email", func.lower(User.email), unique=True)
```

- Two layers: Python stores emails lower-cased; the index rejects case variants from any writer.
  `@validates` runs on ORM attribute sets only; Core `insert()` and raw SQL skip it (review L1).
- Without the `Index(...)` line, `alembic check` reports a missing index (PR mutation M2: 5 tests fail).

`backend/app/memberships/models.py::BuildingMembership` (relationships)

```python
    user: Mapped[User] = relationship(foreign_keys=[user_id], lazy="raise")
    status_changed_by: Mapped[User | None] = relationship(
        foreign_keys=[status_changed_by_user_id], lazy="raise"
    )
    # A role exists only as part of its membership: the ORM deletes loaded roles with it, and one
    # removed from `roles` (delete-orphan). passive_deletes leaves unloaded ones to the database's
    # cascade instead of loading them first.
    roles: Mapped[list[MembershipRole]] = relationship(
        cascade="all, delete-orphan", passive_deletes=True, lazy="raise"
    )
```

- These exist for flush ordering and cascades, not for navigation. A relationship tells the unit of work
  that `users` must be inserted before `building_memberships`, and roles deleted before their membership.
- `foreign_keys=[...]` is required: two FKs point at `users`, so SQLAlchemy can't guess which is which.
- `lazy="raise"`: touching `m.roles` without `selectinload` raises at once, not a later async error.
- Remove `delete-orphan`/`all` and the round-2 bug returns: the ORM tries to NULL a PK column
  (`test_orm_delete_of_a_membership_with_loaded_roles_deletes_them` fails).
- `Mapped[list[MembershipRole]]` names a later class unquoted: fine, Python 3.14 evaluates annotations lazily.

`backend/app/memberships/models.py::MembershipRole`

```python
class MembershipRole(TimestampMixin, Base):
    __tablename__ = "membership_roles"
    __table_args__ = (
        # Composite, so a role can't name a membership in another building (ADR-0005). ON UPDATE
        # stays NO ACTION: a membership with roles can't be moved to another building either.
        ForeignKeyConstraint(
            ["building_id", "membership_id"],
            ["building_memberships.building_id", "building_memberships.id"],
            ondelete="CASCADE",
            name="fk_membership_roles_building_id_membership_id",
        ),
    )

    building_id: Mapped[UUID] = mapped_column(ForeignKey("buildings.id", ondelete="RESTRICT"))
    membership_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True)
    role: Mapped[Role] = mapped_column(database_enum(Role, name="role"), primary_key=True)
```

- The ticket's central guarantee. A plain FK on `membership_id` would accept `(B, M)` for M in A (PR
  mutation M1: 5 tests fail). `roles` joins on both columns, so a role appended to `membership.roles` gets
  its `building_id` filled in (`test_role_appended_to_a_membership_takes_the_memberships_building`).

`backend/migrations/versions/2b2e5bcaf6b4_users_memberships_roles.py::upgrade` (hand-edited parts)

```python
    # Checked by hand: a unique index on the expression lower(email), so emails differing only in
    # case can't both exist, whoever writes them.
    op.create_index("uq_users_lower_email", "users", [sa.text("lower(email)")], unique=True)
    # ...
        # Hand-edited: autogenerate rendered this check twice (once named just "role"). The
        # column's Enum has create_constraint=False so it doesn't add another.
        sa.CheckConstraint(
            "role IN ('resident', 'security', 'property_management', 'council')",
            name=op.f("ck_membership_roles_role"),
        ),
```

- Same fix as P1-01: `backend/app/models/types.py::database_enum` asks for a CHECK, which autogenerate
  rendered twice; the migration keeps one, named by the convention.

`backend/tests/test_schema_identity.py::test_role_pointing_at_a_membership_in_another_building_is_rejected`

```python
async def test_role_pointing_at_a_membership_in_another_building_is_rejected(db: AsyncSession):
    a = await _building(db, "a")
    b = await _building(db, "b")
    m = await _membership(db, a, await _user(db, "alice@example.com"))

    with pytest.raises(IntegrityError, match="fk_membership_roles_building_id_membership_id"):
        await db.execute(INSERT_ROLE, {"b": b.id, "m": m.id, "role": "resident"})
```

- Raw SQL, so only the database can reject it; matching the constraint name stops a different error
  passing it. Positive control: `test_role_in_the_memberships_own_building_is_accepted`.

## 5. Edge cases and tests

All tests are in `backend/tests/test_schema_identity.py`.

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Case-variant email inserted by raw SQL | Index rejects it | `test_email_differing_only_in_case_is_rejected_by_the_database` (2 params) |
| Case-variant email through the model | Lower-cased, then the index rejects it | `test_model_insert_of_a_case_variant_is_rejected`, `test_stored_email_is_lower_case` |
| Role naming a membership in another building | Composite FK rejects it (raw and model) | `test_role_pointing_at_a_membership_in_another_building_is_rejected`, `test_model_role_pointing_at_a_membership_in_another_building_is_rejected` |
| Membership with roles moved to another building | NO ACTION on update rejects it | `test_moving_a_membership_with_roles_to_another_building_is_rejected` (+ control without roles) |
| Enum gains a value with no migration | CHECK text compared with the enum | `test_check_in_the_database_lists_exactly_the_enum_values` |
| User and membership flushed together, membership added first | Users inserted first | `test_new_user_and_their_membership_can_be_flushed_together` |
| ORM delete of a membership, roles loaded / not loaded / deleted explicitly | Loaded: ORM deletes them; unloaded: DB cascade; explicit: no warning | `test_orm_delete_of_a_membership_with_loaded_roles_deletes_them`, `test_orm_delete_of_a_membership_leaves_unloaded_roles_to_the_cascade`, `test_membership_and_its_roles_can_be_deleted_together` |
| Role removed from a loaded `roles` list | Row deleted (delete-orphan) | `test_removing_a_role_from_a_loaded_membership_deletes_the_row` |
| Mixed-case email via Core `insert()` | Stored as written; uniqueness still holds | **No test** (review L1, accepted) |
| `İnci@x.com` and `inci@x.com` via the model | Python and Postgres `lower()` disagree (`'İ'.lower()` is 2 characters); both can be stored | **No test** (review L2/L5, deferred to P2-01) |
| 320-character email that grows when lowered | `DataError` from VARCHAR(320) | **No test** (review L4) |
| `passive_deletes=True` removed, or `user` relationship removed alone | Behaviour would change silently | **No test** (review L-B) |
| Empty `full_name` / `email` (`''`) | Accepted by the database | **No test**; left to later Pydantic schemas |

Acceptance criteria → tests:

1. `test_email_differing_only_in_case_is_rejected_by_the_database`, `test_a_different_email_is_accepted`
2. `test_second_membership_in_the_same_building_is_rejected`, `test_membership_in_another_building_is_allowed`
3. the two cross-building tests in the table + `test_role_in_the_memberships_own_building_is_accepted`
4. `test_duplicate_role_on_a_membership_is_rejected`, `test_membership_may_hold_several_roles`
5. `test_status_outside_the_enum_is_rejected_by_the_database`, `test_role_outside_the_enum_is_rejected_by_the_database`, `test_check_in_the_database_lists_exactly_the_enum_values`
6. `test_deleting_a_membership_deletes_its_roles_and_keeps_the_user`
7. `test_users_table_has_no_role_or_building_column`
8. `test_user_and_membership_defaults`, `test_raw_inserts_get_server_defaults`
9. `test_deleting_a_user_with_a_membership_is_restricted`, `test_deleting_a_building_with_memberships_is_restricted`, `test_status_changed_by_must_name_an_existing_user`, `test_deleting_the_user_who_changed_a_status_is_restricted`
10. `test_moving_a_membership_with_roles_to_another_building_is_rejected`
11. `test_user_email_is_lower_cased_before_any_sql`, `test_stored_email_is_lower_case`
12. `test_migration_upgrades_downgrades_and_upgrades_again` (pinned revisions, ends with `alembic check`)
13. `test_membership_status_values_are_the_lowercase_ticket_list`, `test_role_values_are_the_lowercase_ticket_list`, `test_staff_roles_are_every_role_but_resident_and_immutable`

## 6. Review log

| Round | Reviewer | Verdict | Findings (severity: one line) | Outcome |
|---|---|---|---|---|
| 1 | Codex `gpt-6-astra` (high) | MERGE | none | — |
| 1 | Fresh Claude + security pass | MERGE | M1: no relationships, so flushes ordered by class name (FK violation, `SAWarning`) | Fixed in `3a2229f`, test-first |
| 1 | same | | L1: Core writes skip lower-casing; L2: `İ` lowers differently in Python and Postgres; L3: no index on `membership_roles.building_id` / `status_changed_by_user_id` | Follow-ups |
| 2 | Codex + fresh Claude | MERGE | M (both): `roles` had no delete cascade, so with roles loaded the ORM tried to NULL a PK column | Fixed in `22b04c4` (`delete-orphan`), test-first |
| 2 | fresh Claude | | L4: lowering can lengthen past 320; L5: index meaning depends on the DB collation | Follow-ups |
| 3 | Codex + fresh Claude | MERGE | L-A: no `building` relationship (ORM deleting building + membership in one flush fails); L-B: `passive_deletes` and `user` alone unpinned; L-C: follow-ups only in the PR | Follow-ups; L-C claimed done, **but not** (finding 1) |

## 7. Not verified

- **Non-ASCII emails.** The `İ` case (L2) and the collation dependence (L5) are known and untested. With
  libc `en_US.utf8`, two accounts can differ only in a dotless/dotted i: a known account-takeover pattern
  once password reset sends mail. Not reachable until an API writes users (P2-01, P4-02, P4-05).
- **That P2-01 will act on this.** The P2-01 ticket does not mention it (finding 1).
- **Lookups using the index.** Nothing queries `users` by email yet. `User.email == x` instead of
  `func.lower(User.email) == x.lower()` misses Core/raw-SQL rows and the index; nothing enforces this.
- **Status bookkeeping.** No trigger updates `status_changed_at` or `status_changed_by_user_id` when
  `status` changes; future services must set both. Nothing stops roles on `pending`/`denied` memberships:
  P2-03's authorization must check `status = 'active'` and `users.is_active`.
- **Missing indexes** (L3) and **ORM building deletes** (L-A): unmeasured / untested; nothing deletes
  buildings or users by design.
- The migration ran only on fresh databases; none holding data exists yet.

## 8. How to change this safely

- **New role or status:** add it to `backend/app/memberships/enums.py`, then write a migration that
  replaces `ck_membership_roles_role` / `ck_building_memberships_status` (drop + add). `alembic check` will
  *not* notice; `test_check_in_the_database_lists_exactly_the_enum_values` and the two
  `..._lowercase_ticket_list` tests will. Decide whether it joins `STAFF_ROLES`. Check `VARCHAR` width:
  the column is as wide as the longest value.
- **New tenant table referencing a membership** (occupancies, P1-03): give it `building_id` with a plain FK
  to `buildings` and a composite FK `(building_id, membership_id) → building_memberships(building_id, id)`,
  hand-named if the convention passes 63 characters. Copy the cross-building and positive-control tests.
- **Email lookups:** always `func.lower(User.email) == value.lower()`. If you change normalisation
  (NFKC, ASCII-only), change `backend/app/users/models.py::_lower_email` and the lookup together.
- **New relationship:** keep `lazy="raise"`; the ORM-flush tests at the end of the test file catch
  ordering and cascade regressions. Never edit `2b2e5bcaf6b4` after merge; add a new revision.

## 9. Must explain, then quiz

**1. Why are roles on the membership, not the user?** A person can be a resident in building A and
security in building B. Authorization is per building: every request is under
`/api/buildings/{building_id}/…` (ADR-0004), so the question is always "what may this user do *here*?".
A role on `users` would apply in every building the user joins, and suspending a membership
(`building_memberships.status`) would not remove it. Here, `backend/app/memberships/models.py::MembershipRole`
hangs off one membership, so both the roles and the status are per building.

**2. What does the composite FK prevent that a plain FK on `membership_id` does not?** A plain FK only
checks that membership M exists *somewhere*. The row `(building_id=B, membership_id=M)` with M in A would
pass, and a later query `WHERE building_id = :B` would find a role in B the user never had. The composite FK
`fk_membership_roles_building_id_membership_id` requires the *pair* to exist in
`building_memberships(building_id, id)`, so the role's building always equals its membership's building.
With `ON UPDATE NO ACTION` it also blocks moving a membership with roles to another building. It needs
`UNIQUE (building_id, id)` on the parent as its target.

**3. `lower(email)` unique index vs `citext`?** `citext` is a Postgres extension type whose `=` ignores
case: every comparison and plain index is case-insensitive automatically, so `WHERE email = :x` just works.
Costs: `CREATE EXTENSION` (needs privileges; another thing to manage on RDS later), a non-standard type
for SQLAlchemy and asyncpg, and it still calls `lower()` internally, so the non-ASCII/collation issues
(L2, L5) remain. The functional index needs nothing extra but only helps queries that write
`lower(email)`; a plain `email = :x` silently misses case variants and skips the index. Since the model
also stores emails lower-cased, the gap is mostly for rows written by Core or raw SQL.

**4. Why is `password_hash` nullable?** A user row exists before the person has a password: invitation
(P4-02) creates the user, and the password comes when they accept; the bootstrap admin (P4-03) and reset
flows are similar. NULL means "cannot log in yet", which is better than a fake hash someone might match.
P2-01 must treat NULL as invalid credentials (its criterion lists "null password" among the 401 cases),
using the same dummy-hash timing as an unknown email.

**Quiz**

1. A service runs `await db.execute(insert(User).values(email="Bob@X.com", full_name="Bob"))`. What is
   stored, and does a later model insert of `bob@x.com` succeed?
2. Why does `UNIQUE (building_id, id)` exist on `building_memberships` when `id` is already the primary key?
3. A developer writes `m = await db.get(BuildingMembership, id)` then `for r in m.roles: ...`. What
   happens, and why was that chosen?
4. What would break if you removed `cascade="all, delete-orphan"` from `BuildingMembership.roles`
   (keeping `passive_deletes=True`)?
5. How would you extend this schema so a council member's role is valid only for a term (start and end
   date)?

<details><summary>Answers</summary>

1. `Bob@X.com`, as written: Core `insert()` doesn't go through `@validates`. The later `bob@x.com`
   insert fails on `uq_users_lower_email`, because the index compares `lower(email)`. Uniqueness holds;
   only the stored spelling differs (review L1).
2. A foreign key can only reference columns covered by a unique constraint or PK. The composite FK from
   `membership_roles` (and later occupancies) references the pair `(building_id, id)`, so the pair needs
   its own unique constraint, even though `id` alone is already unique.
3. It raises immediately (`lazy="raise"`). Under asyncio an implicit lazy load can't run anyway; it would
   fail later with a confusing greenlet error. You must load roles explicitly, e.g.
   `selectinload(BuildingMembership.roles)`.
4. With roles loaded, deleting the membership, or removing a role from `roles`, makes the ORM try to set
   `membership_roles.membership_id` to NULL, but that column is part of the PK, so you get an
   `AssertionError` at flush. `test_orm_delete_of_a_membership_with_loaded_roles_deletes_them` and
   `test_removing_a_role_from_a_loaded_membership_deletes_the_row` fail. Unloaded roles would still go
   by the database cascade.
5. Add nullable `valid_from` / `valid_until` columns to `membership_roles` (expand migration), with a CHECK
   `valid_until IS NULL OR valid_until > valid_from`. The PK `(membership_id, role)` permits only one row
   per role, so for term *history* you'd need a separate history table or a surrogate PK with an exclusion
   constraint against overlapping terms. Authorization (P2-03) must then filter on the current date, in
   one shared helper. Keep the composite FK. Add tests: overlapping terms rejected, expired role ignored.

</details>
