import pytest
from pydantic import ValidationError

from app.core.config import Settings


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
    with pytest.raises(ValidationError, match="must not be set in production"):
        Settings(
            _env_file=None,
            app_env="prod",
            trusted_origins=["https://condo.example.org"],
            secret_key="not-the-default-secret",  # noqa: S106 (test fixture, not a real secret)
            s3_bucket_name="condo-app-prod-files",
            ses_from_email="noreply@example.org",
            **{field: "http://localhost:4566"},
        )


def test_prod_accepts_settings_without_s3_endpoints():
    settings = Settings(
        _env_file=None,
        app_env="prod",
        trusted_origins=["https://condo.example.org"],
        secret_key="not-the-default-secret",  # noqa: S106 (test fixture, not a real secret)
        s3_bucket_name="condo-app-prod-files",
        ses_from_email="noreply@example.org",
    )

    assert settings.s3_endpoint_url is None


PROD = {
    "app_env": "prod",
    "secret_key": "not-the-default-secret",  # (test fixture, not a real secret)
    "s3_bucket_name": "condo-app-prod-files",
    "ses_from_email": "noreply@example.org",
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
