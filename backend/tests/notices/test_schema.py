"""P6-01a criteria 1-4 (and 1a-4a): what the `notices` table refuses."""

from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.notices.enums import NoticePriority, NoticeStatus
from tests.helpers.db import assert_integrity_error
from tests.notices.conftest import archived, make_attachment, make_notice, published
from tests.world import World

pytestmark = pytest.mark.anyio

T = World.T2 + timedelta(days=3)
MEMBERSHIP_COLUMNS = (
    "author_membership_id",
    "published_by_membership_id",
    "archived_by_membership_id",
)


# --- criteria 2 and 2a: every reference stays in the notice's building --------------------------


@pytest.mark.parametrize("column", ["attachment_file_id", *MEMBERSHIP_COLUMNS])
async def test_a_reference_to_another_building_is_rejected(
    db: AsyncSession, world: World, column: str
):
    b_file = await make_attachment(
        db, world.b.id, world.b_manager.user.id, content_type="application/pdf"
    )
    manager = world.a_manager.membership
    # A row valid in every other respect, so only the cross-building FK can fail.
    overrides: dict[str, Any] = {
        "published_by_membership_id": published(manager, T),
        "archived_by_membership_id": archived(manager, T + timedelta(days=1)),
    }.get(column, {})
    overrides = dict(overrides)
    overrides[column] = (
        b_file.id if column == "attachment_file_id" else world.b_manager.membership.id
    )

    await assert_integrity_error(
        db, make_notice(db, manager, **overrides), constraint=f"fk_notices_building_id_{column}"
    )


async def test_references_in_the_notices_own_building_are_accepted(db: AsyncSession, world: World):
    manager = world.a_manager.membership
    file = await make_attachment(db, world.a.id, world.a_manager.user.id, content_type="image/png")

    notice = await make_notice(
        db,
        manager,
        attachment_file_id=file.id,
        published_at=T,
        published_by_membership_id=manager.id,
        **archived(manager, T + timedelta(days=1)),
    )

    assert notice.attachment_file_id == file.id


async def test_the_same_id_can_be_a_composite_fk_target(db: AsyncSession):
    # D7: P6-01c's notice_reads references notices(building_id, id).
    unique = await db.scalar(
        text(
            "SELECT count(*) FROM pg_constraint WHERE conrelid = 'notices'::regclass"
            " AND contype = 'u' AND conname = 'uq_notices_building_id_id'"
        )
    )
    assert unique == 1


# --- criteria 1 and 1a: enum values -----------------------------------------------------------


@pytest.mark.parametrize(
    ("column", "value", "constraint"),
    # Values that fit the column (varchar of the longest member), so only the check can refuse them.
    [
        ("priority", "loud", "ck_notices_notice_priority"),
        ("status", "deleted", "ck_notices_notice_status"),
    ],
)
async def test_unknown_enum_values_are_refused(
    db: AsyncSession, world: World, column: str, value: str, constraint: str
):
    notice = await make_notice(db, world.a_manager.membership)

    async def write() -> None:
        await db.execute(
            text(f"UPDATE notices SET {column} = :value WHERE id = :id"),  # noqa: S608
            {"id": notice.id, "value": value},
        )

    await assert_integrity_error(db, write(), constraint=constraint)


# --- criteria 3, 3a, 4 and 4a: each state's columns ----------------------------------------------


async def test_a_valid_row_of_each_state_is_accepted(db: AsyncSession, world: World):
    manager = world.a_manager.membership
    draft = await make_notice(db, manager, expires_at=T)
    live = await make_notice(
        db,
        manager,
        priority=NoticePriority.URGENT,
        **published(manager, T, expires_at=T + timedelta(days=7)),
    )
    retired = await make_notice(
        db,
        manager,
        published_at=T,
        published_by_membership_id=manager.id,
        **archived(manager, T + timedelta(days=1)),
    )
    discarded = await make_notice(db, manager, **archived(manager, T))

    assert [n.status for n in (draft, live, retired, discarded)] == [
        NoticeStatus.DRAFT,
        NoticeStatus.PUBLISHED,
        NoticeStatus.ARCHIVED,
        NoticeStatus.ARCHIVED,
    ]


def _invalid_rows() -> list[Any]:
    """(state, overrides, constraint) for every way a row can break its checks. Persona names
    stand for their membership ids (the world isn't built at collection time)."""
    later = T + timedelta(hours=2)
    rows: list[tuple[str, str, dict[str, Any], str]] = [
        ("draft with published_at", "draft", {"published_at": later}, "draft_state"),
        (
            "draft with published_by",
            "draft",
            {"published_by_membership_id": "a_manager"},
            "draft_state",
        ),
        ("draft with archived_at", "draft", {"archived_at": later}, "draft_state"),
        (
            "draft with archived_by",
            "draft",
            {"archived_by_membership_id": "a_manager"},
            "draft_state",
        ),
        ("published without published_at", "published", {"published_at": None}, "published_state"),
        (
            "published without published_by",
            "published",
            {"published_by_membership_id": None},
            "published_state",
        ),
        ("published with archived_at", "published", {"archived_at": later}, "published_state"),
        (
            "published with archived_by",
            "published",
            {"archived_by_membership_id": "a_manager"},
            "published_state",
        ),
        ("archived without archived_at", "archived", {"archived_at": None}, "archived_state"),
        (
            "archived without archived_by",
            "archived",
            {"archived_by_membership_id": None},
            "archived_state",
        ),
        (
            "archived with published_at but no publisher",
            "archived",
            {"published_at": T},
            "archived_state",
        ),
        (
            "archived with a publisher but no published_at",
            "archived",
            {"published_by_membership_id": "a_manager"},
            "archived_state",
        ),
        (
            "archived before it was published",
            "archived",
            {
                "published_at": later + timedelta(hours=1),
                "published_by_membership_id": "a_manager",
            },
            "archived_after_published",
        ),
        (
            "expiring when it was published",
            "published",
            {"expires_at": T},
            "expires_after_published",
        ),
        (
            "expiring before it was published",
            "published",
            {"expires_at": T - timedelta(seconds=1)},
            "expires_after_published",
        ),
        ("a blank title", "draft", {"title": "  "}, "title_not_blank"),
        ("an empty title", "draft", {"title": ""}, "title_not_blank"),
        ("a blank body", "draft", {"body": " \t"}, "body_not_blank"),
    ]
    return [
        pytest.param(state, overrides, f"ck_notices_{constraint}", id=name)
        for name, state, overrides, constraint in rows
    ]


@pytest.mark.parametrize(("state", "overrides", "constraint"), _invalid_rows())
async def test_state_checks_reject_a_row_that_breaks_its_state(
    db: AsyncSession, world: World, state: str, overrides: dict[str, Any], constraint: str
):
    manager = world.a_manager.membership
    resolved = {
        key: getattr(world, value).membership.id
        if key.endswith("membership_id") and value
        else value
        for key, value in overrides.items()
    }
    base = {
        "draft": {},
        "published": published(manager, T),
        "archived": archived(manager, T + timedelta(hours=2)),
    }[state]

    await assert_integrity_error(
        db, make_notice(db, manager, **{**base, **resolved}), constraint=constraint
    )


@pytest.mark.parametrize(("column", "length"), [("title", 200), ("body", 10_000)])
async def test_text_columns_hold_their_limit(
    db: AsyncSession, world: World, column: str, length: int
):
    notice = await make_notice(db, world.a_manager.membership, **{column: "x" * length})

    assert len(getattr(notice, column)) == length
