# Explanation — P1-02 Users, memberships and roles schema

> **PR:** #44 · **Source revision:** `22b04c4`, the pre-merge PR head of the code. **Reviewed:** the final
> review round (3) reviewed this commit; nothing after it touched `backend/`. **Merge commit:** `684514c`
> (squash). The PR's commits stay reachable at `refs/pull/44/head`.
> **This revision was expanded after the merge**, at James's request, under the explanation rules of PR #46
> (`bed1b8b`). It describes the same code as the first version (`1bbaf19`): `git diff 22b04c4 684514c --
> backend/` and `git log 684514c..origin/main -- backend/` are both empty (checked 2026-10-15).
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. Lasting decisions live in ADRs and [HUMAN_INBOX](../HUMAN_INBOX.md).
> Form: full. Tier: 1. Walkthrough variant: C (process: `alembic upgrade`, then ORM flushes and writes that
> hit each constraint).

**What I ran for this revision** (2026-10-15, worktree at `origin/main` = `bed1b8b`, compose db on 55432):
`make test DB_PORT=55432` → **115 passed** (37 in `backend/tests/test_schema_identity.py`);
`alembic upgrade 891dd631e5a1:2b2e5bcaf6b4 --sql` (DDL in §3); an `echo=True` script of three ORM flushes
(§3); the two pre-fix model files from `378d4c4` and `3a2229f` against today's tests, and three one-line
mutations of the final `BuildingMembership.roles`/`.user` (§6). Every mutation was reverted. Anything else
called "ran" below is quoted from the PR.

**The first version's findings are closed.** It reported four gaps in the PR text; the bookkeeping commit
`7a80889` closed all of them: the email follow-ups are now in the P2-01 ticket ("Carried from P1-02"), the
inbox has three P1-02 decision rows, the ticket's Scope no longer claims `EmailStr` lower-cases the address,
and the PR header says 309 non-test lines (which I confirmed: 23 + 70 + 2 + 32 + 182).

## 1. What was built and why

The identity tables the whole authorization model rests on ([ADR-0004](../adr/0004-path-scoped-tenancy.md)):
global `users`, per-building `building_memberships` with a status, and `membership_roles` per membership.
Schema only: no API, no service. Two decisions carry the ticket. First, the database itself rejects a role
whose `building_id` differs from its membership's building (a composite foreign key, ADR-0005). Second,
email uniqueness is case-insensitive: the model stores emails lower-cased and a unique index on
`lower(email)` backs it up for every writer. Review then added ORM relationships so SQLAlchemy writes these
tables in foreign-key order (round 1) and deletes loaded roles with their membership (round 2).

## 2. Decisions

Terms used below. A **foreign key (FK)** makes the database reject a row whose referenced row doesn't exist.
`ON DELETE`/`ON UPDATE` say what happens to referencing rows when the referenced row is deleted or its key
changes: `RESTRICT`/`NO ACTION` reject the change, `CASCADE` follows it. The **unit of work** is the part of
SQLAlchemy that turns the objects you added, changed or deleted in a session into `INSERT`/`UPDATE`/
`DELETE` statements at **flush** time, and decides their order.

### D1. Emails: lower-cased by the model, unique on `lower(email)` in the database

- **Problem or constraint:** two accounts whose emails differ only in case (`Alice@x.com`, `alice@x.com`)
  mean two logins for one mailbox: confusing, and a takeover vector once password reset sends mail. The
  ticket's Scope prescribed a unique functional index on `lower(email)` and said a Pydantic `EmailStr` would
  lower-case emails on write.
- **Chosen:** two layers. `backend/app/users/models.py::_lower_email` (`@validates("email")`) lower-cases
  the whole address with Python's `str.lower()` whenever the attribute is set through the model, before any
  SQL. The index `uq_users_lower_email` on `lower(email)` (`backend/app/users/models.py::Index`) rejects a
  case variant whoever writes it: the model, Core `insert()`, raw SQL, a `psql` session.
