"""Races in membership administration (P4-06a criteria 3, 14, 15, 17; tenant row 10): two managers
demoting or suspending each other, a manager acting after losing their authority, two suspensions of
one member, and a session write meeting a role change.

On real connections, as `tests/onboarding/test_decisions_concurrency.py` (whose `_run` builds the
world in a scratch database). The first write is held open (its commit is deferred); the second must
wait for it on the building lock, then act on what it committed.
"""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.audit.models import AuditEvent
from app.auth import service as auth
from app.core.errors import DomainError
from app.core.security import hash_token
from app.invitations import service as invitations
from app.invitations.models import Invitation
from app.invitations.schemas import InvitationAccept, InvitationCreate
from app.memberships import service
from app.memberships.enums import MembershipStatus, OccupancyRelationship, Role
from app.memberships.models import BuildingMembership, MembershipRole, UnitOccupancy
from app.memberships.schemas import (
    MemberDeactivateIn,
    MemberRolesIn,
    MemberSuspendIn,
    MemberTransferIn,
)
from app.rate_limits.service import RateLimiter
from app.tenancy.context import TenantContext
from tests.conftest import FrozenClock
from tests.factories import make_membership, make_user
from tests.onboarding.test_concurrency import _run
from tests.world import Member, World

type Sessions = async_sessionmaker[AsyncSession]
type Write = Callable[[AsyncSession], Awaitable[Any]]

REASON = MemberSuspendIn(reason="Unpaid fees")
MOVED_OUT = MemberDeactivateIn(reason="Moved out")


def _ctx(world: World, member: Member) -> TenantContext:
    return TenantContext(
        user_id=member.user.id,
        building_id=world.a.id,
        membership_id=member.membership.id,
        roles=frozenset({Role.PROPERTY_MANAGEMENT}),
        features=frozenset(),
    )


async def _second_manager(
    sessions: Sessions, world: World, roles: tuple[Role, ...] = (Role.PROPERTY_MANAGEMENT,)
) -> Member:
    async with sessions() as db:
        user = await make_user(db, full_name="second manager")
        membership = await make_membership(user, world.a, roles=roles)
        await db.commit()
        return Member(user, membership)


def _demote(ctx: TenantContext, target: UUID) -> Write:
    async def write(db: AsyncSession) -> Any:
        return await service.change_roles(
            db, ctx, target, MemberRolesIn(add=[Role.COUNCIL], remove=[Role.PROPERTY_MANAGEMENT])
        )

    return write


def _suspend(ctx: TenantContext, target: UUID) -> Write:
    async def write(db: AsyncSession) -> Any:
        return await service.suspend_member(db, ctx, target, REASON)

    return write


def _remove_manager(ctx: TenantContext, target: UUID) -> Write:
    async def write(db: AsyncSession) -> Any:
        return await service.change_roles(
            db, ctx, target, MemberRolesIn(remove=[Role.PROPERTY_MANAGEMENT])
        )

    return write


def _deactivate(ctx: TenantContext, target: UUID) -> Write:
    async def write(db: AsyncSession) -> Any:
        return await service.deactivate_member(db, ctx, target, MOVED_OUT)

    return write


def _transfer(ctx: TenantContext, target: UUID, unit_id: UUID) -> Write:
    async def write(db: AsyncSession) -> Any:
        return await service.transfer_member(
            db,
            ctx,
            target,
            MemberTransferIn(unit_id=unit_id, relationship=OccupancyRelationship.TENANT),
        )

    return write


async def _outcome(write: Write, db: AsyncSession) -> str:
    try:
        await write(db)
    except DomainError as exc:
        await db.rollback()
        return exc.code
    return "ok"


async def _held_then(sessions: Sessions, first: Write, second: Write) -> tuple[str, str]:
    """Run `first` with its commit held, start `second` and check that it waits, then commit
    `first` and return both outcomes."""
    async with sessions() as held:
        commit = held.commit

        async def hold() -> None:
            pass

        held.commit = hold  # type: ignore[method-assign]
        first_outcome = await _outcome(first, held)
        held.commit = commit  # type: ignore[method-assign]

        async def run_second() -> str:
            async with sessions() as db:
                return await _outcome(second, db)

        task = asyncio.create_task(run_second())
        await asyncio.sleep(0.5)
        assert not task.done(), "the second write did not wait for the first"
        await held.commit()
        second_outcome = await asyncio.wait_for(task, timeout=10)
    return first_outcome, second_outcome


