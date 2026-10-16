"""Log a test client in without a password (the world's users have none)."""

from app.auth.service import start_session
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.users.models import User


async def login_as(db: AsyncSession, client: AsyncClient, user: User) -> str:
    """Create a session row for `user` in the test's transaction and give `client` its cookie.

    Returns the raw token. The row is flushed, not committed: requests run on savepoints of the
    test's connection, so they see it.
    """
    token = await start_session(db, user.id, user_agent="tests", ip=None)
    client.cookies.set(settings.session_cookie_name, token)
    return token
