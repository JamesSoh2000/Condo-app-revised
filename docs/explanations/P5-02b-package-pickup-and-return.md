# Explanation — P5-02b Package pickup and return

> **PR:** #115 · **Source revision:** `d7ced8d59f1376a9a2876ef35123a4b8a6b3bfcd` (pre-merge), the PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (1) reviewed this
> commit (`d7ced8d`).
> **Merge commit:** not known when written; after the merge, `gh pr view 115 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `d7ced8d` the diff (`git diff origin/main...HEAD`, 11 paths), the whole of the
> new code in `backend/app/packages/service.py` (`pickup_package` to the end of the file), `router.py`,
> `schemas.py`, `state.py`, `kinds.py`, `actions.py`, and the assertions of the tests cited below; compiled the
> conditional UPDATE and the membership lock to Postgres SQL (§3); ran `pytest tests/packages/test_transitions.py
> tests/packages/test_concurrency.py tests/packages/test_state.py
> tests/notifications/test_notify.py::test_only_the_in_app_kinds_have_no_email`: 88 passed. Differences from
> the plan: three, noted in the PR below the Plan (a helper's name, a wrong sentence in the Risks line, test
> names), see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 1. Walkthrough variant: A.

## 1. What was built and why

The desk (security and property management) can now mark a package that is waiting at the desk as
**picked up** or **returned** to the carrier: `POST /api/buildings/{b}/packages/{id}/pickup` and
`POST …/{id}/return`. Each is a state transition decided by one conditional
`UPDATE packages … WHERE status IN ('received') RETURNING`, so when two requests race, exactly one wins
and the other gets 409 `invalid_transition` (CLAUDE.md rule 7). The pickup records who collected the package:
either a member allowed to collect it, or a name typed at the desk. It also tells the recipient in-app, in the
same transaction as the audit row. The ticket calls this the reference transition that notices and maintenance
(P6) will copy.

The two decisions that matter most: the package is **read and checked first, but only the UPDATE decides**
(D1), and the member check **locks the membership row before reading it**, so a move-out that is committing
at the same moment is never missed (D2).

## 2. Decisions

### D1. Pre-read and check, then the conditional UPDATE decides

- **Problem or constraint:** the pickup member must be checked against the package's unit and recipient
  before the UPDATE writes it. The UPDATE also has to be the only thing that decides a race (rule 7). There is
  a trap: `packages.picked_up_by_membership_id` has a composite foreign key `(building_id, membership_id)`.
  An unchecked building-B membership id would fail that FK inside the UPDATE, which is a 500, not a 422.
- **Chosen:** `_for_transition` reads the package through `visible_packages` (404 if it isn't there) and runs
  `assert_transition` on the status it read (409 early). `_check_pickup_member` then checks the member (422).
  Then `_transition` runs `UPDATE … WHERE id AND building_id AND status IN sources(to) RETURNING`. When zero
  rows come back, it calls `_for_transition` again, which re-reads the package and raises 404 or 409 from the
  status as it is now.
- **Alternatives rejected:**
  - Update first and validate afterwards: the FK would fire before the check, so the member would need a
    second UPDATE.
  - Validate inside the UPDATE's WHERE with an `EXISTS`: a refused member would look the same as a lost race
    unless a second query was added, and D2's lock order would be lost.
  - `SELECT … FOR UPDATE` and then a plain UPDATE: that works, but it is the pattern rule 7 replaces.
- **Tradeoffs and accepted limitations:** one extra read per action. A package that isn't `received`
  answers 409 before the body's member is judged (criterion 10).
- **Basis:** ticket scope, CLAUDE.md rule 7, the P5-01 carry ("use `assert_transition` and the same
  from-states"); the pre-read itself is autonomous.
- **Source:** recorded (PR #115 D1; ticket Frame notes).

### D2. Who may collect, and the lock that makes the answer current

- **Problem or constraint:** the ticket says "a current occupant of the unit or the recipient", PRODUCT_SCOPE
  says "the recipient or any active resident of the same unit", and the P1-03 carry says to accept active
  memberships only. A deactivation or move-out that commits while the pickup is checking must not be missed.
- **Chosen:** an **active** membership of this building that is either the package's named recipient or has a
  current occupancy (`ended_at IS NULL`) of the package's unit. `_check_pickup_member` first runs
  `SELECT … FOR SHARE` on the membership row, then checks status and occupancy in a **separate** statement.
  Every refusal gets one answer, 422 `invalid_pickup_member`, building B included.
- **Alternatives rejected:**
  - No lock: a deactivation committing between the check and the pickup's commit would be missed.
  - One joined `SELECT … FOR SHARE`: after waiting, Postgres re-checks only the locked row's new version, not
    the occupancy row joined to it.
  - 404 for a building-B member: the ticket allowed 404 or 422. 422 keeps one answer for every refused
    member, like P5-02a's `invalid_recipient`.
- **Tradeoffs and accepted limitations:** a pickup waits for a membership write that is in flight. A named
  recipient who has moved to another unit of the building can still collect their own package.
- **Basis:** ticket, PRODUCT_SCOPE "Package pickup", the P1-03 carry, and the lock pattern in
  `backend/app/memberships/occupancy.py::_prepare` and `backend/app/memberships/service.py::_target`
  (membership writes take FOR NO KEY UPDATE);
  the lock itself is autonomous.
- **Source:** recorded (PR #115 D2; ticket Frame notes, criteria 8 and 13).

### D3. The transition time is `clock_timestamp()`

- **Problem or constraint:** `received_at` is the creating transaction's `now()`, and the check constraint
  `ck_packages_picked_up_after_received` requires `picked_up_at >= received_at`. Postgres's `now()` is the
  time the *transaction* started. A pickup transaction that began before the create committed would get an
  earlier `now()` and fail the check (a 500).
- **Chosen:** `clock_timestamp()` (the wall clock at the moment the statement runs) inside the UPDATE. The
  row is already committed by then, so the wall clock is past the creating transaction's `now()`.
- **Alternatives rejected:** `now()` (the case above); the app's `clock.now()`, which in production is another
  machine's clock, so skew could break the check.
- **Tradeoffs and accepted limitations:** tests can't freeze this time with `frozen_clock`; no test needs to.
- **Basis:** CLAUDE.md lesson "a fresh clock in the writing statement"; autonomous.
- **Source:** recorded (PR #115 D3). Supporting evidence, not proof: this run's first `make check` failed in
  P5-02a's existing test helper `backend/tests/packages/test_api.py::_picked_up`, which mixes the host clock with the
  DB clock, when the two drifted apart by more than a second (PR evidence).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Exactly one of `picked_up_by_membership_id` and `picked_up_by_name` | both allowed | two answers to "who collected it" that might conflict | autonomous (ticket "one required") | PR table |
| `package.picked_up` is in-app only (`email_template=None`) | keep P3-03's generic `notification` email | the ticket says in-app only | ticket | PR table |
| Pickup notifies the named recipient if their membership is active, otherwise the unit's current active occupants | always the recipient | a unit-addressed package has no recipient; an inactive member has lost access | ticket + P1-03 carry | PR table |
| Audit metadata holds `unit_id`, `picked_up_by_membership_id`, `picked_up_by` (`"member"`/`"name"`); return holds `unit_id` | storing the typed name or reason | CLAUDE.md rule 10 (IDs and field names only) | CLAUDE.md | PR table |
| `PackageOut` unchanged | adding who collected it and the reason | not needed here; P5-03 decides what the desk shows | autonomous | PR table, follow-ups |
| Return notifies nobody and takes no member | — | ticket scope | ticket | Frame notes |

**Framing changes:** criteria 7–15 added. Criterion 1 was sharpened: a building-B member gives 422 (the ticket
allowed 404 or 422). Criterion 13 (a member change during the pickup) is the case the ticket missed. None
loosened. See the ticket's Frame notes.

**Plan versus final code** (recorded in the PR below the Plan):

1. The recipients helper is `backend/app/packages/service.py::_recipient_user_ids`, not `_pickup_recipients`.
2. The Plan's Risks line says the pickup "holds the package row while it waits on the membership row". That
   is wrong for the final code: `_check_pickup_member` runs before `_transition`, so while it waits the pickup
   holds no package lock. It takes the package row lock only at the UPDATE.
3. The criterion → test map used working names. The PR's evidence table names the tests as written.

## 3. How it is implemented

### Overview

- `backend/app/packages/router.py::pickup` and `::return_`: desk-only action endpoints (`_DESK`: feature
  `packages` on, role security or property_management).
- `backend/app/packages/schemas.py::PackagePickup`, `::PackageReturn`: the bodies (stripped, length-capped,
  no control characters; for a pickup, exactly one way to name who collected it).
- `backend/app/packages/service.py::pickup_package`, `::return_package`: the two use cases. They share
  `_for_transition` (read + early answer), `_transition` (the conditional UPDATE + re-read) and, for pickup,
  `_check_pickup_member` and `_recipient_user_ids`.
- `backend/app/packages/state.py::sources`: the statuses that may move to a target, taken from `ALLOWED`. The
  UPDATE's `status IN (…)` comes from here, so there is no second list to keep in sync.

### Walkthrough (variant A): `POST /api/buildings/{b}/packages/{p}/pickup`

1. **HTTP.** `{"picked_up_by_membership_id": "<m>"}` arrives at `backend/app/packages/router.py::pickup`. FastAPI validates the body
   with `PackagePickup` first: a missing, doubled or blank pickup person is a 422 `validation_error`.
2. **Dependencies.** The building router resolves the session and `get_tenant_context` (404
   `building_not_found` for a non-member, a pending member or a suspended one). Then `_DESK` runs
   `require_feature(packages)` (403 `feature_disabled`) and `require_roles(security, property_management)`
   (403 `forbidden_role`).
3. **Read and early answer.** `_for_transition` loads the package with
   `visible_packages(ctx).where(Package.id == package_id)`. Another building's package and a missing one both
   give 404 `package_not_found`. `assert_transition(package.status, PICKED_UP)` gives 409 unless it is
   `received`.
4. **Member check** (only when a member is named). `_check_pickup_member` runs:
   ```sql
   SELECT building_memberships.id FROM building_memberships
   WHERE building_memberships.id = $1 AND building_memberships.building_id = $2 FOR SHARE
   ```
   This waits for any in-flight status or occupancy write on that member. Then it reads, in a new statement:
   active, in this building, and either the recipient or someone with an open occupancy of the unit. Zero rows
   means 422 `invalid_pickup_member`.
5. **The decision.** `_transition` runs (compiled from the code):
   ```sql
   UPDATE packages SET status=$1, picked_up_at=clock_timestamp(), picked_up_by_name=$2,
     picked_up_by_membership_id=$3, handed_out_by_membership_id=$4, updated_at=now()
   WHERE packages.id = $5 AND packages.building_id = $6 AND packages.status IN ('received')
   RETURNING packages.*
   ```
   A row back means this request won. Zero rows means another transition got there first:
   `_for_transition` re-reads and raises 409 (or 404).
6. **Side effects, same transaction.** `notify(kind="package.picked_up")` to `_recipient_user_ids`. It writes
   notification rows only; the kind has no email template, so no `email.send` job. Then
   `record_audit(package.picked_up)` with IDs and field names only. Then `db.commit()`, once.
7. **Response.** 200 `PackageOut` with `status: picked_up` and `picked_up_at` set.

`POST …/return` is steps 1–3, 5 and 7, with `{"reason": "…"}`, `returned_at=clock_timestamp()` and
`return_reason`. It writes the audit row `package.returned {unit_id}` and no notification.

### Data model changes

None, and no migration. P5-01 created the columns and the per-status check constraints that this ticket
writes into (`received_state`, `picked_up_state`, `returned_state`, `picked_up_after_received`,
`returned_after_received` in `backend/app/packages/models.py::Package`).

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/packages/service.py` | `pickup_package`, `return_package`, `_for_transition`, `_transition`, `_check_pickup_member`, `_recipient_user_ids`, `InvalidPickupMember` | +199 / −5 |
| `backend/app/packages/router.py` | the two routes | +36 / −1 |
| `backend/app/packages/schemas.py` | `PickupName`, `ReturnReason`, `PackagePickup`, `PackageReturn` | +31 / −1 |
| `backend/app/packages/state.py` | `sources` | +5 |
| `backend/app/notifications/kinds.py` | `package.picked_up` in-app only | +1 / −1 |
| `backend/app/audit/actions.py` | `PACKAGE_PICKED_UP`, `PACKAGE_RETURNED` | +2 |
| `frontend/src/api/schema.d.ts` | regenerated (`packages_pickup`, `packages_return`) | +223 |
| `backend/tests/packages/test_transitions.py` | HTTP criteria and tenant table | +626 |
| `backend/tests/packages/test_concurrency.py` | races on real connections | +176 |
| `backend/tests/notifications/test_notify.py` | in-app kinds list gains `package.picked_up` | +4 / −2 |
| `docs/tickets/P5-02b-package-pickup-and-return.md` | framing | +63 / −4 |

