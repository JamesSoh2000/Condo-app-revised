"""`python -m app.cli audit` (P2-04 criterion 5).

The query and the report run in the test's transaction. A CLI command runs its own event loop, which
can't share the test's connection (tests/test_cli_seed.py), so the CLI tests check the parsing and
the wiring with a fake session and a fake query; `make cli args="audit …"` is run on the stack in
the PR.
"""

import asyncio
import json
from datetime import timedelta
from uuid import uuid7

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from typer.testing import CliRunner

from app import cli
from app.audit.report import render
from app.audit.service import (
    AuditEventRow,
    AuditQuery,
    UnknownFilterValue,
    find_audit_events,
    record_audit,
)
from app.core import clock
from tests.conftest import FrozenClock
from tests.world import World

pytestmark = pytest.mark.anyio


async def _record(
    db: AsyncSession, action: str, *, building=None, actor=None, entity=("test", None), **meta
) -> None:
    await record_audit(
        db,
        action=action,
        entity_type=entity[0],
        entity_id=entity[1],
        building_id=building.id if building is not None else None,
        actor_user_id=actor.id if actor is not None else None,
        metadata=meta or None,
    )
    await db.flush()


async def _actions(db: AsyncSession, **query) -> list[str]:
    return [row.action for row in await find_audit_events(db, AuditQuery(**query))]


@pytest.fixture
async def events(db: AsyncSession, world: World, frozen_clock: FrozenClock) -> list[str]:
    """Three events in A, one in B and one identity event, a minute apart, oldest first."""
    await _record(db, "unit.created", building=world.a, actor=world.a_manager.user)
    frozen_clock.advance(minutes=1)
    await _record(db, "unit.created", building=world.b, actor=world.b_manager.user)
    frozen_clock.advance(minutes=1)
    await _record(db, "auth.logged_in", actor=world.a_manager.user, entity=("session", uuid7()))
    frozen_clock.advance(minutes=1)
    await _record(db, "membership.approved", building=world.a, actor=world.a_manager.user)
    frozen_clock.advance(minutes=1)
    await _record(db, "auth.loggedxin", building=world.a, actor=world.a_resident1.user)
    return [
        "auth.loggedxin",
        "membership.approved",
        "auth.logged_in",
        "unit.created",
        "unit.created",
    ]


async def test_building_filter_prints_only_that_buildings_events(db, world, events):
    rows = await find_audit_events(db, AuditQuery(building_slug="maple"))

    assert [r.action for r in rows] == ["auth.loggedxin", "membership.approved", "unit.created"]
    assert {r.building_slug for r in rows} == {"maple"}
    text = render(rows, as_json=False)
    assert "birch" not in text
    assert "auth.logged_in" not in text
    assert str(world.b_manager.user.email) not in text


async def test_no_filter_lists_everything_newest_first(db, events):
    assert await _actions(db) == events


async def test_actor_filter_is_case_insensitive(db, world, events):
    email = world.a_manager.user.email.upper()

    assert await _actions(db, actor_email=email) == [
        "membership.approved",
        "auth.logged_in",
        "unit.created",
    ]


async def test_entity_filter_matches_type_and_id(db, world):
    session_id = uuid7()
    await _record(db, "auth.logged_in", entity=("session", session_id))
    await _record(db, "auth.logged_out", entity=("session", uuid7()))
    await _record(db, "auth.logged_out_all", entity=("user", session_id))

    assert await _actions(db, entity_type="session", entity_id=session_id) == ["auth.logged_in"]


async def test_action_prefix_is_literal_not_a_like_pattern(db, events):
    assert await _actions(db, action_prefix="auth.") == ["auth.loggedxin", "auth.logged_in"]
    # `_` would match any character in LIKE; here it matches only itself.
    assert await _actions(db, action_prefix="auth.logged_") == ["auth.logged_in"]
    assert await _actions(db, action_prefix="%") == []


async def test_since_keeps_only_newer_events(db, events, frozen_clock):
    frozen_clock.advance(seconds=30)

    assert await _actions(db, since=clock.now() - timedelta(minutes=2)) == [
        "auth.loggedxin",
        "membership.approved",
    ]


async def test_filters_combine(db, world, events):
    assert await _actions(db, building_slug="maple", action_prefix="unit.") == ["unit.created"]
    assert await _actions(db, building_slug="birch", actor_email=world.a_manager.user.email) == []


async def test_at_most_200_rows_newest_first(db, frozen_clock):
    for n in range(205):
        await record_audit(db, action="test.recorded", entity_type="test", metadata={"n": n})
        frozen_clock.advance(seconds=1)
    await db.flush()

    rows = await find_audit_events(db, AuditQuery())

    assert len(rows) == 200
    assert [r.metadata["n"] for r in rows] == list(range(204, 4, -1))


