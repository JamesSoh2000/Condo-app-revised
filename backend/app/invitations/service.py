"""Invitations (P4-02a): a manager creates, lists, revokes and resends them; the invitee looks one
up and accepts it through the public routes (P4-02b).

The token is 32 random bytes; only its sha256 is stored (`token_hash`), and the token itself goes
into the email's context, which the worker drops from the job once it is sent (`sensitive_keys`).
Each write use-case commits once (CLAUDE.md rule 5).
"""

import re
from datetime import datetime, timedelta
from typing import NamedTuple
from uuid import UUID

from anyio import to_thread
from sqlalchemy import ColumnElement, and_, delete, func, insert, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import actions
from app.audit.service import record_audit
from app.auth.service import cap_idle_windows, resolve_session, start_logged_in_session
from app.buildings.models import Building
from app.core import clock
from app.core.config import settings
from app.core.errors import Conflict, Forbidden, NotFound, field_errors
from app.core.pagination import CursorParams, Page, paginate
from app.core.security import (
    WeakPasswordError,
    check_password_policy,
    generate_token,
    hash_password,
    hash_token,
)
from app.email.service import queue_email
from app.email.templates import DEFAULT_LOCALE, SUPPORTED_LOCALES
from app.invitations.models import Invitation
from app.invitations.schemas import (
    InvitationAccept,
    InvitationAcceptedOut,
    InvitationCreate,
    InvitationOut,
    InvitationPublicOut,
    InvitationStatus,
)
from app.memberships.enums import MembershipStatus, OccupancyRelationship, Role
from app.memberships.models import BuildingMembership, MembershipRole
from app.memberships.occupancy import end_occupancy, transfer_occupancy
from app.rate_limits.service import RateLimiter, ip_key
from app.tenancy.context import TenantContext
from app.units.models import Unit
from app.units.service import UnitNotFound
from app.users.models import User

INVITATION_TTL = timedelta(days=7)


class InvitationNotFound(NotFound):
    code = "invitation_not_found"


class InvitationPending(Conflict):
    code = "invitation_pending"


class UnitInactive(Conflict):
    code = "unit_inactive"


class InvalidTransition(Conflict):
    code = "invalid_transition"


def status_of(invitation: Invitation, now: datetime) -> InvitationStatus:
    if invitation.accepted_at is not None:
        return InvitationStatus.ACCEPTED
    if invitation.revoked_at is not None:
        return InvitationStatus.REVOKED
    if invitation.expires_at <= now:
        return InvitationStatus.EXPIRED
    return InvitationStatus.PENDING


def _open() -> ColumnElement[bool]:
    """Neither accepted nor revoked: revoke and resend act only on these (expired ones included)."""
    return and_(Invitation.accepted_at.is_(None), Invitation.revoked_at.is_(None))


def status_clause(status: InvitationStatus, now: datetime) -> ColumnElement[bool]:
    # The same order of precedence as `status_of`.
    match status:
        case InvitationStatus.ACCEPTED:
            return Invitation.accepted_at.is_not(None)
        case InvitationStatus.REVOKED:
            return and_(Invitation.accepted_at.is_(None), Invitation.revoked_at.is_not(None))
        case InvitationStatus.EXPIRED:
            return and_(_open(), Invitation.expires_at <= now)
        case InvitationStatus.PENDING:
            return and_(_open(), Invitation.expires_at > now)


def _out(invitation: Invitation, now: datetime) -> InvitationOut:
    return InvitationOut(
        id=invitation.id,
        email=invitation.email,
        roles=[Role(role) for role in invitation.roles],
        unit_id=invitation.unit_id,
        relationship=invitation.relationship,
        status=status_of(invitation, now),
        expires_at=invitation.expires_at,
        created_at=invitation.created_at,
    )


def _not_found() -> InvitationNotFound:
    # One body for "no such invitation" and "another building's" (ADR-0004).
    return InvitationNotFound(detail="Invitation not found.")


def _invalid_transition() -> InvalidTransition:
    return InvalidTransition(detail="This invitation was already accepted or revoked.")


async def _audit(db: AsyncSession, ctx: TenantContext, action: str, invitation_id: UUID) -> None:
    await record_audit(
        db,
        action=action,
        entity_type="invitation",
        entity_id=invitation_id,
        building_id=ctx.building_id,
        actor_user_id=ctx.user_id,
    )


