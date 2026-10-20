"""Password hashing, session tokens and the password policy (ADR-0003, P2-01a).

Passwords are hashed with argon2id: slow and memory-hard, because a password is guessable. Session
tokens are 32 random bytes, so a fast sha256 is enough to keep the stored value useless to a reader
of the database.
"""

import base64
import binascii
import hashlib
import secrets
from functools import cache
from importlib import resources
from typing import Literal

from argon2 import PasswordHasher, extract_parameters
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
    # UnicodeEncodeError: argon2 encodes the hash as ASCII before parsing it (review round 1 M1).
    except VerificationError, InvalidHashError, UnicodeEncodeError:
        return False


def is_valid_hash(password_hash: str) -> bool:
    """True if `password_hash` is an argon2 hash in the exact form argon2 writes, with parameters a
    real verification would run. Login verifies against `DUMMY_HASH` otherwise.

    The point is timing: a hash libargon2 refuses fails in microseconds, so an account with a
    corrupt hash would answer faster than an unknown email. argon2-cffi's `extract_parameters`
    parses more than libargon2 runs (review rounds: P2-01a 2-3, P2-01b 1-2), so instead of
    listing bad inputs this rebuilds the canonical string from what was parsed and requires an
    exact match (ruling out leading zeros, signs, reordered or extra fields, non-canonical
    base64), then bounds every parameter.
    """
    try:
        params = extract_parameters(password_hash)
    except InvalidHashError, UnicodeEncodeError:
        return False
    *_, salt, digest = password_hash.split("$")
    canonical = (
        f"$argon2{params.type.name.lower()}$v={params.version}"
        f"$m={params.memory_cost},t={params.time_cost},p={params.parallelism}${salt}${digest}"
    )
    # Lower bounds: libargon2's minimums (argon2.h). Upper bounds: ours, far above what
    # hash_password writes (t=3, m=64 MiB, p=4, 16-byte salt, 32-byte digest); past them a
    # verification could fail fast on allocation, or isn't a hash this app would accept.
    within_bounds = (
        params.version in {16, 19}
        and 8 <= params.salt_len <= 64
        and 4 <= params.hash_len <= 64
        and 1 <= params.time_cost <= 16
        and 1 <= params.parallelism <= 16
        and 8 * params.parallelism <= params.memory_cost <= 1024 * 1024
    )
    return (
        password_hash == canonical
        and within_bounds
        and _is_canonical_b64(salt)
        and _is_canonical_b64(digest)
    )


def _is_canonical_b64(field: str) -> bool:
    try:
        raw = base64.b64decode(field + "=" * (-len(field) % 4), validate=True)
    except binascii.Error, ValueError:
        return False
    return base64.b64encode(raw).decode().rstrip("=") == field


def needs_rehash(password_hash: str) -> bool:
    """True if the hash was made with other parameters than `hash_password` uses now, or isn't a
    valid hash at all (it needs replacing either way)."""
    return not is_valid_hash(password_hash) or _hasher.check_needs_rehash(password_hash)


# Verified against when there is no hash to check (unknown email, no password set), so that path
# costs the same as a wrong password and its timing doesn't reveal which emails have accounts.
DUMMY_HASH = hash_password(secrets.token_urlsafe(32))


def generate_token() -> str:
    """A new session token: 32 random bytes, URL-safe base64 (43 characters)."""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """What the database stores for a token: its sha256, as 64 lowercase hex characters."""
    return hashlib.sha256(token.encode()).hexdigest()


type WeakPasswordReason = Literal["too_short", "too_long", "too_common", "invalid_characters"]


# The 422 message for each reason, on the password field (invitation accept, password reset).
PASSWORD_POLICY_MESSAGES: dict[WeakPasswordReason, str] = {
    "too_short": f"must be at least {PASSWORD_MIN_LENGTH} characters",
    "too_long": f"must be at most {PASSWORD_MAX_LENGTH} characters",
    "too_common": "is too common",
    "invalid_characters": "contains characters that can't be stored",
}


class WeakPasswordError(ValueError):
    def __init__(self, reason: WeakPasswordReason) -> None:
        super().__init__(f"password rejected by the policy: {reason}")
        self.reason: WeakPasswordReason = reason


def check_password_policy(password: str) -> None:
    """Raise `WeakPasswordError` unless `password` is 12-128 characters and not a common one.

    No composition rules (NIST SP 800-63B). Length counts characters, not bytes.
    """
    try:
        password.encode()
    except UnicodeEncodeError:
        # A lone surrogate (JSON can carry one): it can't be hashed (review round 2 M1).
        raise WeakPasswordError("invalid_characters") from None
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