**Key excerpts**

`backend/app/packages/service.py::_transition`

```python
async def _transition(
    db: AsyncSession, ctx: TenantContext, package_id: UUID, to: PackageStatus, **values: Any
) -> Package:
    # ...
    package = await db.scalar(
        update(Package)
        .where(
            Package.id == package_id,
            Package.building_id == ctx.building_id,
            Package.status.in_(sources(to)),
        )
        .values(status=to, **values)
        .returning(Package)
        .execution_options(populate_existing=True)
    )
    if package is not None:
        return package
    current = await _for_transition(db, ctx, package_id, to)
    # Unreachable: the UPDATE would have matched a package that may still become `to`.
    raise AssertionError(f"package {current.id} matched no transition to {to}")
```

- This is the whole concurrency guarantee: the `status IN (…)` in the WHERE. `populate_existing` makes the
  session's copy of the package take the values the UPDATE returned, not the ones the pre-read loaded.
- Without `Package.status.in_(sources(to))`, two pickups both succeed, and a pickup racing a return fails the
  `returned_state` check (a 500). The PR's mutation probe m1 removed this line and three race tests failed.
- If the re-read finds a package that could still make the move, the code raises `AssertionError` (a 500)
  instead of looping. Postgres can't produce that state here.

`backend/app/packages/service.py::_check_pickup_member`

