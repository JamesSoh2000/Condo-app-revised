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