- **Alternatives rejected:**
  - *Rely on Pydantic `EmailStr` (the ticket's Scope):* email-validator lower-cases only the domain, so
    `Alice@Example.COM` becomes `Alice@example.com`. The agent checked this with `uv run --with
    email-validator` (PR decisions table). Recorded.
  - *`CHECK (email = lower(email))` with a plain unique index:* contradicts criterion 1's given, which stores
    `Alice@Example.com` with raw SQL and expects the *second* insert to fail on uniqueness. Recorded (Frame
    notes, PR decisions table).
  - *The `citext` extension type:* not weighed in any record. ARCHITECTURE §5 and the ticket prescribe the
    `lower(email)` index, and the ticket asks for the tradeoff only as a Must-explain question (answered in
    §9, as my own analysis). Rationale not recorded.
- **Tradeoffs and accepted limitations:**
  - `@validates` runs only on ORM attribute sets. Core `insert()`/`update()` and raw SQL store the spelling
    as given (review L1). Uniqueness still holds (the index compares `lower(email)`); only the stored
    spelling differs.
  - The index serves only queries written as `lower(email) = …`. A plain `User.email == x` misses rows
    stored with capitals and can't use the index. Nothing enforces the lookup form; it is a rule in a code
    comment, the inbox and the P2-01 ticket.
  - Python and Postgres lower-case some characters differently (review L2, L5). I checked on the compose db
    (collation `en_US.utf8`, provider libc): `'İnci@x.com'.lower()` is `'i̇nci@x.com'` in Python (11
    characters: `i` plus a combining dot) and `inci@x.com` in Postgres (10). So the model stores
    `i̇nci@x.com`, whose `lower()` is not `inci@x.com`, and a second account `inci@x.com` passes the index.
    The same growth can push a 320-character address past `VARCHAR(320)` (review L4, a `DataError`).
    Accepted as unreachable until an API writes users; deferred to P2-01 (§7).
- **Basis:** ticket (the index), corrected in framing (who lower-cases); the model validator follows
  `backend/app/buildings/models.py::_validate_timezone` (P1-01). The model-side choice is **autonomous**.
- **Source:** recorded: Frame notes ("Corrected", first decision), PR decisions rows 1–2, review round 1
  L1/L2 and round 2 L4/L5, inbox row "`User.email` is lower-cased by the model".

### D2. A composite FK ties each role to its membership *and* that membership's building

- **Problem or constraint:** `membership_roles` carries `building_id` so authorization can ask "which roles
  does this user have in building B?" by filtering on `building_id`. With a plain FK on `membership_id`,
  the row `(building_id=B, membership_id=M)` for a membership M in building A is accepted, and the user
  silently holds a role in B. ADR-0005 makes such cross-building references impossible at the storage
  layer rather than trusting every service to check.
- **Chosen:** `FOREIGN KEY (building_id, membership_id) REFERENCES building_memberships (building_id, id)`,
  named `fk_membership_roles_building_id_membership_id`
  (`backend/app/memberships/models.py::ForeignKeyConstraint`). Its target is
  `UNIQUE (building_id, id)` on `building_memberships`: Postgres lets an FK reference only columns covered by
  a primary key or unique constraint, and `id` alone (the PK) is not the pair. `membership_roles.building_id`
  also keeps its own plain FK to `buildings` (`ON DELETE RESTRICT`).
- **Alternatives rejected:**
  - *Plain FK on `membership_id` only:* accepts the cross-building row above. The PR's mutation M1 (composite
    → plain) made 5 tests fail. Recorded (ADR-0005, PR mutations).
  - *Composite FK only, no FK from `membership_roles.building_id` to `buildings`:* ADR-0005 says every
    tenant-owned table has `building_id` with an FK to `buildings`. Recorded (PR decisions table). Inferred:
    the composite FK already implies the building exists (the membership's own FK guarantees it), so the
    plain FK adds no protection today; it keeps the rule uniform for fitness checks and readers.
  - *The naming convention's name:* `fk_membership_roles_building_id_membership_id_building_memberships` is
    66 characters; Postgres truncates identifiers to 63, so the name in the database would not match the
    model and tests matching the constraint name would be fragile. Hand-named. Recorded (**autonomous**).
- **Tradeoffs and accepted limitations:** one extra unique index on `building_memberships`, which ADR-0005
  calls negligible. Writes through the model must give `building_id`; the `roles` relationship fills it in
  when a role is appended to a loaded membership
  (`backend/tests/test_schema_identity.py::test_role_appended_to_a_membership_takes_the_memberships_building`).
- **Basis:** ADR-0005; ticket Scope.
- **Source:** recorded (ADR-0005, ticket Scope, PR decisions rows 7 and 9, PR mutation M1).

### D3. The composite FK keeps `ON UPDATE NO ACTION`

- **Problem or constraint:** framing found a case the ticket missed (criterion 10). If a membership that has
  roles is moved to another building (`UPDATE building_memberships SET building_id = B`), what happens to its
  roles, whose `building_id` is still A?
- **Chosen:** leave `ON UPDATE` at the default, `NO ACTION`: the update is rejected while any role points at
  the old `(A, M)` pair. A membership without roles can be moved (control test).
- **Alternatives rejected:** *`ON UPDATE CASCADE`:* the roles would follow silently. The decision says a move
  "should fail, not silently move the roles". Inferred: a role granted in building A is a decision about A;
  carrying it to B unasked would grant B access nobody approved there.
- **Tradeoffs and accepted limitations:** a real "transfer to another building" feature must delete or
  re-grant the roles first, explicitly. I also checked the ORM path (not covered by a test): loading a
  membership, with or without `selectinload(roles)`, setting `building_id = B` and flushing raises
  `ForeignKeyViolationError … "fk_membership_roles_building_id_membership_id"`. The ORM defaults to
  `passive_updates=True`, so it leaves key changes to the database, which refuses.
- **Basis:** **autonomous** (criterion 10 added in framing).
- **Source:** recorded (Frame notes, PR decisions row 8); the ORM behaviour is from my run.

### D4. Delete rules: history is RESTRICTed, roles CASCADE with their membership

- **Problem or constraint:** what should deleting a user, a building, or a membership do to the rows that
  point at it?
- **Chosen:**

  | FK | ON DELETE | Effect |
  |---|---|---|
  | `building_memberships.building_id → buildings` | RESTRICT | a building with memberships can't be deleted |
  | `building_memberships.user_id → users` | RESTRICT | a user with a membership can't be deleted |
  | `building_memberships.status_changed_by_user_id → users` | RESTRICT | nor can a user who changed someone's status |
  | `membership_roles (building_id, membership_id) → building_memberships` | CASCADE | roles go with their membership |
  | `membership_roles.building_id → buildings` | RESTRICT | unreachable in practice: memberships already block it |

- **Alternatives rejected:** *CASCADE or SET NULL for the three membership FKs:* memberships will carry
  history (occupancies, packages, audit), so users and buildings are deactivated (`is_active`), not deleted.
  "Retention/erasure is a later ticket." Recorded. For roles, CASCADE is the ticket's Scope and criterion 6:
  a role has no meaning without its membership.
- **Tradeoffs and accepted limitations:** deleting a user (an erasure request, a test fixture) needs an
  explicit plan later; the database will refuse until memberships are dealt with. `SET NULL` on
  `status_changed_by_user_id` would have let a user be deleted while losing "who changed this", which the
  RESTRICT keeps. No index on `status_changed_by_user_id` or `membership_roles.building_id`, so each
  user/building delete scans those tables to check the RESTRICT (review L3; deletes are rare by design).
- **Basis:** matches `units` (`backend/app/units/models.py::RESTRICT`, P1-01). P1-01's `building_features`
  uses CASCADE instead ("settings, not records"). The ticket Scope sets the roles CASCADE.
- **Source:** recorded (Frame notes, PR decisions row 5, inbox row "Memberships → users and buildings").
  Inferred: RESTRICT on `membership_roles.building_id` (rather than CASCADE) follows the same "history"
  rule; no record discusses that FK's delete rule separately.

### D5. ORM relationships exist to order flushes; all are `lazy="raise"` (review round 1)

- **Problem or constraint:** the plan declared no relationships ("the DB cascade works without them",
  mistakes log). Without a relationship between two mappers, SQLAlchemy's unit of work has no dependency to
  follow and falls back to a sort key of `module.ClassName`. `app.memberships.models.BuildingMembership`
  sorts before `app.users.models.User`, so a flush inserts the membership before the user it names, and
  deletes a membership before its roles. Failure detail in §6.
- **Chosen:** in `backend/app/memberships/models.py::BuildingMembership`, many-to-one `user` and
  `status_changed_by` (each with `foreign_keys=[…]`, because two FKs point at `users` and SQLAlchemy can't
  guess which is which) and one-to-many `roles`. All three `lazy="raise"`. No back-references on `User`.
- **Alternatives rejected:** *no relationships (the original plan):* failed as above. Recorded (review round
  1, M1). *Default lazy loading (`lazy="select"`):* under asyncio an implicit lazy load can't run (it
  needs to do I/O inside attribute access) and fails with a greenlet error far from the cause;
  `lazy="raise"` fails at once, at the line that touched the attribute. Recorded (PR decisions row 11, code
  comment).
