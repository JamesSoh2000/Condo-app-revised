"""The public invitation routes (P4-02b criteria 1-9 and 12): the lookup and the accept.

Invitations are inserted here with a known token rather than through the manager route, so each test
holds the raw token the email would carry.
"""

import uuid
from collections.abc import AsyncIterator
from datetime import timedelta
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditEvent
from app.auth.models import AuthSession
from app.buildings.models import Building
from app.core import clock
from app.core.config import settings
from app.core.security import generate_token, hash_password, hash_token, verify_password
from app.invitations.models import Invitation
from app.main import app
from app.memberships.enums import MembershipStatus, OccupancyRelationship, Role
from app.memberships.models import BuildingMembership, MembershipRole, UnitOccupancy
from app.units.models import Unit
from app.users.models import User
from tests.conftest import CSRF_HEADERS, FrozenClock, UserClientFactory
from tests.factories import make_membership, make_occupancy, make_user
from tests.helpers.tenancy import assert_problem, without_request_id
from tests.world import World

pytestmark = pytest.mark.anyio

EMAIL = "guard@example.test"
PASSWORD = "correct horse battery staple"  # noqa: S105 (a test password)
NEW_PERSON = {"full_name": "Gina Guard", "password": PASSWORD}


async def _invite(
    db: AsyncSession,
    world: World,
    *,
    email: str = EMAIL,
    roles: tuple[Role, ...] = (Role.SECURITY,),
    building: Building | None = None,
    unit: Unit | None = None,
    relationship: OccupancyRelationship | None = None,
) -> tuple[str, Invitation]:
    token = generate_token()
    building = building or world.a
    manager = world.a_manager if building.id == world.a.id else world.b_manager
    invitation = Invitation(
        building_id=building.id,
        email=email,
        roles=[role.value for role in roles],
        unit_id=unit.id if unit else None,
        relationship=relationship,
        token_hash=hash_token(token),
        expires_at=clock.now() + timedelta(days=7),
        created_by_user_id=manager.user.id,
    )
    db.add(invitation)
    await db.flush()
    return token, invitation


def _url(token: str) -> str:
    return f"/api/invitations/{token}"


def _accept_url(token: str) -> str:
    return f"/api/invitations/{token}/accept"


async def _fresh(db: AsyncSession, invitation: Invitation) -> Invitation:
    row = await db.scalar(
        select(Invitation)
        .where(Invitation.id == invitation.id)
        .execution_options(populate_existing=True)
    )
    assert row is not None
    return row


async def _user(db: AsyncSession, email: str = EMAIL) -> User | None:
    return await db.scalar(
        select(User)
        .where(func.lower(User.email) == email)
        .execution_options(populate_existing=True)
    )


async def _membership(db: AsyncSession, building_id: uuid.UUID, user_id: uuid.UUID) -> Any:
    return (
        await db.execute(
            select(BuildingMembership.id, BuildingMembership.status).where(
                BuildingMembership.building_id == building_id,
                BuildingMembership.user_id == user_id,
            )
        )
    ).one_or_none()


async def _roles(db: AsyncSession, membership_id: uuid.UUID) -> list[str]:
    return sorted(
        await db.scalars(
            select(MembershipRole.role).where(MembershipRole.membership_id == membership_id)
        )
    )


async def _actions(db: AsyncSession) -> list[str]:
    return sorted(
        await db.scalars(
            select(AuditEvent.action).where(
                AuditEvent.action.in_(
                    ["invitation.accepted", "membership.activated", "auth.logged_in"]
                )
            )
        )
    )


async def _counts(db: AsyncSession) -> tuple[int, int, int, int, int]:
    """Users, memberships, occupancies, sessions and accept-related audit rows."""

    async def count(model: Any) -> int:
        return await db.scalar(select(func.count()).select_from(model)) or 0

    return (
        await count(User),
        await count(BuildingMembership),
        await count(UnitOccupancy),
        await count(AuthSession),
        len(await _actions(db)),
    )


