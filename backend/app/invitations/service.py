"""Invitations (P4-02a): a manager creates, lists, revokes and resends them; P4-02b accepts them.

The token is 32 random bytes; only its sha256 is stored (`token_hash`), and the token itself goes
into the email's context, which the worker drops from the job once it is sent (`sensitive_keys`).
Each write use-case commits once (CLAUDE.md rule 5).
"""

from datetime import datetime, timedelta
from uuid import UUID

from sqlalchemy import ColumnElement, and_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import actions
from app.audit.service import record_audit
from app.buildings.models import Building
from app.core import clock
from app.core.errors import Conflict, NotFound
from app.core.pagination import CursorParams, Page, paginate
from app.core.security import generate_token, hash_token
from app.email.service import queue_email
from app.email.templates import DEFAULT_LOCALE, SUPPORTED_LOCALES
from app.invitations.models import Invitation
from app.invitations.schemas import InvitationCreate, InvitationOut, InvitationStatus
from app.memberships.enums import Role
from app.tenancy.context import TenantContext
from app.units.models import Unit
from app.units.service import UnitNotFound

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
    raise InvalidTransition(detail="This invitation was already accepted or revoked.")


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
    email = await db.scalar(
        select(Invitation.email).where(
            Invitation.id == invitation_id, Invitation.building_id == ctx.building_id
        )
    )
    if email is None:
        raise _not_found()
    await _refuse_another_pending(db, ctx, email, now, besides=invitation_id)
    token = generate_token()
    invitation = await _transition(
        db, ctx, invitation_id, token_hash=hash_token(token), expires_at=now + INVITATION_TTL
    )
    await _queue_invitation_email(db, building, invitation, token)
    await _audit(db, ctx, actions.INVITATION_RESENT, invitation_id)
    out = _out(invitation, now)
    await db.commit()
    return out
