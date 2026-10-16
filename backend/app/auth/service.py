"""Session lifecycle (ADR-0003): login, resolving a cookie, activity refresh, logout.

`login`, `touch_session` and `logout` are use-cases and commit once each (CLAUDE.md rule 5);
`start_session` and `resolve_session` only flush or read.
"""

from datetime import timedelta
from typing import NamedTuple
from uuid import UUID

from anyio import to_thread
from sqlalchemy import exists, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import AuthSession
from app.core import clock
from app.core.config import settings
from app.core.errors import Unauthorized
from app.core.security import (
    DUMMY_HASH,
    generate_token,
    hash_password,
    hash_token,
    is_valid_hash,
    needs_rehash,
    verify_password,
)
from app.memberships.enums import STAFF_ROLES, MembershipStatus
from app.memberships.models import BuildingMembership, MembershipRole
from app.users.models import User

# Activity moves last_seen_at and idle_expires_at forward at most this often: one write per user
# per 5 minutes instead of one per request.
REFRESH_EVERY = timedelta(minutes=5)


class CurrentSession(NamedTuple):
    session: AuthSession
    user: User


class InvalidCredentials(Unauthorized):
    code = "invalid_credentials"
    title = "Unauthorized"


async def login(
    db: AsyncSession, *, email: str, password: str, user_agent: str | None, ip: str | None
) -> str:
    """Check the credentials and start a session; return the raw token for the cookie.

    Every failure (unknown email, no or unparsable hash, wrong password, inactive user) raises the
    same `InvalidCredentials` after exactly one argon2 verification, so neither the body nor the
    timing tells them apart.
    """
    # lower() on both sides in Postgres: the same function as uq_users_lower_email (P1-02).
    user = await db.scalar(select(User).where(func.lower(User.email) == func.lower(email)))
    stored = user.password_hash if user is not None else None
    usable = stored if stored is not None and is_valid_hash(stored) else None
    # argon2 is CPU-bound and memory-hard: run it off the event loop.
    matches = await to_thread.run_sync(verify_password, password, usable or DUMMY_HASH)
    if user is None or usable is None or not matches or not user.is_active:
        raise InvalidCredentials(detail="The email or password is incorrect.")
    if needs_rehash(usable):
        user.password_hash = await to_thread.run_sync(hash_password, password)
    token = await start_session(db, user.id, user_agent=user_agent, ip=ip)
    await db.commit()
    return token


async def start_session(
    db: AsyncSession, user_id: UUID, *, user_agent: str | None, ip: str | None
) -> str:
    """Add a session for `user_id` and return its raw token. Flushes, never commits."""
    now = clock.now()
    token = generate_token()
    db.add(
        AuthSession(
            user_id=user_id,
            token_hash=hash_token(token),
            created_at=now,
            last_seen_at=now,
            expires_at=now + timedelta(days=settings.session_absolute_days),
            idle_expires_at=now + await idle_window(db, user_id),
            user_agent=user_agent[:300] if user_agent else None,
            ip=ip,
        )
    )
    await db.flush()
    return token


async def idle_window(db: AsyncSession, user_id: UUID) -> timedelta:
    """12 hours if the user holds a staff role on an active membership, else 7 days (ADR-0003)."""
    is_staff = await db.scalar(
        select(
            exists().where(
                BuildingMembership.user_id == user_id,
                BuildingMembership.status == MembershipStatus.ACTIVE,
                MembershipRole.membership_id == BuildingMembership.id,
                MembershipRole.role.in_(STAFF_ROLES),
            )
        )
    )
    if is_staff:
        return timedelta(hours=settings.session_idle_staff_hours)
    return timedelta(days=settings.session_idle_resident_days)


async def resolve_session(db: AsyncSession, token: str) -> CurrentSession | None:
    """The live session the token names, with its active user; None otherwise. One query."""
    now = clock.now()
    row = (
        await db.execute(
            select(AuthSession, User)
            .join(User, User.id == AuthSession.user_id)
            .where(
                AuthSession.token_hash == hash_token(token),
                AuthSession.revoked_at.is_(None),
                AuthSession.expires_at > now,
                AuthSession.idle_expires_at > now,
                User.is_active,
            )
        )
    ).one_or_none()
    return None if row is None else CurrentSession(*row)


async def touch_session(db: AsyncSession, session: AuthSession) -> None:
    """Record activity, at most once per `REFRESH_EVERY`; the idle window follows current roles."""
    now = clock.now()
    if now - session.last_seen_at < REFRESH_EVERY:
        return
    idle = await idle_window(db, session.user_id)
    # Conditional on the value read: of two concurrent requests, only one writes.
    await db.execute(
        update(AuthSession)
        .where(AuthSession.id == session.id, AuthSession.last_seen_at == session.last_seen_at)
        .values(last_seen_at=now, idle_expires_at=now + idle)
    )
    await db.commit()


async def logout(db: AsyncSession, token: str | None) -> None:
    """Revoke the session `token` names, if it is live. Unknown or missing tokens are a no-op."""
    if not token:
        return
    await db.execute(
        update(AuthSession)
        .where(AuthSession.token_hash == hash_token(token), AuthSession.revoked_at.is_(None))
        .values(revoked_at=clock.now())
    )
    await db.commit()
