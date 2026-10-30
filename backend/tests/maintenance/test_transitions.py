"""The manager's moves (P6-03c criteria 1, 2, 2a, 4 and 8): start, hold, resolve, reopen. The
races, the window closing during a wait and two identical moves at once are in
`test_concurrency.py`; the notifications in `test_status_notify.py`."""

import uuid
from datetime import datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import func, literal, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditEvent
from app.buildings.enums import Feature
from app.buildings.models import BuildingFeature
from app.jobs.models import Job
from app.maintenance import service
from app.maintenance.enums import MaintenanceStatus
from app.maintenance.models import (
    MaintenanceRequest,
    MaintenanceRequestPhoto,
    MaintenanceStatusEvent,
)
from app.maintenance.state import ALLOWED, MOVES, REOPEN_WINDOW, sources
from app.notifications.models import Notification
from tests.helpers.tenancy import (
    assert_cross_building_404,
    assert_forbidden_role,
    assert_not_visible,
    assert_problem,
    without_request_id,
)
from tests.maintenance.conftest import make_maintenance_request
from tests.maintenance.test_api import base
from tests.world import World

pytestmark = pytest.mark.anyio

S = MaintenanceStatus
VERBS = list(MOVES)
ROW_MODELS = (
    MaintenanceRequest,
    MaintenanceRequestPhoto,
    MaintenanceStatusEvent,
    Notification,
    Job,
    AuditEvent,
)
PAST = {"start": "started", "hold": "held", "resolve": "resolved", "reopen": "reopened"}
# Every (verb, source) the API accepts, and every one it refuses.
ALLOWED_PAIRS = [(verb, source) for verb, (_, froms) in MOVES.items() for source in froms]
REFUSED_PAIRS = [
    (verb, source) for verb, (_, froms) in MOVES.items() for source in S if source not in froms
]


async def counts(db: AsyncSession) -> tuple[int, ...]:
    return tuple(
        [await db.scalar(select(func.count()).select_from(model)) or 0 for model in ROW_MODELS]
    )


async def _row(db: AsyncSession, request_id: uuid.UUID) -> MaintenanceRequest:
    row = await db.scalar(
        select(MaintenanceRequest)
        .where(MaintenanceRequest.id == request_id)
        .execution_options(populate_existing=True)
    )
    assert row is not None
    return row


async def _now(db: AsyncSession) -> datetime:
    now = await db.scalar(select(func.clock_timestamp()))
    assert now is not None
    return now


async def _request_in(
    db: AsyncSession,
    world: World,
    status: MaintenanceStatus,
    submitted: datetime | None = None,
    **overrides: Any,
) -> MaintenanceRequest:
    """a_resident1's request in `status`, its status columns set by a_manager, submitted two days
    ago unless `submitted` says when."""
    submitted = submitted or await _now(db) - timedelta(days=2)
    return await make_maintenance_request(
        db,
        world.a_resident1.membership,
        world.a_101,
        submitted_at=submitted,
        status=status,
        acted_by=world.a_manager.membership,
        **overrides,
    )


def _url(world: World, request_id: uuid.UUID, verb: str) -> str:
    return f"{base(world)}/{request_id}/{verb}"


# --- the state table ------------------------------------------------------------------------------


def test_the_verbs_and_cancel_cover_allowed_exactly() -> None:
    # Criterion 1: a pair outside `ALLOWED` is never accepted, and every allowed pair has one verb.
    pairs = sorted((source, target) for target, froms in MOVES.values() for source in froms)
    pairs += [(source, S.CANCELLED) for source in sources(S.CANCELLED)]
    allowed = sorted((source, target) for source, targets in ALLOWED.items() for target in targets)
    assert sorted(pairs) == allowed
    assert len(set(pairs)) == len(pairs)


# --- criterion 1: the tenant table ----------------------------------------------------------------


@pytest.mark.parametrize(("verb", "source"), ALLOWED_PAIRS)
async def test_a_manager_moves_a_request(
    as_user: Any, world: World, db: AsyncSession, verb: str, source: MaintenanceStatus
) -> None:
    request = await _request_in(db, world, source)
    client = await as_user(world.a_manager.user)

    response = await client.post(_url(world, request.id, verb))

    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["id"], body["status"]) == (str(request.id), MOVES[verb][0])
    assert body["requester_name"] == world.a_resident1.user.full_name