- **Tradeoffs and accepted limitations:** every reader must load relationships explicitly
  (`selectinload(BuildingMembership.roles)`), which also makes N+1 queries impossible by accident. The
  relationships are not navigation API; there is no `User.memberships`. Rationale for leaving out
  back-references: not recorded. Inferred: it keeps `backend/app/users/models.py` free of imports from
  `app.memberships` (the dependency runs one way). Only `user` *or* `status_changed_by` is needed to order
  `User` first; removing `user` alone fails no test (review round 3, L-B; I confirmed: 37 passed). And
  there is no relationship to `Building`, so deleting a building and its memberships in one ORM flush still
  deletes the building first and hits the RESTRICT (review round 3, L-A; buildings aren't deleted by design;
  `Unit` has the same gap).
- **Basis:** review finding (round 1, M1); `lazy="raise"` **autonomous**.
- **Source:** recorded (PR "Deviation" note and decisions row 11, review round 1 M1, inbox row "ORM
  relationships are `lazy="raise"`", mistakes log row "Declared no ORM relationships").

### D6. `roles` is `cascade="all, delete-orphan", passive_deletes=True` (review round 2)

- **Problem or constraint:** the round-1 `roles` relationship had only `passive_deletes=True`. A one-to-many
  relationship's default behaviour, when the parent is deleted or a child is removed from the collection,
  is to *dissociate* the loaded children by setting their FK to NULL. Here that FK, `membership_id`, is part
  of `membership_roles`' primary key, so SQLAlchemy refuses (an `AssertionError`) and the flush crashes.
  This happened only when roles were loaded, which round 1's tests never did. Failure detail in §6.
- **Chosen:** `cascade="all, delete-orphan"`: deleting a membership deletes its loaded roles through the ORM,
  and a role removed from `membership.roles` is deleted (an "orphan"). `passive_deletes=True` stays: when
  roles are *not* loaded, the ORM doesn't `SELECT` them first and leaves them to the database's
  `ON DELETE CASCADE`. The SQL for both cases is in §3.
- **Alternatives rejected:** *the round-1 relationship without a delete cascade:* crashes as above.
  Recorded (review round 2, both reviewers). No other alternative is recorded.
- **Tradeoffs and accepted limitations:** a role can't be moved between memberships by reassigning it in
  Python (it would be deleted as an orphan); that matches the data model, where a role exists only inside
  its membership. `passive_deletes=True` is not pinned by a test: I removed it and all 37 tests still pass
  (review round 3, L-B). Without it, deleting a membership with unloaded roles would first load them and then
  delete them one by one: same result, more queries. The mistakes log proposes a fitness test ("every
  one-to-many relationship whose child FK is part of the child's PK has `delete-orphan`") for the next
  ticket.
- **Basis:** review finding (round 2, Medium, Codex and Claude).
- **Source:** recorded (PR review round 2, inbox row "ORM relationships…", mistakes log row "The round-1
  fix"). The PR's decisions table still describes the round-1 form (`passive_deletes=True` only); the review
  section and the inbox have the final one.

### D7. `full_name` and `status_changed_at` are NOT NULL

- **Problem or constraint:** the ticket's Scope gave types but not nullability for `full_name` and
  `status_changed_at`.
- **Chosen:** `full_name VARCHAR(200) NOT NULL`; `status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now()`.
  The model gives `status_changed_at` no Python default, so an ORM insert omits the column and reads the
  server's value back with `RETURNING` (§3 shows it).
- **Alternatives rejected:**
  - *Nullable `full_name`:* every flow that creates a user asks for a name (P4-02 invitation accept, P4-05
    signup, P4-03 bootstrap, P1-06 seed). Recorded; "reversible with an expand migration".
  - *`status_changed_at` NULL until the first change:* the column would not answer "in this status since
    when?" for a membership that never changed. Recorded (**autonomous**, reversible).
- **Tradeoffs and accepted limitations:** NOT NULL does not mean non-empty: the database accepts
  `full_name = ''` (and `email = ''`); later Pydantic schemas must reject empty or padded values (PR
  follow-ups). Nothing keeps `status_changed_at` honest after insert: there is no trigger, so every service
  that changes `status` must set `status_changed_at` and `status_changed_by_user_id` itself. Why a service
  rule rather than a trigger: not recorded. Inferred: CLAUDE.md puts state changes in service code
  (conditional `UPDATE … RETURNING`), where the acting user is known; a trigger couldn't know the actor.
- **Basis:** downstream tickets (`full_name`); **autonomous** (`status_changed_at`).
- **Source:** recorded (Frame notes, PR decisions rows 4 and 6, inbox row "Memberships → users and
  buildings").

### Smaller decisions

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Roles on the membership, never on `users` | Role column on `users` | Roles are per building (§9 Q1); `test_users_table_has_no_role_or_building_column` pins it | ADR-0004, ticket | recorded |
| `password_hash` nullable | NOT NULL, or a placeholder hash | No login until set through invitation or reset (§9 Q4) | ticket | recorded |
| Status and role as `VARCHAR` + one named CHECK (`database_enum`, `native_enum=False`) | Postgres `ENUM` types | Same as P1-01: adding a value is a CHECK swap, not `ALTER TYPE`. Autogenerate rendered each CHECK twice; one was removed by hand | existing pattern (`backend/app/models/types.py::database_enum`) | recorded (PR "Migration") |
| CHECK names `ck_building_memberships_status`, `ck_membership_roles_role` | `membership_status` | Shorter; matches `ck_building_features_feature` | existing pattern | recorded |
| Index named `uq_users_lower_email` by hand | Convention name | `backend/app/models/base.py::NAMING_CONVENTION` has no column to name an expression index after; `uq_` because it enforces uniqueness | **autonomous** | recorded |
| `TimestampMixin` on all three; uuid7 PK on users and memberships; PK `(membership_id, role)` on roles | Surrogate id on roles | The PK itself enforces "one row per role"; matches `building_features` | existing pattern | recorded |
| Index on `building_memberships.user_id` only | Also on `building_id` | `building_id` already leads both unique constraints | ticket | recorded (ticket); the "already leads" reason is inferred |
| `STAFF_ROLES` is a `frozenset` | A mutable `set` (the ticket's word) | A module constant used by authorization should not change at run time | **autonomous** | recorded |
| Column `status_changed_by_user_id` | ARCHITECTURE §5's `status_changed_by` | The ticket names it; `_user_id` says what it points at | ticket | recorded |

Interview angles: why the composite FK needs `UNIQUE (building_id, id)` on the parent; `citext` vs a
functional index; how the unit of work decides statement order; why `lazy="raise"` under asyncio; why a PK
column in a child FK forces `delete-orphan`; what `ON UPDATE NO ACTION` buys; the non-ASCII `lower()` gap.

**Framing changes:** sharpened 1 (raw SQL so the index alone is tested, more spellings, positive control),
3 (positive control, model path), 5 (raw SQL, `Role` too, DB checks list exactly the enum values). Added 8
(defaults), 9 (RESTRICT and the `status_changed_by_user_id` FK), 10 (moving a membership with roles), 11
(lower-casing before SQL), 12 (pinned migration round-trip), 13 (enum values). Corrected the Scope's
`EmailStr` claim. Loosened: none.

## 3. How it is implemented

### Overview

- `backend/app/users/models.py::User`, with the lower-casing validator and the module-level
  `uq_users_lower_email` index.
- `backend/app/memberships/models.py::BuildingMembership` (with the three relationships) and
  `backend/app/memberships/models.py::MembershipRole`; enums in `backend/app/memberships/enums.py`.
- `backend/app/models/registry.py` imports both new models modules, so autogenerate and `alembic check`
  see them (P1-01's registry fitness test fails if one is missing).
- One migration, `2b2e5bcaf6b4` (down: P1-01's `891dd631e5a1`), autogenerated then hand-edited.
- `backend/tests/test_schema_identity.py`: 37 tests against the migrated `condo_test` database.

### Walkthrough (Variant C)

1. **Trigger:** `make migrate` (or the test session's upgrade to `head`) runs
   `backend/migrations/versions/2b2e5bcaf6b4_users_memberships_roles.py::upgrade`. It creates `users` and
   its expression index, then `building_memberships`, then `membership_roles` (parents first, so each FK
   has its target). The key DDL, from the offline `--sql` render I ran:

   ```sql
   CREATE UNIQUE INDEX uq_users_lower_email ON users (lower(email));
   -- building_memberships ...
       CONSTRAINT uq_building_memberships_building_id_id UNIQUE (building_id, id),
   -- membership_roles ...
       CONSTRAINT ck_membership_roles_role CHECK (role IN ('resident', 'security', 'property_management', 'council')),
       CONSTRAINT fk_membership_roles_building_id_membership_id FOREIGN KEY(building_id, membership_id)
           REFERENCES building_memberships (building_id, id) ON DELETE CASCADE,
   ```

2. **An ORM flush of a new user and their membership** (D5). Captured with `echo=True`; the membership was
   added to the session *before* the user, and the email given as `Alice@Example.com`. The relationship
   makes the unit of work insert `users` first; `_lower_email` had already changed the email at
   construction, so the parameter is lower-case:

   ```sql
   INSERT INTO users (email, password_hash, full_name, phone, locale, is_active, email_verified_at, id) VALUES (...)
   -- ('alice@example.com', None, 'Alice', None, 'en', True, None, UUID('01a141ea-...'))
   INSERT INTO building_memberships (building_id, user_id, status, status_changed_by_user_id, id) VALUES (...)
       RETURNING building_memberships.status_changed_at, building_memberships.created_at, building_memberships.updated_at
   ```

3. **ORM delete of a membership** (D6). With roles loaded (`selectinload`), the ORM deletes them itself,
   children first; with roles not loaded, it issues one statement and the database's `ON DELETE CASCADE`
   removes the roles (`passive_deletes`):

   ```sql
   -- roles loaded
   DELETE FROM membership_roles WHERE membership_roles.membership_id = $1::UUID AND membership_roles.role = $2
   -- [(M, 'council'), (M, 'resident')]
   DELETE FROM building_memberships WHERE building_memberships.id = $1::UUID
   -- roles not loaded
   DELETE FROM building_memberships WHERE building_memberships.id = $1::UUID
   ```

4. **A write hitting the composite FK** (D2): a raw
   `INSERT INTO membership_roles (building_id, membership_id, role) VALUES (B, M, 'resident')` where M is in
   A fails with `insert or update on table "membership_roles" violates foreign key constraint
   "fk_membership_roles_building_id_membership_id"`: no row `(B, M)` exists in
   `building_memberships(building_id, id)`. The same constraint rejects moving M to B while it has roles
   (D3), with `update or delete on table "building_memberships" violates foreign key constraint …`.
5. **Other failures:** each constraint fails with an `IntegrityError` naming it (`uq_users_lower_email`,
   `uq_building_memberships_building_id_user_id`, `pk_membership_roles`, `ck_membership_roles_role`,
   `fk_building_memberships_user_id_users`, …), and the tests match on the name so a different error can't
   pass them.
6. **Downgrade / recover:** `downgrade` drops children first (roles, memberships, users), or the FKs block
   the drops. Create-only, so `downgrade 891dd631e5a1` then `upgrade head` is safe on disposable dev data;
   on a database with users it would destroy them.

<details><summary>Deeper: the full DDL of revision 2b2e5bcaf6b4 (offline render)</summary>

```sql
CREATE TABLE users (
    email VARCHAR(320) NOT NULL,
    password_hash VARCHAR(255),
    full_name VARCHAR(200) NOT NULL,
    phone VARCHAR(32),
    locale VARCHAR(10) DEFAULT 'en' NOT NULL,
    is_active BOOLEAN DEFAULT true NOT NULL,
    email_verified_at TIMESTAMP WITH TIME ZONE,
    id UUID NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    CONSTRAINT pk_users PRIMARY KEY (id)
);

CREATE UNIQUE INDEX uq_users_lower_email ON users (lower(email));

CREATE TABLE building_memberships (
    building_id UUID NOT NULL,
    user_id UUID NOT NULL,
    status VARCHAR(11) DEFAULT 'pending' NOT NULL,
    status_changed_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    status_changed_by_user_id UUID,
    id UUID NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    CONSTRAINT pk_building_memberships PRIMARY KEY (id),
    CONSTRAINT ck_building_memberships_status CHECK (status IN ('pending', 'active', 'denied', 'suspended', 'deactivated')),
    CONSTRAINT fk_building_memberships_building_id_buildings FOREIGN KEY(building_id) REFERENCES buildings (id) ON DELETE RESTRICT,
    CONSTRAINT fk_building_memberships_status_changed_by_user_id_users FOREIGN KEY(status_changed_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT fk_building_memberships_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT uq_building_memberships_building_id_id UNIQUE (building_id, id),
    CONSTRAINT uq_building_memberships_building_id_user_id UNIQUE (building_id, user_id)
);

CREATE INDEX ix_building_memberships_user_id ON building_memberships (user_id);

CREATE TABLE membership_roles (
    building_id UUID NOT NULL,
    membership_id UUID NOT NULL,
    role VARCHAR(19) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    CONSTRAINT pk_membership_roles PRIMARY KEY (membership_id, role),
    CONSTRAINT ck_membership_roles_role CHECK (role IN ('resident', 'security', 'property_management', 'council')),
    CONSTRAINT fk_membership_roles_building_id_membership_id FOREIGN KEY(building_id, membership_id) REFERENCES building_memberships (building_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_membership_roles_building_id_buildings FOREIGN KEY(building_id) REFERENCES buildings (id) ON DELETE RESTRICT
);
```

Note the widths: `status VARCHAR(11)` and `role VARCHAR(19)` are the longest enum values (`deactivated`,
`property_management`). A longer new value needs the column widened too (§8).

</details>

### Data model changes

- **`users`:** `email` VARCHAR(320) NOT NULL + `uq_users_lower_email` (prevents two accounts that differ
  only in case, D1); `password_hash` NULL (no login until one is set); `full_name` NOT NULL (D7); `phone`
  NULL; `locale` default `'en'`; `is_active` default true; `email_verified_at` NULL. No role or building
  column (roles are per building).
- **`building_memberships`:** FKs to `buildings` and `users`, both RESTRICT (history must not vanish, D4);
  `status` VARCHAR + CHECK, default `'pending'` (a typo like `'approved'` can't reach the table);
  `status_changed_at` NOT NULL default `now()` (D7); `status_changed_by_user_id` FK RESTRICT, nullable;
  `UNIQUE (building_id, user_id)` (one membership per person per building); `UNIQUE (building_id, id)` (the
  composite-FK target, D2); index on `user_id` ("all my buildings" lookups).
- **`membership_roles`:** PK `(membership_id, role)` (no duplicate role, several roles allowed); CHECK on
  `role`; plain FK `building_id → buildings` RESTRICT; composite FK `(building_id, membership_id) →
  building_memberships(building_id, id)` ON DELETE CASCADE, ON UPDATE NO ACTION (D2–D4).

## 4. The code

**Files changed** (`git diff fd276ec 684514c`)

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/users/models.py` | new: `User`, email validator, `uq_users_lower_email` | +32 |
| `backend/app/memberships/enums.py` | new: `MembershipStatus`, `Role`, `STAFF_ROLES` | +23 |
| `backend/app/memberships/models.py` | new: `BuildingMembership`, `MembershipRole` | +70 |
| `backend/app/models/registry.py` | registers the two models modules (plus two empty `__init__.py`) | +2 |
| `backend/migrations/versions/2b2e5bcaf6b4_users_memberships_roles.py` | new migration | +182 |
| `backend/tests/test_schema_identity.py` | new: 37 tests | +591 |
| `docs/tickets/P1-02-users-memberships-roles-schema.md`, `docs/tickets/README.md` | framing, Scope fix, status | +61 / −9 |
| `docs/tickets/P2-01-sessions-login-logout-csrf.md` | "Carried from P1-02" (email follow-ups) | +13 |
| `docs/HUMAN_INBOX.md`, `docs/AGENT_MISTAKES_LOG.md` | 3 decisions to audit, 3 mistakes rows | +3, +4 |
| this file | the explanation | +400 at merge |

**Key excerpts** (code identical at `22b04c4` and `684514c`)

`backend/app/users/models.py::User`
([permalink](https://github.com/JamesSoh2000/Condo-app-revised/blob/684514c969c536e6b7d5d6ba7cde9bc7092d3308/backend/app/users/models.py#L10-L32))

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

- D1's two layers: Python stores emails lower-cased; the index rejects case variants from any writer.
- Without the `Index(...)` line, `alembic check` reports a missing index and the database accepts case
  variants (PR mutation M2: 5 tests fail).
- Without `_lower_email`, `test_user_email_is_lower_cased_before_any_sql` and
  `test_stored_email_is_lower_case` fail; uniqueness would still hold.

`backend/app/memberships/models.py::BuildingMembership` (relationships)
([permalink](https://github.com/JamesSoh2000/Condo-app-revised/blob/684514c969c536e6b7d5d6ba7cde9bc7092d3308/backend/app/memberships/models.py#L40-L52))

```python
    # Declared so the unit of work orders a flush by these FKs: users before the memberships that
    # name them, roles deleted before their membership. Without relationships it orders tables by
    # class name. lazy="raise": load them explicitly; an implicit lazy load fails under asyncio.
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

- These exist for flush ordering and cascades (D5, D6), not for navigation.
- Remove both `user` and `status_changed_by`: the round-1 failure returns
  (`test_new_user_and_their_membership_can_be_flushed_together` fails). Remove only one: no test notices.
- Remove `cascade="all, delete-orphan"`: the round-2 failure returns (I ran it: 2 failed, 35 passed).
- Remove `passive_deletes=True`: no test notices (I ran it: 37 passed); unloaded roles get an extra
  `SELECT`.
- `roles` has no explicit join condition. The only FK path from `membership_roles` to
  `building_memberships` is the composite FK, so SQLAlchemy joins on both columns and fills in a new role's
  `building_id` as well as its `membership_id`.
- `Mapped[list[MembershipRole]]` names a later class unquoted: fine, Python 3.14 evaluates annotations
  lazily.

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

- The ticket's central guarantee (D2, D3). A plain FK on `membership_id` would accept `(B, M)` for M in A
  (PR mutation M1: 5 tests fail). `ondelete="CASCADE"` is criterion 6 (PR mutation M3: 3 tests fail).
- `membership_id` is in the primary key, which is why D6's `delete-orphan` is required rather than optional.

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

`backend/tests/test_schema_identity.py::test_orm_delete_of_a_membership_with_loaded_roles_deletes_them`

```python
async def test_orm_delete_of_a_membership_with_loaded_roles_deletes_them(db: AsyncSession):
    a = await _building(db, "a")
    alice = await _user(db, "alice@example.com")
    m = await _membership(db, a, alice)
    await _role(db, m, Role.RESIDENT)
    await _role(db, m, Role.COUNCIL)
    membership = await _membership_with_roles_loaded(db, m.id)
    assert len(membership.roles) == 2

    await db.delete(membership)
    await db.flush()

    assert await db.get(BuildingMembership, m.id) is None
    assert await _roles_of(db, m.id) == set()
    assert await db.get(User, alice.id) is not None
```

- The test that pins round 2's fix. `assert len(membership.roles) == 2` proves the roles really are loaded
  (the condition the round-1 tests missed). The criterion-3 test is the other one worth reading:
  `backend/tests/test_schema_identity.py::test_role_pointing_at_a_membership_in_another_building_is_rejected`
  inserts `(B, M)` with raw SQL, so only the database can reject it, and matches the constraint name.

## 5. Edge cases and tests

All tests are in `backend/tests/test_schema_identity.py`.

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Case-variant email inserted by raw SQL | Index rejects it | `test_email_differing_only_in_case_is_rejected_by_the_database` (2 params) |
| Case-variant email through the model | Lower-cased, then the index rejects it | `test_model_insert_of_a_case_variant_is_rejected`, `test_stored_email_is_lower_case` |
| Role naming a membership in another building | Composite FK rejects it (raw and model) | `test_role_pointing_at_a_membership_in_another_building_is_rejected`, `test_model_role_pointing_at_a_membership_in_another_building_is_rejected` |
| Membership with roles moved to another building (raw SQL) | NO ACTION on update rejects it | `test_moving_a_membership_with_roles_to_another_building_is_rejected` (+ control without roles) |
| Same move through the ORM, roles loaded or not | Rejected by the same FK | **No test**; I ran it (D3) |
| Enum gains a value with no migration | CHECK text compared with the enum | `test_check_in_the_database_lists_exactly_the_enum_values` |
| User and membership flushed together, membership added first | Users inserted first | `test_new_user_and_their_membership_can_be_flushed_together` |
| ORM delete of a membership: roles loaded / not loaded / deleted explicitly too | Loaded: ORM deletes them; unloaded: DB cascade; explicit: children first, no warning | `test_orm_delete_of_a_membership_with_loaded_roles_deletes_them`, `test_orm_delete_of_a_membership_leaves_unloaded_roles_to_the_cascade`, `test_membership_and_its_roles_can_be_deleted_together` |
| Role removed from a loaded `roles` list | Row deleted (delete-orphan) | `test_removing_a_role_from_a_loaded_membership_deletes_the_row` |
| Role appended to a loaded membership without `building_id` | Relationship fills it in | `test_role_appended_to_a_membership_takes_the_memberships_building` |
| Mixed-case email via Core `insert()` | Stored as written; uniqueness still holds | **No test** (review L1, accepted) |
| `İnci@x.com` and `inci@x.com` via the model | Python and Postgres `lower()` disagree; both can be stored | **No test** (review L2/L5, deferred to P2-01) |
| 320-character email that grows when lowered | `DataError` from VARCHAR(320) | **No test** (review L4, deferred to P2-01) |
| `passive_deletes=True` removed, or `user` relationship removed alone | Behaviour changes, or not, silently | **No test** (review L-B; I confirmed both mutations pass) |
| Building and its memberships deleted in one ORM flush | Building deleted first → RESTRICT error | **No test** (review L-A; nothing deletes buildings) |
| Empty `full_name` / `email` (`''`) | Accepted by the database | **No test**; left to later Pydantic schemas |
| Roles on a `pending`/`denied` membership, or on an inactive user | Allowed by the schema | **No test**; P2-03 must filter `status = 'active'` |

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

The PR also shows the migration's constraints can fail tests: four mutations (composite → plain FK; drop the
email index; roles CASCADE → NO ACTION; `user_id` RESTRICT → CASCADE) failed 5, 5, 3 and 3 tests. Red
first: the tests were committed before the code (`97dfb12`) and failed at collection.

## 6. Review log

Commit reviewed: the PR doesn't name it per round. Round 3's is `22b04c4` (the PR says no code changed after
the final round). For rounds 1 and 2, inferred from commit order: each round ran on the head between the
commits listed.

| Round | Reviewer | Commit reviewed | Verdict | Findings (severity: one line) | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6-astra` (high) | `378d4c4` (inferred) | MERGE | none | — |
| 1 | Fresh Claude + security pass | `378d4c4` (inferred) | MERGE | M1: no relationships, so flushes ordered by class name | Fixed in `3a2229f`, test-first (D5) |
| 1 | same | | | L1: Core writes skip lower-casing; L2: `İ` lowers differently in Python and Postgres; L3: no index on `membership_roles.building_id` / `status_changed_by_user_id` | Accepted; follow-ups (§7) |
| 2 | Codex + fresh Claude | `3a2229f` (inferred) | MERGE | M (both): `roles` had no delete cascade, so with roles loaded the ORM tried to NULL a PK column | Fixed in `22b04c4`, test-first (D6) |
| 2 | fresh Claude | | | L4: lowering can lengthen past 320; L5: the index's meaning depends on the DB collation | Follow-ups, P2-01 (§7) |
| 3 | Codex + fresh Claude | `22b04c4` | MERGE | L-A: no `building` relationship; L-B: `passive_deletes` and `user` alone unpinned; L-C: follow-ups only in the PR | L-A, L-B follow-ups; L-C fixed in `7a80889` (P2-01 note) |

### Round 1, M1: flushes ordered by class name

- **Failure (inputs → wrong outcome).** A user and their membership created in one session and flushed
  together, with the membership added first (inferred: P4-02's invitation accept, which creates a new user
  and their membership "in one transaction", would have hit this). Without relationships the unit of work ordered by `module.ClassName`, inserted
  `building_memberships` first, and Postgres rejected it:
  `ForeignKeyViolationError … insert or update on table "building_memberships" violates foreign key
  constraint "fk_building_memberships_status_changed_by_user_id_users"`. Second symptom: deleting a
  membership *and* its role in one flush deleted the membership first; the database's cascade removed the
  role, so the ORM's own `DELETE` matched nothing: `SAWarning: DELETE statement on table 'membership_roles'
  expected to delete 1 row(s); 0 were matched`. The first is a hard failure; the second a warning (the rows
  end up deleted), made an error inside the test.
- **Why the tests missed it.** Every helper flushed one object at a time, so order never arose (mistakes
  log: "tested the schema one object per flush").
- **Evidence for the fix.** Red first in the PR: `test_new_user_and_their_membership_can_be_flushed_together`
  and `test_membership_and_its_roles_can_be_deleted_together` failed with the errors above, then passed
  after `3a2229f` (`make check` green, 112 passed). Neighbour added:
  `test_orm_delete_of_a_membership_leaves_unloaded_roles_to_the_cascade`. I re-ran it for this revision:
  with `backend/app/memberships/models.py` from `378d4c4` and today's tests, the same two tests fail with the
  same two messages.
- **Decision produced:** D5.

### Round 2, M: loaded roles crash the delete

- **Failure (inputs → wrong outcome).** A membership loaded with `selectinload(BuildingMembership.roles)`,
  then `db.delete(membership)` (or `membership.roles.remove(role)`), then flush. The round-1 `roles`
  relationship had no delete cascade, so SQLAlchemy tried to dissociate the loaded roles by setting
  `membership_roles.membership_id` to NULL, a primary-key column:
  `AssertionError: Dependency rule on column 'building_memberships.id' tried to blank-out primary key column
  'membership_roles.membership_id' on instance '<MembershipRole at 0x…>'`. Any future "remove a role" or
  "delete a membership" service that loaded roles first would crash. Codex and Claude found it independently;
  Codex supplied a proof script.
- **Why the tests missed it.** Round 1's fix was tested with unloaded roles only. The mistakes log records
  this as the "fix not tested on adjacent cases" pattern, for the fifth time, after its CLAUDE.md lesson.
- **Evidence for the fix.** Reproduced red with Codex's proof, then as
  `test_orm_delete_of_a_membership_with_loaded_roles_deletes_them` and
  `test_removing_a_role_from_a_loaded_membership_deletes_the_row`; green after `22b04c4` (115 passed).
  Neighbour: `test_role_appended_to_a_membership_takes_the_memberships_building` (passed before and after).
  Round 3's Claude reviewer mutated the fix (dropping `delete-orphan` or the cascade fails tests). I re-ran
  it: with the `3a2229f` model, those two tests fail with the message above (`2 failed, 4 passed` on the
  ORM tests).
- **Decision produced:** D6.

### Round 3

No code change. L-C (follow-ups only in the PR body) was fixed by the bookkeeping commit, which added
"Carried from P1-02" to the P2-01 ticket. L-A and L-B are follow-ups (§7). Codex also ran 8 probes of its
own; the PR doesn't list them.

## 7. Not verified, accepted risks and follow-ups

What no test, check or reviewer proved (the untested rows of §5, plus):

- **Non-ASCII emails** (L2, L4, L5): two accounts differing only in a dotted `İ` can coexist (I confirmed
  the divergence, D1); once password reset sends mail, that is a known account-takeover pattern. Not
  reachable until an API writes users (P2-01, P4-02, P4-05).
- **Lookups that use the index:** nothing queries `users` by email yet, and nothing enforces the
  `func.lower(User.email) == …` form.
- **Status bookkeeping:** the schema allows roles on non-active memberships and inactive users, and no
  trigger keeps `status_changed_at` in step with `status`; only later service and authorization code does.
- **Missing indexes** (L3): unmeasured; they matter only for user/building deletes, which don't happen.
- The migration ran only on fresh databases (tests, compose `condo_dev`); none holding real data exists.

Accepted risks and follow-ups, with where each is tracked:

| Item | Where tracked |
|---|---|
| Look users up with `func.lower(User.email) == …`, never `User.email == …` (L1) | P2-01 ticket, "Carried from P1-02"; inbox row "`User.email` is lower-cased by the model"; code comment on the index |
| One normalisation on write and lookup; send mail only to the stored address; or reject non-ASCII (L2, L5) | P2-01 ticket, "Carried from P1-02"; inbox (same row) |
| Check the length after normalising (L4) | P2-01 ticket, "Carried from P1-02" |
| The same email rules for P4-02 and P4-05 | Only via the P2-01 note ("Login (and later P4-02, P4-05) must…"); neither ticket mentions it |
| Login treats NULL `password_hash` and inactive users as invalid credentials | P2-01 ticket's login criterion ("null password or inactive user") |
| Authorization accepts only `status = 'active'` memberships and active buildings | P2-03 ticket Scope (`get_tenant_context` query) |
| Services that change `status` also set `status_changed_at`/`status_changed_by_user_id` | inbox row "Memberships → users and buildings" ("services set it on each change; no trigger") |
| Pydantic schemas reject empty or padded `email`/`full_name` | **Tracked only here** and in the PR body |
| `email-validator` isn't a dependency yet; the first `EmailStr` schema adds it | **Tracked only here** and in the PR body |
| Indexes on `membership_roles.building_id`, `building_memberships.status_changed_by_user_id` (L3) | **Tracked only here** and in the PR body |
| A `building` relationship on `BuildingMembership`/`MembershipRole` (and `Unit`) if buildings are ever deleted through the ORM (L-A) | Mistakes log mentions it as part of the round-2 row, not as an open item; otherwise **tracked only here** and in the PR body |
| Tests pinning `passive_deletes` and the `user` relationship alone (L-B) | Mistakes log row "No test pins `passive_deletes=True`…" ("follow-ups"); no ticket |
| Fitness test: one-to-many relationships whose child FK is in the child's PK have `delete-orphan` | Mistakes log, "Proposed for the next ticket"; not in any ticket |
| Deleting or erasing users and buildings (RESTRICT blocks it today) | "Retention/erasure is a later ticket" (Frame notes); no ticket found |

## 8. How to change this safely

- **New role or status:** add it to `backend/app/memberships/enums.py`, then write a migration that replaces
  `ck_membership_roles_role` / `ck_building_memberships_status` (drop + add). `alembic check` will *not*
  notice; `test_check_in_the_database_lists_exactly_the_enum_values` and the two
  `..._lowercase_ticket_list` tests will. Decide whether it joins `STAFF_ROLES`. Widen the `VARCHAR` if the
  new value is longer than `deactivated` (11) or `property_management` (19).
- **New tenant table referencing a membership** (occupancies, P1-03): give it `building_id` with a plain FK
  to `buildings` and a composite FK `(building_id, membership_id) → building_memberships(building_id, id)`,
  hand-named if the convention passes 63 characters. Decide `ON UPDATE` deliberately (D3). Copy the
  cross-building and positive-control tests.
- **New relationship:** keep `lazy="raise"`. If the child's FK is part of its primary key, use
  `cascade="all, delete-orphan"` (D6) and test with the children *loaded* as well as unloaded. The ORM-flush
  tests near the end of the test file catch ordering and cascade regressions.
- **Email lookups:** always `func.lower(User.email) == value.lower()`. If you change normalisation (NFKC,
  ASCII-only), change `backend/app/users/models.py::_lower_email` and the lookup together, and check what
  Postgres `lower()` does with the same input.
- **Status changes:** set `status_changed_at` and `status_changed_by_user_id` in the same conditional
  `UPDATE` that changes `status`. Never edit `2b2e5bcaf6b4`; add a new revision.

## 9. Must explain, then quiz

**1. Why are roles on the membership, not the user?** A person can be a resident in building A and security
in building B. Authorization is per building: every request is under `/api/buildings/{building_id}/…`
(ADR-0004), and `get_tenant_context` loads the *active membership* for that building with its roles, so
the question is always "what may this user do *here*?". A role on `users` would apply in every building the
user joins, and suspending a membership (`building_memberships.status`) would not remove it.
`backend/app/memberships/models.py::MembershipRole` hangs off one membership, so roles and status are both
per building, and `test_users_table_has_no_role_or_building_column` keeps it that way.

**2. What does the composite FK prevent that a plain FK on `membership_id` does not?** A plain FK only
checks that membership M exists *somewhere*. The row `(building_id=B, membership_id=M)` with M in A would
pass, and a query `WHERE building_id = :B` would find a role in B the user never had: a cross-tenant
privilege grant from one bug in one service. The composite FK
`fk_membership_roles_building_id_membership_id` requires the *pair* to exist in
`building_memberships(building_id, id)`, so the role's building always equals its membership's building,
whatever code writes the row. With `ON UPDATE NO ACTION` it also blocks moving a membership with roles to
another building (D3). It needs `UNIQUE (building_id, id)` on the parent as its target.

**3. `lower(email)` unique index vs `citext`?** No record weighs this (D1); what follows is my analysis.
`citext` is a Postgres extension type whose comparisons ignore case: every `=` and every plain index on the
column is case-insensitive, so `WHERE email = :x` just works and no caller can forget. Costs: `CREATE
EXTENSION` (privileges; one more thing to manage on a managed database later), a non-standard column type
for SQLAlchemy and asyncpg, and it still lower-cases with the database's rules, so the non-ASCII and
collation issues (L2, L5) remain. The functional index needs nothing extra and keeps the column a plain
`VARCHAR`, but it helps only queries that write `lower(email)`; a plain `email = :x` silently misses case
variants and skips the index. Here the model also stores emails lower-cased, so the gap is mostly for rows
written by Core or raw SQL, and the rule "always compare `lower()`" is written down for P2-01.

**4. Why is `password_hash` nullable?** A user row exists before the person has a password: invitation
(P4-02) creates the user, and the password comes when they accept; the bootstrap admin (P4-03), the seed
(P1-06, "until then users have a null `password_hash`") and reset flows are similar. NULL means "cannot
log in yet", which is safer than a placeholder hash someone might match. P2-01 must treat NULL as invalid
credentials (its login criterion lists "null password" among the identical 401 cases), with the same
timing as an unknown email.

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

1. `Bob@X.com`, as written: Core `insert()` doesn't go through `@validates`. The later `bob@x.com` insert
   fails on `uq_users_lower_email`, because the index compares `lower(email)`. Uniqueness holds; only the
   stored spelling differs (review L1), which is why lookups must compare `lower(email)`.
2. A foreign key can only reference columns covered by a unique constraint or PK. The composite FK from
   `membership_roles` (and later occupancies) references the pair `(building_id, id)`, so the pair needs its
   own unique constraint, even though `id` alone is already unique.
3. It raises immediately (`lazy="raise"`). Under asyncio an implicit lazy load can't run anyway; it would
   fail later with a confusing greenlet error. You load roles explicitly, e.g.
   `selectinload(BuildingMembership.roles)`. The choice was recorded with the round-1 fix (D5).
4. With roles loaded, deleting the membership, or removing a role from `roles`, makes the ORM try to set
   `membership_roles.membership_id` to NULL; that column is part of the PK, so the flush fails with
   `AssertionError: Dependency rule … tried to blank-out primary key column`. That was round 2's bug;
   `test_orm_delete_of_a_membership_with_loaded_roles_deletes_them` and
   `test_removing_a_role_from_a_loaded_membership_deletes_the_row` fail. Unloaded roles would still go by
   the database cascade.
5. Add nullable `valid_from` / `valid_until` columns to `membership_roles` (expand migration), with a CHECK
   `valid_until IS NULL OR valid_until > valid_from`. The PK `(membership_id, role)` permits only one row per
   role, so for term *history* you'd need a separate history table or a surrogate PK with an exclusion
   constraint against overlapping terms. Authorization (P2-03) must then filter on the current date, in one
   shared helper. Keep the composite FK. Add tests: overlapping terms rejected, expired role ignored, and
   the ORM delete tests with roles loaded.

</details>
