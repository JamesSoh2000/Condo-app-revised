from typing import Any

import pytest
from pydantic import ValidationError

from app.core.config import LOCAL_DEV_SECRET_KEY, Settings


def test_dev_settings_parse_json_trusted_origins(monkeypatch):
    monkeypatch.setenv("APP_ENV", "dev")
    monkeypatch.setenv(
        "TRUSTED_ORIGINS",
        '["http://localhost:5173","http://127.0.0.1:5173"]',
    )

    settings = Settings(_env_file=None)

    assert settings.app_env == "dev"
    assert settings.trusted_origins == [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]


def test_prod_rejects_localhost_trusted_origins():
    with pytest.raises(ValidationError, match="localhost origins"):
        Settings(
            _env_file=None,
            app_env="prod",
            trusted_origins=["http://localhost:5173"],
            secret_key="not-the-default-secret",  # noqa: S106 (test fixture, not a real secret)
            s3_bucket_name="condo-app-prod-files",
            ses_from_email="noreply@example.org",
        )


def test_test_app_env_is_accepted(monkeypatch):
    # CI runs with APP_ENV=test (.github/workflows/ci.yml).
    monkeypatch.setenv("APP_ENV", "test")

    settings = Settings(_env_file=None)

    assert settings.app_env == "test"
    assert settings.is_production is False


def test_aws_region_defaults_to_ca_central_1(monkeypatch):
    monkeypatch.delenv("AWS_REGION", raising=False)

    settings = Settings(_env_file=None)

    assert settings.aws_region == "ca-central-1"


def test_local_service_endpoints_load_from_env(monkeypatch):
    monkeypatch.setenv("SMTP_HOST", "mailpit")
    monkeypatch.setenv("SMTP_PORT", "1025")
    monkeypatch.setenv("S3_ENDPOINT_URL", "http://s3:4566")
    monkeypatch.setenv("S3_PUBLIC_ENDPOINT_URL", "http://localhost:4566")

    settings = Settings(_env_file=None)

    assert settings.smtp_host == "mailpit"
    assert settings.smtp_port == 1025
    assert settings.s3_endpoint_url == "http://s3:4566"
    assert settings.s3_public_endpoint_url == "http://localhost:4566"


def test_s3_endpoints_default_to_real_aws(monkeypatch):
    monkeypatch.delenv("S3_ENDPOINT_URL", raising=False)
    monkeypatch.delenv("S3_PUBLIC_ENDPOINT_URL", raising=False)

    settings = Settings(_env_file=None)

    assert settings.s3_endpoint_url is None
    assert settings.s3_public_endpoint_url is None


@pytest.mark.parametrize("field", ["s3_endpoint_url", "s3_public_endpoint_url"])
def test_prod_rejects_s3_emulator_endpoints(field):
    endpoint: dict[str, Any] = {field: "http://localhost:4566"}
    with pytest.raises(ValidationError, match="must not be set in production"):
        Settings(
            _env_file=None,
            app_env="prod",
            trusted_origins=["https://condo.example.org"],
            secret_key="not-the-default-secret",  # noqa: S106 (test fixture, not a real secret)
            s3_bucket_name="condo-app-prod-files",
            ses_from_email="noreply@example.org",
            **endpoint,
        )


def test_prod_accepts_settings_without_s3_endpoints():
    settings = Settings(
        _env_file=None,
        app_env="prod",
        trusted_origins=["https://condo.example.org"],
        secret_key="not-the-default-secret",  # noqa: S106 (test fixture, not a real secret)
        s3_bucket_name="condo-app-prod-files",
        ses_from_email="noreply@example.org",
        # Required in production since P3-02.
        email_from="Maple Tower <no-reply@example.org>",
        app_base_url="https://condo.example.org",
        smtp_starttls=True,
    )

    assert settings.s3_endpoint_url is None


# Any-valued, so `Settings(**PROD)` type-checks: each key goes to a differently typed field.
PROD: dict[str, Any] = {
    "app_env": "prod",
    "secret_key": "not-the-default-secret",  # (test fixture, not a real secret)
    "s3_bucket_name": "condo-app-prod-files",
    "ses_from_email": "noreply@example.org",
    # Required in production since P3-02.
    "email_from": "Maple Tower <no-reply@example.org>",
    "app_base_url": "https://condo.example.org",
    "smtp_starttls": True,
}


