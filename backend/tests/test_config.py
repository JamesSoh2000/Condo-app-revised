import pytest
from pydantic import ValidationError

from app.core.config import Settings


def test_dev_settings_parse_json_allowed_origins(monkeypatch):
    monkeypatch.setenv("APP_ENV", "dev")
    monkeypatch.setenv(
        "ALLOWED_ORIGINS",
        '["http://localhost:5173","http://127.0.0.1:5173"]',
    )

    settings = Settings(_env_file=None)

    assert settings.app_env == "dev"
    assert settings.allowed_origins == [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]


def test_prod_rejects_localhost_allowed_origins():
    with pytest.raises(ValidationError, match="localhost origins"):
        Settings(
            _env_file=None,
            app_env="prod",
            allowed_origins=["http://localhost:5173"],
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
            allowed_origins=["https://condo.example.org"],
            secret_key="not-the-default-secret",  # noqa: S106 (test fixture, not a real secret)
            s3_bucket_name="condo-app-prod-files",
            ses_from_email="noreply@example.org",
            **{field: "http://localhost:4566"},
        )


def test_prod_accepts_settings_without_s3_endpoints():
    settings = Settings(
        _env_file=None,
        app_env="prod",
        allowed_origins=["https://condo.example.org"],
        secret_key="not-the-default-secret",  # noqa: S106 (test fixture, not a real secret)
        s3_bucket_name="condo-app-prod-files",
        ses_from_email="noreply@example.org",
    )

    assert settings.s3_endpoint_url is None