async def _assert_nothing_written(
    db: AsyncSession, before: tuple[int, ...], invitation: Invitation
) -> None:
    assert await _counts(db) == before
    row = await _fresh(db, invitation)
    assert (row.accepted_at, row.accepted_user_id) == (None, None)


@pytest.fixture
async def other_ip_client() -> AsyncIterator[AsyncClient]:
    """A client whose requests come from another IP, on the overrides the `client` fixture set."""
    transport = ASGITransport(app=app, client=("203.0.113.9", 4321))
    async with AsyncClient(
        transport=transport, base_url="http://test", headers=CSRF_HEADERS
    ) as other:
        yield other


# Criterion 1


async def test_new_person_accepts_and_is_logged_in_as_active_security(
    client: AsyncClient, db: AsyncSession, world: World
) -> None:
    token, invitation = await _invite(db, world)

    r = await client.post(_accept_url(token), json=NEW_PERSON)

    assert r.status_code == 200, r.text
    user = await _user(db)
    assert user is not None
    assert user.full_name == "Gina Guard"
    assert user.password_hash is not None and verify_password(PASSWORD, user.password_hash)
    assert user.email_verified_at is not None
    membership = await _membership(db, world.a.id, user.id)
    assert membership.status == MembershipStatus.ACTIVE
    assert await _roles(db, membership.id) == ["security"]
    assert r.json() == {
        "building_id": str(world.a.id),
        "membership_id": str(membership.id),
        "roles": ["security"],
    }
    cookie = r.cookies.get(settings.session_cookie_name)
    assert cookie
    session = await db.scalar(
        select(AuthSession).where(AuthSession.token_hash == hash_token(cookie))
    )
    assert session is not None and session.user_id == user.id
    # The staff idle window: the roles were written before the session started.
    assert session.idle_expires_at - session.created_at == timedelta(
        hours=settings.session_idle_staff_hours
    )
    me = await client.get("/api/auth/me")
    assert me.status_code == 200, me.text
    [only] = me.json()["memberships"]
    assert (only["building"]["id"], only["status"], only["roles"]) == (
        str(world.a.id),
        "active",
        ["security"],
    )
    row = await _fresh(db, invitation)
    assert row.accepted_at is not None and row.accepted_user_id == user.id
    assert await _actions(db) == ["auth.logged_in", "invitation.accepted", "membership.activated"]


# Criterion 2


async def _accepted(db: AsyncSession, world: World) -> str:
    token, invitation = await _invite(db, world)
    invitation.accepted_at = clock.now()
    invitation.accepted_user_id = world.no_membership.id
    await db.flush()
    return token


async def _expired(db: AsyncSession, world: World) -> str:
    token, invitation = await _invite(db, world)
    invitation.expires_at = clock.now()
    await db.flush()
    return token


async def _revoked(db: AsyncSession, world: World) -> str:
    token, invitation = await _invite(db, world)
    invitation.revoked_at = clock.now()
    await db.flush()
    return token


async def _resent(db: AsyncSession, world: World) -> str:
    # A resend replaces the hash: the old token matches nothing.
    token, invitation = await _invite(db, world)
    invitation.token_hash = hash_token(generate_token())
    await db.flush()
    return token


async def _inactive_building(db: AsyncSession, world: World) -> str:
    token, _ = await _invite(db, world)
    await db.execute(update(Building).where(Building.id == world.a.id).values(is_active=False))
    return token


async def _unknown(db: AsyncSession, world: World) -> str:
    await _invite(db, world)
    return generate_token()


async def _short(db: AsyncSession, world: World) -> str:
    token, _ = await _invite(db, world)
    return token[:-1]


async def _bad_characters(db: AsyncSession, world: World) -> str:
    await _invite(db, world)
    return "~" * 43


async def _not_utf8(db: AsyncSession, world: World) -> str:
    # Percent-decodes to a lone surrogate's bytes, which aren't valid UTF-8.
    await _invite(db, world)
    return "%ED%A0%80" + "a" * 40