@pytest.mark.parametrize(
    "origin",
    [
        "https://condo.example.org/",
        "https://condo.example.org/app",
        "condo.example.org",
        "https://",
        "ftp://condo.example.org",
        "https://condo.example.org?x=1",
        " https://condo.example.org",
        # Review round 2, F5: a trailing dot, an empty or dash-edged label, a port out of range.
        "https://condo.example.org.",
        "https://localhost.",
        "https://condo..example.org",
        "https://-",
        "https://-condo.example.org",
        "https://condo.example.org:99999",
        "https://condo.example.org:0",
    ],
)
@pytest.mark.parametrize("app_env", ["dev", "prod"])
def test_trusted_origins_must_be_bare_origins_in_every_env(origin, app_env):
    with pytest.raises(ValidationError, match="TRUSTED_ORIGINS"):
        Settings(_env_file=None, **{**PROD, "app_env": app_env}, trusted_origins=[origin])


@pytest.mark.parametrize(
    ("origins", "message"),
    [
        ([], "explicit"),
        (["*"], "explicit"),
        (["http://condo.example.org"], "https"),
        (["https://condo.example.org", "http://127.0.0.1:8080"], "localhost"),
        # Review round 1, F2: loopback is rejected whatever the scheme or port.
        (["https://localhost"], "localhost"),
        (["https://localhost:8443"], "localhost"),
        (["https://127.0.0.1"], "localhost"),
        (["https://127.4.5.6:8443"], "localhost"),
        (["https://0.0.0.0"], "localhost"),
        (["http://localhost"], "localhost"),
        (["https://app.localhost"], "localhost"),
    ],
)
def test_prod_rejects_unsafe_trusted_origins(origins, message):
    with pytest.raises(ValidationError, match=message):
        Settings(_env_file=None, **PROD, trusted_origins=origins)


def test_trusted_origins_accept_ports_in_dev_and_https_in_prod():
    dev = Settings(_env_file=None, trusted_origins=["http://localhost:8080"])
    prod = Settings(_env_file=None, **PROD, trusted_origins=["https://condo.example.org:8443"])

    assert dev.trusted_origins == ["http://localhost:8080"]
    assert prod.trusted_origins == ["https://condo.example.org:8443"]


@pytest.mark.parametrize(
    "origin",
    ["https://localhost.example.org", "https://app.127.example.org", "https://127.example"],
)
def test_prod_accepts_hosts_that_only_look_like_loopback(origin):
    assert Settings(_env_file=None, **PROD, trusted_origins=[origin]).trusted_origins == [origin]


def test_old_allowed_origins_setting_is_gone():
    assert "allowed_origins" not in Settings.model_fields


# P1-06: staging gets the checks that keep dev values out; prod-only checks stay prod-only.
STAGING: dict[str, Any] = {
    "app_env": "staging",
    "secret_key": "not-the-default-secret",  # (test fixture, not a real secret)
    "trusted_origins": ["https://staging.condo.example.org"],
    "s3_bucket_name": "condo-app-staging-files",
}


def test_staging_settings_are_accepted():
    settings = Settings(_env_file=None, **STAGING)

    assert settings.app_env == "staging"
    assert settings.is_production is False


@pytest.mark.parametrize(
    ("override", "message"),
    [
        ({"secret_key": LOCAL_DEV_SECRET_KEY}, "SECRET_KEY must be changed in staging"),
        ({"trusted_origins": []}, "explicit in staging"),
        ({"trusted_origins": ["*"]}, "explicit in staging"),
        ({"trusted_origins": ["http://localhost:5173"]}, "localhost origins in staging"),
        ({"trusted_origins": ["https://127.0.0.1"]}, "localhost origins in staging"),
        ({"s3_bucket_name": "condo-app-dev-files"}, "S3_BUCKET_NAME"),
        ({"s3_bucket_name": ""}, "S3_BUCKET_NAME"),
    ],
)
def test_staging_rejects_dev_values(override, message):
    with pytest.raises(ValidationError, match=message):
        Settings(_env_file=None, **(STAGING | override))


def test_staging_allows_what_only_prod_forbids():
    # http origins, the S3 emulator endpoints and the example sender stay prod-only checks.
    settings = Settings(
        _env_file=None,
        **(
            STAGING
            | {
                "trusted_origins": ["http://staging.condo.example.org"],
                "s3_endpoint_url": "http://s3:4566",
                "ses_from_email": "noreply@example.com",
            }
        ),
    )

    assert settings.s3_endpoint_url == "http://s3:4566"


def test_prod_still_rejects_the_dev_secret_key():
    with pytest.raises(ValidationError, match="SECRET_KEY must be changed in production"):
        Settings(_env_file=None, **(PROD | {"secret_key": LOCAL_DEV_SECRET_KEY}))


# P2-01a criterion 11 (carried from P1-04 round 3 L1): browsers omit a default port from `Origin`,
# so an origin listed with one could never match the CSRF check.


