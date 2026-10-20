"""Session lifecycle (ADR-0003): login, resolving a cookie, activity refresh, logout, the caller's
view of their account and sessions (P2-02), password reset (P4-04) and signup (P4-05a).

`login`, `touch_session`, `logout`, `logout_all`, `revoke_session`, `request_password_reset`,
`confirm_password_reset` and `signup` are use-cases and commit once each (CLAUDE.md rule 5);
`start_session`, `revoke_all_sessions` and the readers never commit. Each use-case but
`touch_session` records its audit event (P2-04) in that same commit.
"""

import re
from collections import defaultdict
from datetime import datetime, timedelta
from typing import NamedTuple, NoReturn
from uuid import UUID

from anyio import to_thread
from sqlalchemy import ColumnElement, and_, delete, exists, func, insert, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import actions
from app.audit.service import record_audit
from app.auth.models import AuthSession, PasswordResetToken
from app.auth.schemas import (
    MeBuildingOut,
    MeMembershipOut,
    MeOccupancyOut,
    MeOut,
    MeUserOut,
    PasswordResetRequestedOut,
    SessionOut,
)
from app.buildings.models import Building
from app.core import clock
from app.core.config import settings
from app.core.errors import BadRequest, Conflict, NotFound, Unauthorized, field_errors
from app.core.pagination import CursorParams, Page, paginate
from app.core.security import (
    DUMMY_HASH,
    PASSWORD_POLICY_MESSAGES,
    WeakPasswordError,
    check_password_policy,
    generate_token,
    hash_password,
    hash_token,
    is_valid_hash,
    needs_rehash,
    verify_password,
)
from app.email.service import queue_email
from app.email.templates import DEFAULT_LOCALE, SUPPORTED_LOCALES
from app.memberships.enums import STAFF_ROLES, MembershipStatus, Role
from app.memberships.models import BuildingMembership, MembershipRole, UnitOccupancy
from app.rate_limits.service import RateLimiter, ip_key
from app.units.models import Unit
from app.users.models import User

# Activity moves last_seen_at and idle_expires_at forward at most this often: one write per user
# per 5 minutes instead of one per request.
REFRESH_EVERY = timedelta(minutes=5)
# An ended session's row (with its IP and user agent) is kept this long for investigations that
# start from an audit event, then deleted by `sessions.cleanup` (P3-01b D1).
SESSION_RETENTION = timedelta(days=30)
PASSWORD_RESET_TTL = timedelta(hours=1)
# What `generate_token` makes; anything else is no token of ours (as invitations).
_RESET_TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
# The one answer to every allowed reset request, whether or not an account matched (criterion 1).
RESET_REQUESTED = PasswordResetRequestedOut(
    detail="If an account exists for this email, we sent a link to reset its password."
)


class CurrentSession(NamedTuple):
    session: AuthSession
    user: User


class NewSession(NamedTuple):
    token: str
    id: UUID


class InvalidCredentials(Unauthorized):
    code = "invalid_credentials"
    title = "Unauthorized"


class ResetTokenInvalid(BadRequest):
    code = "reset_token_invalid"


class EmailInUse(Conflict):
    code = "email_in_use"


class SignedUp(NamedTuple):
    user: MeUserOut
    token: str