async def test_same_instant_events_keep_insertion_order_newest_first(db):
    for n in range(3):
        await record_audit(db, action="test.recorded", entity_type="test", metadata={"n": n})
    await db.flush()

    assert [r.metadata["n"] for r in await find_audit_events(db, AuditQuery())] == [2, 1, 0]


@pytest.mark.parametrize(
    "query",
    [AuditQuery(building_slug="no-such-building"), AuditQuery(actor_email="x@nowhere.test")],
)
async def test_unknown_building_or_actor_is_an_error(db, query):
    with pytest.raises(UnknownFilterValue):
        await find_audit_events(db, query)


async def test_json_report_is_an_array_of_the_rows(db, world, events):
    rows = await find_audit_events(db, AuditQuery(building_slug="maple"))

    printed = json.loads(render(rows, as_json=True))

    assert [e["action"] for e in printed] == [r.action for r in rows]
    first = printed[0]
    assert first["building_slug"] == "maple"
    assert first["actor_email"] == world.a_resident1.user.email
    assert first["building_id"] == str(world.a.id)
    assert set(first) == {
        "id",
        "created_at",
        "action",
        "building_id",
        "building_slug",
        "actor_user_id",
        "actor_email",
        "entity_type",
        "entity_id",
        "request_id",
        "metadata",
    }


async def test_text_report_has_one_line_per_event(db, events):
    rows = await find_audit_events(db, AuditQuery())

    lines = render(rows, as_json=False).splitlines()

    assert len(lines) == len(rows)
    assert "auth.loggedxin" in lines[0]


def test_empty_text_report_says_so() -> None:
    assert render([], as_json=False) == "no audit events"
    assert render([], as_json=True) == "[]"


# The command line: parsing and wiring, with a fake session and query.

runner = CliRunner()


def _fake_query(monkeypatch: pytest.MonkeyPatch, result: list[AuditEventRow] | Exception):
    seen: list[AuditQuery] = []
    opened: list[str] = []

    async def fake_find(db, query: AuditQuery) -> list[AuditEventRow]:
        seen.append(query)
        if isinstance(result, Exception):
            raise result
        return result

    def fake_run(work) -> None:
        opened.append("session")
        asyncio.run(work(object()))

    monkeypatch.setattr(cli, "find_audit_events", fake_find)
    monkeypatch.setattr(cli, "run_in_session", fake_run)
    return seen, opened


def test_cli_passes_every_filter(monkeypatch, frozen_clock):
    seen, _ = _fake_query(monkeypatch, [])
    entity = uuid7()

    result = runner.invoke(
        cli.app,
        [
            "audit",
            "--building",
            "maple",
            "--actor",
            "Manager@Example.test",
            "--entity",
            f"session:{entity}",
            "--action",
            "auth.",
            "--since",
            "7d",
        ],
    )

    assert result.exit_code == 0, result.output
    assert seen == [
        AuditQuery(
            building_slug="maple",
            actor_email="Manager@Example.test",
            entity_type="session",
            entity_id=entity,
            action_prefix="auth.",
            since=frozen_clock.at - timedelta(days=7),
        )
    ]
    assert result.output.strip() == "no audit events"


@pytest.mark.parametrize(
    ("since", "delta"),
    [("30m", timedelta(minutes=30)), ("12h", timedelta(hours=12)), ("1d", timedelta(days=1))],
)
def test_cli_since_units(monkeypatch, frozen_clock, since, delta):
    seen, _ = _fake_query(monkeypatch, [])

    result = runner.invoke(cli.app, ["audit", "--since", since])

    assert result.exit_code == 0, result.output
    assert seen[0].since == frozen_clock.at - delta


@pytest.mark.parametrize(
    "args",
    [
        ["--since", "7"],
        ["--since", "7w"],
        ["--since", "-1d"],
        ["--since", "d"],
        ["--entity", "session"],
        ["--entity", "session:not-a-uuid"],
        ["--entity", ":" + str(uuid7())],
    ],
)
def test_cli_malformed_option_is_a_usage_error_without_a_session(monkeypatch, args):
    seen, opened = _fake_query(monkeypatch, [])

    result = runner.invoke(cli.app, ["audit", *args])

    assert result.exit_code == 2, result.output
    assert opened == []
    assert seen == []


def test_cli_unknown_building_exits_1(monkeypatch):
    _fake_query(monkeypatch, UnknownFilterValue("no building with slug 'nope'"))

    result = runner.invoke(cli.app, ["audit", "--building", "nope"])

    assert result.exit_code == 1
    assert "no building with slug 'nope'" in result.output


def test_cli_json_flag_prints_json(monkeypatch):
    _fake_query(monkeypatch, [])

    result = runner.invoke(cli.app, ["audit", "--json"])

    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == []
