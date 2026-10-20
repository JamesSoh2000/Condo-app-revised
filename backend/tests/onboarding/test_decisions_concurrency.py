"""Races in the managers' decisions (P4-05b criteria 4 and 14, tenant row 10): two approvals, an
approval and a denial, and an approval meeting a unit's deactivation.

On real connections, as `test_concurrency.py` (whose `_run` builds the world in a scratch database).
"""

import asyncio
from typing import Any

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.errors import DomainError
from app.memberships.enums import MembershipStatus, OccupancyRelationship, Role
from app.memberships.models import BuildingMembership, UnitOccupancy
from app.onboarding import service
from app.onboarding.models import OnboardingRequest, OnboardingStatus
from app.onboarding.schemas import OnboardingDecisionIn
from app.tenancy.context import TenantContext
from app.units import service as unit_service
from app.units.models import Unit
from tests.factories import make_membership, make_unit, make_user
from tests.onboarding.test_concurrency import _run
from tests.world import World

type Sessions = async_sessionmaker[AsyncSession]


def _ctx(world: World) -> TenantContext:
    manager = world.a_manager
    return TenantContext(
        user_id=manager.user.id,
        building_id=world.a.id,
        membership_id=manager.membership.id,
        roles=frozenset({Role.PROPERTY_MANAGEMENT}),
        features=frozenset(),
    )


async def _pending_request(
    sessions: Sessions, world: World, unit_id: Any = None
) -> tuple[Any, Any]:
    async with sessions() as db:
        user = await make_user(db)
        membership = await make_membership(user, world.a, status=MembershipStatus.PENDING)
        request = OnboardingRequest(
            building_id=world.a.id,
            membership_id=membership.id,
            unit_id=unit_id or world.a_102.id,
            relationship=OccupancyRelationship.TENANT,
        )
        db.add(request)
        await db.commit()
        return membership.id, request.id


async def _decide(sessions: Sessions, world: World, request_id: Any, action: str) -> str:
    async with sessions() as db:
        try:
            if action == "approve":
                await service.approve_request(db, _ctx(world), request_id)
            else:
                await service.deny_request(
                    db, _ctx(world), request_id, OnboardingDecisionIn(reason="Not on the lease.")
                )
        except DomainError as exc:
            return exc.code
        return action


async def _scalar(sessions: Sessions, stmt: Any) -> Any:
    async with sessions() as db:
        return await db.scalar(stmt)


@pytest.mark.parametrize("second", ["approve", "deny"])
def test_concurrent_decisions_give_one_winner(scratch_database_url: str, second: str) -> None:
    async def body(sessions: Sessions, world: World) -> None:
        membership_id, request_id = await _pending_request(sessions, world)

        outcomes = await asyncio.gather(
            _decide(sessions, world, request_id, "approve"),
            _decide(sessions, world, request_id, second),
        )

        winners = [o for o in outcomes if o in {"approve", "deny"}]
        assert len(winners) == 1, outcomes
        assert sorted(outcomes) == sorted([winners[0], "already_decided"])
        status = await _scalar(
            sessions, select(OnboardingRequest.status).where(OnboardingRequest.id == request_id)
        )
        assert status == (
            OnboardingStatus.APPROVED if winners[0] == "approve" else OnboardingStatus.DENIED
        )
        occupancies = await _scalar(
            sessions,
            select(func.count()).where(UnitOccupancy.membership_id == membership_id),
        )
        assert occupancies == (1 if winners[0] == "approve" else 0)

    _run(scratch_database_url, body)


@pytest.mark.parametrize("deactivation_commits", [True, False], ids=["commits", "rolls-back"])
def test_approval_waits_for_a_unit_deactivation(
    scratch_database_url: str, deactivation_commits: bool
) -> None:
    # As `deactivate_unit` does: the unit FOR UPDATE, then is_active. The approval's FOR KEY SHARE
    # read waits, then re-checks is_active on the row the deactivation committed.
    async def body(sessions: Sessions, world: World) -> None:
        membership_id, request_id = await _pending_request(sessions, world)
        async with sessions() as deactivating:
            await deactivating.execute(
                select(Unit.id).where(Unit.id == world.a_102.id).with_for_update()
            )
            await deactivating.execute(
                update(Unit).where(Unit.id == world.a_102.id).values(is_active=False)
            )
            task = asyncio.create_task(_decide(sessions, world, request_id, "approve"))
            await asyncio.sleep(1.0)
            assert not task.done(), "the approval did not wait for the unit's deactivation"
            if deactivation_commits:
                await deactivating.commit()
            else:
                await deactivating.rollback()
            outcome = await asyncio.wait_for(task, timeout=10)

        assert outcome == ("unit_inactive" if deactivation_commits else "approve")
        request_status, membership_status = (
            await _scalar(
                sessions,
                select(OnboardingRequest.status).where(OnboardingRequest.id == request_id),
            ),
            await _scalar(
                sessions,
                select(BuildingMembership.status).where(BuildingMembership.id == membership_id),
            ),
        )
        if deactivation_commits:
            assert (request_status, membership_status) == (
                OnboardingStatus.PENDING,
                MembershipStatus.PENDING,
            )
        else:
            assert (request_status, membership_status) == (
                OnboardingStatus.APPROVED,
                MembershipStatus.ACTIVE,
            )

    _run(scratch_database_url, body)


@pytest.mark.parametrize("approval_commits", [True, False], ids=["commits", "rolls-back"])
def test_unit_deactivation_waits_for_an_approval(
    scratch_database_url: str, approval_commits: bool
) -> None:
    # The other order (criterion 14; review round 1, Claude: tested only sequentially). The approval
    # holds the unit FOR KEY SHARE and its new occupancy until it commits; `deactivate_unit`'s FOR
    # UPDATE waits, then sees the occupancy (409) or, after a rollback, deactivates the unit.
    async def body(sessions: Sessions, world: World) -> None:
        # A unit nobody lives in (102 has residents in the world, which would refuse it anyway).
        async with sessions() as db:
            unit_id = (await make_unit(db, world.a)).id
            await db.commit()
        _, request_id = await _pending_request(sessions, world, unit_id)
        release = asyncio.Event()
        async with sessions() as approving:
            real_commit = approving.commit

            async def held_commit() -> None:
                await release.wait()
                if not approval_commits:
                    raise RuntimeError("simulated failure at commit")
                await real_commit()

            approving.commit = held_commit  # type: ignore[method-assign]
            approval = asyncio.create_task(
                service.approve_request(approving, _ctx(world), request_id)
            )
            await asyncio.sleep(0.5)
            deactivation = asyncio.create_task(_deactivate(sessions, world, unit_id))
            await asyncio.sleep(1.0)
            assert not deactivation.done(), "the deactivation did not wait for the approval"
            release.set()
            if approval_commits:
                await asyncio.wait_for(approval, timeout=10)
            else:
                with pytest.raises(RuntimeError, match="simulated failure"):
                    await asyncio.wait_for(approval, timeout=10)
                await approving.rollback()
            outcome = await asyncio.wait_for(deactivation, timeout=10)

        assert outcome == ("unit_has_occupants" if approval_commits else "deactivated")
        active = await _scalar(sessions, select(Unit.is_active).where(Unit.id == unit_id))
        assert active is approval_commits

    _run(scratch_database_url, body)


async def _deactivate(sessions: Sessions, world: World, unit_id: Any) -> str:
    async with sessions() as db:
        try:
            await unit_service.deactivate_unit(db, _ctx(world), unit_id)
        except DomainError as exc:
            return exc.code
        return "deactivated"