async def _scalar(sessions: Sessions, stmt: Any) -> Any:
    async with sessions() as db:
        return await db.scalar(stmt)


async def _active_managers(sessions: Sessions, world: World) -> int:
    count: int = await _scalar(
        sessions,
        select(func.count())
        .select_from(BuildingMembership)
        .join(MembershipRole, MembershipRole.membership_id == BuildingMembership.id)
        .where(
            BuildingMembership.building_id == world.a.id,
            BuildingMembership.status == MembershipStatus.ACTIVE,
            MembershipRole.role == Role.PROPERTY_MANAGEMENT,
        ),
    )
    return count


@pytest.mark.parametrize(
    ("action", "second_roles"),
    [
        (_demote, (Role.PROPERTY_MANAGEMENT,)),
        (_suspend, (Role.PROPERTY_MANAGEMENT,)),
        (_deactivate, (Role.PROPERTY_MANAGEMENT,)),
        (_remove_manager, (Role.PROPERTY_MANAGEMENT, Role.COUNCIL)),
    ],
    ids=["demote", "suspend", "deactivate", "remove-only"],
)
def test_managers_acting_on_each_other_leave_one_manager(
    scratch_database_url: str,
    action: Callable[[TenantContext, UUID], Write],
    second_roles: tuple[Role, ...],
) -> None:
    # Criterion 3. Without the building lock, each would count the other still active and both
    # succeed, leaving none. P4-06b: `deactivate` too (criterion 9), and `remove-only` (criterion
    # 10, the open Medium of PR #93): the second, holding council too, removes the first's only
    # role; `LastManager` from the precedence check must not turn into the stale refusal (403).
    async def body(sessions: Sessions, world: World) -> None:
        second = await _second_manager(sessions, world, second_roles)
        first = world.a_manager

        outcomes = await _held_then(
            sessions,
            action(_ctx(world, first), second.membership.id),
            action(_ctx(world, second), first.membership.id),
        )

        assert outcomes == ("ok", "last_manager")
        assert await _active_managers(sessions, world) == 1

    _run(scratch_database_url, body)


def test_concurrent_managers_without_holding_still_leave_one(scratch_database_url: str) -> None:
    # Criterion 3 as two plain concurrent requests: whichever order the database picks.
    async def body(sessions: Sessions, world: World) -> None:
        second = await _second_manager(sessions, world)
        first = world.a_manager

        async def run(write: Write) -> str:
            async with sessions() as db:
                return await _outcome(write, db)

        outcomes = await asyncio.gather(
            run(_demote(_ctx(world, first), second.membership.id)),
            run(_demote(_ctx(world, second), first.membership.id)),
        )

        assert sorted(outcomes) == ["last_manager", "ok"]
        assert await _active_managers(sessions, world) == 1

    _run(scratch_database_url, body)


@pytest.mark.parametrize(
    ("demotion", "expected"),
    [(_demote, "forbidden_role"), (_suspend, "building_not_found")],
    ids=["role-removed", "suspended"],
)
def test_stale_manager_is_refused_after_the_lock(
    scratch_database_url: str,
    demotion: Callable[[TenantContext, UUID], Write],
    expected: str,
) -> None:
    # Criterion 15: the second manager's context was read before the wait; after it, they are no
    # longer a manager (or no longer active), so their suspension of a resident must not land.
    async def body(sessions: Sessions, world: World) -> None:
        second = await _second_manager(sessions, world)
        target = world.a_resident1.membership.id

        outcomes = await _held_then(
            sessions,
            demotion(_ctx(world, world.a_manager), second.membership.id),
            _suspend(_ctx(world, second), target),
        )

        assert outcomes == ("ok", expected)
        status = await _scalar(
            sessions, select(BuildingMembership.status).where(BuildingMembership.id == target)
        )
        assert status == MembershipStatus.ACTIVE
        suspended_events = await _scalar(
            sessions,
            select(func.count()).where(
                AuditEvent.action == "membership.suspended", AuditEvent.entity_id == target
            ),
        )
        assert suspended_events == 0

    _run(scratch_database_url, body)