async def _queue_invitation_email(
    db: AsyncSession, building: Building, invitation: Invitation, token: str
) -> None:
    await queue_email(
        db,
        # The stored, validated address (the P1-02 carry: mail goes only to the stored address).
        to=invitation.email,
        template="invitation",
        context={
            "building_name": building.name,
            "roles": list(invitation.roles),
            # A path: the template puts APP_BASE_URL in front. In `context`, the payload key the
            # worker drops once the email is sent.
            "link": f"/invite/{token}",
            "expires_at": invitation.expires_at.isoformat(),
        },
        locale=building.locale if building.locale in SUPPORTED_LOCALES else DEFAULT_LOCALE,
    )


async def _lock_building(db: AsyncSession, ctx: TenantContext) -> Building:
    """Lock the building row (NO KEY UPDATE, which foreign-key checks from other tables don't wait
    for). Every write that makes an invitation pending takes it first, so two of them for one
    building run one after the other and the second sees the first's row (D2)."""
    building = await db.scalar(
        select(Building).where(Building.id == ctx.building_id).with_for_update(key_share=True)
    )
    assert building is not None  # noqa: S101 (get_tenant_context found it active)
    return building


async def _refuse_another_pending(
    db: AsyncSession,
    ctx: TenantContext,
    email: str,
    now: datetime,
    *,
    besides: UUID | None = None,
) -> None:
    """At most one pending invitation per email and building. Call after `_lock_building`."""
    stmt = select(Invitation.id).where(
        Invitation.building_id == ctx.building_id,
        Invitation.email == email,
        status_clause(InvitationStatus.PENDING, now),
    )
    if besides is not None:
        stmt = stmt.where(Invitation.id != besides)
    if await db.scalar(stmt.limit(1)) is not None:
        raise InvitationPending(
            detail="This email already has a pending invitation; resend or revoke it."
        )


async def create_invitation(
    db: AsyncSession, ctx: TenantContext, data: InvitationCreate
) -> InvitationOut:
    """Create a pending invitation and queue its email; 409 `invitation_pending` if the email has
    one here already."""
    building = await _lock_building(db, ctx)
    if data.unit_id is not None:
        # Loaded within the caller's building (CLAUDE.md rule 2): another building's unit is a 404.
        unit = await db.scalar(
            select(Unit).where(Unit.id == data.unit_id, Unit.building_id == ctx.building_id)
        )
        if unit is None:
            raise UnitNotFound(detail="Unit not found.")
        if not unit.is_active:
            raise UnitInactive(detail="This unit is deactivated.")
    now = clock.now()
    await _refuse_another_pending(db, ctx, data.email, now)
    token = generate_token()
    invitation = Invitation(
        building_id=ctx.building_id,
        email=data.email,
        roles=[role.value for role in data.roles],
        unit_id=data.unit_id,
        relationship=data.relationship,
        token_hash=hash_token(token),
        expires_at=now + INVITATION_TTL,
        created_by_user_id=ctx.user_id,
    )
    db.add(invitation)
    await db.flush()
    await db.refresh(invitation, ["created_at"])
    await _queue_invitation_email(db, building, invitation, token)
    await _audit(db, ctx, actions.INVITATION_CREATED, invitation.id)
    out = _out(invitation, now)
    await db.commit()
    return out


async def list_invitations(
    db: AsyncSession, ctx: TenantContext, params: CursorParams, status: InvitationStatus | None
) -> Page[InvitationOut]:
    now = clock.now()
    stmt = select(Invitation).where(Invitation.building_id == ctx.building_id)
    if status is not None:
        stmt = stmt.where(status_clause(status, now))
    return await paginate(db, stmt, Invitation.id, params, lambda row: _out(row, now))


async def _transition(
    db: AsyncSession, ctx: TenantContext, invitation_id: UUID, **values: object
) -> Invitation:
    """One conditional UPDATE of an open invitation of this building (CLAUDE.md rule 7). Zero rows:
    404 if it isn't this building's, else 409 `invalid_transition` (accepted or revoked)."""
    changed = await db.scalar(
        update(Invitation)
        .where(
            Invitation.id == invitation_id,
            Invitation.building_id == ctx.building_id,
            _open(),
        )
        .values(**values)
        .returning(Invitation)
        .execution_options(populate_existing=True)
    )
    if changed is not None:
        return changed
    exists = await db.scalar(
        select(Invitation.id).where(
            Invitation.id == invitation_id, Invitation.building_id == ctx.building_id
        )
    )
    if exists is None:
        raise _not_found()
    raise _invalid_transition()