async def login(
    db: AsyncSession,
    limiter: RateLimiter,
    *,
    email: str,
    password: str,
    user_agent: str | None,
    ip: str | None,
) -> str:
    """Check the credentials and start a session; return the raw token for the cookie.

    Every failure (unknown email, no or unparsable hash, wrong password, inactive user) raises the
    same `InvalidCredentials` after exactly one argon2 verification, so neither the body nor the
    timing tells them apart.

    Every attempt counts against the client's IP, then the email (P2-05), before anything is looked
    up: a limited attempt costs no argon2 and answers the same whether the email exists. The counts
    commit on the limiter's own sessions; `db` has not begun yet.
    """
    await limiter.enforce(ip_key("login", ip), settings.rate_limit_login_ip)
    await limiter.enforce(await limiter.email_key("login", email), settings.rate_limit_login_email)
    # lower() on both sides in Postgres: the same function as uq_users_lower_email (P1-02).
    found = (
        await db.execute(
            select(User.id, User.password_hash, User.is_active).where(
                func.lower(User.email) == func.lower(email)
            )
        )
    ).one_or_none()
    # End the read before argon2 runs, so the pooled connection isn't held for the slow part: a
    # burst of logins would otherwise hold every connection (review round 2).
    await db.rollback()
    stored = found.password_hash if found is not None else None
    usable = stored if stored is not None and is_valid_hash(stored) else None
    # argon2 is CPU-bound and memory-hard: run it off the event loop.
    matches = await to_thread.run_sync(verify_password, password, usable or DUMMY_HASH)
    if found is None or usable is None or not matches or not found.is_active:
        await _login_failed(db, found.id if found is not None else None)
    # The user's lock (taken again by the session's start), then the hash and status again: a
    # password reset may have committed while argon2 ran, and a session started from the old
    # password would outlive the reset that ended them all (P4-04 criterion 8).
    current = (
        await db.execute(
            select(User.password_hash, User.is_active)
            .where(User.id == found.id)
            .with_for_update(key_share=True)
        )
    ).one()
    if current.password_hash != usable or not current.is_active:
        await _login_failed(db, found.id)
    if needs_rehash(usable):
        upgraded = await to_thread.run_sync(hash_password, password)
        # Only over the hash that was verified: a password changed meanwhile wins.
        await db.execute(
            update(User)
            .where(User.id == found.id, User.password_hash == usable)
            .values(password_hash=upgraded)
        )
    token = await start_logged_in_session(db, found.id, user_agent=user_agent, ip=ip)
    await db.commit()
    return token


async def _login_failed(db: AsyncSession, user_id: UUID | None) -> NoReturn:
    # Never the attempted email or password; the user's id only when the email matched one.
    await record_audit(
        db,
        action=actions.AUTH_LOGIN_FAILED,
        entity_type="user",
        metadata={"user_id": user_id} if user_id is not None else None,
    )
    # Committed although the login fails: the router commits nothing on an error.
    await db.commit()
    raise InvalidCredentials(detail="The email or password is incorrect.")


async def start_logged_in_session(
    db: AsyncSession, user_id: UUID, *, user_agent: str | None, ip: str | None
) -> str:
    """Start a session for `user_id` and audit it `auth.logged_in`, as every login is (login, an
    invitation's new account). Return the raw token. Flushes, never commits."""
    session = await _new_session(db, user_id, user_agent=user_agent, ip=ip)
    await record_audit(
        db,
        action=actions.AUTH_LOGGED_IN,
        entity_type="session",
        entity_id=session.id,
        actor_user_id=user_id,
    )
    return session.token


async def start_session(
    db: AsyncSession, user_id: UUID, *, user_agent: str | None, ip: str | None
) -> str:
    """Add a session for `user_id` and return its raw token. Flushes, never commits."""
    return (await _new_session(db, user_id, user_agent=user_agent, ip=ip)).token


async def _new_session(
    db: AsyncSession, user_id: UUID, *, user_agent: str | None, ip: str | None
) -> NewSession:
    # The lock, then the roles (`idle_window` below), as `touch_session` does.
    await lock_idle_deadlines(db, user_id)
    now = clock.now()
    token = generate_token()
    session = AuthSession(
        user_id=user_id,
        token_hash=hash_token(token),
        created_at=now,
        last_seen_at=now,
        expires_at=now + timedelta(days=settings.session_absolute_days),
        idle_expires_at=now + await idle_window(db, user_id),
        # Postgres text can't hold NUL (review round 2).
        user_agent=user_agent.replace("\x00", "")[:300] if user_agent else None,
        ip=ip,
    )
    db.add(session)
    await db.flush()
    return NewSession(token, session.id)


async def lock_idle_deadlines(db: AsyncSession, user_id: UUID) -> None:
    """Take the user's idle-deadline lock until the transaction ends: the user row, FOR NO KEY
    UPDATE (foreign-key checks from sessions and memberships don't wait for it).

    Every write that sets a user's idle deadlines takes it before reading the roles: a session's
    start or refresh, and a role change (`apply_role_change`). They run one at a time per user, and
    each reads the roles the previous one committed, so none can store a window read before a
    staff role was granted (P4-02b, inbox B-6).
    """
    await db.execute(select(User.id).where(User.id == user_id).with_for_update(key_share=True))


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


