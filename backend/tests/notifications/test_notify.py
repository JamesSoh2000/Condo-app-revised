"""`notify` and the recipient helpers (P3-03 criteria 1, 1a-1d, 6, 10-12)."""

import logging
import time
import uuid
from collections.abc import Iterator
from typing import Any
from uuid import uuid7

import pytest
from sqlalchemy import event, func, insert, select
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, AsyncSession

from app.core.database import AsyncSessionLocal
from app.email.templates import SUPPORTED_LOCALES, render_email
from app.jobs.models import Job
from app.memberships.enums import MembershipStatus, Role
from app.memberships.models import BuildingMembership
from app.notifications.kinds import KINDS
from app.notifications.models import Notification
from app.notifications.service import (
    active_member_user_ids,
    notify,
    staff_user_ids,
    unit_resident_user_ids,
)
from app.users.models import User
from tests.email.conftest import point_settings_at
from tests.factories import make_unit
from tests.helpers.db import assert_integrity_error
from tests.notifications.conftest import make_notification
from tests.world import World

pytestmark = pytest.mark.anyio


@pytest.fixture(autouse=True)
def _email_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    point_settings_at(monkeypatch, 1025)


def arrived(world: World, recipients: list[uuid.UUID], **overrides: Any) -> dict[str, Any]:
    entity_id = overrides.pop("entity_id", uuid.UUID("01900000-0000-7000-8000-000000000001"))
    return {
        "building_id": world.a.id,
        "recipient_user_ids": recipients,
        "kind": "package.arrived",
        "title": "A package arrived",
        "body": "Your package is at the front desk.",
        "link": "/packages",
        "entity_type": "package",
        "entity_id": entity_id,
    } | overrides


async def rows(db: AsyncSession) -> list[Notification]:
    return list((await db.scalars(select(Notification).order_by(Notification.id))).all())


async def email_jobs(db: AsyncSession) -> list[Job]:
    return list(
        (await db.scalars(select(Job).where(Job.kind == "email.send").order_by(Job.id))).all()
    )


# Criterion 1


async def test_notify_writes_rows_and_email_jobs_that_commit_together(
    db: AsyncSession, db_connection: AsyncConnection, world: World
) -> None:
    r1, r2 = world.a_resident1.user, world.a_resident2.user
    entity_id = uuid.uuid4()
    await db.commit()

    async with AsyncSessionLocal(
        bind=db_connection, join_transaction_mode="create_savepoint"
    ) as caller:
        await notify(caller, **arrived(world, [r1.id, r2.id], entity_id=entity_id))
        await caller.commit()

    notifications = await rows(db)
    assert [(n.building_id, n.recipient_user_id) for n in notifications] == [
        (world.a.id, r1.id),
        (world.a.id, r2.id),
    ]
    for n in notifications:
        assert (n.kind, n.title, n.body, n.link) == (
            "package.arrived",
            "A package arrived",
            "Your package is at the front desk.",
            "/packages",
        )
        assert (n.entity_type, n.entity_id, n.read_at) == ("package", entity_id, None)

    jobs = await email_jobs(db)
    assert [(j.payload["to"], j.payload["template"], j.dedupe_key) for j in jobs] == [
        # The kind's own template since P5-02a (it was the generic `notification`).
        (r1.email, "package_arrived", f"package.arrived:{entity_id}:{r1.id}"),
        (r2.email, "package_arrived", f"package.arrived:{entity_id}:{r2.id}"),
    ]
    assert jobs[0].payload["context"] == {
        "title": "A package arrived",
        "body": "Your package is at the front desk.",
        "link": "/packages",
    }


async def test_notify_writes_nothing_when_the_caller_rolls_back(
    db: AsyncSession, db_connection: AsyncConnection, world: World
) -> None:
    recipients = [world.a_resident1.user.id, world.a_resident2.user.id]
    await db.commit()

    async with AsyncSessionLocal(
        bind=db_connection, join_transaction_mode="create_savepoint"
    ) as caller:
        await notify(caller, **arrived(world, recipients))
        assert len(await rows(caller)) == 2  # written in the caller's transaction...
        await caller.rollback()

    assert await rows(db) == []  # ...and gone with it
    assert await email_jobs(db) == []


