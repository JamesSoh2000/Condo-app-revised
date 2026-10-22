# Explanation — P5-01 Package schema and state machine

> **PR:** #109 · **Source revision:** `4c792c138b959a01592b0b29ef0b98f054c56113`, the pre-merge PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (1) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 109 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `4c792c1` the diff (`git diff --stat origin/main...HEAD`, 21 files), every
> file under `backend/app/packages/`, the `seed.py` additions, the migration `87e4d8b897e7`, the
> `occupancy_window` function body in migration `8887ac143e98`, and the assertions of every test cited in §5;
> compiled `visible_packages` for a resident and a council context to get the SQL in §9; ran
> `pytest tests/packages tests/test_cli_seed.py tests/test_world.py`: 160 passed. Differences from the plan:
> size and test names, see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 1. Walkthrough variant: C (schema, and one query run from a caller to the database).

## 1. What was built and why

Packages are the reference slice: the first domain whose records belong to a unit and must be hidden from
people who don't live there. This ticket adds the `packages` table, the rules for how a package's status may
change (`backend/app/packages/state.py::assert_transition`), and the one query that decides who may see a
package (`backend/app/packages/queries.py::visible_packages`). A resident sees a package if they are its named
recipient, or if they lived in its unit when it was received; security and property management see every
package in their building; council alone sees none. Package photos are now downloadable by exactly the people
who can see the package (`backend/app/packages/photos.py::can_view_package_photo`). There are no endpoints yet:
P5-02a and P5-02b build them on this query. The seed adds 15 demo packages in Maple.

The two decisions that matter most: the database checks enforce what each *state* looks like while Python
checks which *moves* are legal (D1), and visibility is a single composable `Select` with the caller's own
membership id bound into it (D2).

## 2. Decisions

### D1. State checks make each status's columns exclusive to it

- **Problem or constraint:** the ticket listed three checks. P5-02b writes pickups (with a pickup person, its
  criterion 5) and returns (with a reason). Without more, a row could hold columns of a status it isn't in,
  such as a `received` package with a `return_reason`.
- **Chosen:** one check per status that requires that status's columns and forbids the other statuses'
  columns (`ck_packages_received_state`, `ck_packages_picked_up_state`, `ck_packages_returned_state`), plus
  `picked_up_at >= received_at` and `returned_at >= received_at`.
- **Alternatives rejected:** only the ticket's three checks (impossible rows stay representable); a trigger
  that enforces transitions (a row check can't see the old row, and the conditional
  `UPDATE … WHERE status IN (…)` that `CLAUDE.md` rule 7 prescribes already guards the edges).
- **Tradeoffs and accepted limitations:** the database checks states, not edges. Edges are checked by
  `backend/app/packages/state.py::assert_transition` and, in P5-02b, by the conditional UPDATE. An "undo
  pickup" feature would have to change these checks (it needs an ADR anyway, per P5-02b's "Out").