```python
    await db.execute(
        select(BuildingMembership.id)
        .where(
            BuildingMembership.id == membership_id,
            BuildingMembership.building_id == ctx.building_id,
        )
        .with_for_update(read=True)
    )
    lives_there = (
        select(UnitOccupancy.id)
        .where(
            UnitOccupancy.building_id == ctx.building_id,
            UnitOccupancy.membership_id == BuildingMembership.id,
            UnitOccupancy.unit_id == package.unit_id,
            UnitOccupancy.ended_at.is_(None),
        )
        .exists()
    )
    may_collect = await db.scalar(
        select(BuildingMembership.id).where(
            BuildingMembership.id == membership_id,
            BuildingMembership.building_id == ctx.building_id,
            BuildingMembership.status == MembershipStatus.ACTIVE,
            or_(BuildingMembership.id == package.recipient_membership_id, lives_there),
        )
    )
    if may_collect is None:
        raise InvalidPickupMember(
            detail="Only the recipient or someone who lives in the unit can collect this package."
        )
```

- `with_for_update(read=True)` is `FOR SHARE`. `deactivate_member`, `suspend_member` and the occupancy
  helpers lock the membership row `FOR NO KEY UPDATE` (`backend/app/memberships/service.py::_target`,
  `backend/app/memberships/occupancy.py::_prepare`), and
  that lock conflicts with `FOR SHARE`. So this statement waits for them to finish. Under READ COMMITTED
  (each statement sees data committed before it started), the next statement then sees what they
  committed (D2).