@pytest.mark.parametrize("verb", VERBS)
@pytest.mark.parametrize("persona", ["a_security", "a_resident1", "a_council"])
async def test_other_roles_may_not_move_a_request(
    as_user: Any, world: World, db: AsyncSession, verb: str, persona: str
) -> None:
    request = await _request_in(db, world, MOVES[verb][1][0])
    before = await counts(db)
    client = await as_user(getattr(world, persona).user)
    await assert_forbidden_role(client, "POST", _url(world, request.id, verb))
    assert await counts(db) == before
    assert (await _row(db, request.id)).status == MOVES[verb][1][0]


@pytest.mark.parametrize("verb", VERBS)
async def test_multi_in_a_may_not_move_a_request(
    as_user: Any, world: World, db: AsyncSession, verb: str
) -> None:
    # A resident in A and security in B: neither role runs requests, in either building.
    request = await _request_in(db, world, MOVES[verb][1][0])
    client = await as_user(world.multi)
    await assert_forbidden_role(client, "POST", _url(world, request.id, verb))
    assert (await _row(db, request.id)).status == MOVES[verb][1][0]


async def test_signed_out_is_401(client: Any, world: World) -> None:
    for verb in VERBS:
        assert_problem(await client.post(_url(world, uuid.uuid4(), verb)), 401, "not_authenticated")


@pytest.mark.parametrize("persona", ["b_manager", "a_pending", "a_suspended"])
async def test_outsiders_get_building_not_found(
    as_user: Any, world: World, db: AsyncSession, persona: str
) -> None:
    client = await as_user(getattr(world, persona).user)
    for verb in VERBS:
        request = await _request_in(db, world, MOVES[verb][1][0])
        before = await counts(db)
        await assert_cross_building_404(client, "POST", _url(world, request.id, verb))
        assert await counts(db) == before
        assert (await _row(db, request.id)).status == MOVES[verb][1][0]


@pytest.mark.parametrize("verb", VERBS)
async def test_another_buildings_request_is_the_same_404_as_none(
    as_user: Any, world: World, db: AsyncSession, verb: str
) -> None:
    source = MOVES[verb][1][0]
    b_request = await make_maintenance_request(
        db,
        world.b_resident1.membership,
        world.b_101,
        submitted_at=await _now(db) - timedelta(days=2),
        status=source,
        acted_by=world.b_manager.membership,
    )
    client = await as_user(world.a_manager.user)
    before = await counts(db)
    code = "maintenance_request_not_found"
    hidden = await assert_not_visible(client, "POST", _url(world, b_request.id, verb), code=code)
    missing = await assert_not_visible(client, "POST", _url(world, uuid.uuid4(), verb), code=code)
    assert without_request_id(hidden) == without_request_id(missing)
    assert await counts(db) == before
    assert (await _row(db, b_request.id)).status == source


@pytest.mark.parametrize(("verb", "source"), REFUSED_PAIRS)
async def test_every_disallowed_source_is_invalid_transition(
    as_user: Any, world: World, db: AsyncSession, verb: str, source: MaintenanceStatus
) -> None:
    request = await _request_in(db, world, source)
    client = await as_user(world.a_manager.user)
    before = await counts(db)
    assert_problem(await client.post(_url(world, request.id, verb)), 409, "invalid_transition")
    assert await counts(db) == before
    assert (await _row(db, request.id)).status == source