- **Basis:** ticket (the three checks), P5-02b's scope; autonomous for the additions.
- **Source:** recorded (PR #109 D1; ticket Frame notes, criterion 2).

### D2. `visible_packages` is one `Select` of `Package`, with grants OR-ed by role

- **Problem or constraint:** the rule must live in exactly one place (`CLAUDE.md` rule 3) and must compose
  into the list, get and summary endpoints and into the photo hook.
- **Chosen:** `select(Package).where(Package.building_id == ctx.building_id, _grant(ctx))`. Security or
  property management grants `true`. A resident gets "named recipient OR occupancy window", with
  `ctx.membership_id` bound as a parameter. Any other role set grants `false()`.
- **Alternatives rejected:** `ctx.is_staff` (`STAFF_ROLES` includes `council`, which must see none); a filter
  applied in each endpoint (several places to get wrong; the ticket's "Must explain" 3).
- **Tradeoffs and accepted limitations:** staff queries skip the window function entirely. Resident queries
  call `occupancy_window` once per candidate row in the building that isn't addressed to them by name.
- **Basis:** ticket; ADR-0016 (`occupancy_window`).
- **Source:** recorded (PR #109 D2).

### D3. The photo hook checks the attachment and the package's `photo_file_id`, then visibility

- **Problem or constraint:** P3-04b made attached package photos visible to nobody until a `can_view` hook is
  registered from a module `backend/app/main.py` imports.
- **Chosen:** `backend/app/packages/photos.py` registers `can_view_package_photo` when it is imported, and
  `backend/app/main.py` imports it at module level. The hook grants only if `file.attached_type == "package"`
  and a package *visible to the caller* has `id = file.attached_id` and `photo_file_id = file.id`.
- **Alternatives rejected:** registering inside `create_app()` (tests build several apps, and
  `backend/app/files/purposes.py::register_can_view` raises on a second registration); checking only
  `attached_id` (a file the package doesn't show would still be served).
- **Tradeoffs and accepted limitations:** a photo replaced on its package (no such flow exists yet) stops
  being viewable.
- **Basis:** ticket (P3-04b follow-up); autonomous for the two extra conditions.
- **Source:** recorded (PR #109 D3).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| The `claim_file` call goes in P5-02a's `POST /packages` | call it here | there is no write use case in this ticket; P5-02a's scope already lists it | ticket | PR #109 table; Frame notes |
| `idempotency_key`, `request_hash` NOT NULL | nullable | P5-02a requires the header; relaxing NOT NULL later is an expand step | P5-02a; autonomous | PR #109 table |
| `description` nullable | NOT NULL | optional in P5-02a's body | P5-02a | PR #109 table |
| Composite FKs `ON DELETE RESTRICT` | `SET NULL` on the photo | packages are history; `files.cleanup` deletes only unattached files | ADR-0005, P3-04c | PR #109 table |
| Seeded packages are left as they are once created | reset their times on each run | their times are relative to the first run, so there is no fixed value to restore | autonomous | PR #109 table; `backend/app/seed.py::_packages` docstring |
| Staff means security or property management, not `STAFF_ROLES` | `ctx.is_staff` | council must see none | ticket | Frame notes |

**Framing changes:** criteria 1–3 and 6 were sharpened (every composite FK by constraint name, the full set of
state checks, every pair of states, what "follows the visibility" means for the hook). Criteria 7–12 were
added: building isolation including `multi` (tenant row 3), the window's edges, the time-zone and query-shape
cases carried from P1-03, roles that grant nothing and the union, the idempotency key, and the seed. None was
loosened. The download route's name was corrected in a later ticket commit (`/download-url`).

**Plan versus final code:** compared against the PR's Plan. Two differences, both recorded in the PR below the
Plan or in its evidence table: (1) size: 524 non-test lines added against an estimate of ~360, of which 172 are
the autogenerated migration and 119 the seed (352 excluding the generated migration); not split, because the
schema and the visibility query are tested together. (2) Some test names differ from the Plan's tentative ones
(for example `test_record_times_are_timestamptz`, not `test_times_are_timestamptz`); the evidence table names
the real ones.

## 3. How it is implemented

### Overview

- **Table** `packages` (`backend/app/packages/models.py::Package`, migration `87e4d8b897e7`): six composite
  FKs, one unique key, five row checks plus the enum check, three indexes.
- **State rules** (`backend/app/packages/state.py::ALLOWED`): `received → picked_up | returned`; nothing else.
- **Visibility** (`backend/app/packages/queries.py::visible_packages`): a `Select` built from the tenant
  context alone.
- **Photo hook** (`backend/app/packages/photos.py::can_view_package_photo`): registered for
  `FilePurpose.PACKAGE_PHOTO` on import; `backend/app/files/service.py::download_url` asks it.
- **Seed** (`backend/app/seed.py::_packages`): 15 Maple packages keyed by `idempotency_key`.

### Walkthrough (variant C: a resident's visibility query, from caller to rows)

1. **Trigger.** A caller holds a `TenantContext` built by `get_tenant_context` from the session (in this
   ticket, a test or the photo hook) and calls `visible_packages(ctx)`.
2. **Building filter.** `visible_packages` always adds `packages.building_id = :ctx.building_id`, whatever the
   roles.
3. **Grant.** `backend/app/packages/queries.py::_grant` checks the roles in order: any of security or property
   management → `true`; else resident → `recipient_membership_id = :membership OR
   public.occupancy_window(:membership, packages.unit_id, packages.received_at)`; else `false`. Both
   `:membership` parameters are `ctx.membership_id`.
4. **Database.** `occupancy_window` (migration `8887ac143e98`, ADR-0016) is a `STABLE` SQL function that
   returns whether that membership has an occupancy of that unit with
   `started_at <= received_at AND (ended_at IS NULL OR ended_at > received_at)`: a half-open window.
5. **Result.** The caller narrows it (`.where(Package.status == …)`), wraps it (`.subquery()`) or tests it
   (`.exists()`, as the photo hook does). The SQL for a resident is in §9.
6. **Failure modes.** A context with no granting role yields `WHERE false` (an empty result, not an error).
   A wrong building id yields nothing from another building, because the filter is on the record itself.

### Data model changes

| Column / constraint | What it prevents |
|---|---|
| `unit_id`, `recipient_membership_id`, `received_by_membership_id`, `picked_up_by_membership_id`, `handed_out_by_membership_id`, `photo_file_id`: each with a composite FK `(building_id, x)` → `(building_id, id)` | A package in building A naming building B's unit, member or file (ADR-0005). |
| `received_at`, `picked_up_at`, `returned_at` are `timestamptz`; `received_at` defaults to `now()` | A naive time is read in the session's time zone, which moved the window in P1-03 review round 5 (a new occupant saw the former occupant's record). |
| `ck_packages_received_state` | A waiting package with pickup or return details. |
| `ck_packages_picked_up_state` | A pickup without a time, without the staff member who handed it out, or with nobody recorded as collecting it; a pickup with return details. |
| `ck_packages_returned_state` | A return without a time or reason; a return with pickup details. |
| `ck_packages_picked_up_after_received`, `ck_packages_returned_after_received` | Events dated before the package arrived. |
| `ck_packages_package_status` | A status outside the three values. |
| `uq_packages_building_id_idempotency_key`; `idempotency_key`, `request_hash` NOT NULL | Two packages from one retried create request (P5-02a). The same key in another building is allowed. |
| `ix_packages_building_id_status_received_at`, `ix_packages_building_id_unit_id_received_at` (both `received_at DESC`), `ix_packages_recipient_membership_id` | Slow desk lists, per-unit lists and the "named recipient" branch of the resident grant. |

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/packages/models.py` | `Package`, `PACKAGE_ATTACHED_TYPE` | +128 |
| `backend/migrations/versions/87e4d8b897e7_packages_p5_01.py` | create `packages` (autogenerated, edited) | +172 |
| `backend/app/packages/queries.py` | `visible_packages` | +39 |
| `backend/app/packages/photos.py` | `can_view_package_photo`, registration | +27 |
| `backend/app/packages/state.py` | `ALLOWED`, `InvalidTransition`, `assert_transition` | +26 |
| `backend/app/packages/enums.py` | `PackageStatus` | +9 |
| `backend/app/seed.py` | `SeedPackage`, `PACKAGES`, `_packages` | +119 |
| `backend/app/main.py`, `backend/app/models/registry.py` | import the hook; register the model | +4 |
| `backend/tests/packages/*` | conftest and five test files | +938 |
| `backend/tests/test_cli_seed.py`, `backend/tests/test_world.py` | count packages too | +5 |
| `docs/tickets/P5-01-…md`, `docs/tickets/README.md` | frame; in progress | +75/−8 |

`backend/app/packages/queries.py::visible_packages`

```python
_SEE_ALL = (Role.SECURITY, Role.PROPERTY_MANAGEMENT)


def visible_packages(ctx: TenantContext) -> Select[Package]:
    # ...
    return select(Package).where(Package.building_id == ctx.building_id, _grant(ctx))


def _grant(ctx: TenantContext) -> ColumnElement[bool]:
    if ctx.has_any(*_SEE_ALL):
        return true()
    if ctx.has_any(Role.RESIDENT):
        # Always the context's own membership, never a value from the request.
        return or_(
            Package.recipient_membership_id == ctx.membership_id,
            occupancy_window_clause(ctx.membership_id, Package.unit_id, Package.received_at),
        )
    return false()
```

- Builds the whole visibility rule from the context. The order of the checks gives the union for multi-role
  callers: anyone with a see-all role gets everything, which is a superset of the resident grant.
- Why: D2. Without the building filter, staff would see every building's packages (mutation probe: 7 tests
  fail). With `ctx.is_staff` instead of `_SEE_ALL`, council sees everything (mutation probe: 3 tests fail).

`backend/app/packages/photos.py::can_view_package_photo`

```python
async def can_view_package_photo(ctx: TenantContext, file: File, db: AsyncSession) -> bool:
    """The file is attached to a package the caller may see, and is that package's photo."""
    if file.attached_type != PACKAGE_ATTACHED_TYPE:
        return False
    shown = visible_packages(ctx).where(
        Package.id == file.attached_id, Package.photo_file_id == file.id
    )
    return bool(await db.scalar(select(shown.exists())))


register_can_view(FilePurpose.PACKAGE_PHOTO, can_view_package_photo)
```

- Called by `backend/app/files/service.py::download_url` (through `_may_view`) only for a `ready` file of the
  caller's building that is attached. It reuses `visible_packages`, so the photo's rule cannot drift from the
  package's.
- Why: D3. Remove the `attached_type` check and a package photo attached to another record type becomes
  viewable through any visible package with the same id (mutation probe:
  `test_a_photo_attached_to_another_record_type_is_refused` fails). Remove the `photo_file_id` condition and a
  stray file attached to a package is served (two tests fail).

`backend/app/packages/state.py::assert_transition`

```python
ALLOWED: Mapping[PackageStatus, frozenset[PackageStatus]] = {
    PackageStatus.RECEIVED: frozenset({PackageStatus.PICKED_UP, PackageStatus.RETURNED}),
}


class InvalidTransition(Conflict):
    code = "invalid_transition"


def assert_transition(from_: PackageStatus, to: PackageStatus) -> None:
    """Raise `InvalidTransition` (409) unless a package may move from `from_` to `to`."""
    if to not in ALLOWED.get(from_, frozenset()):
        raise InvalidTransition(detail=f"A {from_} package can't become {to}.")
```

- Pure logic: a status missing from `ALLOWED` is final. `InvalidTransition` follows the per-domain pattern
  (`backend/app/units/service.py::InvalidTransition`) and maps to a 409 problem with `code`
  `invalid_transition`.

`backend/app/packages/models.py::Package` (the state checks)

```python
        CheckConstraint(
            f"status <> 'received' OR ({_null(_PICKUP_COLUMNS + _RETURN_COLUMNS)})",
            name="received_state",
        ),
        CheckConstraint(
            "status <> 'picked_up' OR (picked_up_at IS NOT NULL"
            " AND handed_out_by_membership_id IS NOT NULL"
            " AND (picked_up_by_membership_id IS NOT NULL OR picked_up_by_name IS NOT NULL)"
            f" AND {_null(_RETURN_COLUMNS)})",
            name="picked_up_state",
        ),
        CheckConstraint(
            "status <> 'returned' OR (returned_at IS NOT NULL AND return_reason IS NOT NULL"
            f" AND {_null(_PICKUP_COLUMNS)})",
            name="returned_state",
        ),
        CheckConstraint("picked_up_at >= received_at", name="picked_up_after_received"),
        CheckConstraint("returned_at >= received_at", name="returned_after_received"),
```

- Each check is an implication: "if the status is X, then X's shape". A NULL time makes the ordering checks
  pass, which is what a `received` row needs.
- Why: D1. The migration repeats these strings literally (`backend/migrations/versions/87e4d8b897e7_packages_p5_01.py::upgrade`);
  `alembic check` reported no drift.

`backend/tests/packages/test_visibility.py::test_an_hour_before_a_move_stays_on_its_side_in_toronto_time`

```python
    security = world.a_security.membership
    formers_last_hour = await make_package(
        db, world.a_101, security, received_at=World.T1 - timedelta(hours=1)
    )
    before_resident1 = await make_package(
        db, world.a_101, security, received_at=World.T2 - timedelta(hours=1)
    )
    await db.execute(text("SET LOCAL TimeZone = 'America/Toronto'"))

    former = await seen(db, visible_packages(persona_ctx(world, "a_former")))
    resident1 = await seen(db, visible_packages(persona_ctx(world, "a_resident1")))

    assert formers_last_hour.id in former
    assert before_resident1.id not in resident1
```

- The hardest carried criterion: a naive `received_at` read in Toronto time (4 hours behind UTC in July)
  would land an hour-before-the-move package 3 hours after it. With the migration mutated to a naive column,
  this test fails (mutation probe, PR #109).

## 5. Edge cases and tests

All tests are under `backend/tests/packages/` unless named otherwise; run at the source revision.

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| A package names another building's unit, member or file | composite FK rejects it | `backend/tests/packages/test_schema.py::test_a_reference_to_another_building_is_rejected` (6 cases, each asserting its constraint name) |
| A row's columns contradict its status | the state checks reject it | `backend/tests/packages/test_schema.py::test_state_checks_reject_a_row_that_breaks_its_state` (19 cases), `::test_a_valid_row_of_each_state_is_accepted` |
| An illegal move (e.g. `picked_up → received`, or staying put) | `InvalidTransition`, 409 `invalid_transition` | `backend/tests/packages/test_state.py::test_every_other_transition_is_invalid`, `::test_picked_up_back_to_received_is_invalid` |
| A new occupant sees the former occupant's package | the window, not "ever lived here" | `backend/tests/packages/test_visibility.py::test_visibility_by_persona` (`a_resident1` sees P1 only, `a_former` P0 only) |
| The window's edges are off by one | half-open window | `backend/tests/packages/test_visibility.py::test_a_package_received_at_the_instant_a_former_left_is_not_theirs`, `::test_a_package_received_at_the_instant_resident1_moved_in_is_theirs` |
| The named recipient is hidden by the window | recipient OR window | `backend/tests/packages/test_visibility.py::test_named_recipient_sees_a_package_received_before_their_occupancy`, `::test_named_recipient_sees_it_for_a_unit_they_never_lived_in` |
| Naming a recipient hides the package from the unit's occupant | the grants are a union | `backend/tests/packages/test_visibility.py::test_naming_a_recipient_hides_nothing_from_the_units_occupant` |
| Council sees packages | council isn't a granting role | `backend/tests/packages/test_visibility.py::test_visibility_by_persona` (`a_council`), `::test_a_context_without_a_granting_role_sees_nothing` |
| A user's role in one building is applied in another | the building filter is on the record | `backend/tests/packages/test_visibility.py::test_multi_sees_only_its_own_buildings_packages_with_each_membership`, `::test_a_context_never_reaches_another_buildings_packages` |
| The session's time zone moves the window | `timestamptz` columns | `backend/tests/packages/test_schema.py::test_record_times_are_timestamptz`, `backend/tests/packages/test_visibility.py::test_an_hour_before_a_move_stays_on_its_side_in_toronto_time`, `::test_visibility_unchanged_in_toronto_time` |
| A composed query resolves a column against the wrong table | `occupancy_window` takes values, not names | `backend/tests/packages/test_visibility.py::test_the_query_composes_with_an_alias_and_an_occupancy_join` |
| A client value reaches the query | only `ctx.building_id` and `ctx.membership_id` are bound | `backend/tests/packages/test_visibility.py::test_the_query_selects_packages_by_building_and_the_contexts_membership` |
| The hook isn't registered in the server process | `app.main` imports `app.packages.photos` | `backend/tests/packages/test_photos.py::test_importing_the_app_alone_registers_the_package_photo_hook` (fresh interpreter) |
| A photo is served to someone who can't see its package | the hook reuses `visible_packages` | `backend/tests/packages/test_photos.py::test_the_photo_follows_the_packages_visibility`, `::test_download_url_follows_the_package` (200 / the same 404 body as a random id) |
| A file attached elsewhere, or not the package's photo, is served | `attached_type` and `photo_file_id` conditions | `backend/tests/packages/test_photos.py::test_a_photo_attached_to_another_record_type_is_refused`, `::test_a_photo_its_package_doesnt_show_is_refused`, `::test_a_photo_attached_to_a_package_that_names_another_file_is_refused` |
| A retried create inserts twice | unique `(building_id, idempotency_key)` | `backend/tests/packages/test_schema.py::test_idempotency_key_is_unique_per_building`, `::test_the_same_idempotency_key_in_two_buildings_is_allowed`, `::test_idempotency_columns_are_required` |
| The seed duplicates packages or creates invalid ones | found by key; rows pass the checks on insert | `test_seed_packages.py` (3 tests), `backend/tests/test_cli_seed.py::test_seed_twice_keeps_row_counts_and_ids` |

Acceptance criteria → tests: 1 `test_a_reference_to_another_building_is_rejected`; 2 the state-check tests;
3 `test_state.py`; 4 `test_visibility_by_persona`; 5 the three named-recipient tests; 6 `test_photos.py`;
7 the two `multi`/isolation tests; 8 the two edge tests; 9 the time-zone tests, the query-shape test and the
compose test; 10 the three idempotency tests; 11 the no-grant and union tests; 12 `test_seed_packages.py`, plus
the stack transcript in PR #109.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6-astra` (medium effort), fresh, the sole Tier 1 reviewer on James's instruction for this run; security pass included | `4c792c1` | `MERGE` | none | — |

No finding changed the code or the design. Codex ran `make test` (2214 passed), ruff, the format check, mypy,
`git diff --check` and a migration proof of its own (upgrade, downgrade, re-upgrade, indexes, schema
comparison: 1 passed; the proof file was scratch and was deleted).

## 7. Not verified, accepted risks and follow-ups

- **No endpoint exists yet**, so tenant rows 1, 2, 4 and 6 (role gates, unauthenticated, pending and
  suspended members) and rows 8–10 (transitions, retries and concurrency over HTTP) are untested here; they
  belong to P5-02a and P5-02b. Only the photo download goes through HTTP.
- **Query cost is unmeasured.** No `EXPLAIN` was run; the indexes follow the ticket. A resident's query calls
  `occupancy_window` per candidate row in the building.
- **No relationships on `Package`**, so a flush that inserts a package together with a new unit or membership
  in one batch isn't ordered by the FKs. Every caller today flushes those first. Tracked in PR #109's
  follow-ups.
- **Empty strings pass the checks.** A `picked_up_by_name` or `return_reason` of `''` satisfies "IS NOT NULL".
  Input validation in P5-02b has to refuse them. No test covers this. Tracked only here.
- **`claim_file` in the create use case** moves to P5-02a (already in its scope; PR #109 follow-ups). Until
  then, no code attaches package photos outside the tests.
- **Flaky test seen once:** `backend/tests/memberships/test_members_concurrency.py::test_stale_clock_is_occupancy_changed`
  (`deactivate`) failed once under the full local suite and then passed 5/5 alone and in the next full run.
  It isn't touched by this ticket. Tracked in PR #109's follow-ups.

## 8. How to change this safely

- **A new state or move** (e.g. "lost"): add it to `PackageStatus`, `ALLOWED`, a new state check and the other
  checks' forbidden columns, and write a migration that alters the non-native enum's check (see
  `backend/migrations/versions/f727e687ccf2_files_cleanup_p3_04c.py::upgrade` for the pattern).
  `test_state.py` and `backend/tests/packages/test_schema.py::_invalid_rows` will tell you what you missed.
- **A new role that sees packages:** change `_grant` only. `backend/tests/packages/test_visibility.py::EXPECTED` is the persona table
  to extend. Never filter packages anywhere else.
- **Another domain copying the pattern:** copy `visible_packages` and the hook's shape (`attached_type`, then
  the record's own file column, then visibility), and import the hook module from `backend/app/main.py`.

## 9. Must explain, then quiz

**1. Why can't `a_resident1` see P0? The actual SQL.** For a resident, `visible_packages(ctx)` compiles to
(the select list trimmed to `id`):

```sql
SELECT packages.id
FROM packages
WHERE packages.building_id = %(building_id_1)s::UUID
  AND (packages.recipient_membership_id = %(recipient_membership_id_1)s::UUID
       OR public.occupancy_window(%(occupancy_window_1)s::UUID, packages.unit_id, packages.received_at))
```

Both membership parameters are `a_resident1`'s membership id. P0 is in Maple, so the first condition holds;
it names no recipient, so the second is false; it stays only if `occupancy_window(a_resident1, 101, T0 + 1 day)`
is true. That function looks for an occupancy of 101 by `a_resident1` with
`started_at <= T0 + 1 day < ended_at`. `a_resident1`'s only occupancy starts at T2 (2025-07-15), after
T0 + 1 day, so there is none, and P0 is filtered out. `a_former` does have a 101 occupancy covering that
instant, which is why they see P0. Proven by `backend/tests/packages/test_visibility.py::test_visibility_by_persona`.

**2. Why put the rules both in Python (`ALLOWED`) and in check constraints?** They check different things (D1).
The checks enforce what a row in each state looks like, so no write path (a service, a seed, a manual SQL fix)
can store a contradictory row. A row check can't see the row's previous value, so it can't say "picked up may
not become received". `ALLOWED` states the legal moves for services to check and report as a 409. P5-02b will
also put the from-states in the conditional `UPDATE … WHERE status IN (…)`, which makes the check and the write
one atomic statement under concurrency.

**3. Why is visibility a reusable `Select` rather than a filter in each endpoint?** One definition means list,
get, summary and the photo hook cannot disagree. A missed filter in one endpoint would leak packages, and a
`Select` composes: the hook narrows it and tests `.exists()`
(`backend/app/packages/photos.py::can_view_package_photo`), and the list endpoint will add `.where` and order by.
`backend/tests/packages/test_visibility.py::test_the_query_composes_with_an_alias_and_an_occupancy_join` proves the result is the same
when composed (recorded: ticket, D2).

**Quiz**

1. A package for unit 101 is received exactly at T1. Which of `a_former`, `a_resident1` and `a_security` see it,
   and why?
2. Why does the photo hook check `Package.photo_file_id == file.id` when `claim_file` already set
   `file.attached_id` to the package?
3. Why is `received_at` `timestamptz`, and what did a naive column break in P1-03?
4. What would break if `_grant` used `ctx.is_staff` instead of `_SEE_ALL`?
5. How would you extend this so council members see waiting-package *counts* per floor without seeing the
   packages themselves?

<details><summary>Answers</summary>

1. Only `a_security`. The window is half-open: `a_former`'s 101 occupancy ends at T1 (`ended_at > T1` is
   false), and `a_resident1`'s starts at T2. Staff see every package. Test:
   `test_a_package_received_at_the_instant_a_former_left_is_not_theirs`.
2. The attachment says which record owns the file; the package's own column says which file it shows. Requiring
   both means a file attached to the package but not shown by it (a stray, a replaced photo) isn't served.
   Test: `test_a_photo_attached_to_a_package_that_names_another_file_is_refused`.
3. `occupancy_window` takes a `timestamptz`. A naive value is cast in the session's time zone, so in
   `America/Toronto` it shifts by 4–5 hours and can cross a move: in P1-03 review round 5, a new occupant saw
   the former occupant's record.
4. `STAFF_ROLES` includes `council`, so council would see every package in the building, against the ticket.
   Three tests fail (mutation probe in PR #109).
5. Not by widening `visible_packages`: council must still see no rows. Add a separate aggregate query (count of
   `received` packages grouped by the unit's floor, filtered by building) behind a council-only endpoint,
   returning numbers only, and test that it exposes no package ids. Inferred: the ticket says "aggregates
   only, later" without a design.

</details>