async def apply_role_change(
    db: AsyncSession, user_id: UUID, *, active_session_id: UUID | None
) -> None:
    """Make the user's sessions follow roles just changed in this transaction (an invitation's
    accept): record activity on `active_session_id` (the request's own session), then cap every
    live session's idle deadline to the window the roles allow, from its last activity. Never
    lengthens one, so an expired session stays expired. Takes the user's idle-deadline lock first.
    Flushes, never commits."""
    await lock_idle_deadlines(db, user_id)
    now = clock.now()
    window = await idle_window(db, user_id)
    if active_session_id is not None:
        await db.execute(
            update(AuthSession)
            .where(AuthSession.id == active_session_id, _is_live(now))
            .values(last_seen_at=now, idle_expires_at=now + window)
        )
    await db.execute(
        update(AuthSession)
        .where(AuthSession.user_id == user_id, AuthSession.revoked_at.is_(None))
        .values(
            idle_expires_at=func.least(
                AuthSession.idle_expires_at, AuthSession.last_seen_at + window
            )
        )
    )


async def resolve_session(db: AsyncSession, token: str) -> CurrentSession | None:
    """The live session the token names, with its active user; None otherwise. One query."""
    row = (
        await db.execute(
            select(AuthSession, User)
            .join(User, User.id == AuthSession.user_id)
            .where(
                AuthSession.token_hash == hash_token(token), _is_live(clock.now()), User.is_active
            )
        )
    ).one_or_none()
    return None if row is None else CurrentSession(*row)


def _is_live(now: datetime) -> ColumnElement[bool]:
    """Not revoked, and before both deadlines."""
    return and_(
        AuthSession.revoked_at.is_(None),
        AuthSession.expires_at > now,
        AuthSession.idle_expires_at > now,
    )


async def touch_session(db: AsyncSession, session: AuthSession) -> None:
    """Record activity, at most once per `REFRESH_EVERY`; the idle window follows current roles."""
    now = clock.now()
    if now - session.last_seen_at < REFRESH_EVERY:
        return
    # The lock, then the roles: a staff role granted meanwhile is read here (P4-02b, inbox B-6).
    await lock_idle_deadlines(db, session.user_id)
    idle = await idle_window(db, session.user_id)
    # And the clock again: the session may have expired while this waited for the lock (review
    # round 4); `now` from before the wait would still call it live.
    now = clock.now()
    # Conditional on the value read: of two concurrent requests, only one writes. And only while
    # still live: a role change may have capped the session into the past since it was resolved.
    await db.execute(
        update(AuthSession)
        .where(
            AuthSession.id == session.id,
            AuthSession.last_seen_at == session.last_seen_at,
            _is_live(now),
        )
        .values(last_seen_at=now, idle_expires_at=now + idle)
    )
    await db.commit()


async def logout(db: AsyncSession, token: str | None) -> None:
    """Revoke the session `token` names, if it is live. Unknown or missing tokens are a no-op."""
    if not token:
        return
    revoked = (
        await db.execute(
            update(AuthSession)
            .where(AuthSession.token_hash == hash_token(token), AuthSession.revoked_at.is_(None))
            .values(revoked_at=clock.now())
            .returning(AuthSession.id, AuthSession.user_id)
        )
    ).one_or_none()
    if revoked is not None:
        await record_audit(
            db,
            action=actions.AUTH_LOGGED_OUT,
            entity_type="session",
            entity_id=revoked.id,
            actor_user_id=revoked.user_id,
        )
    await db.commit()


async def revoke_all_sessions(db: AsyncSession, user_id: UUID) -> int:
    """Revoke every session of the user not yet revoked; return how many. Never commits.

    For logout-all, and later password reset and deactivation (ADR-0003). Takes effect on the
    next request: `resolve_session` reads `revoked_at` every time.
    """
    revoked = await db.scalars(
        update(AuthSession)
        .where(AuthSession.user_id == user_id, AuthSession.revoked_at.is_(None))
        .values(revoked_at=clock.now())
        .returning(AuthSession.id)
    )
    return len(revoked.all())