- The `FOR SHARE` lock is held until this transaction ends. A deactivation that starts after the check
  therefore waits for the pickup to commit, and the pickup can't record a member who was deactivated before
  it committed.
- Without the lock, the four `test_a_pickup_waits_for_a_change_of_its_member` cases fail (mutation probe m2).

`backend/app/packages/schemas.py::PackagePickup`

```python
PickupName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=120),
    BeforeValidator(printable_before_strip),
]
# ...
class PackagePickup(InputModel):
    # ...
    picked_up_by_membership_id: UUID | None = None
    picked_up_by_name: PickupName | None = None

    @model_validator(mode="after")
    def _exactly_one(self) -> PackagePickup:
        if (self.picked_up_by_membership_id is None) == (self.picked_up_by_name is None):
            raise ValueError("send exactly one of picked_up_by_membership_id and picked_up_by_name")
        return self
```

- The P5-01 carry: the table's `NOT NULL` checks accept `''`, so blank and whitespace-only values are refused
  here (`min_length=1` after the strip). `printable_before_strip` runs on the raw value, so a trailing tab is
  refused instead of being stripped away. `InputModel` forbids unknown fields.

`backend/tests/packages/test_concurrency.py::test_two_concurrent_pickups_have_one_winner`

```python
def test_two_concurrent_pickups_have_one_winner(scratch_database_url: str) -> None:
    async def body(sessions: Sessions, world: World, package: Package) -> None:
        outcomes = await asyncio.gather(
            _act(sessions, world, package, "pickup"), _act(sessions, world, package, "pickup")
        )

        assert sorted(outcomes) == ["200", "409"]
        assert await _status(sessions, package) == PackageStatus.PICKED_UP
        assert await _count(sessions, AuditEvent, AuditEvent.action == "package.picked_up") == 1
        assert await _count(sessions, Notification, Notification.entity_id == package.id) == 1

    _run(scratch_database_url, body)
```

