"""Recipient allowlist matching (P3-02 criterion 15)."""

import pytest

from app.email.service import is_allowlisted


@pytest.mark.parametrize(
    "address", ["a@example.test", "A@Example.Test", "first.last+tag@example.test"]
)
def test_domain_entry_matches_that_domain_in_any_case(address: str) -> None:
    assert is_allowlisted(address, ("@example.test",))


@pytest.mark.parametrize(
    "address",
    ["a@sub.example.test", "a@notexample.test", "a@example.test.evil", "example.test@evil.test"],
)
def test_domain_entry_matches_no_other_domain(address: str) -> None:
    assert not is_allowlisted(address, ("@example.test",))


def test_address_entry_matches_only_that_address() -> None:
    allowlist = ("james@example.org",)

    assert is_allowlisted("james@example.org", allowlist)
    assert is_allowlisted("JAMES@example.ORG", allowlist)
    assert not is_allowlisted("other@example.org", allowlist)
    assert not is_allowlisted("xjames@example.org", allowlist)


def test_any_entry_may_match() -> None:
    allowlist = ("james@example.org", "@example.test")

    assert is_allowlisted("james@example.org", allowlist)
    assert is_allowlisted("dev@example.test", allowlist)
    assert not is_allowlisted("dev@example.org", allowlist)


def test_empty_allowlist_allows_everyone() -> None:
    assert is_allowlisted("someone@gmail.com", ())
