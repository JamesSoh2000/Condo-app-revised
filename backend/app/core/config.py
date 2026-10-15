from functools import lru_cache
from typing import Literal

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


AppEnv = Literal["dev", "test", "prod"]


class Settings(BaseSettings):
    """
    Central application settings.

    This file only loads configuration values.
    It does NOT create database connections, Redis clients, S3 clients,
    SES clients, or SNS clients yet.
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
    secret_key: str = "change-me-in-local-dev-only"

    # CORS
    # Example: ALLOWED_ORIGINS=["http://localhost:5173","http://127.0.0.1:5173"]
    allowed_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]

    # Database config only. Do not connect yet.
    database_url: str = "postgresql+asyncpg://postgres:devpassword@db:5432/condo_dev"

    # Redis config only. Do not connect yet.
    redis_url: str = "redis://localhost:6379/0"

    # AWS config only. Do not create AWS clients yet.
    aws_region: str = "us-east-1"
    s3_bucket_name: str = "condo-app-dev-files"
    ses_from_email: str = "noreply@example.com"

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
            if self.secret_key == "change-me-in-local-dev-only":
                raise ValueError("SECRET_KEY must be changed in production")

            if not self.allowed_origins or "*" in self.allowed_origins:
                raise ValueError("ALLOWED_ORIGINS must be explicit in production; do not use '*'")

            if any(origin.startswith(("http://localhost", "http://127.0.0.1")) for origin in self.allowed_origins):
                raise ValueError("ALLOWED_ORIGINS must not use localhost origins in production")

            if self.s3_bucket_name in {"", "condo-app-dev-files"}:
                raise ValueError("S3_BUCKET_NAME must be set to a production bucket in production")

            if self.ses_from_email in {"", "noreply@example.com"}:
                raise ValueError("SES_FROM_EMAIL must be set to a real verified sender in production")

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