INVALID = {
    "unknown": _unknown,
    "short": _short,
    "bad-characters": _bad_characters,
    "not-utf8": _not_utf8,
    "accepted": _accepted,
    "expired": _expired,
    "revoked": _revoked,
    "resent": _resent,
    "inactive-building": _inactive_building,
}


@pytest.mark.parametrize("make", INVALID.values(), ids=INVALID.keys())
async def test_invalid_tokens_answer_one_404_body(
    client: AsyncClient, db: AsyncSession, world: World, make: Any
) -> None:
    # Another pending invitation exists, so the 404 isn't explained by an empty table.
    await _invite(db, world, email="other@example.test")
    unknown = generate_token()
    expected_get = without_request_id(
        assert_problem(await client.get(_url(unknown)), 404, "invitation_invalid")
    )
    expected_post = without_request_id(
        assert_problem(
            await client.post(_accept_url(unknown), json=NEW_PERSON), 404, "invitation_invalid"
        )
    )
    token = await make(db, world)
    before = await _counts(db)

    got = assert_problem(await client.get(_url(token)), 404, "invitation_invalid")
    posted = assert_problem(
        await client.post(_accept_url(token), json=NEW_PERSON), 404, "invitation_invalid"
    )

    assert without_request_id(got) == expected_get
    assert without_request_id(posted) == expected_post
    assert await _counts(db) == before
    assert await _user(db) is None


async def test_expired_at_and_after_expiry_but_valid_just_before(
    client: AsyncClient, db: AsyncSession, world: World, frozen_clock: FrozenClock
) -> None:
    token, invitation = await _invite(db, world)
    frozen_clock.at = invitation.expires_at - timedelta(seconds=1)
    assert (await client.get(_url(token))).status_code == 200
    frozen_clock.at = invitation.expires_at
    assert_problem(await client.get(_url(token)), 404, "invitation_invalid")
    frozen_clock.advance(days=1)
    assert_problem(
        await client.post(_accept_url(token), json=NEW_PERSON), 404, "invitation_invalid"
    )


async def test_accepted_token_cannot_be_used_twice(
    client: AsyncClient, db: AsyncSession, world: World
) -> None:
    token, _ = await _invite(db, world)
    assert (await client.post(_accept_url(token), json=NEW_PERSON)).status_code == 200
    client.cookies.clear()
    before = await _counts(db)

    assert_problem(
        await client.post(_accept_url(token), json=NEW_PERSON), 404, "invitation_invalid"
    )
    assert_problem(await client.get(_url(token)), 404, "invitation_invalid")
    assert await _counts(db) == before


# Criterion 3


async def test_existing_account_without_session_gets_login_required(
    client: AsyncClient, db: AsyncSession, world: World
) -> None:
    user = await make_user(db, email=EMAIL, password_hash=hash_password("the old password!"))
    token, invitation = await _invite(db, world)
    before = await _counts(db)

    assert_problem(await client.post(_accept_url(token), json=NEW_PERSON), 409, "login_required")
    assert_problem(await client.post(_accept_url(token), json={}), 409, "login_required")

    await _assert_nothing_written(db, before, invitation)
    await db.refresh(user)
    assert user.password_hash is not None
    assert verify_password("the old password!", user.password_hash)


async def test_revoked_session_counts_as_no_session(
    as_user: UserClientFactory, db: AsyncSession, world: World
) -> None:
    user = await make_user(db, email=EMAIL)
    invitee = await as_user(user)
    await db.execute(
        update(AuthSession).where(AuthSession.user_id == user.id).values(revoked_at=clock.now())
    )
    token, invitation = await _invite(db, world)
    before = await _counts(db)

    assert_problem(await invitee.post(_accept_url(token), json={}), 409, "login_required")
    await _assert_nothing_written(db, before, invitation)


