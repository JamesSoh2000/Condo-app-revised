"""The record fence (ADR-0021, inbox B-10): an occupancy write whose transaction began before a
unit's maintenance request was stamped, but that reaches the occupancy after the request committed,
is refused with 409 `occupancy_changed` instead of moving the window edge behind the request.

On real connections, with `test_concurrency.py`'s scratch database (one session per request). "Began
before" is a session whose first statement ran before the create: its `now()` is from then.
"""

import asyncio
from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import func, select

from app.core import clock
from app.core.errors import DomainError
from app.core.security import generate_token, hash_token
from app.invitations import service as invitations
from app.invitations.models import Invitation
from app.invitations.schemas import InvitationAccept
from app.maintenance import service
from app.maintenance.enums import MaintenanceLocation
from app.maintenance.models import MaintenanceRequest
from app.maintenance.schemas import MaintenanceRequestCreate, MaintenanceRequestOut
from app.memberships.enums import MembershipStatus, OccupancyRelationship, Role
from app.memberships.models import UnitOccupancy
from app.memberships.occupancy import end_occupancy, transfer_occupancy
from app.memberships.schemas import MemberDeactivateIn, MemberTransferIn
from app.memberships.service import deactivate_member, transfer_member
from app.onboarding import service as onboarding
from app.onboarding.models import OnboardingRequest
from app.rate_limits.service import RateLimiter
from tests.factories import make_membership, make_user
from tests.maintenance.test_concurrency import Sessions, _data, _run
from tests.packages.conftest import persona_ctx
from tests.world import World

MOVE_OUT = MemberDeactivateIn(reason="Lease ended.")


async def _submit(
    sessions: Sessions, world: World, data: MaintenanceRequestCreate, key: str = "fence-0001"
) -> MaintenanceRequestOut:
    async with sessions() as db:
        result = await service.create_request(db, persona_ctx(world, "a_resident1"), data, key)
    return result.request


async def _code(action: Any) -> str:
    try:
        await action
    except DomainError as exc:
        return exc.code
    return "done"


async def _current_unit(sessions: Sessions, membership_id: Any) -> Any:
    async with sessions() as db:
        return await db.scalar(
            select(UnitOccupancy.unit_id).where(
                UnitOccupancy.membership_id == membership_id, UnitOccupancy.ended_at.is_(None)
            )
        )


def test_a_move_out_that_began_before_a_request_is_refused_then_a_retry_ends_after_it(
    scratch_database_url: str,
) -> None:
    async def body(sessions: Sessions, world: World, _fixture: MaintenanceRequest) -> None:
        manager = persona_ctx(world, "a_manager")
        resident = world.a_resident1.membership.id
        async with sessions() as stale:
            await stale.scalar(select(func.now()))
            request = await _submit(sessions, world, _data(world))
            code = await _code(deactivate_member(stale, manager, resident, MOVE_OUT))
        assert code == "occupancy_changed"
        assert await _current_unit(sessions, resident) == world.a_101.id

        async with sessions() as retry:
            await deactivate_member(retry, manager, resident, MOVE_OUT)
        async with sessions() as db:
            ended = await db.scalar(
                select(UnitOccupancy.ended_at).where(UnitOccupancy.membership_id == resident)
            )
        assert ended is not None and ended > request.submitted_at

    _run(scratch_database_url, body)


@pytest.mark.parametrize("where", ["common area", "another unit"])
def test_a_request_elsewhere_does_not_refuse_a_move_out(
    scratch_database_url: str, where: str
) -> None:
    # Only the unit the move-out ends is fenced: a common-area request has no unit, and a request
    # for a unit the member doesn't leave isn't in the window that moves.
    async def body(sessions: Sessions, world: World, _fixture: MaintenanceRequest) -> None:
        manager = persona_ctx(world, "a_manager")
        async with sessions() as stale:
            await stale.scalar(select(func.now()))
            if where == "common area":
                data = MaintenanceRequestCreate(
                    location=MaintenanceLocation.COMMON_AREA,
                    common_area="Lobby",
                    category="plumbing",
                    description="The lobby tap drips.",
                )
                await _submit(sessions, world, data)
            else:
                async with sessions() as db:
                    await service.create_request(
                        db,
                        persona_ctx(world, "a_resident2"),
                        MaintenanceRequestCreate(
                            location=MaintenanceLocation.UNIT,
                            unit_id=world.a_102.id,
                            category="plumbing",
                            description="The bath tap drips.",
                        ),
                        "fence-0002",
                    )
            code = await _code(
                deactivate_member(stale, manager, world.a_resident1.membership.id, MOVE_OUT)
            )
        assert code == "done"

    _run(scratch_database_url, body)


