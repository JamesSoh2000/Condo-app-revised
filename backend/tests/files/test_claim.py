"""`claim_file` (P3-04b criteria 7, 23, 24): attach a verified file to its record, once."""

import asyncio
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

import pytest
from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.buildings.models import Building
from app.core.database import AsyncSessionLocal
from app.files.models import File, FilePurpose, FileStatus
from app.files.service import FileNotFound, InvalidFile, claim_file
from app.memberships.enums import Role
from app.tenancy.context import TenantContext
from app.users.models import User
from tests.world import Member

pytestmark = pytest.mark.anyio

MAINTENANCE, PACKAGE, NOTICE = (
    FilePurpose.MAINTENANCE_PHOTO,
    FilePurpose.PACKAGE_PHOTO,
    FilePurpose.NOTICE_ATTACHMENT,
)


def ctx_of(user_id: uuid.UUID, building_id: uuid.UUID, *roles: Role) -> TenantContext:
    return TenantContext(
        user_id=user_id,
        building_id=building_id,
        membership_id=uuid.uuid4(),
        roles=frozenset(roles),
        features=frozenset(),
    )


def ctx_for(member: Member, *roles: Role) -> TenantContext:
    return ctx_of(member.user.id, member.membership.building_id, *roles)


async def a_file(
    db: AsyncSession,
    building_id: uuid.UUID,
    uploader_id: uuid.UUID,
    purpose: FilePurpose = MAINTENANCE,
    status: FileStatus = FileStatus.READY,
) -> File:
    """A file row as `complete` leaves it (no S3 object: `claim_file` never reads one)."""
    file_id = uuid.uuid7()
    file = File(
        id=file_id,
        building_id=building_id,
        uploaded_by_user_id=uploader_id,
        purpose=purpose,
        s3_key=f"b/{building_id}/{purpose}/{file_id}",
        s3_version_id="v1" if status is FileStatus.READY else None,
        content_type="image/png",
        size_bytes=64,
        original_name="x.png",
        status=status,
    )
    db.add(file)
    await db.flush()
    return file


async def attachment(db: AsyncSession, file_id: uuid.UUID) -> tuple[Any, Any]:
    row = (
        await db.execute(select(File.attached_type, File.attached_id).where(File.id == file_id))
    ).one()
    return (row.attached_type, row.attached_id)


@pytest.fixture
def no_commit(monkeypatch, db: AsyncSession) -> None:
    """`claim_file` is a helper: committing is its caller's job (CLAUDE.md rule 5)."""

    async def refuse() -> None:
        raise AssertionError("claim_file committed")

    monkeypatch.setattr(db, "commit", refuse)


async def test_uploader_claims_own_ready_file(db, world, no_commit):
    file = await a_file(db, world.a.id, world.a_resident1.user.id)
    record_id = uuid.uuid4()

    claimed = await claim_file(
        db,
        ctx_for(world.a_resident1, Role.RESIDENT),
        file.id,
        MAINTENANCE,
        "maintenance_request",
        record_id,
    )

    assert claimed.id == file.id
    assert (claimed.attached_type, claimed.attached_id) == ("maintenance_request", record_id)
    assert await attachment(db, file.id) == ("maintenance_request", record_id)


async def test_claim_of_an_unknown_id_is_404(db, world, no_commit):
    with pytest.raises(FileNotFound):
        await claim_file(
            db,
            ctx_for(world.a_resident1, Role.RESIDENT),
            uuid.uuid4(),
            MAINTENANCE,
            "r",
            uuid.uuid4(),
        )


async def test_another_buildings_file_is_404_and_stays_unattached(db, world, no_commit):
    # `multi` uploaded it in B (as security) and claims it through its A membership.
    file = await a_file(db, world.b.id, world.multi.id, purpose=PACKAGE)

    with pytest.raises(FileNotFound):
        await claim_file(
            db,
            ctx_of(world.multi.id, world.a.id, Role.RESIDENT),
            file.id,
            PACKAGE,
            "r",
            uuid.uuid4(),
        )

    assert await attachment(db, file.id) == (None, None)


@pytest.mark.parametrize("case", ["pending", "wrong purpose", "someone else's"])
async def test_claim_refusals_raise_invalid_file_and_attach_nothing(db, world, no_commit, case):
    resident = ctx_for(world.a_resident1, Role.RESIDENT)
    match case:
        case "pending":
            file = await a_file(db, world.a.id, resident.user_id, status=FileStatus.PENDING)
            purpose = MAINTENANCE
        case "wrong purpose":
            file = await a_file(db, world.a.id, resident.user_id)
            purpose = PACKAGE
        case _:
            file = await a_file(db, world.a.id, world.a_resident2.user.id)
            purpose = MAINTENANCE

    with pytest.raises(InvalidFile) as raised:
        await claim_file(db, resident, file.id, purpose, "maintenance_request", uuid.uuid4())

    assert raised.value.code == "invalid_file"
    assert raised.value.status == 422
    assert await attachment(db, file.id) == (None, None)