async def revoke_invitation(db: AsyncSession, ctx: TenantContext, invitation_id: UUID) -> None:
    await _transition(db, ctx, invitation_id, revoked_at=clock.now())
    await _audit(db, ctx, actions.INVITATION_REVOKED, invitation_id)
    await db.commit()


async def resend_invitation(
    db: AsyncSession, ctx: TenantContext, invitation_id: UUID
) -> InvitationOut:
    """A new token and expiry, and the email again. The old token's hash is replaced in the same
    statement, so the old link stops working the moment this commits.

    Resending makes the invitation pending again, so it is refused (409 `invitation_pending`) while
    another invitation for the email is pending: an expired offer must not come back beside its
    replacement (review round 1).
    """
    building = await _lock_building(db, ctx)
    now = clock.now()
    target = (
        await db.execute(
            select(Invitation.email, Invitation.accepted_at, Invitation.revoked_at).where(
                Invitation.id == invitation_id, Invitation.building_id == ctx.building_id
            )
        )
    ).one_or_none()
    if target is None:
        raise _not_found()
    # Its own state first: an accepted or revoked one is `invalid_transition` whatever else is
    # pending (review round 2). `_transition` checks it again, in the statement that writes.
    if target.accepted_at is not None or target.revoked_at is not None:
        raise _invalid_transition()
    await _refuse_another_pending(db, ctx, target.email, now, besides=invitation_id)
    token = generate_token()
    invitation = await _transition(
        db, ctx, invitation_id, token_hash=hash_token(token), expires_at=now + INVITATION_TTL
    )
    await _queue_invitation_email(db, building, invitation, token)
    await _audit(db, ctx, actions.INVITATION_RESENT, invitation_id)
    out = _out(invitation, now)
    await db.commit()
    return out


# Public routes (P4-02b): the token in the path is the only credential.

# What `generate_token` makes: 32 bytes as unpadded URL-safe base64. Anything else is no token of
# ours, and is refused before it is hashed (a non-UTF-8 path can't be).
_TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
# An invitation can't change these: role changes and lifting a suspension are P4-06's (D1).
_REACTIVATABLE = (MembershipStatus.PENDING, MembershipStatus.DENIED, MembershipStatus.DEACTIVATED)
_POLICY_MESSAGES = {
    "too_short": "must be at least 12 characters",
    "too_long": "must be at most 128 characters",
    "too_common": "is too common",
    "invalid_characters": "contains characters that can't be stored",
}


class InvitationInvalid(NotFound):
    code = "invitation_invalid"


class LoginRequired(Conflict):
    code = "login_required"


class InvitationEmailMismatch(Forbidden):
    code = "invitation_email_mismatch"


class MembershipExists(Conflict):
    code = "membership_exists"


class _Pending(NamedTuple):
    """A pending invitation as `_find_valid` reads it."""

    id: UUID
    building_id: UUID
    email: str
    roles: list[str]
    unit_id: UUID | None
    relationship: OccupancyRelationship | None
    token_hash: str
    created_by_user_id: UUID
    building_name: str


class AcceptResult(NamedTuple):
    out: InvitationAcceptedOut
    # The new account's session token, for the cookie; None when the caller was logged in.
    session_token: str | None


def _invalid() -> InvitationInvalid:
    # One body for unknown, malformed, expired, revoked, used and replaced tokens: the answer
    # mustn't tell a guesser which tokens once existed (ticket).
    return InvitationInvalid(detail="This invitation is no longer valid.")


def _login_required() -> LoginRequired:
    return LoginRequired(detail="An account already uses this email: log in to accept.")


def mask_email(email: str) -> str:
    """`g***@example.test`: the first character of the local part, a fixed `***` (so the length
    doesn't show) and the whole domain."""
    local, _, domain = email.rpartition("@")
    return f"{local[:1]}***@{domain}"


async def _find_valid(db: AsyncSession, token: str, now: datetime) -> _Pending:
    """The pending invitation `token` names, in an active building, or `InvitationInvalid`."""
    if not _TOKEN.fullmatch(token):
        raise _invalid()
    row = (
        await db.execute(
            select(
                Invitation.id,
                Invitation.building_id,
                Invitation.email,
                Invitation.roles,
                Invitation.unit_id,
                Invitation.relationship,
                Invitation.token_hash,
                Invitation.created_by_user_id,
                Building.name.label("building_name"),
            )
            .join(Building, Building.id == Invitation.building_id)
            .where(
                Invitation.token_hash == hash_token(token),
                status_clause(InvitationStatus.PENDING, now),
                Building.is_active,
            )
        )
    ).one_or_none()
    if row is None:
        raise _invalid()
    return _Pending(*row)