async def test_session_of_another_user_is_a_mismatch(
    as_user: UserClientFactory, db: AsyncSession, world: World
) -> None:
    await make_user(db, email=EMAIL)
    token, invitation = await _invite(db, world)
    other = await as_user(world.no_membership)
    before = await _counts(db)

    assert_problem(await other.post(_accept_url(token), json={}), 403, "invitation_email_mismatch")
    await _assert_nothing_written(db, before, invitation)


async def test_session_of_another_user_is_a_mismatch_when_no_account_has_the_email(
    as_user: UserClientFactory, db: AsyncSession, world: World
) -> None:
    token, invitation = await _invite(db, world)
    other = await as_user(world.no_membership)
    before = await _counts(db)

    r = await other.post(_accept_url(token), json=NEW_PERSON)

    assert_problem(r, 403, "invitation_email_mismatch")
    assert settings.session_cookie_name not in r.cookies
    await _assert_nothing_written(db, before, invitation)
    assert await _user(db) is None


async def test_invitee_logged_in_accepts_without_password_change(
    as_user: UserClientFactory, db: AsyncSession, world: World
) -> None:
    old_hash = hash_password("the old password!")
    user = await make_user(db, email=EMAIL, password_hash=old_hash)
    invitee = await as_user(user)
    token, invitation = await _invite(db, world)
    sessions_before = await db.scalar(select(func.count()).select_from(AuthSession))

    r = await invitee.post(_accept_url(token), json={"password": "a brand new password!"})

    assert r.status_code == 200, r.text
    assert settings.session_cookie_name not in r.cookies
    assert await db.scalar(select(func.count()).select_from(AuthSession)) == sessions_before
    await db.refresh(user)
    assert user.password_hash == old_hash
    membership = await _membership(db, world.a.id, user.id)
    assert membership.status == MembershipStatus.ACTIVE
    assert await _roles(db, membership.id) == ["security"]
    assert (await _fresh(db, invitation)).accepted_user_id == user.id
    assert await _actions(db) == ["invitation.accepted", "membership.activated"]


async def test_invitee_email_matches_whatever_its_case(
    as_user: UserClientFactory, db: AsyncSession, world: World
) -> None:
    # `users.email` is lowered by the model; a row written around it still matches.
    user = await make_user(db, email="placeholder@example.test")
    await db.execute(update(User).where(User.id == user.id).values(email="Guard@Example.TEST"))
    invitee = await as_user(user)
    token, _ = await _invite(db, world)

    r = await invitee.post(_accept_url(token), json={})

    assert r.status_code == 200, r.text


# Criterion 4


async def test_roles_in_the_body_are_rejected(
    client: AsyncClient, db: AsyncSession, world: World
) -> None:
    token, invitation = await _invite(db, world)
    before = await _counts(db)

    r = await client.post(_accept_url(token), json=NEW_PERSON | {"roles": ["property_management"]})

    body = assert_problem(r, 422, "validation_error")
    assert [e["loc"] for e in body["errors"]] == [["body", "roles"]]
    await _assert_nothing_written(db, before, invitation)


# Criterion 5


async def test_invitation_with_unit_starts_occupancy(
    client: AsyncClient, db: AsyncSession, world: World
) -> None:
    token, _ = await _invite(
        db,
        world,
        email="owner@example.test",
        roles=(Role.RESIDENT,),
        unit=world.a_102,
        relationship=OccupancyRelationship.OWNER,
    )

    r = await client.post(_accept_url(token), json=NEW_PERSON)

    assert r.status_code == 200, r.text
    occupancy = await db.scalar(
        select(UnitOccupancy).where(
            UnitOccupancy.membership_id == uuid.UUID(r.json()["membership_id"])
        )
    )
    assert occupancy is not None
    assert (occupancy.building_id, occupancy.unit_id, occupancy.relationship) == (
        world.a.id,
        world.a_102.id,
        OccupancyRelationship.OWNER,
    )
    assert occupancy.ended_at is None
    me = await client.get("/api/auth/me")
    assert me.json()["memberships"][0]["occupancy"]["unit_id"] == str(world.a_102.id)


