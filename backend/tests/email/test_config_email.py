"""Email settings validation (P3-02 criteria 6, 15 and 16)."""

from typing import Any

import pytest
from pydantic import ValidationError

from app.core.config import Settings

# Everything else staging and production require, so each test isolates one email setting.
DEPLOYED: dict[str, Any] = {
    "secret_key": "not-the-default-secret",
    "trusted_origins": ["https://app.example.org"],
    "s3_bucket_name": "condo-app-staging-files",
    "ses_from_email": "noreply@example.org",
    "email_from": "Maple Tower <no-reply@example.org>",
    "app_base_url": "https://app.example.org",
    "email_recipient_allowlist": "@example.org",
    "smtp_starttls": True,
}


def make(**values: Any) -> Settings:
    return Settings(_env_file=None, **values)


def test_dev_defaults_are_valid_and_allow_everyone() -> None:
    settings = make()

    assert settings.email_recipient_allowlist == ()
    assert settings.app_base_url == "http://localhost:5173"
    assert settings.smtp_starttls is False


@pytest.mark.parametrize("env", ["staging", "prod"])
def test_deployed_baseline_is_valid(env: str) -> None:
    assert make(app_env=env, **DEPLOYED).app_env == env


# Criterion 6


@pytest.mark.parametrize("empty", ["", "  "])
def test_staging_requires_an_allowlist(empty: str) -> None:
    with pytest.raises(ValidationError, match="EMAIL_RECIPIENT_ALLOWLIST"):
        make(app_env="staging", **(DEPLOYED | {"email_recipient_allowlist": empty}))


def test_staging_allowlist_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EMAIL_RECIPIENT_ALLOWLIST", "")
    values = {k: v for k, v in DEPLOYED.items() if k != "email_recipient_allowlist"}

    with pytest.raises(ValidationError, match="EMAIL_RECIPIENT_ALLOWLIST"):
        make(app_env="staging", **values)


def test_prod_may_have_an_empty_allowlist() -> None:
    settings = make(app_env="prod", **(DEPLOYED | {"email_recipient_allowlist": ""}))

    assert settings.email_recipient_allowlist == ()


# Criterion 15 (parsing)


def test_allowlist_is_comma_separated_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EMAIL_RECIPIENT_ALLOWLIST", " James@Example.org , @Example.TEST ")

    assert make().email_recipient_allowlist == ("james@example.org", "@example.test")


@pytest.mark.parametrize(
    "value",
    [
        "example.test",
        "@",
        "@@example.test",
        "a@example.test,,b@example.test",
        "a@example.test,",
        "a b@example.test",
        "a@exa mple.test",
        "a@b@example.test",
        "@example..test",
        "@-example.test",
    ],
)
def test_malformed_allowlist_entry_fails(value: str) -> None:
    with pytest.raises(ValidationError, match="EMAIL_RECIPIENT_ALLOWLIST"):
        make(email_recipient_allowlist=value)


# Criterion 16


@pytest.mark.parametrize("env", ["staging", "prod"])
@pytest.mark.parametrize(
    "url", ["http://localhost:5173", "https://127.0.0.1", "https://app.localhost"]
)
def test_deployed_app_base_url_is_not_loopback(env: str, url: str) -> None:
    with pytest.raises(ValidationError, match="APP_BASE_URL"):
        make(app_env=env, **(DEPLOYED | {"app_base_url": url}))


def test_prod_app_base_url_is_https() -> None:
    with pytest.raises(ValidationError, match="APP_BASE_URL"):
        make(app_env="prod", **(DEPLOYED | {"app_base_url": "http://app.example.org"}))


@pytest.mark.parametrize(
    "url",
    ["app.example.org", "https://app.example.org/", "https://app.example.org/path", "ftp://x.org"],
)
def test_app_base_url_is_an_origin(url: str) -> None:
    with pytest.raises(ValidationError, match="APP_BASE_URL"):
        make(app_base_url=url)


def test_prod_email_from_is_not_the_dev_default() -> None:
    default = Settings.model_fields["email_from"].default

    with pytest.raises(ValidationError, match="EMAIL_FROM"):
        make(app_env="prod", **(DEPLOYED | {"email_from": default}))


@pytest.mark.parametrize(
    "value",
    [
        "",
        "no-reply",
        "Maple <no-reply>",
        "a@example.org, b@example.org",
        "Maple <no-reply@example.org>\r\nBcc: x@example.org",
    ],
)
def test_email_from_is_one_address(value: str) -> None:
    with pytest.raises(ValidationError, match="EMAIL_FROM"):
        make(email_from=value)


@pytest.mark.parametrize("value", ["no-reply@example.org", '"Maple, Tower" <no-reply@example.org>'])
def test_email_from_accepts_an_address_with_or_without_a_name(value: str) -> None:
    assert make(email_from=value).email_from == value


def test_smtp_credentials_need_starttls() -> None:
    with pytest.raises(ValidationError, match="SMTP_STARTTLS"):
        make(smtp_username="user", smtp_password="pass", smtp_starttls=False)  # noqa: S106


def test_prod_needs_starttls() -> None:
    with pytest.raises(ValidationError, match="SMTP_STARTTLS"):
        make(app_env="prod", **(DEPLOYED | {"smtp_starttls": False}))