async def get_public_invitation(
    db: AsyncSession, limiter: RateLimiter, token: str, *, ip: str | None
) -> InvitationPublicOut:
    """What the invitee sees before accepting. Writes nothing but the rate-limit count."""
    await limiter.enforce(ip_key("invitation", ip), settings.rate_limit_invitation_ip)
    row = await _find_valid(db, token, clock.now())
    return InvitationPublicOut(
        building_name=row.building_name,
        email_masked=mask_email(row.email),
        roles=sorted(Role(role) for role in row.roles),
    )


def _new_account_input(data: InvitationAccept) -> tuple[str, str]:
    missing = [
        (field, "Field required", "missing")
        for field in ("full_name", "password")
        if getattr(data, field) is None
    ]
    if missing:
        raise field_errors(*missing)
    assert data.full_name is not None and data.password is not None  # noqa: S101 (checked above)
    try:
        check_password_policy(data.password)
    except WeakPasswordError as exc:
        # The reason only: never the password (P2-01b carry).
        raise field_errors(
            ("password", _POLICY_MESSAGES[exc.reason], f"password_{exc.reason}")
        ) from None
    return data.full_name, data.password


async def accept_invitation(
    db: AsyncSession,
    limiter: RateLimiter,
    token: str,
    data: InvitationAccept,
    *,
    session_token: str | None,
    user_agent: str | None,
    ip: str | None,
) -> AcceptResult:
    """Accept an invitation: the membership becomes `active` with exactly the invited roles.

    A new email gets an account (from `data`) and a session; an existing account must be the
    caller's session (409 `login_required` without one, 403 `invitation_email_mismatch` for
    another user's) and its password is never touched.

    Reads and checks first, then ends the read so argon2 runs with no connection held (as `login`
    does), then writes in one transaction that starts by claiming the token with a conditional
    UPDATE: of two concurrent accepts, the second waits on the row and then matches nothing (D2).
    """
    await limiter.enforce(ip_key("invitation", ip), settings.rate_limit_invitation_ip)
    now = clock.now()
    invitation = await _find_valid(db, token, now)
    caller = await resolve_session(db, session_token) if session_token else None
    caller_id = caller.user.id if caller is not None else None
    # lower() in Postgres, as `login` and `uq_users_lower_email`; the invitation's email is lowered.
    account_id = await db.scalar(select(User.id).where(func.lower(User.email) == invitation.email))
    if caller_id is not None and caller_id != account_id:
        # Also when no account has the email: accepting must not swap the browser's session (D3).
        raise InvitationEmailMismatch(
            detail="This invitation is for another account: log out to accept it."
        )
    if account_id is not None and caller_id is None:
        raise _login_required()
    new_account = _new_account_input(data) if account_id is None else None
    await db.rollback()
    password_hash = await to_thread.run_sync(hash_password, new_account[1]) if new_account else None

    # The building first, as create and resend lock it (building, then invitation): FOR SHARE, so
    # a deactivation waits for this accept, or this waits for it and reads it as committed
    # (review round 1, F3).
    building_active = await db.scalar(
        select(Building.is_active)
        .where(Building.id == invitation.building_id)
        .with_for_update(read=True)
    )
    if not building_active:
        raise _invalid()
    # The time of the claim, not of the read: the token may have expired while the password
    # hashed (review round 1, F2).
    now = clock.now()
    claimed = await db.scalar(
        update(Invitation)
        .where(
            Invitation.id == invitation.id,
            Invitation.token_hash == invitation.token_hash,
            status_clause(InvitationStatus.PENDING, now),
        )
        .values(accepted_at=now)
        .returning(Invitation.id)
    )
    if claimed is None:
        raise _invalid()
    if invitation.unit_id is not None:
        # FOR SHARE: a concurrent deactivation (FOR UPDATE) waits for this accept, or this waits
        # for it and reads the unit as it committed.
        unit_active = await db.scalar(
            select(Unit.is_active)
            .where(Unit.building_id == invitation.building_id, Unit.id == invitation.unit_id)
            .with_for_update(read=True)
        )
        if not unit_active:
            raise UnitInactive(detail="This unit is deactivated.")
    if new_account is not None:
        account_id = await db.scalar(
            pg_insert(User)
            .values(
                email=invitation.email,
                full_name=new_account[0],
                password_hash=password_hash,
                # The emailed token proves the address.
                email_verified_at=now,
            )
            # The account was created since the read (another building's invitation): it is an
            # existing account now, which needs a login.
            .on_conflict_do_nothing(index_elements=[func.lower(User.email)])
            .returning(User.id)
        )
        if account_id is None:
            raise _login_required()
    assert account_id is not None  # noqa: S101 (found, or inserted above)
    await db.execute(
        update(Invitation).where(Invitation.id == invitation.id).values(accepted_user_id=account_id)
    )
    membership_id = await _activate_membership(db, invitation, account_id, now)
    if new_account is None:
        # The caller's sessions now follow the roles just granted (review round 1, F1). A new
        # account's session starts below, with them.
        await cap_idle_windows(db, account_id)
    await record_audit(
        db,
        action=actions.INVITATION_ACCEPTED,
        entity_type="invitation",
        entity_id=invitation.id,
        building_id=invitation.building_id,
        actor_user_id=account_id,
        metadata={"membership_id": membership_id},
    )
    await record_audit(
        db,
        action=actions.MEMBERSHIP_ACTIVATED,
        entity_type="membership",
        entity_id=membership_id,
        building_id=invitation.building_id,
        actor_user_id=account_id,
        metadata={"invitation_id": invitation.id},
    )
    new_session = None
    if new_account is not None:
        # After the roles: the session's idle window depends on holding a staff role.
        new_session = await start_logged_in_session(db, account_id, user_agent=user_agent, ip=ip)
    out = InvitationAcceptedOut(
        building_id=invitation.building_id,
        membership_id=membership_id,
        roles=sorted(Role(role) for role in invitation.roles),
    )
    await db.commit()
    return AcceptResult(out, new_session)