async def test_deactivated_unit_refuses_accept(
    client: AsyncClient, db: AsyncSession, world: World
) -> None:
    token, invitation = await _invite(
        db,
        world,
        email="owner@example.test",
        roles=(Role.RESIDENT,),
        unit=world.a_102,
        relationship=OccupancyRelationship.OWNER,
    )
    await db.execute(update(Unit).where(Unit.id == world.a_102.id).values(is_active=False))
    before = await _counts(db)

    assert_problem(await client.post(_accept_url(token), json=NEW_PERSON), 409, "unit_inactive")
    await _assert_nothing_written(db, before, invitation)
    assert await _user(db, "owner@example.test") is None


# Criterion 6


async def test_lookup_is_rate_limited_per_ip(
    client: AsyncClient, other_ip_client: AsyncClient
) -> None:
    limit = settings.rate_limit_invitation_ip.limit
    assert limit < 30
    statuses = [(await client.get(_url(generate_token()))).status_code for _ in range(30)]

    assert statuses[:limit] == [404] * limit
    assert set(statuses[limit:]) == {429}
    limited = await client.get(_url(generate_token()))
    assert_problem(limited, 429, "rate_limited")
    assert int(limited.headers["Retry-After"]) >= 1
    # Another IP has a counter of its own.
    assert (await other_ip_client.get(_url(generate_token()))).status_code == 404


async def test_accept_counts_against_the_same_limit(
    client: AsyncClient, db: AsyncSession, world: World
) -> None:
    token, invitation = await _invite(db, world)
    for _ in range(settings.rate_limit_invitation_ip.limit):
        await client.get(_url(generate_token()))
    before = await _counts(db)

    assert_problem(await client.post(_accept_url(token), json=NEW_PERSON), 429, "rate_limited")
    await _assert_nothing_written(db, before, invitation)


# Criterion 7


async def test_lookup_shows_building_masked_email_and_roles(
    client: AsyncClient, db: AsyncSession, world: World
) -> None:
    token, invitation = await _invite(db, world, roles=(Role.COUNCIL, Role.RESIDENT))
    before = await _counts(db)

    r = await client.get(_url(token))

    assert r.status_code == 200, r.text
    assert r.json() == {
        "building_name": world.a.name,
        "email_masked": "g***@example.test",
        "roles": ["council", "resident"],
    }
    assert token not in r.text and invitation.token_hash not in r.text
    assert await _counts(db) == before
    assert (await _fresh(db, invitation)).accepted_at is None


async def test_one_character_local_part_is_masked_the_same_way(
    client: AsyncClient, db: AsyncSession, world: World
) -> None:
    token, _ = await _invite(db, world, email="g@example.test")
    assert (await client.get(_url(token))).json()["email_masked"] == "g***@example.test"


# Criterion 8


@pytest.mark.parametrize("missing", ["full_name", "password"])
async def test_new_account_needs_full_name_and_password(
    client: AsyncClient, db: AsyncSession, world: World, missing: str
) -> None:
    token, invitation = await _invite(db, world)
    before = await _counts(db)
    body = {key: value for key, value in NEW_PERSON.items() if key != missing}

    problem = assert_problem(
        await client.post(_accept_url(token), json=body), 422, "validation_error"
    )
    assert problem["errors"] == [
        {"loc": ["body", missing], "msg": "Field required", "type": "missing"}
    ]
    await _assert_nothing_written(db, before, invitation)


@pytest.mark.parametrize(
    ("password", "reason"),
    [
        ("short pass", "too_short"),
        ("passwordpassword", "too_common"),
    ],
)
async def test_weak_password_is_refused_without_echo(
    client: AsyncClient, db: AsyncSession, world: World, password: str, reason: str
) -> None:
    token, invitation = await _invite(db, world)
    before = await _counts(db)

    r = await client.post(_accept_url(token), json=NEW_PERSON | {"password": password})

    problem = assert_problem(r, 422, "validation_error")
    assert [(e["loc"], e["type"]) for e in problem["errors"]] == [
        (["body", "password"], f"password_{reason}")
    ]
    assert password not in r.text
    await _assert_nothing_written(db, before, invitation)


