# Explanation — P5-03a Package desk read fields

> **PR:** #116 · **Source revision:** `d9355cb`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (2) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 116 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `d9355cb` the diff (`git diff origin/main...HEAD`), `backend/app/packages/`
> `service.py`, `schemas.py`, `queries.py` and `router.py` in full where cited, `backend/app/core/pagination.py::paginate`,
> the assertions of every test cited in §5 (`backend/tests/packages/test_desk_fields.py`, `backend/tests/packages/test_api.py::_out`), the PR
> body and both review reports; captured the SQL the list runs (a scratch test with a `before_cursor_execute`
> listener, deleted after); ran `make test PYTEST_ADDOPTS="tests/packages"`: 297 passed. That pass found the
> `Result.tuples()` deprecation (§6), fixed before round 2. Differences from the plan: see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 1. Walkthrough variant: A.

## 1. What was built and why

Every package the API returns (`PackageOut`) now carries the unit's current `unit_tower` and `unit_label`, and,
for the front desk only, the recipient's current `recipient_name`. `GET /packages` gains a `?carrier=` filter
that ignores case. No endpoint, role, table or migration changed.

The desk's waiting list (P5-03b) shows each package's unit and recipient and filters by carrier; before this,
the API named the unit and recipient by id only. The two decisions that matter: the names come from the API
in two batched lookups per response (not a client-side join), and residents get `recipient_name: null`
always, so this change shows them nothing they couldn't see before.

This is the first of four parts: P5-03 was split while framing into P5-03a (this), P5-03b (page and list),
P5-03c (log panel) and P5-03d (pickup and return dialogs).

## 2. Decisions

### D1. The unit and recipient come from the API, not a client-side join

- **Problem or constraint:** the waiting list shows a unit and a recipient per row; `PackageOut` had only
  `unit_id` and `recipient_membership_id`. P5-02a left it open: "add them to the API (additive) or join
  client-side from the units list, and decide while framing".
- **Chosen:** three additive fields on `PackageOut`, filled by `backend/app/packages/service.py::_outs` with
  one units query and at most one names query per response, whatever the page size.
- **Alternatives rejected:** a client-side join from `units_list` (paged at 100, so a big building needs
  several requests before the first row) plus `units_occupants` per unit (one request per row's unit, and it
  lists current occupants only, so a recipient who moved out would have no name).
- **Tradeoffs and accepted limitations:** every response that returns a package costs one or two more
  statements, also for one package (create, get, pickup, return).
- **Basis:** ticket carry from P5-02a; autonomous (decision rule 3: the simplest reversible option).
- **Source:** recorded (PR #116 D1; ticket Frame notes).

### D2. `recipient_name` is for security and property management only

- **Problem or constraint:** residents read `PackageOut` too. A resident sees packages received at their
  unit while they lived there, including ones addressed to a co-occupant, and no other endpoint shows a
  resident another member's name. The P5-02b carry warned: "staff-only fields need care".
- **Chosen:** `backend/app/packages/queries.py::sees_recipient_names` is true for a caller with `security` or
  `property_management` in this building; for everyone else `_outs` skips the names query, and
  `recipient_name` is null, even on a package addressed to the caller.
- **Alternatives rejected:** the name for everyone who sees the package (widens what residents learn about
  co-occupants and former co-occupants, a privacy call P5-04 doesn't need); a separate desk schema or endpoint
  (two response shapes for one list, more code for the same rule).
- **Tradeoffs and accepted limitations:** the field's meaning depends on the caller's role. The OpenAPI
  description says so (`backend/app/packages/schemas.py::PackageOut`). A resident who wants "is it for me?" compares
  `recipient_membership_id` with their own membership id.
- **Basis:** P5-02b carry; autonomous. Lasting (P5-04 reads `PackageOut`), so it is in the inbox's
  "Decisions to audit".
- **Source:** recorded (PR #116 D2).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Unit search stays the existing `?unit_id=` | a unit-label search on `/packages` | P5-03b picks the unit with `units_list`, which already searches | existing API | PR table |
| Carrier matches the whole value ignoring case, with `lower()` in Postgres on both sides | Python `.lower()` on the parameter; `ILIKE` | Python and Postgres lower-case some letters differently; `ILIKE` treats `%` and `_` as wildcards | autonomous | PR table |
| The parameter uses the create body's `Carrier` type | a plain string | a NUL or control character would reach Postgres (the CLAUDE.md lesson) | convention | PR table |
| Live values (the unit's and user's current names), not copies on the package | denormalized columns | a migration, and stale after a rename | autonomous | PR table |
| Who collected a package and the return reason stay out | add them now | the waiting list shows `received` packages only | ticket scope | PR table, ticket "Out" |

**Framing changes:** the split itself (first commit). The original P5-03 criteria are all kept: 5 in P5-03b;
1, 2 and 4 in P5-03c; 3 in P5-03d. P5-05 now depends on P5-03c and P5-03d. This part's six criteria are new,
from the P5-02a carry and the original "filter by carrier"; missed cases added: renames, a deactivated unit,
a suspended or moved-out recipient, control characters, the statement count. Nothing loosened.

**Plan versus final code** (also in the PR, below the Plan):
- The builder is the private `_outs` (with `_out` for one package), not a public `package_outs`: only the
  service calls it.
- The plan listed an invalid UTF-8 escape (`%ED%A0%80`) among the 422 cases. Starlette decodes the query
  string with replacement characters, which are printable, so it is a valid carrier that matches nothing:
  `test_an_undecodable_carrier_escape_is_not_a_server_error` asserts the empty page.
- Two tests beyond the plan: `test_a_resident_runs_no_name_lookup`, `test_a_carrier_of_50_characters_is_accepted`.

## 3. How it is implemented

### Overview

- `backend/app/packages/schemas.py::PackageColumns` holds the package row's own fields; `backend/app/packages/schemas.py::PackageOut` extends it with
  `unit_tower`, `unit_label` and `recipient_name`.
- `backend/app/packages/service.py::_outs` turns a list of `PackageColumns` into `PackageOut`s: one units query, and for the desk
  one names query. `backend/app/packages/service.py::_out` wraps it for one package.
- Every service function that returns a package goes through them: `create_package` (also both `_replay`
  paths), `list_packages`, `get_package`, `pickup_package`, `return_package`.
- `list_packages` maps the page with `PackageColumns.model_validate`, then calls `_outs` once for the page.
- `backend/app/packages/router.py::list` takes `carrier` as `Carrier | None`; `list_packages` adds the `lower() = lower()` filter.

### Walkthrough (variant A): `GET /api/buildings/{b}/packages?status=received&carrier=ups` as security

1. **HTTP:** `backend/app/packages/router.py::list`. FastAPI validates `carrier` with the `Carrier` type
   (`backend/app/packages/schemas.py::Carrier`): `printable_before_strip` refuses control characters on the raw value, then the
   value is stripped and must be 1–50 characters. A failure is 422 `validation_error` before any query.
2. **Dependencies:** unchanged: session, `get_tenant_context` (the caller's roles in this building), the
   `packages` feature.
3. **Service:** `backend/app/packages/service.py::list_packages` starts from `visible_packages(ctx)` (CLAUDE.md rule 3) and adds
   the filters; `paginate` reads one page plus one row, newest first.
4. **Database:** the three statements after the tenant context, captured at the source revision:

```sql
SELECT packages.building_id, packages.unit_id, ... packages.id, packages.created_at, packages.updated_at
FROM packages
WHERE packages.building_id = $1::UUID AND packages.status = $2 AND lower(packages.carrier) = lower($3::VARCHAR)
ORDER BY packages.id DESC LIMIT $4::INTEGER

SELECT units.id, units.tower, units.label
FROM units
WHERE units.building_id = $1::UUID AND units.id IN ($2::UUID)

SELECT building_memberships.id, users.full_name
FROM building_memberships JOIN users ON users.id = building_memberships.user_id
WHERE building_memberships.building_id = $1::UUID AND building_memberships.id IN ($2::UUID)
```

   As a resident, the visibility condition is added to the first statement and the third never runs.
5. **Side effects:** none (a read).
6. **Response:** `Page[PackageOut]`. On the stack (PR #116 transcript), security's
   `?status=received&carrier=amazon` returned `Amazon | None 201 | Kim Laurent`, `Amazon | None 304 | None`,
   `Amazon | None 101 | Alex Chen`; resident Alex Chen's `?carrier=AMAZON` returned only unit 101's, with
   `recipient_name` null.

### Data model changes

None. The lookups rely on the existing composite foreign keys `(building_id, unit_id)` and
`(building_id, recipient_membership_id)` on `packages` (`backend/app/packages/models.py::_composite_fk`), which
keep the unit and the recipient in the package's building.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/packages/schemas.py` | `PackageColumns`; `PackageOut` adds the three fields | +16/−2 |
| `backend/app/packages/queries.py` | `sees_recipient_names` | +6/−0 |
| `backend/app/packages/service.py` | `_outs`, `_out`; every return path uses them; carrier filter | +72/−10 |
| `backend/app/packages/router.py` | `carrier` query parameter | +6/−2 |
| `frontend/src/api/schema.d.ts` | regenerated | +11/−0 |
| `backend/tests/packages/test_desk_fields.py` | new: criteria 1–5 | +470 |
| `backend/tests/packages/test_api.py` | `_out` exact bodies include the fields | +9/−5 |
| `docs/tickets/…`, `docs/ROADMAP.md` | the split | docs |

**Key excerpts.**

`backend/app/packages/service.py::_outs`

```python
async def _outs(
    db: AsyncSession, ctx: TenantContext, packages: Sequence[PackageColumns]
) -> list[PackageOut]:
    """`packages` with their units' current tower and label and, for the desk, their recipients'
    current names (P5-03a): two statements at most, however many packages."""
    if not packages:
        return []
    units = {
        row.id: row
        for row in await db.execute(
            select(Unit.id, Unit.tower, Unit.label).where(
                Unit.building_id == ctx.building_id,
                Unit.id.in_({package.unit_id for package in packages}),
            )
        )
    }
    recipient_ids = {
        package.recipient_membership_id
        for package in packages
        if package.recipient_membership_id is not None
    }
    names: dict[UUID, str] = {}
    if recipient_ids and sees_recipient_names(ctx):
        rows = await db.execute(
            select(BuildingMembership.id, User.full_name)
            .join(User, User.id == BuildingMembership.user_id)
            .where(
                BuildingMembership.building_id == ctx.building_id,
                BuildingMembership.id.in_(recipient_ids),
            )
        )
        names = {membership_id: full_name for membership_id, full_name in rows}
    return [
        PackageOut(
            **package.model_dump(),
            # The composite FKs keep both in the package's building, so the lookups find them.
            unit_tower=units[package.unit_id].tower,
            unit_label=units[package.unit_id].label,
            recipient_name=(
                None
                if package.recipient_membership_id is None
                else names.get(package.recipient_membership_id)
            ),
        )
        for package in packages
    ]
```

- Collects the page's unit and recipient ids into sets and asks for each set once, so the statement count
  doesn't grow with the page (criterion 5).
- Both lookups filter by `ctx.building_id` as well as by id (CLAUDE.md rules 1–2), although the composite
  FKs already keep the rows in the building.
- The names query runs only when `sees_recipient_names(ctx)` (D2). Without that condition a resident would
  get co-occupants' names: mutation m1 in the PR makes three tests fail.
- `units[...]` raises `KeyError` if a unit row were missing; the composite FK makes that unreachable.
  `names.get` returns null for a missing membership, which the same FK also rules out.

`backend/app/packages/service.py::list_packages`

```python
    if carrier is not None:
        # Both sides lower-cased by Postgres: Python's `str.lower` differs for some letters.
        stmt = stmt.where(func.lower(Package.carrier) == func.lower(carrier))
    page = await paginate(db, stmt, Package.id, params, PackageColumns.model_validate)
    return Page[PackageOut](items=await _outs(db, ctx, page.items), next_cursor=page.next_cursor)
```

- The filter joins `status` and `unit_id` inside `visible_packages(ctx)`, so the cursor pages through the
  filtered list only.
- `paginate` can't enrich rows (its mapper is synchronous and gets one row at a time), so the page is mapped
  to `PackageColumns` first and enriched once for the whole page. Mapping each row through `_out` instead
  would cost two statements per row: mutation m3 makes the statement-count test fail.
- Python's `"İ".lower()` is `"i̇"` (`i` plus a combining dot, two code points); Postgres's `lower()` gives `i`
  (checked on the dev database, collation `en_US.utf8`). Lowering only the parameter in Python would miss a
  carrier spelled with it: mutation m2 fails `test_postgres_lowercases_the_carrier`.

`backend/app/packages/queries.py::sees_recipient_names` and `backend/app/packages/schemas.py::PackageOut`

```python
def sees_recipient_names(ctx: TenantContext) -> bool:
    """True if the caller is shown the names of the packages' recipients: the desk only (P5-03a).
    A resident sees packages addressed to a co-occupant, and no other route shows them that name."""
    return ctx.has_any(*_SEE_ALL)
```

```python
class PackageOut(PackageColumns):
    # The unit's current tower and label (P5-03a).
    unit_tower: str | None
    unit_label: str
    recipient_name: str | None = Field(
        description=(
            "The recipient's current full name, for security and property management only; null "
            "for every other caller, and for a package addressed to the unit."
        )
    )
```

- The rule sits in `queries.py` next to `visible_packages`, the module that already decides who sees what,
  and reuses its `_SEE_ALL` (security, property management; not council).
- `ctx.has_any` checks the caller's roles in the URL's building, so a user who is security in one building and
  a resident in another gets names in the first only.
- `Field(description=...)` without a default keeps the field required, so every `PackageOut` built anywhere
  must pass it; the description reaches `schema.d.ts`.

## 5. Edge cases and tests

All in `backend/tests/packages/test_desk_fields.py` unless named; that file runs with SQLAlchemy deprecation
warnings as errors.

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| An endpoint returns a package without the fields | all six paths go through `_out`/`_outs` | `test_every_package_endpoint_names_the_unit` (create, replay, list, get, pickup, return) |
| A replay returns other fields than the first 201 (row 9) | both build from the same row | same test: `_fields(created) == _fields(replayed)` |
| A renamed or deactivated unit shows its old name | live lookup | `test_a_deactivated_or_renamed_unit_shows_its_current_name` |
| A suspended, moved-out or renamed recipient loses their name for the desk | live lookup by membership, whatever its status | `test_the_desk_sees_the_recipients_current_name[a_security,a_manager]` |
| A unit package gets a name | null when no recipient | `test_a_unit_package_has_no_recipient_name` |
| A resident sees a co-occupant's name, or their own | names query skipped | `test_residents_never_see_a_recipient_name` (resident; council + resident on a co-occupant's and on their own) |
| A multi-building user gets names in the building where they are a resident | per-building roles | `test_recipient_names_follow_the_role_in_this_building` |
| The resident's response runs the names query anyway | skipped | `test_a_resident_runs_no_name_lookup` (one statement fewer than security's) |
| Carrier case, combination, paging, no match | `lower() = lower()` inside the visible query | `test_the_list_filters_by_carrier_ignoring_case` (also not `UPS Store`), `test_the_carrier_filter_combines_with_status_and_unit`, `test_the_cursor_pages_through_the_filtered_list`, `test_no_carrier_match_is_an_empty_page` |
| Python and Postgres lower-case differently | both sides in Postgres | `test_postgres_lowercases_the_carrier` |
| Blank, 51 characters, NUL, tab, newline | 422 before any query | `test_an_invalid_carrier_filter_is_a_422` (7 cases); `test_a_carrier_of_50_characters_is_accepted` |
| An undecodable escape | decoded to U+FFFD, matches nothing | `test_an_undecodable_carrier_escape_is_not_a_server_error` |
| Tenant rows 2, 3, 5, 6 with the filter | unchanged guards | `test_the_carrier_filter_without_a_session_is_401`, `test_non_members_and_suspended_members_get_404_with_a_carrier_filter[b_manager,a_pending,a_suspended]`, `test_a_residents_carrier_filter_lists_only_their_packages`, `test_council_alone_lists_nothing_with_a_carrier_filter` |
| A query per row | ids batched per page | `test_a_page_of_25_runs_as_many_statements_as_a_page_of_1[a_security,a_resident1]` |

Acceptance criteria → tests:
1. Unit fields: `test_every_package_endpoint_names_the_unit`, `test_a_deactivated_or_renamed_unit_shows_its_current_name`.
2. Recipient name: the four criterion-2 tests above.
3. Carrier filter: the seven carrier tests above.
4. Tenant table: the rows above; rows 4, 7, 8, 10 n/a (no role, body id, transition or race changes; the
   P5-02a/b tests still pass).
5. No query per row: the statement-count test (both personas).
6. Contract: `chore(api): regenerate schema.d.ts …`; CI's drift check green on `d9355cb`.

Mutation probes (`scripts/mutation-probe.sh`, PR #116): m1 names for every caller, m2 Python `.lower()`, m3
one `_outs` per row, m4 no carrier filter: each made the named tests fail and passed restored.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol` (high), fresh, with the security pass | `10185a7` | `MERGE` | none; 6 probes of its own passed | — |
| reality pass | implementer, step 6 | `10185a7` | finding | Low: `Result.tuples()` deprecated in SQLAlchemy 2.1 | fixed in `e06f89e`, test `062813f` |
| 2 | Codex `gpt-6.1-sol` (high), fresh, whole diff again | `d9355cb` | `MERGE` | none; 8 probes passed | — |

The reviewer set was James's instruction for this run: Codex `gpt-6.1-sol` at high effort as the only
reviewer, instead of the playbook's Tier 1 pair (a Claude reviewer with the security pass plus Codex
`gpt-6-astra`).

**The one fix.** The SQL capture for this explanation printed `SADeprecationWarning: The Result.tuples() method
is deprecated` from `_outs`. Failure: a SQLAlchemy release that removes it breaks every desk response that
names a recipient. Evidence: `pytest -W error::sqlalchemy.exc.SADeprecationWarning tests/packages/test_desk_fields.py` (in `backend/`)
failed 6 tests; the file now carries that filter (`062813f`, red), and `e06f89e` iterates the rows directly
(30 passed; `tests/packages` 297 passed). Round 2 called the fix sound.

## 7. Not verified, accepted risks and follow-ups

- **Local flakes, pre-existing, not touched here.** `backend/tests/packages/test_concurrency.py` fails now and then on
  this machine with `CheckViolationError … ck_packages_picked_up_after_received` / `returned_after_received`:
  the factory row's `received_at` (`now()`) came out later than the transition's `clock_timestamp()`, so the
  database clock stepped back between them. Reproduced on `main` (`ab34e6f`): 2 failures in 14 runs. Round 2's
  local run also had one-off failures in `backend/tests/jobs/test_worker.py` claim counts (passed alone). CI was green
  on both reviewed heads. Tracked only here and in the PR.
- **D2 is a choice to audit:** residents never see `recipient_name`. Inbox "Decisions to audit".
- **Cost on single-package responses:** create, get, pickup and return each run the units lookup and, for
  the desk, the names lookup: one or two primary-key reads. Not measured.
- **No performance test at scale**: the statement count is fixed, but no `EXPLAIN` was run on the
  `lower(carrier)` filter, which has no index (it filters within the building's rows). Acceptable at desk
  volumes; tracked only here.
- **Not shown:** who collected a package and the return reason (ticket "Out"; P5-03d's ticket carries the note).

## 8. How to change this safely

- **A new endpoint that returns a package:** build the response with `backend/app/packages/service.py::_out` (one) or `_outs` (a
  list), never `PackageOut.model_validate`: `PackageOut`'s fields are required, so a missed path fails loudly.
  Add the endpoint to `test_every_package_endpoint_names_the_unit`.
- **Widening `recipient_name`** (say, to the recipient themselves): change `backend/app/packages/queries.py::sees_recipient_names`
  only, and rewrite `test_residents_never_see_a_recipient_name` to the new rule: it fails first.
- **Another desk-only field** (who collected it): follow the same pattern, batched in `_outs` and gated in
  `queries.py`; extend the statement-count test.
- **Another filter:** add it in `list_packages` on top of `visible_packages(ctx)`, validated by a schema type,
  and test it with the cursor.

## 9. Must explain, then quiz

**1. Why does the resident's `PackageOut` carry a null `recipient_name` rather than their co-occupant's name?**
Residents see packages by unit and occupancy window (`backend/app/packages/queries.py::visible_packages`), so a resident can see a
package addressed to someone else in their unit, now or in the past. No other endpoint shows a resident another
member's name, and the resident page (P5-04) doesn't need it, so the safe default keeps exposure where it was
(D2). `backend/app/packages/queries.py::sees_recipient_names` gates the names query, so for a resident the name is never even
read.

**2. Why compare `lower(carrier)` in Postgres instead of lower-casing the parameter in Python?**
The stored value is lower-cased by Postgres; the parameter must be lower-cased by the same function, or the two
disagree on some letters. Python turns `İ` into `i` plus a combining dot, Postgres into `i`, so a Python-lowered
`İSTANBUL KARGO` misses a stored `İstanbul Kargo` (`test_postgres_lowercases_the_carrier`, mutation m2).

**3. How does the list stay at a fixed number of statements however many packages a page holds?**
`list_packages` maps the page to `PackageColumns` without extra queries, then `_outs` collects every unit id and
recipient id of the page into sets and asks once per set (`IN (...)`). A page of 25 runs the same statements as a
page of 1 (`test_a_page_of_25_runs_as_many_statements_as_a_page_of_1`).

**Quiz**

1. A manager in building A is also a resident in building B. What `recipient_name` do they get for a package in
   each building, and which line decides it?
2. Why does `list_packages` map with `PackageColumns.model_validate` instead of `PackageOut.model_validate`?
3. Why is `?carrier=%ED%A0%80` a 200 with no items and not a 422?
4. What breaks if you remove `Unit.building_id == ctx.building_id` from the units lookup? And if you remove the
   `sees_recipient_names(ctx)` condition?
5. How would you add `picked_up_by_name` for the desk without adding a query per row or exposing it to residents?

<details><summary>Answers</summary>

1. In A, the name (they have `property_management` there); in B, null. `backend/app/packages/queries.py::sees_recipient_names`
   checks `ctx.has_any(...)`, and the tenant context holds the roles of the URL's building only
   (`test_recipient_names_follow_the_role_in_this_building` shows the same with security in B and resident in A).
2. `PackageOut` requires the three new fields, which the package row doesn't have, so validating the ORM row as
   `PackageOut` fails; `paginate`'s mapper is synchronous and per row, so it can't run the lookups. The page is
   mapped to `PackageColumns`, then `_outs` enriches it once.
3. Starlette decodes the query string with replacement characters, so the value is `"���"`:
   printable and 3 characters, a valid `Carrier`. No package has that carrier, so the page is empty
   (`test_an_undecodable_carrier_escape_is_not_a_server_error`).
4. Removing the building filter breaks nothing observable today, because the composite FK keeps every package's
   unit in its building; it is defence in depth (CLAUDE.md rule 1) and no test would fail. Removing the role
   condition gives residents their co-occupants' names: `test_residents_never_see_a_recipient_name`,
   `test_recipient_names_follow_the_role_in_this_building` and `test_a_resident_runs_no_name_lookup` fail
   (mutation m1).
5. Add `picked_up_by_name: str | None` to `PackageOut`, read it from the package row in `PackageColumns` (it is a
   column), and in `_outs` set it to null unless `sees_recipient_names(ctx)`; no query is needed. A field from
   another table would get one more batched `IN (...)` query in `_outs`. Then extend the statement-count test
   and the resident test.

</details>