async def _activate_membership(
    db: AsyncSession, invitation: _Pending, user_id: UUID, now: datetime
) -> UUID:
    """Create the membership `active`, or reactivate a pending, denied or deactivated one; give it
    exactly the invitation's roles and unit. Never commits."""
    activated = {
        "status": MembershipStatus.ACTIVE,
        "status_changed_at": now,
        # The manager who invited authorised the change.
        "status_changed_by_user_id": invitation.created_by_user_id,
    }
    inserted = await db.scalar(
        pg_insert(BuildingMembership)
        .values(building_id=invitation.building_id, user_id=user_id, **activated)
        .on_conflict_do_nothing(index_elements=["building_id", "user_id"])
        .returning(BuildingMembership.id)
    )
    reactivated = inserted is None
    if inserted is not None:
        membership_id: UUID = inserted
    else:
        # Conditional (CLAUDE.md rule 7): an active or suspended membership is left alone (D1).
        updated = await db.scalar(
            update(BuildingMembership)
            .where(
                BuildingMembership.building_id == invitation.building_id,
                BuildingMembership.user_id == user_id,
                BuildingMembership.status.in_(_REACTIVATABLE),
            )
            .values(**activated)
            .returning(BuildingMembership.id)
        )
        if updated is None:
            raise MembershipExists(
                detail="This account is already a member here; a manager changes its roles."
            )
        membership_id = updated
        await db.execute(
            delete(MembershipRole).where(
                MembershipRole.building_id == invitation.building_id,
                MembershipRole.membership_id == membership_id,
            )
        )
    await db.execute(
        insert(MembershipRole),
        [
            {"building_id": invitation.building_id, "membership_id": membership_id, "role": role}
            for role in invitation.roles
        ],
    )
    if invitation.unit_id is not None:
        assert invitation.relationship is not None  # noqa: S101 (ck_invitations_unit_with_relationship)
        # Moves a reactivated membership's leftover occupancy, if any, to the invited unit.
        await transfer_occupancy(
            db,
            building_id=invitation.building_id,
            membership_id=membership_id,
            new_unit_id=invitation.unit_id,
            relationship=invitation.relationship,
        )
    elif reactivated and Role.RESIDENT not in invitation.roles:
        # An occupancy belongs to a resident membership (ADR-0010).
        await end_occupancy(db, building_id=invitation.building_id, membership_id=membership_id)
    return membership_id