async def test_too_long_password_is_refused_without_echo(
    client: AsyncClient, db: AsyncSession, world: World
) -> None:
    token, invitation = await _invite(db, world)
    password = "x" * 129
    before = await _counts(db)

    r = await client.post(_accept_url(token), json=NEW_PERSON | {"password": password})

    assert_problem(r, 422, "validation_error")
    assert password not in r.text
    await _assert_nothing_written(db, before, invitation)


async def test_password_is_not_stripped(
    client: AsyncClient, db: AsyncSession, world: World
) -> None:
    token, _ = await _invite(db, world)
    padded = f"  {PASSWORD}  "

    r = await client.post(_accept_url(token), json=NEW_PERSON | {"password": padded})
    assert r.status_code == 200, r.text

    user = await _user(db)
    assert user is not None and user.password_hash is not None
    assert verify_password(padded, user.password_hash)
    assert not verify_password(PASSWORD, user.password_hash)


@pytest.mark.parametrize("full_name", ["Gina\x00Guard", "Gina\nGuard", "   ", "x" * 201])
async def test_bad_full_name_is_refused(
    client: AsyncClient, db: AsyncSession, world: World, full_name: str
) -> None:
    token, invitation = await _invite(db, world)
    before = await _counts(db)

    r = await client.post(_accept_url(token), json=NEW_PERSON | {"full_name": full_name})

    problem = assert_problem(r, 422, "validation_error")
    assert [e["loc"] for e in problem["errors"]] == [["body", "full_name"]]
    await _assert_nothing_written(db, before, invitation)


async def test_full_name_is_stripped(client: AsyncClient, db: AsyncSession, world: World) -> None:
    token, _ = await _invite(db, world)
    r = await client.post(_accept_url(token), json=NEW_PERSON | {"full_name": "  Gina Guard "})
    assert r.status_code == 200, r.text
    user = await _user(db)
    assert user is not None and user.full_name == "Gina Guard"


# Criterion 9: every way an accept makes a membership active


@pytest.mark.parametrize(
    "status", [MembershipStatus.PENDING, MembershipStatus.DENIED, MembershipStatus.DEACTIVATED]
)
async def test_existing_membership_is_activated_with_exactly_the_invited_roles(
    as_user: UserClientFactory, db: AsyncSession, world: World, status: MembershipStatus
) -> None:
    user = await make_user(db, email=EMAIL)
    existing = await make_membership(
        user, world.a, roles=(Role.RESIDENT, Role.COUNCIL), status=status
    )
    invitee = await as_user(user)
    token, _ = await _invite(db, world)

    r = await invitee.post(_accept_url(token), json={})

    assert r.status_code == 200, r.text
    assert r.json()["membership_id"] == str(existing.id)
    membership = await _membership(db, world.a.id, user.id)
    assert membership.status == MembershipStatus.ACTIVE
    assert await _roles(db, existing.id) == ["security"]
    changed_by = await db.scalar(
        select(BuildingMembership.status_changed_by_user_id).where(
            BuildingMembership.id == existing.id
        )
    )
    assert changed_by == world.a_manager.user.id


async def test_existing_user_without_membership_gets_a_new_one(
    as_user: UserClientFactory, db: AsyncSession, world: World
) -> None:
    token, _ = await _invite(db, world, email=world.no_membership.email)
    invitee = await as_user(world.no_membership)

    r = await invitee.post(_accept_url(token), json={})

    assert r.status_code == 200, r.text
    membership = await _membership(db, world.a.id, world.no_membership.id)
    assert membership.status == MembershipStatus.ACTIVE
    assert await _roles(db, membership.id) == ["security"]