def test_concurrent_suspends_give_one_winner(scratch_database_url: str) -> None:
    # Criterion 17 (tenant row 10).
    async def body(sessions: Sessions, world: World) -> None:
        second = await _second_manager(sessions, world)
        target = world.a_resident1.membership.id

        outcomes = await _held_then(
            sessions,
            _suspend(_ctx(world, world.a_manager), target),
            _suspend(_ctx(world, second), target),
        )

        assert outcomes == ("ok", "invalid_transition")
        events = await _scalar(
            sessions,
            select(func.count()).where(
                AuditEvent.action == "membership.suspended", AuditEvent.entity_id == target
            ),
        )
        assert events == 1

    _run(scratch_database_url, body)


@pytest.mark.parametrize("first", ["writer", "change"])
@pytest.mark.parametrize("writer", ["refresh", "new-session"])
def test_session_writes_and_a_staff_role_change_take_turns(
    scratch_database_url: str, frozen_clock: FrozenClock, writer: str, first: str
) -> None:
    # Criterion 14, as `tests/invitations/test_concurrency.py::
    # test_session_writes_and_a_staff_accept_take_turns`: a resident is logged in; one of their
    # sessions is refreshed (or a new login starts) while a manager gives them `security`. Each
    # waits for the other on the per-user lock, so whichever writes second sees the first's result;
    # either way the written session ends after 13 idle hours (ADR-0003).
    async def body(sessions: Sessions, world: World) -> None:
        user_id = world.a_resident1.user.id
        async with sessions() as db:
            other = await auth.start_session(db, user_id, user_agent=None, ip=None)
            await db.commit()
        frozen_clock.advance(minutes=6)

        async def write(db: AsyncSession) -> str:
            if writer == "refresh":
                current = await auth.resolve_session(db, other)
                assert current is not None
                await auth.touch_session(db, current.session)
                return other
            created = await auth.start_logged_in_session(db, user_id, user_agent=None, ip=None)
            await db.commit()
            return created

        async def change(db: AsyncSession) -> str:
            out = await service.change_roles(
                db,
                _ctx(world, world.a_manager),
                world.a_resident1.membership.id,
                MemberRolesIn(add=[Role.SECURITY], remove=[]),
            )
            assert out.roles == [Role.RESIDENT, Role.SECURITY]
            return other

        hold_first, run_second = (write, change) if first == "writer" else (change, write)
        async with sessions() as held:
            commit = held.commit

            async def hold() -> None:
                pass

            held.commit = hold  # type: ignore[method-assign]
            first_result = await hold_first(held)
            held.commit = commit  # type: ignore[method-assign]

            async def second() -> str:
                async with sessions() as db:
                    return await run_second(db)

            task = asyncio.create_task(second())
            await asyncio.sleep(0.5)
            assert not task.done(), "the second write did not wait for the first"
            await held.commit()
            second_result = await asyncio.wait_for(task, timeout=10)

        written = first_result if first == "writer" else second_result
        frozen_clock.advance(hours=13)
        async with sessions() as db:
            assert await auth.resolve_session(db, written) is None

    _run(scratch_database_url, body)


# Review round 1 (Codex F2, Claude L2): a stale caller's refusal comes before anything about the
# target, so a manager who lost access learns nothing about the member's state.