async def test_feature_off_is_403_and_writes_nothing(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    request = await _request_in(db, world, S.IN_PROGRESS)
    await db.execute(
        update(BuildingFeature)
        .where(
            BuildingFeature.building_id == world.a.id,
            BuildingFeature.feature == Feature.MAINTENANCE,
        )
        .values(enabled=False)
    )
    client = await as_user(world.a_manager.user)
    before = await counts(db)
    for verb in VERBS:
        assert_problem(await client.post(_url(world, request.id, verb)), 403, "feature_disabled")
    assert await counts(db) == before
    assert (await _row(db, request.id)).status == S.IN_PROGRESS


async def test_a_body_is_ignored(as_user: Any, world: World, db: AsyncSession) -> None:
    # No body is defined: `hold` takes no reason (framing), so one sent is never stored.
    request = await _request_in(db, world, S.IN_PROGRESS)
    client = await as_user(world.a_manager.user)
    response = await client.post(_url(world, request.id, "hold"), json={"reason": "parts"})
    assert response.status_code == 200, response.text
    assert "parts" not in response.text


# --- criteria 2 and 2a: the columns and the event -------------------------------------------------


# The columns of each status (P6-03a, ADR-0020).
_COLUMNS = {
    S.IN_PROGRESS: {"started"},
    S.ON_HOLD: {"started", "on_hold"},
    S.RESOLVED: {"started", "resolved"},
}


@pytest.mark.parametrize(("verb", "source"), ALLOWED_PAIRS)
async def test_each_move_sets_exactly_its_columns_and_one_event(
    as_user: Any, world: World, db: AsyncSession, verb: str, source: MaintenanceStatus
) -> None:
    request = await _request_in(db, world, source)
    old = await _row(db, request.id)
    old_started = (old.started_at, old.started_by_membership_id)
    client = await as_user(world.a_manager.user)
    before = await _now(db)

    response = await client.post(_url(world, request.id, verb))

    assert response.status_code == 200, response.text
    after = await _now(db)
    target = MOVES[verb][0]
    row = await _row(db, request.id)
    assert row.status == target
    for prefix in ("started", "on_hold", "resolved", "cancelled"):
        at = getattr(row, f"{prefix}_at")
        by = getattr(row, f"{prefix}_by_membership_id")
        if prefix in _COLUMNS[target]:
            assert at is not None and by is not None, prefix
        else:
            assert (at, by) == (None, None), prefix
    [event] = list(
        await db.scalars(
            select(MaintenanceStatusEvent).where(MaintenanceStatusEvent.request_id == request.id)
        )
    )
    assert (event.building_id, event.from_status, event.status, event.by_membership_id) == (
        world.a.id,
        source,
        target,
        world.a_manager.membership.id,
    )
    # The database's clock, taken inside the request.
    assert before <= event.at <= after
    new_column = {"start": "started", "hold": "on_hold", "resolve": "resolved"}.get(verb)
    if source == S.SUBMITTED:
        assert (row.started_at, row.started_by_membership_id) == (
            event.at,
            world.a_manager.membership.id,
        )
    elif "started" in _COLUMNS[target]:
        # A resume, a hold, a resolve and a reopen keep the first start.
        assert (row.started_at, row.started_by_membership_id) == old_started
    if new_column is not None and new_column != "started":
        assert getattr(row, f"{new_column}_at") == event.at
        assert getattr(row, f"{new_column}_by_membership_id") == world.a_manager.membership.id
    body = response.json()
    assert body["status"] == target
    assert body["started_at"] == row.started_at.isoformat().replace("+00:00", "Z")


@pytest.mark.parametrize(("verb", "source"), ALLOWED_PAIRS)
async def test_each_move_is_audited_with_ids_only(
    as_user: Any, world: World, db: AsyncSession, verb: str, source: MaintenanceStatus
) -> None:
    request = await _request_in(db, world, source)
    client = await as_user(world.a_manager.user)

    assert (await client.post(_url(world, request.id, verb))).status_code == 200

    events = list(await db.scalars(select(AuditEvent).where(AuditEvent.entity_id == request.id)))
    metadata: dict[str, Any] = {"from_status": source}
    if verb == "reopen":
        metadata["to_status"] = S.IN_PROGRESS
    assert [
        (e.action, e.entity_type, e.building_id, e.actor_user_id, e.metadata_) for e in events
    ] == [
        (
            f"maintenance.{PAST[verb]}",
            "maintenance_request",
            world.a.id,
            world.a_manager.user.id,
            metadata,
        )
    ]


async def test_a_held_resumed_and_held_again_request_keeps_every_event(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    request = await _request_in(db, world, S.SUBMITTED)
    client = await as_user(world.a_manager.user)
    for verb in ("start", "hold", "start", "hold", "resolve", "reopen", "resolve"):
        assert (await client.post(_url(world, request.id, verb))).status_code == 200, verb

    events = list(
        await db.scalars(
            select(MaintenanceStatusEvent)
            .where(MaintenanceStatusEvent.request_id == request.id)
            .order_by(MaintenanceStatusEvent.id)
        )
    )
    assert [(e.from_status, e.status) for e in events] == [
        (S.SUBMITTED, S.IN_PROGRESS),
        (S.IN_PROGRESS, S.ON_HOLD),
        (S.ON_HOLD, S.IN_PROGRESS),
        (S.IN_PROGRESS, S.ON_HOLD),
        (S.ON_HOLD, S.RESOLVED),
        (S.RESOLVED, S.IN_PROGRESS),
        (S.IN_PROGRESS, S.RESOLVED),
    ]
    assert [e.at for e in events] == sorted(e.at for e in events)
    row = await _row(db, request.id)
    assert (row.started_at, row.resolved_at) == (events[0].at, events[-1].at)


# --- criterion 4: the reopen window ---------------------------------------------------------------


async def _resolved_at(db: AsyncSession, world: World, age: timedelta) -> MaintenanceRequest:
    """A request resolved `age` ago by the database clock."""
    now = await _now(db)
    return await _request_in(
        db,
        world,
        S.RESOLVED,
        submitted=now - age - timedelta(days=1),
        started_at=now - age - timedelta(hours=1),
        resolved_at=now - age,
    )


async def test_reopen_within_the_window_leads_to_in_progress_and_clears_resolved(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    request = await _resolved_at(db, world, REOPEN_WINDOW - timedelta(minutes=1))
    started = (request.started_at, request.started_by_membership_id)
    client = await as_user(world.a_manager.user)

    response = await client.post(_url(world, request.id, "reopen"))

    assert response.status_code == 200, response.text
    row = await _row(db, request.id)
    assert row.status == S.IN_PROGRESS
    assert (row.resolved_at, row.resolved_by_membership_id) == (None, None)
    assert (row.started_at, row.started_by_membership_id) == started


@pytest.mark.parametrize(
    "age", [REOPEN_WINDOW, REOPEN_WINDOW + timedelta(seconds=1), timedelta(days=30)]
)
async def test_reopen_at_14_days_and_after_is_window_closed_and_changes_nothing(
    as_user: Any, world: World, db: AsyncSession, age: timedelta
) -> None:
    request = await _resolved_at(db, world, age)
    before_row = await _row(db, request.id)
    resolved = (before_row.resolved_at, before_row.resolved_by_membership_id)
    client = await as_user(world.a_manager.user)
    before = await counts(db)

    assert_problem(
        await client.post(_url(world, request.id, "reopen")), 409, "reopen_window_closed"
    )

    assert await counts(db) == before
    row = await _row(db, request.id)
    assert row.status == S.RESOLVED
    assert (row.resolved_at, row.resolved_by_membership_id) == resolved


async def test_the_window_is_open_strictly_before_14_days(db: AsyncSession) -> None:
    # At exactly 14 days it is closed: the predicate on fixed values, where the API tests can only
    # come near the boundary (the clock moves between statements).
    now = await _now(db)
    open_ = service.reopen_window_open
    for age, expected in [
        (REOPEN_WINDOW - timedelta(microseconds=1), True),
        (REOPEN_WINDOW, False),
        (REOPEN_WINDOW + timedelta(microseconds=1), False),
    ]:
        resolved_at = literal(now - age)
        assert await db.scalar(select(open_(resolved_at, literal(now)))) is expected, age


async def test_a_cancelled_request_cannot_be_reopened(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    request = await _request_in(db, world, S.CANCELLED)
    client = await as_user(world.a_manager.user)
    assert_problem(await client.post(_url(world, request.id, "reopen")), 409, "invalid_transition")
    assert (await _row(db, request.id)).status == S.CANCELLED


async def test_start_never_reopens_a_resolved_request(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    # Both lead to in_progress; only reopen takes a resolved request, inside its window.
    request = await _resolved_at(db, world, timedelta(days=30))
    client = await as_user(world.a_manager.user)
    assert_problem(await client.post(_url(world, request.id, "start")), 409, "invalid_transition")
    assert (await _row(db, request.id)).status == S.RESOLVED
