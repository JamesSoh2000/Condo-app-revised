"""Fixed-window rate limits counted in Postgres (P2-05), so they survive restarts without Redis.

`RateLimiter.hit` counts on a session of its own and commits at once: the count must stay even when
the request it guards rolls back (a failed login). It is a dependency (`get_rate_limiter`), so tests
can give it their connection as they do `get_db_session`.
"""

import hashlib
import ipaddress
import math
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import clock
from app.core.config import RatePolicy
from app.core.database import AsyncSessionLocal
from app.core.errors import RateLimited
from app.rate_limits.models import RateLimit

EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


@dataclass(frozen=True)
class RateDecision:
    allowed: bool
    # Whole seconds until the current window ends (at least 1): the 429's Retry-After.
    retry_after: int
    count: int


class RateLimiter:
    def __init__(self, sessions: Callable[[], AsyncSession]) -> None:
        self._sessions = sessions

    async def hit(self, key: str, limit: int, window: timedelta) -> RateDecision:
        """Count one attempt for `key` in the current window; allowed while the count ≤ `limit`.

        One atomic upsert, so concurrent hits never lose a count.
        """
        now = clock.now()
        start = window_start(now, window)
        upsert = (
            insert(RateLimit)
            .values(key=key, window_start=start, count=1)
            .on_conflict_do_update(
                index_elements=[RateLimit.key, RateLimit.window_start],
                set_={"count": RateLimit.count + 1},
            )
            .returning(RateLimit.count)
        )
        async with self._sessions() as session:
            count = (await session.execute(upsert)).scalar_one()
            await session.commit()
        retry_after = max(1, math.ceil((start + window - now).total_seconds()))
        return RateDecision(allowed=count <= limit, retry_after=retry_after, count=count)

    async def enforce(self, key: str, policy: RatePolicy) -> None:
        """`hit`, raising `RateLimited` (429 `rate_limited` with Retry-After) over the limit."""
        decision = await self.hit(key, policy.limit, policy.window)
        if not decision.allowed:
            raise RateLimited(decision.retry_after, detail="Too many attempts. Try again later.")

    async def email_key(self, scope: str, email: str) -> str:
        """`<scope>:email:<sha256 hex>` of the email as Postgres lowers it.

        Postgres, not `str.lower()`: login finds users by `lower(email)` in Postgres, and the two
        disagree outside ASCII (Python lowers `İ` to two characters), so a Python key would give one
        account several counters. Hashed, so the table never holds an address.
        """
        async with self._sessions() as session:
            lowered = await session.scalar(select(func.lower(email)))
        assert lowered is not None  # noqa: S101 (lower() of a non-null string)
        return f"{scope}:email:{hashlib.sha256(lowered.encode()).hexdigest()}"


def get_rate_limiter() -> RateLimiter:
    return RateLimiter(AsyncSessionLocal)


def window_start(at: datetime, window: timedelta) -> datetime:
    """The start of the fixed window holding `at`, windows aligned to `window` since the epoch."""
    return EPOCH + (at - EPOCH) // window * window


def ip_key(scope: str, ip: str | None) -> str:
    """`<scope>:ip:<ip>`, an IPv6 client by its /64 (one subscriber's usual allocation, so rotating
    addresses inside it doesn't reset the count), an IPv4-mapped address as IPv4.

    `ip` must be the server-resolved `request.client.host`, never `X-Forwarded-For`: any client can
    write that header, and gunicorn/uvicorn replace the peer with it only when the peer is the
    trusted proxy (`FORWARDED_ALLOW_IPS`). Unknown peers share one key.
    """
    try:
        address = ipaddress.ip_address(ip or "")
    except ValueError:
        return f"{scope}:ip:unknown"
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None:
            return f"{scope}:ip:{address.ipv4_mapped}"
        return f"{scope}:ip:{ipaddress.IPv6Network((address, 64), strict=False)}"
    return f"{scope}:ip:{address}"


async def delete_expired_rate_limits(
    db: AsyncSession, older_than: timedelta = timedelta(days=1)
) -> int:
    """Delete windows that started more than `older_than` ago; return how many. Never commits.

    No policy window is longer than a day (`RatePolicy`), so the default only deletes ended windows.
    Run daily by the `rate_limits.cleanup` job (`app/rate_limits/jobs.py`, P3-01b).
    """
    result = await db.execute(
        delete(RateLimit).where(RateLimit.window_start < clock.now() - older_than)
    )
    deleted: int = result.rowcount  # type: ignore[attr-defined]
    return deleted