@pytest.mark.parametrize(
    ("origin", "app_env"),
    [
        ("https://condo.example.org:443", "prod"),
        ("http://localhost:80", "dev"),
        ("https://localhost:443", "dev"),
    ],
)
def test_trusted_origins_reject_an_explicit_default_port(origin, app_env):
    with pytest.raises(ValidationError, match="default port"):
        Settings(_env_file=None, **{**PROD, "app_env": app_env}, trusted_origins=[origin])


def test_trusted_origins_accept_non_default_ports():
    settings = Settings(
        _env_file=None, trusted_origins=["http://localhost:8080", "https://x.test:80"]
    )

    assert settings.trusted_origins == ["http://localhost:8080", "https://x.test:80"]


def test_seed_password_is_a_secret_and_unset_by_default(monkeypatch):
    monkeypatch.delenv("SEED_PASSWORD", raising=False)
    assert Settings(_env_file=None).seed_password is None

    monkeypatch.setenv("SEED_PASSWORD", "staging-demo-pass-2026")
    settings = Settings(_env_file=None)

    assert settings.seed_password is not None
    assert settings.seed_password.get_secret_value() == "staging-demo-pass-2026"
    assert "staging-demo-pass-2026" not in repr(settings)


# P2-01b criterion 1: the session cookie's name and Secure flag follow the environment

STAGING = {
    **PROD,
    "app_env": "staging",
    "trusted_origins": ["https://staging.example.org"],
    # Required in staging since P3-02.
    "email_recipient_allowlist": "@example.org",
}


@pytest.mark.parametrize(
    ("values", "name", "secure"),
    [
        ({}, "session", False),
        ({"app_env": "test"}, "session", False),
        (STAGING, "__Host-session", True),
        ({**PROD, "trusted_origins": ["https://condo.example.org"]}, "__Host-session", True),
    ],
    ids=["dev", "test", "staging", "prod"],
)
def test_session_cookie_defaults_follow_the_environment(values, name, secure):
    settings = Settings(_env_file=None, **values)

    assert (settings.session_cookie_name, settings.session_cookie_secure) == (name, secure)
    assert settings.session_absolute_days == 30
    assert settings.session_idle_resident_days == 7
    assert settings.session_idle_staff_hours == 12


def test_session_cookie_settings_load_from_env(monkeypatch):
    monkeypatch.setenv("SESSION_COOKIE_NAME", "__Host-session")
    monkeypatch.setenv("SESSION_COOKIE_SECURE", "true")

    settings = Settings(_env_file=None)

    assert (settings.session_cookie_name, settings.session_cookie_secure) == (
        "__Host-session",
        True,
    )


@pytest.mark.parametrize(
    "override",
    [{"session_cookie_secure": False}, {"session_cookie_name": "session"}],
    ids=["not-secure", "no-host-prefix"],
)
def test_staging_refuses_an_insecure_session_cookie(override):
    with pytest.raises(ValidationError, match="SESSION_COOKIE"):
        Settings(_env_file=None, **STAGING, **override)


def test_host_prefixed_cookie_needs_secure_in_every_env():
    with pytest.raises(ValidationError, match="__Host-"):
        Settings(_env_file=None, session_cookie_name="__Host-session", session_cookie_secure=False)


# P2-01b review round 2 L4


@pytest.mark.parametrize(
    "override",
    [
        {"session_cookie_name": ""},
        {"session_absolute_days": 0},
        {"session_idle_resident_days": -1},
        {"session_idle_staff_hours": 0},
    ],
)
def test_session_settings_must_be_usable(override):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **override)


# P2-07 criterion 5: docs routes are served in dev and test only, unless API_DOCS_ENABLED says so


@pytest.mark.parametrize(
    ("values", "enabled"),
    [
        ({}, True),
        ({"app_env": "test"}, True),
        (STAGING, False),
        ({**PROD, "trusted_origins": ["https://condo.example.org"]}, False),
    ],
    ids=["dev", "test", "staging", "prod"],
)
def test_api_docs_default_follows_the_environment(values, enabled):
    assert Settings(_env_file=None, **values).api_docs_enabled is enabled


@pytest.mark.parametrize(("app_env", "value"), [("prod", "true"), ("dev", "false")])
def test_api_docs_flag_loads_from_env(monkeypatch, app_env, value):
    monkeypatch.setenv("API_DOCS_ENABLED", value)
    values = {**PROD, "trusted_origins": ["https://condo.example.org"], "app_env": app_env}

    assert Settings(_env_file=None, **values).api_docs_enabled is (value == "true")