async def test_email_context_adds_template_values_under_the_notifications_own(
    db: AsyncSession, world: World
) -> None:
    await notify(
        db,
        **arrived(
            world,
            [world.a_resident1.user.id],
            email_context={"carrier": "Purolator", "title": "ignored"},
        ),
    )

    (job,) = await email_jobs(db)
    assert job.payload["context"] == {
        "carrier": "Purolator",
        "title": "A package arrived",
        "body": "Your package is at the front desk.",
        "link": "/packages",
    }


# Criterion 1a


async def test_same_entity_again_adds_a_row_but_no_second_email(
    db: AsyncSession, world: World
) -> None:
    recipient = [world.a_resident1.user.id]
    await notify(db, **arrived(world, recipient))
    await notify(db, **arrived(world, recipient))

    assert len(await rows(db)) == 2
    assert len(await email_jobs(db)) == 1


async def test_no_entity_means_no_dedupe_key(db: AsyncSession, world: World) -> None:
    recipient = [world.a_resident1.user.id]
    await notify(db, **arrived(world, recipient, entity_type=None, entity_id=None))
    await notify(db, **arrived(world, recipient, entity_type=None, entity_id=None))

    jobs = await email_jobs(db)
    assert [job.dedupe_key for job in jobs] == [None, None]


# Criterion 1b


async def test_a_repeated_recipient_gets_one_row_and_one_email(
    db: AsyncSession, world: World
) -> None:
    r1, r2 = world.a_resident1.user.id, world.a_resident2.user.id
    await notify(db, **arrived(world, [r2, r1, r2]))

    assert [n.recipient_user_id for n in await rows(db)] == [r2, r1]
    assert len(await email_jobs(db)) == 2


@pytest.fixture
def statements(engine: AsyncEngine) -> Iterator[list[str]]:
    """Every SQL statement sent while the test runs."""
    sent: list[str] = []

    def record(_conn: Any, _cursor: Any, statement: str, *_args: Any) -> None:
        sent.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", record)
    try:
        yield sent
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record)


async def test_no_recipients_writes_nothing(
    db: AsyncSession, world: World, statements: list[str]
) -> None:
    await db.flush()
    statements.clear()

    await notify(db, **arrived(world, []))

    assert statements == []
    assert await rows(db) == []


async def test_every_email_of_a_call_is_queued_in_one_statement(
    db: AsyncSession, world: World, statements: list[str]
) -> None:
    # P6-01c: one `jobs` INSERT per call, whatever the number of recipients, in recipient-id order
    # (each dedupe key is a unique-index entry; the P3-03 deadlock).
    recipients = [world.a_resident2.user.id, world.a_resident1.user.id, world.a_council.user.id]
    await db.flush()
    statements.clear()

    await notify(db, **arrived(world, recipients))

    assert [s.split(" ")[2] for s in statements if s.startswith("INSERT")] == [
        "notifications",
        "jobs",
    ]
    entity = arrived(world, [])["entity_id"]
    assert [job.dedupe_key for job in await email_jobs(db)] == [
        f"package.arrived:{entity}:{user_id}" for user_id in sorted(recipients)
    ]


async def test_active_member_user_ids_lists_each_active_member_once(
    db: AsyncSession, world: World
) -> None:
    assert await active_member_user_ids(db, world.a.id) == sorted(
        [
            world.a_manager.user.id,
            world.a_security.user.id,
            world.a_resident1.user.id,
            world.a_resident2.user.id,
            world.a_council.user.id,
            world.a_former.user.id,
            world.multi.id,
        ]
    )  # not a_pending, a_suspended
    assert await active_member_user_ids(db, world.b.id) == sorted(
        [world.b_manager.user.id, world.b_resident1.user.id, world.multi.id]
    )


