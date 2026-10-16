"""Password hashing, session tokens and the password policy (ADR-0003, P2-01a).

Passwords are hashed with argon2id: slow and memory-hard, because a password is guessable. Session
tokens are 32 random bytes, so a fast sha256 is enough to keep the stored value useless to a reader
of the database.
"""

import hashlib
import secrets
from functools import cache
from importlib import resources
from typing import Literal

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

# argon2-cffi's defaults: RFC 9106's low-memory profile (argon2id, t=3, m=64 MiB, p=4).
_hasher = PasswordHasher()

PASSWORD_MIN_LENGTH = 12
PASSWORD_MAX_LENGTH = 128


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    """True only if `password` matches; False for a mismatch or a hash that can't be parsed."""
    try:
        return _hasher.verify(password_hash, password)
    except VerificationError, InvalidHashError:
        return False


def needs_rehash(password_hash: str) -> bool:
    """True if the hash was made with other parameters than `hash_password` uses now."""
    return _hasher.check_needs_rehash(password_hash)


# Verified against when there is no hash to check (unknown email, no password set), so that path
# costs the same as a wrong password and its timing doesn't reveal which emails have accounts.
DUMMY_HASH = hash_password(secrets.token_urlsafe(32))


def generate_token() -> str:
    """A new session token: 32 random bytes, URL-safe base64 (43 characters)."""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """What the database stores for a token: its sha256, as 64 lowercase hex characters."""
    return hashlib.sha256(token.encode()).hexdigest()


type WeakPasswordReason = Literal["too_short", "too_long", "too_common"]


class WeakPasswordError(ValueError):
    def __init__(self, reason: WeakPasswordReason) -> None:
        super().__init__(f"password rejected by the policy: {reason}")
        self.reason: WeakPasswordReason = reason


def check_password_policy(password: str) -> None:
    """Raise `WeakPasswordError` unless `password` is 12-128 characters and not a common one.

    No composition rules (NIST SP 800-63B). Length counts characters, not bytes.
    """
    if len(password) < PASSWORD_MIN_LENGTH:
        raise WeakPasswordError("too_short")
    if len(password) > PASSWORD_MAX_LENGTH:
        raise WeakPasswordError("too_long")
    if password.lower() in _common_passwords():
        raise WeakPasswordError("too_common")


@cache
def _common_passwords() -> frozenset[str]:
    # The 1,000 most frequent passwords of 12-128 printable ASCII characters in SecLists'
    # xato-net-10-million-passwords-1000000.txt (commit 21537beae7465102a3ebbedea6a7852a0cbcb3c4,
    # MIT licence), lower-cased and de-duplicated. Shorter ones already fail the length rule.
    text = resources.files("app.core").joinpath("common_passwords.txt").read_text("utf-8")
    return frozenset(text.splitlines())
