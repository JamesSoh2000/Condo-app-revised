from functools import lru_cache
from typing import Literal

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

AppEnv = Literal["dev", "test", "prod"]

# Keeps the app bootable locally; validate_production_settings rejects it in production.
LOCAL_DEV_SECRET_KEY = "change-me-in-local-dev-only"  # noqa: S105


class Settings(BaseSettings):
    """
    Central application settings.

    This file only loads configuration values.
    It does NOT create database connections, S3 clients, SMTP/SES clients,
    or SNS clients yet.
    """

    model_config = SettingsConfigDict(
        env_file=(".env", "backend/.env"),
        extra="ignore",
    )

    # App
    app_env: AppEnv = "dev"
    log_level: str = "INFO"
    service_name: str = "condo-management-api"
    project_name: str = "Building Management API"

    # Security
    # Local default keeps the app bootable before real secrets are configured.
    # Production must override this.
    secret_key: str = LOCAL_DEV_SECRET_KEY

    # CORS
    # Example: ALLOWED_ORIGINS=["http://localhost:5173","http://127.0.0.1:5173"]
    allowed_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]

    # Database config only. Do not connect yet.
    database_url: str = "postgresql+asyncpg://postgres:devpassword@db:5432/condo_dev"
    # Used by the test suite only. Its schema is dropped and rebuilt on every test session.
    test_database_url: str = "postgresql+asyncpg://postgres:devpassword@127.0.0.1:5432/condo_test"

    # AWS config only. Do not create AWS clients yet.
    aws_region: str = "ca-central-1"
    s3_bucket_name: str = "condo-app-dev-files"
    # Only set for the local S3 emulator (ADR-0007): the API reaches it at the container-internal
    # URL, and presigned URLs use the public one so the browser can reach them. Unset = real AWS S3.
    s3_endpoint_url: str | None = None
    s3_public_endpoint_url: str | None = None
    ses_from_email: str = "noreply@example.com"

    # SMTP config only (Mailpit locally). Do not connect yet; P3-02 adds the sender.
    smtp_host: str = "localhost"
    smtp_port: int = 1025

    # Build/deployment metadata
    git_sha: str = "local"
    image_tag: str = "local"
    build_time: str = "local"

    readiness_check_database: bool = False

    @model_validator(mode="after")
    def validate_production_settings(self) -> "Settings":
        """
        Keep local development easy, but prevent obvious unsafe production config.
        """
        if self.is_production:
            if self.secret_key == LOCAL_DEV_SECRET_KEY:
                raise ValueError("SECRET_KEY must be changed in production")

            if not self.allowed_origins or "*" in self.allowed_origins:
                raise ValueError("ALLOWED_ORIGINS must be explicit in production; do not use '*'")

            if any(
                origin.startswith(("http://localhost", "http://127.0.0.1"))
                for origin in self.allowed_origins
            ):
                raise ValueError("ALLOWED_ORIGINS must not use localhost origins in production")

            if self.s3_bucket_name in {"", "condo-app-dev-files"}:
                raise ValueError("S3_BUCKET_NAME must be set to a production bucket in production")

            if self.s3_endpoint_url is not None or self.s3_public_endpoint_url is not None:
                raise ValueError(
                    "S3_ENDPOINT_URL and S3_PUBLIC_ENDPOINT_URL must not be set in production"
                )

            if self.ses_from_email in {"", "noreply@example.com"}:
                raise ValueError(
                    "SES_FROM_EMAIL must be set to a real verified sender in production"
                )

        return self

    @property
    def is_production(self) -> bool:
        return self.app_env == "prod"

    @property
    def cors_allow_credentials(self) -> bool:
        """
        FastAPI/Starlette should not use allow_credentials=True with wildcard origins.
        """
        return "*" not in self.allowed_origins


@lru_cache
def get_settings() -> Settings:
    """
    Cached settings object.

    This avoids reparsing environment variables repeatedly and makes testing
    easier because tests can call get_settings.cache_clear() after monkeypatching env vars.
    """
    return Settings()


settings = get_settings()