# Criterion 1c

BAD_INPUT: list[tuple[str, dict[str, Any]]] = [
    ("unknown kind", {"kind": "package.exploded"}),
    ("long title", {"title": "t" * 201}),
    ("long body", {"body": "b" * 1001}),
    ("long link", {"link": "/" + "l" * 300}),
    ("long entity type", {"entity_type": "e" * 41}),
    ("NUL in the title", {"title": "a\x00b"}),
    ("NUL in the body", {"body": "a\x00b"}),
    ("NUL in the link", {"link": "/a\x00b"}),
    ("NUL in the entity type", {"entity_type": "pack\x00age"}),
    # Postgres can't store a lone surrogate either: asyncpg raised DBAPIError (P3-03 carry).
    ("a lone surrogate in the title", {"title": "a\ud800b"}),
    ("a lone surrogate in the body", {"body": "a\udfffb"}),
    ("a lone surrogate in the link", {"link": "/a\ud800b"}),
    ("a lone surrogate in the entity type", {"entity_type": "pack\ud800age"}),
    ("an empty title", {"title": ""}),
    ("an absolute URL", {"link": "https://evil.example/packages"}),
    ("a javascript URL", {"link": "javascript:alert(1)"}),
    ("a scheme-relative URL", {"link": "//evil.example/packages"}),
    ("a backslash after the slash", {"link": "/\\evil.example"}),
    ("a relative path", {"link": "packages"}),
    ("whitespace in the link", {"link": "/packages\n/x"}),
    ("a space in the link", {"link": "/pack ages"}),
    ("an entity id without its type", {"entity_type": None}),
    ("an entity type without an id", {"entity_id": None}),
]


@pytest.mark.parametrize(("case", "overrides"), BAD_INPUT, ids=[case for case, _ in BAD_INPUT])
async def test_notify_refuses_bad_input(
    db: AsyncSession, world: World, case: str, overrides: dict[str, Any]
) -> None:
    with pytest.raises(ValueError):
        await notify(db, **arrived(world, [world.a_resident1.user.id], **overrides))

    assert await rows(db) == []
    assert await email_jobs(db) == []


async def test_notify_accepts_inputs_at_their_limits(db: AsyncSession, world: World) -> None:
    await notify(
        db,
        **arrived(
            world,
            [world.a_resident1.user.id],
            title="t" * 200,
            body="b" * 1000,
            link="/" + "l" * 299,
            entity_type="e" * 40,
        ),
    )
    await notify(db, **arrived(world, [world.a_resident1.user.id], link=None, body=""))

    assert len(await rows(db)) == 2


async def test_a_recipient_without_a_membership_is_refused(db: AsyncSession, world: World) -> None:
    await assert_integrity_error(
        db,
        notify(db, **arrived(world, [world.b_resident1.user.id])),
        constraint="fk_notifications_building_id_recipient_user_id",
    )
    await assert_integrity_error(
        db,
        notify(db, **arrived(world, [world.no_membership.id])),
        constraint="fk_notifications_building_id_recipient_user_id",
    )


async def test_the_table_refuses_half_an_entity(db: AsyncSession, world: World) -> None:
    await assert_integrity_error(
        db,
        make_notification(db, world.a, world.a_resident1.user.id, entity_type="package"),
        constraint="ck_notifications_entity_complete",
    )
    await assert_integrity_error(
        db,
        make_notification(db, world.a, world.a_resident1.user.id, entity_id=uuid.uuid4()),
        constraint="ck_notifications_entity_complete",
    )


async def test_a_denied_applicant_can_be_notified(db: AsyncSession, world: World) -> None:
    world.a_pending.membership.status = MembershipStatus.DENIED
    await db.flush()

    await notify(
        db,
        **arrived(
            world,
            [world.a_pending.user.id],
            kind="membership.denied",
            title="Your request was declined",
            entity_type="membership",
            entity_id=world.a_pending.membership.id,
        ),
    )

    assert len(await rows(db)) == 1
    assert [job.payload["to"] for job in await email_jobs(db)] == [world.a_pending.user.email]