def test_an_explicit_time_is_not_fenced(scratch_database_url: str) -> None:
    # Seeds, tests and backfills pass `at` on purpose (ADR-0016): the fence is for `now()` only.
    async def body(sessions: Sessions, world: World, _fixture: MaintenanceRequest) -> None:
        async with sessions() as db:
            before = await db.scalar(select(func.now()))
        await _submit(sessions, world, _data(world))
        async with sessions() as db:
            ended = await end_occupancy(
                db, building_id=world.a.id, membership_id=world.a_resident1.membership.id, at=before
            )
            await db.commit()
        assert ended is not None and ended.ended_at == before

    _run(scratch_database_url, body)


def test_an_approval_that_began_before_a_request_is_refused(scratch_database_url: str) -> None:
    # The start side, conservative (ADR-0021): a backdated start that can see a committed request
    # of the unit is refused, though "move in, then the request" would also show it to them.
    async def body(sessions: Sessions, world: World, _fixture: MaintenanceRequest) -> None:
        async with sessions() as db:
            user = await make_user(db)
            membership = await make_membership(user, world.a, status=MembershipStatus.PENDING)
            joining = OnboardingRequest(
                building_id=world.a.id,
                membership_id=membership.id,
                unit_id=world.a_101.id,
                relationship=OccupancyRelationship.TENANT,
            )
            db.add(joining)
            await db.commit()
        async with sessions() as stale:
            await stale.scalar(select(func.now()))
            await _submit(sessions, world, _data(world))
            code = await _code(
                onboarding.approve_request(stale, persona_ctx(world, "a_manager"), joining.id)
            )
        assert code == "occupancy_changed"
        assert await _current_unit(sessions, membership.id) is None

    _run(scratch_database_url, body)


def test_an_invitation_accept_that_began_before_a_request_is_refused(
    scratch_database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The accept ends its read and begins its writing transaction itself: hold it at the occupancy
    # helper, after that transaction's first statements, while the request commits.
    async def body(sessions: Sessions, world: World, _fixture: MaintenanceRequest) -> None:
        token = generate_token()
        async with sessions() as db:
            db.add(
                Invitation(
                    building_id=world.a.id,
                    email="newcomer@example.test",
                    roles=[Role.RESIDENT.value],
                    unit_id=world.a_101.id,
                    relationship=OccupancyRelationship.TENANT,
                    token_hash=hash_token(token),
                    expires_at=clock.now() + timedelta(days=7),
                    created_by_user_id=world.a_manager.user.id,
                )
            )
            await db.commit()
        reached, release = asyncio.Event(), asyncio.Event()

        async def held(*args: Any, **kwargs: Any) -> Any:
            reached.set()
            await release.wait()
            return await transfer_occupancy(*args, **kwargs)

        monkeypatch.setattr(invitations, "transfer_occupancy", held)
        async with sessions() as db:
            accepting = asyncio.create_task(
                _code(
                    invitations.accept_invitation(
                        db,
                        RateLimiter(sessions),
                        token,
                        InvitationAccept(
                            full_name="Nina Newcomer",
                            password="correct horse battery staple",  # noqa: S106
                        ),
                        session_token=None,
                        user_agent=None,
                        ip=None,
                    )
                )
            )
            await asyncio.wait_for(reached.wait(), 10)
            await _submit(sessions, world, _data(world))
            release.set()
            code = await asyncio.wait_for(accepting, 10)
        assert code == "occupancy_changed"
        async with sessions() as db:
            assert (
                await db.scalar(
                    select(func.count())
                    .select_from(UnitOccupancy)
                    .where(
                        UnitOccupancy.unit_id == world.a_101.id, UnitOccupancy.ended_at.is_(None)
                    )
                )
                == 1
            )

    _run(scratch_database_url, body)


def test_a_newcomer_who_moved_in_before_a_request_keeps_it_after_the_requester_leaves(
    scratch_database_url: str,
) -> None:
    # Review round 3's case run serially: an uncommitted request the start-side fence can't see
    # ends the same way, so it is the co-occupant rule (`visible_maintenance`), not a leak.
    async def body(sessions: Sessions, world: World, _fixture: MaintenanceRequest) -> None:
        manager = persona_ctx(world, "a_manager")
        async with sessions() as db:
            await transfer_member(
                db,
                manager,
                world.a_resident2.membership.id,
                MemberTransferIn(unit_id=world.a_101.id, relationship=OccupancyRelationship.TENANT),
            )
        request = await _submit(sessions, world, _data(world))
        async with sessions() as db:
            await transfer_member(
                db,
                manager,
                world.a_resident1.membership.id,
                MemberTransferIn(unit_id=world.a_102.id, relationship=OccupancyRelationship.TENANT),
            )
        async with sessions() as db:
            seen = await service.get_request(db, persona_ctx(world, "a_resident2"), request.id)
        assert seen.id == request.id

    _run(scratch_database_url, body)