@pytest.mark.parametrize(
    ("demotion", "expected"),
    [(_demote, "forbidden_role"), (_suspend, "building_not_found")],
    ids=["role-removed", "suspended"],
)
@pytest.mark.parametrize(
    "operation",
    [
        "suspend-suspended",
        "reactivate-active",
        "roles-on-pending",
        "roles-no-op",
        "unknown-member",
        "self",
    ],
)
def test_stale_manager_gets_the_refusal_before_target_errors(
    scratch_database_url: str,
    demotion: Callable[[TenantContext, UUID], Write],
    expected: str,
    operation: str,
) -> None:
    async def body(sessions: Sessions, world: World) -> None:
        second = await _second_manager(sessions, world)
        ctx = _ctx(world, second)

        async def queued(db: AsyncSession) -> Any:
            match operation:
                case "suspend-suspended":
                    return await service.suspend_member(
                        db, ctx, world.a_suspended.membership.id, REASON
                    )
                case "reactivate-active":
                    return await service.reactivate_member(db, ctx, world.a_resident1.membership.id)
                case "roles-on-pending":
                    return await service.change_roles(
                        db,
                        ctx,
                        world.a_pending.membership.id,
                        MemberRolesIn(add=[Role.SECURITY], remove=[]),
                    )
                case "roles-no-op":
                    return await service.change_roles(
                        db,
                        ctx,
                        world.a_resident1.membership.id,
                        MemberRolesIn(add=[Role.RESIDENT], remove=[]),
                    )
                case "unknown-member":
                    return await service.suspend_member(db, ctx, uuid4(), REASON)
                case _:
                    return await service.suspend_member(db, ctx, second.membership.id, REASON)

        outcomes = await _held_then(
            sessions, demotion(_ctx(world, world.a_manager), second.membership.id), queued
        )

        assert outcomes == ("ok", expected)

    _run(scratch_database_url, body)


# Review round 1 (Codex F1, Claude M1): the invitations' writes wait on the same building lock, and
# a manager demoted or suspended meanwhile must not invite a new manager.


@pytest.mark.parametrize(
    ("demotion", "expected"),
    [(_demote, "forbidden_role"), (_suspend, "building_not_found")],
    ids=["role-removed", "suspended"],
)
@pytest.mark.parametrize("write", ["create", "resend"])
def test_revoked_manager_cannot_create_or_resend_an_invitation(
    scratch_database_url: str,
    demotion: Callable[[TenantContext, UUID], Write],
    expected: str,
    write: str,
) -> None:
    async def body(sessions: Sessions, world: World) -> None:
        second = await _second_manager(sessions, world)
        ctx = _ctx(world, second)
        async with sessions() as db:
            pending = await invitations.create_invitation(
                db,
                _ctx(world, world.a_manager),
                InvitationCreate(email="guard@example.test", roles=[Role.SECURITY]),
            )
        token_before = await _scalar(
            sessions, select(Invitation.token_hash).where(Invitation.id == pending.id)
        )

        async def queued(db: AsyncSession) -> Any:
            if write == "create":
                return await invitations.create_invitation(
                    db,
                    ctx,
                    InvitationCreate(email="taker@example.test", roles=[Role.PROPERTY_MANAGEMENT]),
                )
            return await invitations.resend_invitation(db, ctx, pending.id)

        outcomes = await _held_then(
            sessions, demotion(_ctx(world, world.a_manager), second.membership.id), queued
        )

        assert outcomes == ("ok", expected)
        by_second = await _scalar(
            sessions,
            select(func.count()).where(Invitation.created_by_user_id == second.user.id),
        )
        assert by_second == 0
        token_after = await _scalar(
            sessions, select(Invitation.token_hash).where(Invitation.id == pending.id)
        )
        assert token_after == token_before

    _run(scratch_database_url, body)