@pytest.mark.parametrize("persona", ["a_resident1", "a_suspended"])
async def test_active_or_suspended_membership_is_not_changed(
    as_user: UserClientFactory, db: AsyncSession, world: World, persona: str
) -> None:
    member = getattr(world, persona)
    # A suspended member's session still resolves: the status lives on the membership.
    invitee = await as_user(member.user)
    token, invitation = await _invite(db, world, email=member.user.email)
    roles_before = await _roles(db, member.membership.id)
    status_before = (await _membership(db, world.a.id, member.user.id)).status
    before = await _counts(db)

    assert_problem(await invitee.post(_accept_url(token), json={}), 409, "membership_exists")

    await _assert_nothing_written(db, before, invitation)
    assert await _roles(db, member.membership.id) == roles_before
    assert (await _membership(db, world.a.id, member.user.id)).status == status_before


async def test_reactivation_ends_leftover_occupancy_when_roles_lack_resident(
    as_user: UserClientFactory, db: AsyncSession, world: World
) -> None:
    user = await make_user(db, email=EMAIL)
    old = await make_membership(user, world.a, status=MembershipStatus.DEACTIVATED)
    await make_occupancy(old, world.a_201)
    invitee = await as_user(user)
    token, _ = await _invite(db, world)

    assert (await invitee.post(_accept_url(token), json={})).status_code == 200

    current = await db.scalar(
        select(func.count()).where(
            UnitOccupancy.membership_id == old.id, UnitOccupancy.ended_at.is_(None)
        )
    )
    assert current == 0


async def test_reactivation_moves_leftover_occupancy_to_the_invited_unit(
    as_user: UserClientFactory, db: AsyncSession, world: World
) -> None:
    user = await make_user(db, email=EMAIL)
    old = await make_membership(user, world.a, status=MembershipStatus.DEACTIVATED)
    await make_occupancy(old, world.a_201)
    invitee = await as_user(user)
    token, _ = await _invite(
        db,
        world,
        roles=(Role.RESIDENT,),
        unit=world.a_102,
        relationship=OccupancyRelationship.OWNER,
    )

    assert (await invitee.post(_accept_url(token), json={})).status_code == 200

    rows = (
        await db.execute(
            select(UnitOccupancy.unit_id, UnitOccupancy.relationship).where(
                UnitOccupancy.membership_id == old.id, UnitOccupancy.ended_at.is_(None)
            )
        )
    ).all()
    assert [tuple(row) for row in rows] == [(world.a_102.id, OccupancyRelationship.OWNER)]


async def test_reactivation_keeps_leftover_occupancy_for_a_resident_without_unit(
    as_user: UserClientFactory, db: AsyncSession, world: World
) -> None:
    user = await make_user(db, email=EMAIL)
    old = await make_membership(user, world.a, status=MembershipStatus.DEACTIVATED)
    kept = await make_occupancy(old, world.a_201)
    invitee = await as_user(user)
    token, _ = await _invite(db, world, roles=(Role.RESIDENT,))

    assert (await invitee.post(_accept_url(token), json={})).status_code == 200

    current = await db.scalars(
        select(UnitOccupancy.id).where(
            UnitOccupancy.membership_id == old.id, UnitOccupancy.ended_at.is_(None)
        )
    )
    assert list(current) == [kept.id]


async def test_invitation_of_building_b_activates_only_in_b(
    client: AsyncClient, db: AsyncSession, world: World
) -> None:
    token, _ = await _invite(db, world, building=world.b)

    r = await client.post(_accept_url(token), json=NEW_PERSON)

    assert r.status_code == 200, r.text
    assert r.json()["building_id"] == str(world.b.id)
    user = await _user(db)
    assert user is not None
    assert await _membership(db, world.a.id, user.id) is None
    assert (await _membership(db, world.b.id, user.id)).status == MembershipStatus.ACTIVE


# Criterion 12


async def test_accept_without_csrf_headers_is_refused(
    client: AsyncClient, db: AsyncSession, world: World
) -> None:
    token, invitation = await _invite(db, world)
    before = await _counts(db)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as bare:
        r = await bare.post(_accept_url(token), json=NEW_PERSON)

    assert r.status_code == 403, r.text
    await _assert_nothing_written(db, before, invitation)