- Each `_act` opens its own session on its own connection to a scratch database. This test does **not**
  control which path the loser takes: it may lose at the pre-read (409 from `_for_transition`) or at the
  UPDATE. The deterministic test of the UPDATE path is
  `test_a_pickup_waits_for_a_held_transition_and_loses_after_its_commit`. It holds a returned-but-uncommitted
  row open, checks that the pickup is still waiting after 1 s, then commits (pickup → 409) or rolls back
  (pickup → 200).

## 5. Edge cases and tests

All tests below are in `backend/tests/packages/test_transitions.py` unless marked C
(`backend/tests/packages/test_concurrency.py`). Each refusal test compares the package's status columns and
the notification/job/audit row counts before and after.

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Two pickups at once | One 200, one 409; one audit row, one notification | C `test_two_concurrent_pickups_have_one_winner` |
| Pickup and return at once | One wins, the other 409 | C `test_a_concurrent_pickup_and_return_have_one_winner[pickup,return]` |
| A transition commits while the pickup's UPDATE waits | The UPDATE waits, then matches nothing: 409; after a rollback it wins | C `test_a_pickup_waits_for_a_held_transition_and_loses_after_its_commit[commits,rolls-back]` |
| The member is deactivated or moves out during the pickup | The check waits, then reads the committed state: 422 (200 after a rollback) | C `test_a_pickup_waits_for_a_change_of_its_member[4]` |
| An occupant of another unit, a former occupant, a pending or suspended member, a building-B member | 422 `invalid_pickup_member`, nothing changed | `test_pickup_member_who_may_not_collect_is_422[5]` |
| Unknown vs building-B member id | The same 422 body | `test_unknown_and_other_building_members_get_the_same_422` |
| A suspended named recipient | 422 | `test_a_suspended_named_recipient_may_not_collect` |
| The named recipient moved within the building | Allowed | `test_the_named_recipient_may_collect_after_moving_within_the_building` |
| Current active occupants (incl. council and the multi-building user) | Allowed | `test_current_active_occupants_may_collect[3]` |
| Neither, both, blank, whitespace, control characters, 121 characters, extra field, bad UUID | 422 `validation_error` | `test_pickup_body_is_validated[10]`; boundary `test_a_name_of_120_characters_is_accepted` |
| Blank, ideographic-space-only or NUL reason, 301 characters, extra field | 422 | `test_return_reason_is_validated[7]` |
| A picked-up or returned package | 409 for either action | `test_a_package_that_is_not_received_is_409[4]`, `test_a_second_transition_is_409_and_changes_nothing[4]` |
| A non-`received` package with a building-B member | 409, not 422 (state first) | `test_the_state_is_checked_before_the_pickup_member` |
| Another building's package vs none | The same 404 body | `test_another_buildings_package_and_none_are_the_same_404[2]` |
| Residents, council, the multi user in its resident building | 403 `forbidden_role` | `test_residents_may_not_transition_a_package[4]`, `test_multi_may_not_transition_in_the_building_where_it_is_a_resident[2]` |
| Non-members, pending, suspended | 404 | `test_non_members_get_404[8]` |
| No session | 401 | `test_transitions_without_a_session_are_401[2]` |
| Feature off | 403 `feature_disabled` | `test_transitions_are_403_when_packages_are_disabled[2]` |
| Notification: named, unit-addressed, inactive recipient; no email | as D-table | `test_pickup_notifies_the_named_recipient_in_app_only`, `test_pickup_of_a_unit_package_notifies_its_current_active_occupants`, `test_pickup_of_an_inactive_recipients_package_notifies_nobody` |
| A return notifies nobody | Audit row only | `test_desk_returns_a_package[2]` |
| Typed name kept out of the audit | metadata `picked_up_by: "name"` | `test_pickup_by_a_typed_name_stores_it_stripped` |
| A create retried after the pickup | 201 replay showing `picked_up` | `test_a_create_replay_after_pickup_shows_picked_up` |
| A pickup transaction older than the create | `clock_timestamp()` keeps `picked_up_at >= received_at` | **No test** forces this interleaving (§7) |
| A failure after the UPDATE rolls everything back | One commit at the end | No committed test; Codex's round 1 proof injected an audit failure and saw the rollback (not kept) |

