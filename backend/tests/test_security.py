"""Password hashing, tokens and the password policy (P2-01a criteria 6-8)."""

import hashlib
import re
from importlib import resources

import pytest
from argon2 import PasswordHasher

from app.core.security import (
    DUMMY_HASH,
    WeakPasswordError,
    check_password_policy,
    generate_token,
    hash_password,
    hash_token,
    needs_rehash,
    verify_password,
)

PASSWORD = "correct horse battery staple"  # noqa: S105 (test value)


# Criterion 6: hashing


def test_hash_is_argon2id_and_verifies_only_the_right_password():
    stored = hash_password(PASSWORD)

    assert stored.startswith("$argon2id$")
    assert verify_password(PASSWORD, stored) is True
    assert verify_password(PASSWORD + "!", stored) is False
    assert verify_password("", stored) is False


def test_same_password_hashes_differently_each_time():
    assert hash_password(PASSWORD) != hash_password(PASSWORD)


@pytest.mark.parametrize(
    "stored",
    [
        "not-a-hash",
        "",
        "$2b$12$C6UzMDM.H6dfI/f/IKcEeO5YrWgxi2TfiN3ZQe4VuqUZ7NWEJdgJW",  # bcrypt
        "$argon2id$v=19$m=65536,t=3,p=4$garbage",
        # Review round 1 M1 (Codex, Claude): argon2 encodes the hash as ASCII before parsing it.
        "not-a-hash-é",
        "$argon2id$v=19$m=65536,t=3,p=4$é$invalid",
    ],
    ids=["text", "empty", "bcrypt", "truncated-argon2", "non-ascii", "non-ascii-argon2"],
)
def test_verify_returns_false_for_a_hash_it_cannot_parse(stored):
    assert verify_password(PASSWORD, stored) is False
    # Review round 1 L1: and it needs replacing, rather than raising.
    assert needs_rehash(stored) is True


def test_weaker_parameters_need_a_rehash_and_current_ones_do_not():
    weak = PasswordHasher(time_cost=1, memory_cost=8 * 1024, parallelism=1).hash(PASSWORD)

    assert needs_rehash(weak) is True
    assert needs_rehash(hash_password(PASSWORD)) is False


def test_dummy_hash_costs_what_a_real_hash_costs():
    # The unknown-email path verifies against DUMMY_HASH: it must be a real argon2id hash with the
    # current parameters, or that path would be measurably faster than a wrong password.
    assert DUMMY_HASH.startswith("$argon2id$")
    assert needs_rehash(DUMMY_HASH) is False
    assert DUMMY_HASH.split("$")[3] == hash_password(PASSWORD).split("$")[3]  # m=…,t=…,p=…
    assert verify_password(PASSWORD, DUMMY_HASH) is False


# Criterion 7: tokens


def test_tokens_are_long_url_safe_and_unique():
    tokens = {generate_token() for _ in range(50)}

    assert len(tokens) == 50
    assert all(re.fullmatch(r"[A-Za-z0-9_-]{43,}", t) for t in tokens)


def test_token_hash_is_lowercase_hex_sha256():
    token = generate_token()

    assert hash_token(token) == hashlib.sha256(token.encode()).hexdigest()
    assert re.fullmatch(r"[0-9a-f]{64}", hash_token(token))
    assert hash_token(token) != hash_token(token + "x")


# Criterion 8: the policy


def _common() -> list[str]:
    text = resources.files("app.core").joinpath("common_passwords.txt").read_text("utf-8")
    return text.splitlines()


@pytest.mark.parametrize(
    ("password", "reason"),
    [("a" * 11, "too_short"), ("", "too_short"), ("a" * 129, "too_long")],
)
def test_policy_rejects_passwords_outside_12_to_128_characters(password, reason):
    with pytest.raises(WeakPasswordError) as excinfo:
        check_password_policy(password)

    assert excinfo.value.reason == reason
    assert isinstance(excinfo.value, ValueError)


@pytest.mark.parametrize(
    "password", ["x7#kQ!m2Lp9z", "x7#kQ!m2Lp9z" * 10 + "abcdefgh", "DevPassword!2026"]
)
def test_policy_accepts_12_to_128_uncommon_characters(password):
    assert 12 <= len(password) <= 128
    check_password_policy(password)


@pytest.mark.parametrize(
    "transform", [str, str.upper, str.title], ids=["as-listed", "upper", "title"]
)
def test_policy_rejects_common_passwords_in_any_case(transform):
    for entry in ("123qweasdzxc", "1qaz2wsx3edc", "qwertyqwerty", _common()[-1]):
        with pytest.raises(WeakPasswordError) as excinfo:
            check_password_policy(transform(entry))
        assert excinfo.value.reason == "too_common"


def test_common_list_has_1000_unique_lowercase_entries_that_meet_the_length_rule():
    entries = _common()

    assert len(entries) == 1000
    assert len(set(entries)) == 1000
    assert all(e == e.lower() and 12 <= len(e) <= 128 for e in entries)


def test_policy_counts_characters_not_bytes():
    # 12 characters, 24 bytes in UTF-8.
    check_password_policy("éééééééééééé")
    with pytest.raises(WeakPasswordError):
        check_password_policy("ééééééééééé")