async def test_an_attached_file_cannot_be_claimed_again(db, world, no_commit):
    resident = ctx_for(world.a_resident1, Role.RESIDENT)
    file = await a_file(db, world.a.id, resident.user_id)
    first = uuid.uuid4()
    await claim_file(db, resident, file.id, MAINTENANCE, "maintenance_request", first)

    with pytest.raises(InvalidFile):
        await claim_file(db, resident, file.id, MAINTENANCE, "maintenance_request", uuid.uuid4())

    assert await attachment(db, file.id) == ("maintenance_request", first)


async def test_staff_may_claim_another_staff_members_file(db, world, no_commit):
    photo = await a_file(db, world.a.id, world.a_security.user.id, purpose=PACKAGE)
    notice = await a_file(db, world.a.id, world.a_manager.user.id, purpose=NOTICE)
    package_id = uuid.uuid4()

    await claim_file(
        db,
        ctx_for(world.a_manager, Role.PROPERTY_MANAGEMENT),
        photo.id,
        PACKAGE,
        "package",
        package_id,
    )
    # Security uploads package photos too, but never notice attachments.
    with pytest.raises(InvalidFile):
        await claim_file(
            db, ctx_for(world.a_security, Role.SECURITY), notice.id, NOTICE, "notice", uuid.uuid4()
        )

    assert await attachment(db, photo.id) == ("package", package_id)
    assert await attachment(db, notice.id) == (None, None)


@pytest.mark.parametrize(
    ("claimer", "roles", "uploader", "purpose"),
    [
        # Council is staff but may not upload package photos.
        ("a_council", (Role.COUNCIL, Role.RESIDENT), "a_security", PACKAGE),
        # Maintenance photos are a resident purpose: staff can't take a resident's.
        ("a_manager", (Role.PROPERTY_MANAGEMENT,), "a_resident1", MAINTENANCE),
        # Nor a resident another staff member's package photo.
        ("a_resident2", (Role.RESIDENT,), "a_security", PACKAGE),
    ],
)
async def test_staff_claim_refusals(db, world, no_commit, claimer, roles, uploader, purpose):
    file = await a_file(db, world.a.id, getattr(world, uploader).user.id, purpose=purpose)

    with pytest.raises(InvalidFile):
        await claim_file(
            db, ctx_for(getattr(world, claimer), *roles), file.id, purpose, "record", uuid.uuid4()
        )

    assert await attachment(db, file.id) == (None, None)


# --- 23: two concurrent claims ----------------------------------------------------------------


@pytest.fixture
async def committed(engine: AsyncEngine) -> AsyncIterator[dict[str, uuid.UUID]]:
    """A building, a user and their ready file, really committed; deleted afterwards."""
    async with AsyncSessionLocal(bind=engine) as s:
        building = Building(
            slug=f"claim-{uuid.uuid4().hex[:8]}", name="Claims", address="1 Main St", timezone="UTC"
        )
        user = User(email=f"claim-{uuid.uuid4().hex[:8]}@x.io", full_name="Someone")
        s.add_all([building, user])
        await s.flush()
        file = await a_file(s, building.id, user.id)
        ids = {"building": building.id, "user": user.id, "file": file.id}
        await s.commit()
    try:
        yield ids
    finally:
        async with AsyncSessionLocal(bind=engine) as s:
            await s.execute(delete(File).where(File.building_id == ids["building"]))
            await s.execute(delete(User).where(User.id == ids["user"]))
            await s.execute(delete(Building).where(Building.id == ids["building"]))
            await s.commit()


async def _wait_until_blocked_on_a_lock(engine: AsyncEngine, pid: int) -> None:
    async with engine.connect() as conn:
        for _ in range(100):
            waiting = await conn.scalar(
                text("SELECT wait_event_type FROM pg_stat_activity WHERE pid = :pid"), {"pid": pid}
            )
            if waiting == "Lock":
                return
            await asyncio.sleep(0.05)
    raise AssertionError("the second claim never waited for the first one's lock")


async def test_two_concurrent_claims_have_one_winner(engine, committed):
    ctx = ctx_of(committed["user"], committed["building"], Role.RESIDENT)
    winner, loser = uuid.uuid4(), uuid.uuid4()

    def claim(record_id: uuid.UUID) -> Callable[[AsyncSession], Awaitable[File]]:
        return lambda s: claim_file(s, ctx, committed["file"], MAINTENANCE, "request", record_id)

    async with engine.connect() as c1, engine.connect() as c2:
        s1, s2 = AsyncSessionLocal(bind=c1), AsyncSessionLocal(bind=c2)
        pid = (await c2.execute(select(func.pg_backend_pid()))).scalar_one()
        await c2.commit()

        await claim(winner)(s1)

        async def second() -> None:
            try:
                await claim(loser)(s2)
            finally:
                await s2.rollback()

        task = asyncio.create_task(second())
        try:
            await _wait_until_blocked_on_a_lock(engine, pid)
        finally:
            await s1.commit()
        with pytest.raises(InvalidFile):
            await task

    async with AsyncSessionLocal(bind=engine) as s:
        assert await attachment(s, committed["file"]) == ("request", winner)