# Criterion 1d


async def test_inactive_users_and_refused_addresses_get_no_email(
    db: AsyncSession, world: World, caplog: pytest.LogCaptureFixture
) -> None:
    inactive, odd, fine = world.a_resident1.user, world.a_resident2.user, world.a_council.user
    inactive.is_active = False
    odd.email = "josé@example.com"  # P3-02: ASCII addresses only
    await db.flush()

    with caplog.at_level(logging.INFO, logger="app.notifications.service"):
        await notify(db, **arrived(world, [inactive.id, odd.id, fine.id]))

    assert len(await rows(db)) == 3
    assert [job.payload["to"] for job in await email_jobs(db)] == [fine.email]
    # Skips are logged by user id, never by address (CLAUDE.md rule 10).
    assert "josé" not in caplog.text
    assert str(odd.id) in caplog.text


async def test_email_uses_the_recipients_locale(db: AsyncSession, world: World) -> None:
    french, unsupported = world.a_resident1.user, world.a_resident2.user
    french.locale = "fr"
    unsupported.locale = "de"
    await db.flush()

    await notify(db, **arrived(world, [french.id, unsupported.id]))

    assert [job.payload["locale"] for job in await email_jobs(db)] == ["fr", "en"]


# Criterion 6: the timing line (Codex review round 1, Low: missing for an empty call, and counting
# an email that the dedupe key dropped)


async def test_an_empty_call_still_logs_its_timing(
    db: AsyncSession, world: World, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.INFO, logger="app.notifications.service"):
        await notify(db, **arrived(world, []))

    assert any("recipients=0 emails=0 ms=" in message for message in caplog.messages)


async def test_the_timing_counts_only_emails_actually_queued(
    db: AsyncSession, world: World, caplog: pytest.LogCaptureFixture
) -> None:
    inactive = world.a_resident2.user
    inactive.is_active = False
    await db.flush()
    await notify(db, **arrived(world, [world.a_resident1.user.id]))

    with caplog.at_level(logging.INFO, logger="app.notifications.service"):
        # resident1's email is deduped; the inactive user gets none.
        await notify(db, **arrived(world, [world.a_resident1.user.id, inactive.id]))

    assert len(await email_jobs(db)) == 1
    assert any("recipients=2 emails=0 ms=" in message for message in caplog.messages)


async def test_600_recipients_are_inserted_in_one_statement_under_300_ms(
    db: AsyncSession,
    world: World,
    engine: AsyncEngine,
    caplog: pytest.LogCaptureFixture,
) -> None:
    user_ids = [uuid7() for _ in range(600)]
    await db.execute(
        insert(User).values(
            [
                {"id": uid, "email": f"bulk{n}@example.com", "full_name": "x"}
                for n, uid in enumerate(user_ids)
            ]
        )
    )
    await db.execute(
        insert(BuildingMembership).values(
            [
                {"id": uuid7(), "building_id": world.a.id, "user_id": uid, "status": "active"}
                for uid in user_ids
            ]
        )
    )
    timings: list[float] = []

    def before(_conn: Any, _cursor: Any, statement: str, *_args: Any) -> None:
        if statement.startswith("INSERT INTO notifications"):
            timings.append(-time.perf_counter())

    def after(_conn: Any, _cursor: Any, statement: str, *_args: Any) -> None:
        if statement.startswith("INSERT INTO notifications"):
            timings[-1] += time.perf_counter()

    event.listen(engine.sync_engine, "before_cursor_execute", before)
    event.listen(engine.sync_engine, "after_cursor_execute", after)
    try:
        with caplog.at_level(logging.INFO, logger="app.notifications.service"):
            await notify(db, **arrived(world, user_ids))
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", before)
        event.remove(engine.sync_engine, "after_cursor_execute", after)

    logging.getLogger(__name__).warning(
        "600-recipient notify: row insert %.0f ms; %s", timings[0] * 1000, caplog.messages[-1]
    )
    assert len(timings) == 1
    assert timings[0] < 0.3
    assert await db.scalar(select(func.count()).select_from(Notification)) == 600
    assert len(await email_jobs(db)) == 600
    assert "recipients=600" in caplog.text


