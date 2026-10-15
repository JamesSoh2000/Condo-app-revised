# Explanation — P1-01 Buildings, features and units schema

> Code at the head of PR #43 (2026-10-15), built autonomously
> ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it. The branch is rebased onto
> the latest `main`, so the merged tree will equal the PR head. The PR's commits stay reachable at
> `refs/pull/43/head`. Snapshot: if the code changes later, write a new explanation; lasting decisions
> live in ADRs.
> Form: full (Tier 2). Walkthrough variant: C (process: `alembic upgrade`, then an INSERT hitting each
> constraint).

**Findings for the implementer (code vs PR):** the code matches the PR's plan and decisions table; every
claim checked (one named feature CHECK, `NULLS NOT DISTINCT` rendered, `VARCHAR(11)`, server defaults,
children dropped first, pinned revisions, registry test sees `models/` packages) holds in the code and in
the rendered DDL. Three smaller gaps:

1. **Stale evidence count.** The PR's `make check` line says `71 passed`. That run predates the review
   fixes: the head runs **78** (`make test DB_PORT=55432`, 2026-10-15, 36 of them in this ticket's file).
2. **Ticket text vs test.** Criterion 7 still says "`downgrade -1`". The test now pins
   `891dd631e5a1`/`989e5bd83064` (review round 2, M1). The two are the same today, but the ticket text was
   never updated.
3. **Merge-gate bookkeeping not done yet.** `docs/HUMAN_INBOX.md` has no P1-01 rows, although the Frame
   notes and the PR list six autonomous decisions (marked in §2). Ticket and index still say `in progress`. The playbook
   puts these in the PR's last commit, so this is pending, not a contradiction; it must land before merge.

## 1. What was built and why

The first real tables: `buildings`, `building_features` and `units`, the roots of every tenant-owned table.
The database itself rejects duplicate units (NULL tower included), deleting a building that still has
units, unknown feature names and malformed slugs. `units` also gets `UNIQUE (building_id, id)`, the target
for the composite foreign keys (FKs) of [ADR-0005](../adr/0005-tenant-integrity-in-the-database.md).

## 2. Decisions

| Decision | Alternative rejected | Why | Basis |
|---|---|---|---|
| `backend/app/models/registry.py` imports every models module; `backend/migrations/env.py` imports only it; a test fails if any `app/**/models.py` (or `models/` package) is missing | Do the imports in an `__init__.py` for the `app.models` package (today it has none) | Every feature model imports `app.models.base`, which would run that `__init__.py` first. If that file imported every feature, each feature would import all the others (import cycles) | Ticket offers both; **autonomous** |
| Timezone checked by `@validates("timezone")` on `Building`, calling `validate_timezone` | Check it only in future API schemas; or a DB CHECK | The validator runs on every ORM attribute set (constructor or `b.timezone = …`) before any SQL. The tz database lives on the app host, so it can't be a constraint. It does **not** cover Core `insert()`/`update()`, bulk writes or raw SQL | Ticket (Python) + **autonomous** (where to hook it) |
| `available_timezones()` is cached, minus `localtime`, `Factory`, `posixrules` | Call it each time; accept everything it lists | It scans files on disk on each call. `localtime` points at the host's `/etc/localtime`, so one stored value would mean different zones on different hosts; the other two are placeholders, not zones | **Autonomous** (review round 1, M1) |
| One named CHECK `ck_building_features_feature` in the migration, with `sa.Enum(create_constraint=False)` on the column | Keep what autogenerate wrote | Autogenerate rendered the check twice. Both copies would get the same name from the naming convention, so the CREATE would fail or duplicate | CLAUDE.md rule 11 |
| `server_default` as well as a Python `default` on `locale`, `is_active`, `enabled`, `config` | Python defaults only | Raw SQL (seeds, operator fixes, later data migrations) gets the same values as the ORM | **Autonomous** |
| `name`, `address`, `timezone`, `slug`, `label` NOT NULL | Nullable `address` | Stricter is cheaper to loosen later (an expand migration) than to tighten | **Autonomous** |
| `BuildingFeature` has `created_at`/`updated_at` but no uuid `id` | No timestamps | The ticket's PK is `(building_id, feature)`; timestamps match every other table and show when a feature was toggled | **Autonomous** |
| Feature stored as `VARCHAR(11)` + CHECK (`database_enum`) | Native Postgres `ENUM` type | Existing project convention (`backend/app/models/types.py::database_enum`). Note: the width is the longest value (`maintenance`), so a longer feature name also needs the column widened | Existing code |
| Two tests compare the database's CHECK text with the enum and the slug regex | Trust `alembic check` | `alembic check` does not compare CHECK constraints, so a new enum value with no migration would pass it | Review round 1, L1 |
| The round-trip test pins revision ids | `downgrade -1` | With `-1`, the next ticket's migration would become the one undone, and that ticket would have to edit this protected test | Review round 2, M1 |

Interview angles: why not a native enum; why `RESTRICT` not `CASCADE`; the composite unique key doubles as
the index for `units.building_id` (there is no separate one).

**Framing changes:** sharpened 1 (towered duplicate), 3 (rows survive a failed delete), 4 (same feature in
two buildings), 5 (more slugs; raw SQL for the enum case), 6 (more bad zones; model-level check), 7
(downgrade checked in code). Added 8 (slug/`join_code` uniqueness), 9 (composite-FK target), 10 (defaults),
11 (registry fitness test). Loosened: none.

## 3. How it is implemented

### Overview

- Three models: `backend/app/buildings/models.py::Building`, `backend/app/buildings/models.py::BuildingFeature`,
  `backend/app/units/models.py::Unit`, plus the enum `backend/app/buildings/enums.py::Feature`.
- `backend/app/core/time.py::validate_timezone`: the only rule kept in Python; everything else is a
  database constraint.
- `backend/app/models/registry.py` makes `Base.metadata` complete; `backend/migrations/env.py` imports it so
  autogenerate and `alembic check` see every table.
- One migration, `891dd631e5a1`, hand-edited after autogenerate.
- `backend/tests/test_schema_buildings_units.py`: 36 tests, run against the migrated `condo_test`
  database (the test schema is built by `alembic upgrade head`, so the tests exercise the migration, not
  `create_all`).

### Walkthrough (Variant C)

1. **Trigger:** `make migrate` (or the test session's `command.upgrade(cfg, "head")`) runs `env.py`. Its
   first app import, `app.models.registry`, loads both models modules, so `target_metadata` holds the three
   tables.
2. **Upgrade** (`backend/migrations/versions/891dd631e5a1_buildings_features_units.py::upgrade`): creates `buildings`, then the two
   children. The DDL that runs (from `alembic upgrade 989e5bd83064:891dd631e5a1 --sql`):

   ```sql
   CREATE TABLE building_features (
       building_id UUID NOT NULL, feature VARCHAR(11) NOT NULL,
       enabled BOOLEAN DEFAULT true NOT NULL, config JSONB DEFAULT '{}'::jsonb NOT NULL, -- ...
       CONSTRAINT pk_building_features PRIMARY KEY (building_id, feature),
       CONSTRAINT ck_building_features_feature CHECK (feature IN ('packages', 'notices', ... 'financials')),
       CONSTRAINT fk_building_features_building_id_buildings FOREIGN KEY(building_id)
           REFERENCES buildings (id) ON DELETE CASCADE);
   CREATE TABLE units ( -- ...
       CONSTRAINT fk_units_building_id_buildings FOREIGN KEY(building_id)
           REFERENCES buildings (id) ON DELETE RESTRICT,
       CONSTRAINT uq_units_building_id_id UNIQUE (building_id, id),
       CONSTRAINT uq_units_building_id_tower_label UNIQUE NULLS NOT DISTINCT (building_id, tower, label));
   ```

3. **A write hitting a constraint:** inserting a second `(NULL, '101')` unit in a building fails at flush
   with `IntegrityError` naming `uq_units_building_id_tower_label`. Every constraint name comes from the
   naming convention in `backend/app/models/base.py::NAMING_CONVENTION`, so tests (and later, the error
   mapper of P1-04) can match on the name.
4. **A write stopped in Python:** `Building(timezone="Mars/Base")` raises `ValueError` from the
   validator; no SQL is sent.
5. **Downgrade** (`backend/migrations/versions/891dd631e5a1_buildings_features_units.py::downgrade`): drops `units`, then
   `building_features`, then `buildings` (children first, or the FKs block the drop).
6. **Recover / re-run:** create-only migration, so `alembic downgrade 989e5bd83064` then `upgrade head` is
   safe on dev data you can lose. The dev DB is now at `891dd631e5a1`; an older `main` checkout will not
   know that revision until it pulls.

### Data model changes

- **`buildings`:** `slug` VARCHAR(63) UNIQUE + `ck_buildings_slug_format` (`^[a-z0-9-]+$`: slugs go into
  URLs, so no spaces, capitals or underscores); `name`, `address`, `timezone` NOT NULL; `locale` default
  `'en'`; `join_code` VARCHAR(16) UNIQUE nullable (Postgres treats NULLs as distinct in a plain UNIQUE, so
  many buildings can have self-join off); `is_active` default true.
- **`building_features`:** PK `(building_id, feature)` (one row per building and feature); the CHECK
  stops a typo like `'gym'` reaching the table; FK `ON DELETE CASCADE` (settings die with their building).
- **`units`:** FK `ON DELETE RESTRICT` (a building with units can't be deleted: units will carry history);
  `UNIQUE (building_id, id)` (composite-FK target); `UNIQUE NULLS NOT DISTINCT (building_id, tower,
  label)` (no duplicate unit numbers, including in buildings without towers).

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/buildings/enums.py` | new: `Feature` StrEnum | +14 |
| `backend/app/buildings/models.py` | stubs → `Building`, `BuildingFeature` | +42 / −3 |
| `backend/app/units/models.py` | stub → `Unit` | +20 / −2 |
| `backend/app/core/time.py` | new: `validate_timezone` | +20 |
| `backend/app/models/registry.py` | new: imports every models module | +10 |
| `backend/migrations/env.py` | imports the registry; old comment removed | +1 / −5 |
| `backend/migrations/versions/891dd631e5a1_buildings_features_units.py` | new migration | +151 |
| `backend/tests/test_schema_buildings_units.py` | new: 36 tests | +421 |
| `CLAUDE.md` | reuse list: `validate_timezone`, registry rule | +2 / −1 |
| `docs/tickets/P1-01-buildings-features-units-schema.md`, `docs/tickets/README.md` | framing, status | +46 / −12 |

**Key excerpts**

`backend/app/units/models.py::Unit`

```python
class Unit(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "units"
    __table_args__ = (
        # Target for composite FKs (building_id, unit_id) from tenant tables (ADR-0005).
        UniqueConstraint("building_id", "id"),
        # NULLS NOT DISTINCT: without it, two (NULL, '101') units in one building would both fit.
        UniqueConstraint("building_id", "tower", "label", postgresql_nulls_not_distinct=True),
    )

    # RESTRICT: units carry history (occupancies, packages), so a building with units isn't deleted.
    building_id: Mapped[UUID] = mapped_column(ForeignKey("buildings.id", ondelete="RESTRICT"))
    tower: Mapped[str | None] = mapped_column(String(20))
    label: Mapped[str] = mapped_column(String(20))
    # ...
```

- The two unique keys carry the ticket's main guarantees.
- Remove `postgresql_nulls_not_distinct=True` and duplicate untowered units are accepted (mutation M1 in
  the PR: the duplicate test and `alembic check` both fail). Remove `UniqueConstraint("building_id", "id")`
  and P1-03+'s composite FKs can't be created (Postgres requires a unique key on the referenced columns).

`backend/app/buildings/models.py::BuildingFeature` (and the validator on `Building`)

```python
    @validates("timezone")
    def _validate_timezone(self, _key: str, value: str) -> str:
        return validate_timezone(value)


class BuildingFeature(TimestampMixin, Base):
    __tablename__ = "building_features"

    # Features go with their building: they are settings, not records anyone needs afterwards.
    building_id: Mapped[UUID] = mapped_column(
        ForeignKey("buildings.id", ondelete="CASCADE"), primary_key=True
    )
    feature: Mapped[Feature] = mapped_column(
        database_enum(Feature, name="feature"), primary_key=True
    )
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    config: Mapped[dict[str, Any]] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
```

- Two `primary_key=True` columns make the composite PK; `name="feature"` gives the CHECK its name
  `ck_building_features_feature` through the naming convention.
- `default=dict` (a callable) gives each row its own dict; `default={}` would share one object.
- Without `@validates`, a typo'd zone would be stored and only fail later, when code converts a time.

`backend/app/core/time.py::validate_timezone`

```python
_NOT_ZONES = frozenset({"localtime", "Factory", "posixrules"})


@cache
def _known_timezones() -> frozenset[str]:
    # available_timezones() scans the tz database on disk on every call.
    return frozenset(available_timezones()) - _NOT_ZONES


def validate_timezone(tz: str) -> str:
    """Return `tz` unchanged if it is an IANA zone name this system knows, else raise ValueError."""
    if tz not in _known_timezones():
        raise ValueError(f"unknown timezone: {tz!r}")
    return tz
```

- Exact, case-sensitive set membership: `america/toronto` and `"EST5EDT "` fail.
- The set is computed once per process; a tz update on the host needs a restart to be seen.

`backend/migrations/versions/891dd631e5a1_buildings_features_units.py::upgrade` (the hand edit)

```python
            sa.Enum(
                "packages",
                # ...
                "financials",
                name="feature",
                native_enum=False,
                create_constraint=False,
            ),
        # ...
        # Hand-edited: autogenerate rendered this check twice (once unnamed, which the naming
        # convention also names ck_building_features_feature). The column's Enum below has
        # create_constraint=False so it doesn't add a third.
        sa.CheckConstraint(
            "feature IN ('packages', 'notices', 'maintenance', 'amenities', 'moves', 'visitors',"
            " 'reports', 'financials')",
            name=op.f("ck_building_features_feature"),
        ),
```

- The model's `database_enum` still has `create_constraint=True`; the migration spells the CHECK out
  once instead. Result: exactly one CHECK in the database (verified in the rendered DDL above).
- Drop the `CheckConstraint` and nothing but the raw-SQL test notices (mutation M2): `alembic check` is
  blind to CHECKs.

`backend/tests/test_schema_buildings_units.py::test_composite_fk_to_units_rejects_a_unit_from_another_building`

```python
    unit_in_a = await _unit(db, a, "101")
    # Shaped like a future tenant table (packages): rolled back with the test.
    await db.execute(
        text(
            "CREATE TABLE _unit_ref_probe ("
            " building_id uuid NOT NULL, unit_id uuid NOT NULL,"
            " FOREIGN KEY (building_id, unit_id) REFERENCES units (building_id, id))"
        )
    )
    insert = text("INSERT INTO _unit_ref_probe (building_id, unit_id) VALUES (:b, :u)")

    await db.execute(insert, {"b": a.id, "u": unit_in_a.id})
    with pytest.raises(IntegrityError, match="_unit_ref_probe"):
        await db.execute(insert, {"b": b.id, "u": unit_in_a.id})
```

- Proves the reason the composite key exists: a row in building B cannot point at A's unit. DDL is
  transactional in Postgres, so the probe table disappears with the test's rollback.

`backend/tests/test_schema_buildings_units.py::test_feature_check_in_the_database_lists_exactly_the_enum_values`

```python
    definition = await _check_definition(db, "ck_building_features_feature")

    assert set(re.findall(r"'([^']*)'", definition)) == {f.value for f in Feature}
```

- Reads the live CHECK with `pg_get_constraintdef`; adding a `Feature` member without a migration fails
  here (shown by mutation in round 1).

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Two `(NULL, '101')` units in one building | `NULLS NOT DISTINCT` rejects | `test_duplicate_untowered_unit_in_same_building_is_rejected` |
| Same label in another building / tower | Allowed | `test_same_label_in_another_building_or_tower_is_allowed` |
| Delete a building with units | RESTRICT; rows survive | `test_deleting_a_building_with_units_is_restricted` |
| Delete a building with only features | Features cascade | `test_deleting_a_building_with_only_features_cascades_them` |
| Unknown feature via raw SQL | CHECK rejects | `test_feature_outside_the_enum_is_rejected_by_the_database` |
| Enum or slug regex changed without a migration | Test compares live CHECK text | `test_feature_check_in_the_database_lists_exactly_the_enum_values`, `test_slug_check_in_the_database_uses_the_models_pattern` |
| `localtime`/`Factory`/`posixrules`, wrong case, trailing space | `ValueError` | `test_validate_timezone_rejects_unknown_zones` |
| Timezone set after construction | Validator fires on assignment | `test_building_rejects_an_invalid_timezone_before_any_sql` |
| Bad timezone through raw SQL / Core `update()` | **Accepted**; nothing checks it | No test (by design; see §7) |
| Slugs `-`, `--`, `a-` (match the regex) | Accepted | No test; the ticket's regex allows them |
| Blank `label`/`tower` (`''`, `'  '`) | Accepted | No test (PR follow-up) |
| `config=None` | Stored as JSON `null` | No test (round 3, L1, follow-up) |
| New `models.py` not registered | Fitness test fails | `test_every_models_module_is_imported_by_the_registry` (I re-ran the probe: an empty, unregistered `zz_probe` models module made it FAIL) |

Acceptance criteria → tests:

1. `test_duplicate_untowered_unit_in_same_building_is_rejected`, `test_duplicate_towered_unit_in_same_building_is_rejected`
2. `test_same_label_in_another_building_or_tower_is_allowed`
3. `test_deleting_a_building_with_units_is_restricted`, `test_deleting_a_building_with_only_features_cascades_them`
4. `test_duplicate_feature_for_a_building_is_rejected`, `test_same_feature_in_two_buildings_is_allowed`
5. `test_invalid_slug_is_rejected_by_the_database` (4 cases), `test_valid_slug_is_accepted`, `test_feature_outside_the_enum_is_rejected_by_the_database`
6. `test_validate_timezone_rejects_unknown_zones` (7), `test_validate_timezone_returns_a_known_zone_unchanged`, `test_building_rejects_an_invalid_timezone_before_any_sql`, `test_building_rejects_a_host_dependent_or_placeholder_zone`
7. `test_migration_upgrades_downgrades_and_upgrades_again` (scratch DB `condo_migrations_test`, ends with `command.check`)
8. `test_duplicate_slug_is_rejected`, `test_duplicate_join_code_is_rejected`, `test_many_buildings_may_have_no_join_code`
9. `test_composite_fk_to_units_rejects_a_unit_from_another_building`
10. `test_building_feature_and_unit_defaults`, `test_raw_inserts_get_server_defaults`
11. `test_every_models_module_is_imported_by_the_registry`, `test_migrations_env_imports_the_registry`

Run for this explanation: `make test DB_PORT=55432` → `78 passed`. CI on `9a07c01`: all three required
checks pass.

## 6. Review log

| Round | Reviewer | Verdict | Findings | Outcome |
|---|---|---|---|---|
| 1 | fresh Claude | MERGE | M1: `localtime`/`Factory` accepted as zones | Fixed in `cbb2783` (red first; `posixrules` added) |
| | | | L1: CHECK drift invisible to `alembic check` | Fixed in `cb3e821` (two drift tests, proven by mutation) |
| | | | L2: "catches every write path" overstated | Wording fixed in the PR |
| | | | L3: `VARCHAR(11)` limits future names | Recorded in decisions |
| | | | L4: `config` lacks `MutableDict` | Follow-up |
| 2 | fresh Claude | MERGE | M1: `downgrade -1` breaks when P1-02 adds a migration | Fixed in `9a07c01` (pinned revisions) |
| | | | L1: registry test missed `models/` packages | Fixed in `9a07c01` |
| | | | L2: concurrent runs share the scratch DB | Dismissed: same as the session test DB; harmless |
| 3 | fresh Claude | MERGE | L1: `config=None` stores JSON `null` | Follow-up |
| | | | L2: Core `update()` bypasses `@validates` | Known (round 1 L2) |

## 7. Not verified

- **Timezone set differs per host:** the app image knows 486 zones, the dev host 498. A zone accepted in
  dev can be rejected in prod. Nothing pins the set (PyPI `tzdata` would; it is a new dependency, left for
  James).
- **Bypass paths:** raw SQL, Core `insert()`/`update().values()` and bulk writes store any timezone string.
  No DB check exists; the future buildings service must call `validate_timezone`.
- **Data hygiene not enforced:** blank `label`/`tower`, case-variant join codes (`ABC` and `abc` both
  allowed), slugs such as `-` or `a--b`, negative or absurd `floor`. None tested.
- **`config`:** JSON `null` accepted; in-place edits (`feature.config["x"] = 1`) are not saved.
- **Concurrent test runs** share `condo_migrations_test` and could collide (dismissed, round 2 L2).
- **Inbox and status** not yet updated (finding 3 at the top).

## 8. How to change this safely

- **New feature value:** add it to `Feature`, then write a migration that drops and recreates
  `ck_building_features_feature` (and widens the column if the name is over 11 characters). The drift test
  fails until you do.
- **New tenant table referencing a unit:** use `ForeignKeyConstraint(["building_id", "unit_id"],
  ["units.building_id", "units.id"])`; copy the probe test's shape.
- **New models module:** add it to `backend/app/models/registry.py`; the fitness test tells you if you
  forget.
- **Next migration:** never edit `891dd631e5a1`; the round-trip test pins it and will keep passing.

## 9. Must explain, then quiz

**1. Why does `UNIQUE (building_id, tower, label)` allow duplicates when `tower` is NULL?** In SQL, NULL
means "unknown", and `NULL = NULL` is not true, so by default Postgres treats two NULLs as different values:
`(A, NULL, '101')` and `(A, NULL, '101')` don't collide. Most buildings have no towers, so the plain
constraint would protect almost nothing. `NULLS NOT DISTINCT` (Postgres 15+) makes NULLs compare equal for
this constraint (`backend/app/units/models.py::postgresql_nulls_not_distinct`).

**2. What is `UNIQUE (building_id, id)` for, when `id` is unique already?** A foreign key must reference a
unique column set. Later tables reference units with `(building_id, unit_id) → units(building_id, id)`,
so the database checks that the unit belongs to the *same* building as the row, not just that it exists.
That is ADR-0005's defence against cross-tenant references; the probe test proves it
(`backend/tests/test_schema_buildings_units.py::test_composite_fk_to_units_rejects_a_unit_from_another_building`).
It also serves as the index for lookups by `building_id`.

**3. Why RESTRICT for units, CASCADE for features?** Units will be referenced by occupancies, packages,
requests: history that must not silently disappear, so deleting a building with units must fail
(deactivate it with `is_active` instead). Feature rows are only that building's settings; nobody needs
them once the building is gone, so they go with it.

**4. Why non-native enums?** `backend/app/models/types.py::database_enum` stores a VARCHAR plus a CHECK.
Changing the set means dropping and recreating a CHECK in an ordinary transactional migration. A native
`ENUM` type can add values (`ALTER TYPE … ADD VALUE`) but cannot remove or rename them easily, and the type
is a separate object migrations must create and drop. No ADR records this; `docs/REVIEW-2026-10.md` only
calls it a good existing choice.

**Quiz**

1. A seed script inserts a building with raw SQL and `timezone = 'Mars/Base'`. What happens, and when
   would you first notice?
2. Why did the migration need a hand edit for the feature CHECK, and why didn't `alembic check` catch the
   problem the drift test catches?
3. Why does the composite-FK probe use raw `CREATE TABLE` in the test rather than a model?
4. What would break if we removed `import app.models.registry` from `backend/migrations/env.py`?
5. How would you extend this so a unit can be archived (`is_active = false`) and a new unit in the same
   building can then reuse its tower and label?

<details><summary>Answers</summary>

1. It is stored: the validator only runs on ORM attribute sets, and there is no DB check. You'd notice
   when code first builds a `ZoneInfo("Mars/Base")` (a `ZoneInfoNotFoundError`, likely in a notice or
   booking time conversion).
2. Autogenerate emitted the check twice (from the Enum type and as a table constraint), both named
   `ck_building_features_feature`. Alembic's comparison doesn't inspect CHECK constraints at all, so
   only a test reading `pg_get_constraintdef` sees a mismatch.
3. A model would join `Base.metadata`, and `alembic check` (and the registry) would then expect a real
   table. Raw DDL inside the test transaction is rolled back and leaves the metadata alone.
4. Autogenerate would see no tables and propose dropping all three; `alembic check` (in `make check` and
   the round-trip test) would fail; `test_migrations_env_imports_the_registry` fails first.
5. Replace `uq_units_building_id_tower_label` with a partial unique index: `Index(..., "building_id",
   "tower", "label", unique=True, postgresql_where=text("is_active"), postgresql_nulls_not_distinct=True)`
   (a `UniqueConstraint` can't take a WHERE). Keep `uq_units_building_id_id`: the composite FKs need it.
   Expand/contract: create the index, then drop the old constraint, in a new migration; add tests for
   "archived + new active duplicate succeeds" and "two active duplicates still fail".

</details>