async def delete_ended_sessions(db: AsyncSession) -> int:
    """Delete sessions that ended (revoked, or past either deadline) more than SESSION_RETENTION
    ago; return how many. Never commits.

    An ended session never becomes live again: `touch_session` moves `idle_expires_at` only for a
    session `resolve_session` found live.
    """
    cutoff = clock.now() - SESSION_RETENTION
    result = await db.execute(
        delete(AuthSession).where(
            or_(
                AuthSession.revoked_at < cutoff,
                AuthSession.expires_at < cutoff,
                AuthSession.idle_expires_at < cutoff,
            )
        )
    )
    deleted: int = result.rowcount  # type: ignore[attr-defined]
    return deleted


async def logout_all(db: AsyncSession, user_id: UUID) -> None:
    count = await revoke_all_sessions(db, user_id)
    await record_audit(
        db,
        action=actions.AUTH_LOGGED_OUT_ALL,
        entity_type="user",
        entity_id=user_id,
        actor_user_id=user_id,
        metadata={"count": count},
    )
    await db.commit()


async def list_sessions(
    db: AsyncSession, current: AuthSession, params: CursorParams
) -> Page[SessionOut]:
    """The user's live sessions, newest first; `current` marks the one making the request."""
    stmt = select(AuthSession).where(AuthSession.user_id == current.user_id, _is_live(clock.now()))
    return await paginate(
        db,
        stmt,
        AuthSession.id,
        params,
        lambda row: SessionOut(
            id=row.id,
            created_at=row.created_at,
            last_seen_at=row.last_seen_at,
            user_agent=row.user_agent,
            current=row.id == current.id,
        ),
    )


async def revoke_session(db: AsyncSession, user_id: UUID, session_id: UUID) -> None:
    """Revoke one live session of the user. Anyone else's, or one no longer live: `NotFound`."""
    revoked = await db.scalar(
        update(AuthSession)
        .where(
            AuthSession.id == session_id,
            AuthSession.user_id == user_id,
            _is_live(clock.now()),
        )
        .values(revoked_at=clock.now())
        .returning(AuthSession.id)
    )
    if revoked is None:
        # The same answer whether the session is someone else's or doesn't exist (ADR-0004).
        raise NotFound(detail="Session not found.")
    await record_audit(
        db,
        action=actions.AUTH_SESSION_REVOKED,
        entity_type="session",
        entity_id=session_id,
        actor_user_id=user_id,
    )
    await db.commit()


def _reset_token_live(now: datetime) -> ColumnElement[bool]:
    return and_(
        PasswordResetToken.used_at.is_(None),
        PasswordResetToken.revoked_at.is_(None),
        PasswordResetToken.expires_at > now,
    )


def _reset_invalid() -> ResetTokenInvalid:
    # One body for unknown, malformed, expired, used and replaced tokens, and a deactivated user's.
    return ResetTokenInvalid(
        detail="This password reset link is invalid or has expired. Ask for a new one."
    )


async def request_password_reset(
    db: AsyncSession, limiter: RateLimiter, *, email: str, ip: str | None
) -> None:
    """Email a reset link if `email` is an active account's; otherwise do nothing visible.

    The caller answers `RESET_REQUESTED` either way. Every request counts against the IP, then the
    email, before the lookup (P2-05), and makes a token whether or not it is used, so an unknown
    email takes no early return (ticket: timing).

    The user row is locked first (D2): of two requests for one account the second waits, then
    revokes the first's token, so a user has one live token (the partial unique index).
    """
    await limiter.enforce(ip_key("reset", ip), settings.rate_limit_reset_ip)
    await limiter.enforce(await limiter.email_key("reset", email), settings.rate_limit_reset_email)
    token = generate_token()
    token_hash = hash_token(token)
    # lower() on both sides in Postgres, as `login`.
    found = (
        await db.execute(
            select(User.id, User.email, User.locale, User.is_active)
            .where(func.lower(User.email) == func.lower(email))
            .with_for_update(key_share=True)
        )
    ).one_or_none()
    if found is not None and found.is_active:
        now = clock.now()
        # Expired ones too: the index counts every token neither used nor revoked.
        await db.execute(
            update(PasswordResetToken)
            .where(
                PasswordResetToken.user_id == found.id,
                PasswordResetToken.used_at.is_(None),
                PasswordResetToken.revoked_at.is_(None),
            )
            .values(revoked_at=now)
        )
        await db.execute(
            insert(PasswordResetToken).values(
                user_id=found.id, token_hash=token_hash, expires_at=now + PASSWORD_RESET_TTL
            )
        )
        await queue_email(
            db,
            # The stored address, not the one typed.
            to=found.email,
            template="password_reset",
            # A path: the template puts APP_BASE_URL in front. In `context`, the payload key the
            # worker drops once the email is sent.
            context={"link": f"/reset-password/{token}"},
            locale=found.locale if found.locale in SUPPORTED_LOCALES else DEFAULT_LOCALE,
        )
    await record_audit(
        db,
        action=actions.AUTH_PASSWORD_RESET_REQUESTED,
        entity_type="user",
        metadata={"user_id": found.id} if found is not None else None,
    )
    await db.commit()