@pytest.mark.parametrize("demotion", [_demote, _suspend], ids=["role-removed", "suspended"])
def test_a_revocation_that_rolls_back_leaves_the_waiting_manager_in_charge(
    scratch_database_url: str, demotion: Callable[[TenantContext, UUID], Write]
) -> None:
    # Round 1 neighbour (a failure instead of success): the second manager waits on the lock; the
    # demotion rolls back, so they are still a manager and their suspension lands.
    async def body(sessions: Sessions, world: World) -> None:
        second = await _second_manager(sessions, world)
        target = world.a_resident1.membership.id
        async with sessions() as held:
            commit = held.commit

            async def hold() -> None:
                pass

            held.commit = hold  # type: ignore[method-assign]
            demote = demotion(_ctx(world, world.a_manager), second.membership.id)
            assert await _outcome(demote, held) == "ok"
            held.commit = commit  # type: ignore[method-assign]

            async def run_second() -> str:
                async with sessions() as db:
                    return await _outcome(_suspend(_ctx(world, second), target), db)

            task = asyncio.create_task(run_second())
            await asyncio.sleep(0.5)
            assert not task.done(), "the second write did not wait for the first"
            await held.rollback()
            outcome = await asyncio.wait_for(task, timeout=10)

        assert outcome == "ok"
        status = await _scalar(
            sessions, select(BuildingMembership.status).where(BuildingMembership.id == target)
        )
        assert status == MembershipStatus.SUSPENDED

    _run(scratch_database_url, body)


@pytest.mark.parametrize("first", ["refresh", "reactivate"])
def test_session_refresh_and_a_staff_reactivation_take_turns(
    scratch_database_url: str, frozen_clock: FrozenClock, first: str
) -> None:
    # Criterion 14's reactivation path (review round 2, Codex proof): a suspended guard's session is
    # refreshed while a manager reactivates them; either way the session ends after 13 idle hours.
    async def body(sessions: Sessions, world: World) -> None:
        async with sessions() as db:
            guard = await make_user(db)
            membership = await make_membership(
                guard, world.a, roles=(Role.SECURITY,), status=MembershipStatus.SUSPENDED
            )
            token = await auth.start_session(db, guard.id, user_agent=None, ip=None)
            await db.commit()
        frozen_clock.advance(minutes=6)

        async def refresh(db: AsyncSession) -> None:
            current = await auth.resolve_session(db, token)
            assert current is not None
            await auth.touch_session(db, current.session)
            await db.commit()

        async def reactivate(db: AsyncSession) -> None:
            await service.reactivate_member(db, _ctx(world, world.a_manager), membership.id)

        writes = (refresh, reactivate) if first == "refresh" else (reactivate, refresh)
        assert await _held_then(sessions, *writes) == ("ok", "ok")
        frozen_clock.advance(hours=13)
        async with sessions() as db:
            assert await auth.resolve_session(db, token) is None

    _run(scratch_database_url, body)


# P4-06b: move-out and transfer (criteria 8, 9, 11).


async def _occupancies(sessions: Sessions, membership_id: UUID) -> list[tuple[Any, ...]]:
    async with sessions() as db:
        rows = await db.execute(
            select(UnitOccupancy.unit_id, UnitOccupancy.ended_at.is_(None))
            .where(UnitOccupancy.membership_id == membership_id)
            .order_by(UnitOccupancy.started_at)
        )
        return [tuple(row) for row in rows]


async def _events(sessions: Sessions, action: str, entity_id: UUID) -> int:
    count: int = await _scalar(
        sessions,
        select(func.count()).where(AuditEvent.action == action, AuditEvent.entity_id == entity_id),
    )
    return count


def test_concurrent_deactivations_give_one_winner(scratch_database_url: str) -> None:
    # Criterion 9 (tenant row 10).
    async def body(sessions: Sessions, world: World) -> None:
        second = await _second_manager(sessions, world)
        target = world.a_resident1.membership.id

        outcomes = await _held_then(
            sessions,
            _deactivate(_ctx(world, world.a_manager), target),
            _deactivate(_ctx(world, second), target),
        )

        assert outcomes == ("ok", "invalid_transition")
        assert await _events(sessions, "membership.deactivated", target) == 1
        assert await _occupancies(sessions, target) == [(world.a_101.id, False)]

    _run(scratch_database_url, body)


def test_deactivation_after_a_transfer_ends_the_new_occupancy(scratch_database_url: str) -> None:
    # Criterion 9: the deactivation waits on the building lock, then reads the transfer's rows.
    async def body(sessions: Sessions, world: World) -> None:
        second = await _second_manager(sessions, world)
        target = world.a_resident1.membership.id

        outcomes = await _held_then(
            sessions,
            _transfer(_ctx(world, world.a_manager), target, world.a_102.id),
            _deactivate(_ctx(world, second), target),
        )

        assert outcomes == ("ok", "ok")
        assert await _occupancies(sessions, target) == [
            (world.a_101.id, False),
            (world.a_102.id, False),
        ]

    _run(scratch_database_url, body)