# Criteria 10 and 11


async def test_unit_resident_user_ids_keeps_active_current_occupants(
    db: AsyncSession, world: World
) -> None:
    assert set(await unit_resident_user_ids(db, world.a.id, world.a_201.id)) == {
        world.a_council.user.id,
        world.multi.id,
    }  # not a_suspended, who also lives in 201
    assert await unit_resident_user_ids(db, world.a.id, world.a_101.id) == [
        world.a_resident1.user.id
    ]  # not a_former, whose time in 101 ended
    # Another building's unit, through building A: nothing.
    assert await unit_resident_user_ids(db, world.a.id, world.b_101.id) == []
    assert await unit_resident_user_ids(db, world.a.id, (await make_unit(db, world.a)).id) == []


async def test_staff_user_ids_returns_active_staff_of_the_building(
    db: AsyncSession, world: World
) -> None:
    # multi is security only in B; b_manager is in B.
    assert await staff_user_ids(db, world.a.id, [Role.SECURITY]) == [world.a_security.user.id]
    assert set(await staff_user_ids(db, world.a.id, [Role.PROPERTY_MANAGEMENT, Role.COUNCIL])) == {
        world.a_manager.user.id,
        world.a_council.user.id,
    }
    assert await staff_user_ids(db, world.b.id, [Role.SECURITY]) == [world.multi.id]
    assert await staff_user_ids(db, world.a.id, []) == []

    world.a_security.membership.status = MembershipStatus.SUSPENDED
    await db.flush()
    assert await staff_user_ids(db, world.a.id, [Role.SECURITY]) == []


async def test_a_user_with_several_matching_roles_is_listed_once(
    db: AsyncSession, world: World
) -> None:
    # a_council holds council and resident.
    ids = await staff_user_ids(db, world.a.id, [Role.COUNCIL, Role.RESIDENT])
    assert ids.count(world.a_council.user.id) == 1


# Criterion 12


def test_only_the_in_app_kinds_have_no_email() -> None:
    # P3-03's kinds all email; P4-05a adds the first in-app-only one (the ticket: managers are
    # notified in-app), P5-02b the pickup (its ticket: in-app only), P6-01c a normal notice (only
    # urgent ones email), P6-03b a normal maintenance request (only emergencies email), P6-03d a
    # resident's comment (managers in-app, D2). A new kind without a template must be added here on
    # purpose.
    assert sorted(k for k, spec in KINDS.items() if spec.email_template is None) == [
        "maintenance.resident_commented",
        "maintenance.submitted",
        "notice.published",
        "onboarding.submitted",
        "package.picked_up",
    ]


@pytest.mark.parametrize("locale", SUPPORTED_LOCALES)
@pytest.mark.parametrize("kind", sorted(k for k, spec in KINDS.items() if spec.email_template))
def test_every_kinds_template_renders(kind: str, locale: str) -> None:
    template = KINDS[kind].email_template
    assert template is not None
    email = render_email(
        template,
        {"title": "A package arrived", "body": "At the desk.", "link": "/packages"},
        locale,
    )
    assert email.subject.endswith("A package arrived")
    assert "At the desk." in email.text
    assert "http://localhost:5173/packages" in email.text
    assert 'href="http://localhost:5173/packages"' in email.html

    # Without a link, only the layout's footer names the site.
    without_link = render_email(template, {"title": "T", "body": "B", "link": None}, locale)
    assert "localhost:5173/" not in without_link.text + without_link.html