async def confirm_password_reset(
    db: AsyncSession, limiter: RateLimiter, *, token: str, new_password: str, ip: str | None
) -> None:
    """Set the password of the live token's active user, use the token, and revoke every session
    of the user. 422 if the policy refuses the password (the token stays usable); 400
    `reset_token_invalid` for any token that can't be used.

    Reads first, then ends the read so argon2 runs with no connection held, then writes in one
    transaction that takes the user's lock (the same order as the request and login, D2) and claims
    the token with a conditional UPDATE and the clock read after that lock (D3).
    """
    await limiter.enforce(ip_key("reset_confirm", ip), settings.rate_limit_reset_ip)
    try:
        check_password_policy(new_password)
    except WeakPasswordError as exc:
        # The reason only: never the password (P2-01b carry).
        raise field_errors(
            ("new_password", PASSWORD_POLICY_MESSAGES[exc.reason], f"password_{exc.reason}")
        ) from None
    if not _RESET_TOKEN.fullmatch(token):
        raise _reset_invalid()
    token_hash = hash_token(token)
    # Before argon2: a token that can't be used costs no hashing.
    user_id = await db.scalar(
        select(PasswordResetToken.user_id)
        .join(User, User.id == PasswordResetToken.user_id)
        .where(
            PasswordResetToken.token_hash == token_hash,
            _reset_token_live(clock.now()),
            User.is_active,
        )
    )
    if user_id is None:
        raise _reset_invalid()
    await db.rollback()
    password_hash = await to_thread.run_sync(hash_password, new_password)

    active = await db.scalar(
        select(User.id).where(User.id == user_id, User.is_active).with_for_update(key_share=True)
    )
    now = clock.now()
    claimed = await db.scalar(
        update(PasswordResetToken)
        .where(PasswordResetToken.token_hash == token_hash, _reset_token_live(now))
        .values(used_at=now)
        .returning(PasswordResetToken.id)
    )
    if active is None or claimed is None:
        raise _reset_invalid()
    await db.execute(update(User).where(User.id == user_id).values(password_hash=password_hash))
    revoked = await revoke_all_sessions(db, user_id)
    await record_audit(
        db,
        action=actions.AUTH_PASSWORD_RESET_COMPLETED,
        entity_type="user",
        entity_id=user_id,
        actor_user_id=user_id,
        metadata={"sessions_revoked": revoked},
    )
    await db.commit()


def _email_in_use() -> EmailInUse:
    return EmailInUse(detail="An account already uses this email: log in instead.")