@pytest.mark.parametrize("late", ["deactivate", "transfer"])
def test_stale_clock_is_occupancy_changed(scratch_database_url: str, late: str) -> None:
    # Criterion 8: a transaction that began before a concurrent transfer of the same member
    # committed has an older now() than the new occupancy's start; the helper raises
    # OccupancyTimeError, which is 409 `occupancy_changed` with nothing written.
    async def body(sessions: Sessions, world: World) -> None:
        second = await _second_manager(sessions, world)
        target = world.a_resident1.membership.id
        async with sessions() as stale:
            # As a request's session lookup would: the transaction (and its now()) starts here.
            await stale.execute(select(1))
            await asyncio.sleep(0.05)
            async with sessions() as db:
                outcome = await _outcome(
                    _transfer(_ctx(world, world.a_manager), target, world.a_102.id), db
                )
            assert outcome == "ok"
            write = (
                _deactivate(_ctx(world, second), target)
                if late == "deactivate"
                else _transfer(_ctx(world, second), target, world.a_201.id)
            )
            assert await _outcome(write, stale) == "occupancy_changed"

        status = await _scalar(
            sessions, select(BuildingMembership.status).where(BuildingMembership.id == target)
        )
        assert status == MembershipStatus.ACTIVE
        assert await _occupancies(sessions, target) == [
            (world.a_101.id, False),
            (world.a_102.id, True),
        ]
        assert await _events(sessions, "membership.deactivated", target) == 0
        assert await _events(sessions, "occupancy.transferred", target) == 1

    _run(scratch_database_url, body)


@pytest.mark.parametrize("first", ["revocation", "accept"])
def test_revocation_and_accept_take_turns(scratch_database_url: str, first: str) -> None:
    # Criterion 11: a manager's open invitation is accepted while another manager removes their
    # manager role. Both take the building row lock (the accept FOR SHARE), so the second waits and
    # reads what the first committed: an accept after the revocation is refused; a revocation after
    # the accept leaves it accepted.
    async def body(sessions: Sessions, world: World) -> None:
        second = await _second_manager(sessions, world)
        async with sessions() as db:
            await invitations.create_invitation(
                db,
                _ctx(world, second),
                InvitationCreate(email="guard@example.test", roles=[Role.SECURITY]),
            )
        token = "t" * 43
        async with sessions() as db:
            invitation = await db.scalar(
                select(Invitation).where(Invitation.created_by_user_id == second.user.id)
            )
            assert invitation is not None
            invitation.token_hash = hash_token(token)
            await db.commit()
            invitation_id = invitation.id
        limiter = RateLimiter(sessions)
        new_person = InvitationAccept(full_name="Gina Guard", password="correct horse battery")  # noqa: S106 (a test password)

        async def accept(db: AsyncSession) -> Any:
            return await invitations.accept_invitation(
                db, limiter, token, new_person, session_token=None, user_agent=None, ip=None
            )

        revoke = _demote(_ctx(world, world.a_manager), second.membership.id)
        held, waiting = (revoke, accept) if first == "revocation" else (accept, revoke)
        outcomes = await _held_then(sessions, held, waiting)

        row = await _with(
            sessions, select(Invitation.accepted_at, Invitation.revoked_at), invitation_id
        )
        if first == "revocation":
            assert outcomes == ("ok", "invitation_invalid")
            assert (row.accepted_at, row.revoked_at is not None) == (None, True)
        else:
            assert outcomes == ("ok", "ok")
            assert (row.accepted_at is not None, row.revoked_at) == (True, None)

    _run(scratch_database_url, body)


async def _with(sessions: Sessions, stmt: Any, invitation_id: UUID) -> Any:
    async with sessions() as db:
        return (await db.execute(stmt.where(Invitation.id == invitation_id))).one()