**Acceptance criteria → tests:** 1 the tenant rows above; 2 C `test_two_concurrent_pickups_have_one_winner`;
3 C `test_a_concurrent_pickup_and_return_have_one_winner`; 4 `test_pickup_member_who_may_not_collect_is_422[a_101-a_resident2]`;
5 `test_pickup_body_is_validated[body0]`; 6 `test_transitions_are_403_when_packages_are_disabled`;
7 `test_desk_picks_up_a_package`, `test_desk_returns_a_package`; 8 the who-may-collect rows; 9 the body rows;
10 `test_the_state_is_checked_before_the_pickup_member`; 11 the notification rows; 12
`test_a_second_transition_is_409_and_changes_nothing`; 13 C `test_a_pickup_waits_for_a_change_of_its_member`;
14 `test_a_create_replay_after_pickup_shows_picked_up`; 15 the role and 401 rows. Also on the stack: the PR's
curl transcript (`make up`, seed data).

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6-astra`, medium effort, with the security pass (James's run instruction: the sole reviewer, no Claude reviewer) | `d7ced8d` | `MERGE` | none | — |

Round 1 read all 11 changed paths. It ran the full backend suite (one failure, in P5-02a's clock-sensitive
`_picked_up` helper, which passed on rerun), ruff, mypy and the frontend checks. It wrote four proof tests
(an injected audit failure rolls back the transition and the notification; both actions need the CSRF
headers), all passing, and deleted them after triage. No code changed because of the review.

## 7. Not verified, accepted risks and follow-ups

- **`clock_timestamp()` vs an older transaction (D3):** no test forces a pickup transaction that started before
  the package's create committed. The choice rests on how Postgres defines `now()` and `clock_timestamp()`,
  not on a test.
- **Atomic rollback after a late failure:** no committed test injects a failure after the UPDATE. Codex's
  proof showed it, and the code commits once at the end, but nothing in the suite would catch a regression.
- **Who the race loser loses to:** `test_two_concurrent_pickups_have_one_winner` and the pickup-vs-return test
  accept a loss at either the pre-read or the UPDATE. Only the held-transition test pins the UPDATE path.
- **One unexplained failure:** the first run after the implementation reported
  `test_a_pickup_waits_for_a_held_transition_and_loses_after_its_commit[commits]` failing. The output wasn't
  read before it scrolled away, and 21 runs since have passed. Tracked in the PR follow-ups; watch it in CI.
- **P5-02a's `backend/tests/packages/test_api.py::_picked_up`** mixes the host clock with the DB clock. It failed once
  in this ticket's local `make check` and once in Codex's run. Not changed here (an existing test, out of
  scope). Tracked in the PR follow-ups and the inbox (step 6).
- **`PackageOut`** doesn't show who collected a package or why it was returned. P5-03 adds them if the desk
  page needs them. Tracked in the PR follow-ups and in P5-03's ticket (step 6).
- Undoing a pickup and reminders are out of scope (ticket).

## 8. How to change this safely

- **A new transition** (say `returned → received`): add it to `backend/app/packages/state.py::ALLOWED`;
  `sources` and `assert_transition` follow from there. Write a use case that calls `_for_transition` and
  `_transition` with the target's columns, and check the table's per-status constraints in
  `backend/app/packages/models.py::Package` first. They will reject a row that keeps another status's
  columns.
- **Who may collect:** change only `_check_pickup_member`'s second query, and keep the `FOR SHARE` statement
  before it. `test_pickup_member_who_may_not_collect_is_422` and `test_a_pickup_waits_for_a_change_of_its_member`
  will tell you if you broke the rule or the lock.
- **The notification:** an email needs a template and a change to
  `backend/tests/notifications/test_notify.py::test_only_the_in_app_kinds_have_no_email`.
- **Copying the pattern to P6:** keep the order read → assert → check related IDs → conditional UPDATE →
  re-read on zero rows → side effects → one commit.

## 9. Must explain, then quiz

**1. Two timelines: why the conditional UPDATE gives exactly one pickup winner under READ COMMITTED.**

Timeline (a), both requests pass the pre-read:

| t | Request A | Request B |
|---|---|---|
| 1 | reads the package: `received`, passes `assert_transition` | reads it: `received`, passes |
| 2 | `UPDATE … WHERE status IN ('received')`: matches, locks the row, sets `picked_up` | |
| 3 | | the same UPDATE finds the row locked by A and **waits** |
| 4 | notify, audit, `COMMIT` | |
| 5 | | Postgres re-fetches the row as A committed it and **re-checks the WHERE**: status is `picked_up`, so 0 rows |
| 6 | 200 | `_for_transition` re-reads, `assert_transition(picked_up, picked_up)`: 409 |

Timeline (b), B starts after A commits: B's pre-read sees `picked_up` and answers 409 at once. Either way only
one UPDATE matches the row. In READ COMMITTED, an UPDATE that waited on a row lock evaluates its WHERE again
against the row's newest committed version (`_transition`'s docstring). That re-check is what makes the
status test atomic with the write. Tested by C `test_a_pickup_waits_for_a_held_transition_and_loses_after_its_commit`.

**2. Why does `SELECT` then `UPDATE` have a race that `UPDATE … WHERE status='received' RETURNING` does
not?** A plain `SELECT` takes no lock. Both requests can read `received` and then both run an UPDATE whose WHERE
names only the id. Both match, so two pickups are recorded (or a pickup is followed by a return that breaks
the per-status check). Putting the status in the UPDATE's own WHERE makes the check and the write one atomic
step on the locked row. That is why `_for_transition`'s pre-read is only an early answer and the UPDATE
decides. Mutation probe m1 (the WHERE without the status) made the race tests fail.

**3. After zero rows, why re-read, and how does the re-read decide 404 vs 409?** Zero rows has two causes
that look identical: no such package in this building, or a package that is no longer `received`. The re-read
(`_for_transition`, through `visible_packages`) tells them apart. No row means 404 `package_not_found`, the
same body for another building's package and a missing one. A row means `assert_transition` on its current
status, which raises 409 `invalid_transition`. The app has no route or service that deletes a package, so in
practice the re-read gives 409.

**Quiz**

1. A pickup names a member whose deactivation is committing at the same moment. What does the pickup answer,
   and which statement makes it wait?
2. Why must `_check_pickup_member` run before `_transition`, and not as a check after the UPDATE?
3. What would break if `_check_pickup_member` used a single joined `SELECT … FOR SHARE` instead of a separate
   lock statement and a read?
4. What would break if the UPDATE wrote `picked_up_at=func.now()`?
5. How would you extend this to maintenance requests (P6), with `open → in_progress → done` transitions?

<details><summary>Answers</summary>

1. 422 `invalid_pickup_member`. The `SELECT … FOR SHARE` on the membership waits for the deactivation's
   `FOR NO KEY UPDATE` lock. Once the deactivation commits, the next statement reads `deactivated`
   (C `test_a_pickup_waits_for_a_change_of_its_member[commits-deactivate]`).
2. The UPDATE writes `picked_up_by_membership_id`, and its composite FK `(building_id, membership_id)` would
   reject a building-B id with an IntegrityError (a 500) before any later check ran. Checking first also gives
   one 422 for every refused member.
3. After waiting, Postgres re-checks only the locked membership row's new version. The occupancy row joined to
   it would come from the statement's original snapshot, so a move-out committing at that moment (occupancy
   ended) could be missed and the former occupant accepted.
4. `now()` is the pickup transaction's start time. If that transaction began before the package's create
   committed, `picked_up_at < received_at` violates `ck_packages_picked_up_after_received`: a 500.
5. Put the states in a state module like `backend/app/packages/state.py::ALLOWED`, with `sources(to)`. Make
   one action endpoint per transition. Each use case reads through the domain's `visible_*` helper, asserts the
   transition, checks any body IDs with `building_id = ctx.building_id` (locking what a concurrent write could
   change), runs `UPDATE … WHERE id AND building_id AND status IN sources(to) RETURNING`, re-reads on zero rows
   for 404/409, then writes notify/audit and commits once. Copy the concurrency tests with separate sessions.

</details>