async def signup(
    db: AsyncSession,
    *,
    email: str,
    full_name: str,
    password: str,
    user_agent: str | None,
    ip: str | None,
) -> SignedUp:
    """Create an account for `email` (lowered by the schema) and log it in.

    409 `email_in_use` if an account has the email in any case: unlike password reset, this tells
    the caller an account exists, which the ticket accepts for signup; the per-IP limit
    (`app.auth.router.signup_limit`, counted before the body is even parsed) bounds how many emails
    one client can test. The email stays unverified
    (`email_verified_at` NULL) until the pilot's verification.

    Reads first and ends the read so argon2 runs with no connection held (as `login`); the INSERT
    then decides a race with `ON CONFLICT`: of two signups for one email, the second waits on
    `uq_users_lower_email` and inserts nothing (D2).
    """
    try:
        check_password_policy(password)
    except WeakPasswordError as exc:
        # The reason only: never the password (P2-01b carry).
        raise field_errors(
            ("password", PASSWORD_POLICY_MESSAGES[exc.reason], f"password_{exc.reason}")
        ) from None
    # lower() on both sides in Postgres, as `login`.
    if await db.scalar(select(User.id).where(func.lower(User.email) == func.lower(email))):
        raise _email_in_use()
    await db.rollback()
    password_hash = await to_thread.run_sync(hash_password, password)
    user = (
        await db.execute(
            pg_insert(User)
            .values(email=email, full_name=full_name, password_hash=password_hash)
            .on_conflict_do_nothing(index_elements=[func.lower(User.email)])
            .returning(User.id, User.email, User.full_name, User.phone, User.locale)
        )
    ).one_or_none()
    if user is None:
        raise _email_in_use()
    await record_audit(
        db,
        action=actions.AUTH_SIGNED_UP,
        entity_type="user",
        entity_id=user.id,
        actor_user_id=user.id,
    )
    token = await start_logged_in_session(db, user.id, user_agent=user_agent, ip=ip)
    out = MeUserOut(
        id=user.id, email=user.email, full_name=user.full_name, phone=user.phone, locale=user.locale
    )
    await db.commit()
    return SignedUp(out, token)


async def get_me(db: AsyncSession, user: User) -> MeOut:
    """The shell's bootstrap: the user and every membership the UI must show. Two queries.

    Deactivated memberships and inactive buildings are left out: the user can do nothing there
    and there is nothing to explain. Pending, denied and suspended ones stay, so the UI can say
    why the building is closed to them.
    """
    rows = (
        await db.execute(
            select(
                BuildingMembership.id,
                BuildingMembership.status,
                Building.id.label("building_id"),
                Building.name,
                Building.slug,
                Building.timezone,
                Building.locale,
                UnitOccupancy.unit_id,
                Unit.label,
                Unit.tower,
                UnitOccupancy.relationship,
            )
            .join(Building, Building.id == BuildingMembership.building_id)
            # At most one current occupancy per membership (uq_unit_occupancies_current_membership),
            # so these outer joins never repeat a membership.
            .outerjoin(
                UnitOccupancy,
                and_(
                    UnitOccupancy.membership_id == BuildingMembership.id,
                    UnitOccupancy.ended_at.is_(None),
                ),
            )
            .outerjoin(
                Unit,
                and_(
                    Unit.building_id == UnitOccupancy.building_id,
                    Unit.id == UnitOccupancy.unit_id,
                ),
            )
            .where(
                BuildingMembership.user_id == user.id,
                BuildingMembership.status != MembershipStatus.DEACTIVATED,
                Building.is_active,
            )
            .order_by(Building.name, Building.id)
        )
    ).all()
    roles: defaultdict[UUID, list[Role]] = defaultdict(list)
    if rows:
        for membership_id, role in await db.execute(
            select(MembershipRole.membership_id, MembershipRole.role).where(
                MembershipRole.membership_id.in_([row.id for row in rows])
            )
        ):
            roles[membership_id].append(role)
    return MeOut(
        user=MeUserOut(
            id=user.id,
            email=user.email,
            full_name=user.full_name,
            phone=user.phone,
            locale=user.locale,
        ),
        memberships=[
            MeMembershipOut(
                membership_id=row.id,
                status=row.status,
                # Sorted by value: Postgres would order the enum by declaration.
                roles=sorted(roles[row.id]),
                building=MeBuildingOut(
                    id=row.building_id,
                    name=row.name,
                    slug=row.slug,
                    timezone=row.timezone,
                    locale=row.locale,
                ),
                occupancy=None
                if row.unit_id is None
                else MeOccupancyOut(
                    unit_id=row.unit_id,
                    unit_label=row.label,
                    tower=row.tower,
                    relationship=row.relationship,
                ),
            )
            for row in rows
        ],
    )
