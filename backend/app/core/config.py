import ipaddress
import re
from datetime import timedelta
from functools import lru_cache
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

AppEnv = Literal["dev", "test", "staging", "prod"]

# Keeps the app bootable locally; validate_production_settings rejects it in staging and production.
LOCAL_DEV_SECRET_KEY = "change-me-in-local-dev-only"  # noqa: S105
# What a browser sends in `Origin`: lowercase scheme://host[:port], no path or trailing slash; host
# labels are letters, digits and inner dashes, with no trailing dot.
_LABEL = r"[a-z0-9]([a-z0-9-]*[a-z0-9])?"
_ORIGIN = re.compile(rf"https?://{_LABEL}(\.{_LABEL})*(:[1-9][0-9]{{0,4}})?")


class RatePolicy(BaseModel):
    """At most `limit` attempts per fixed window of `window_seconds` (P2-05).

    The window is at most a day: `delete_expired_rate_limits` deletes windows older than that.
    As an environment variable it is JSON:
    `RATE_LIMIT_LOGIN_IP='{"limit": 30, "window_seconds": 600}'`.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    limit: int = Field(gt=0)
    window_seconds: int = Field(gt=0, le=24 * 3600)

    @property
    def window(self) -> timedelta:
        return timedelta(seconds=self.window_seconds)


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

    # The origins the app is served from. The CSRF check (P2-01) accepts unsafe requests only from
    # these. Not CORS: the SPA and /api share one origin, so there is no CORS middleware.
    # Example: TRUSTED_ORIGINS=["http://localhost:5173","http://127.0.0.1:5173"]
    trusted_origins: list[str] = [
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

    # The password `seed` gives demo users in staging (P2-01a). Dev and test use the public
    # DevPassword!2026 (README); staging must not, because it is reachable.
    seed_password: SecretStr | None = None

    # Sessions (ADR-0003). The cookie's name and Secure flag default per environment in
    # `_session_cookie_defaults`: `session` on local http, `__Host-session` + Secure when deployed.
    session_cookie_name: str = Field("session", min_length=1)
    session_cookie_secure: bool = False
    session_absolute_days: int = Field(30, gt=0)
    session_idle_resident_days: int = Field(7, gt=0)
    session_idle_staff_hours: int = Field(12, gt=0)

    # Rate limits (P2-05), per client IP (IPv6 per /64) and per hashed email. Login applies its two
    # here; P4-04 applies the reset ones and P4-05 the signup and join ones.
    rate_limit_login_ip: RatePolicy = RatePolicy(limit=30, window_seconds=600)
    rate_limit_login_email: RatePolicy = RatePolicy(limit=8, window_seconds=900)
    rate_limit_reset_ip: RatePolicy = RatePolicy(limit=30, window_seconds=600)
    rate_limit_reset_email: RatePolicy = RatePolicy(limit=8, window_seconds=900)
    rate_limit_signup_ip: RatePolicy = RatePolicy(limit=10, window_seconds=3600)
    rate_limit_join_ip: RatePolicy = RatePolicy(limit=20, window_seconds=600)

    @model_validator(mode="before")
    @classmethod
    def _session_cookie_defaults(cls, data: Any) -> Any:
        if isinstance(data, dict):
            deployed = data.get("app_env", "dev") in {"staging", "prod"}
            data.setdefault("session_cookie_name", "__Host-session" if deployed else "session")
            data.setdefault("session_cookie_secure", deployed)
        return data

    @model_validator(mode="after")
    def validate_production_settings(self) -> Settings:
        """
        Keep local development easy, but prevent obvious unsafe production config.
        """
        # Staging is deployed and reachable, so the checks that keep dev values out apply there too;
        # the rest (https, real AWS endpoints and sender) only in production.
        if self.app_env in {"staging", "prod"}:
            where = "in production" if self.is_production else "in staging"
            if self.secret_key == LOCAL_DEV_SECRET_KEY:
                raise ValueError(f"SECRET_KEY must be changed {where}")

            if not self.trusted_origins or "*" in self.trusted_origins:
                raise ValueError(f"TRUSTED_ORIGINS must be explicit {where}; do not use '*'")

            if any(_is_loopback(origin) for origin in self.trusted_origins):
                raise ValueError(f"TRUSTED_ORIGINS must not use localhost origins {where}")

            if self.s3_bucket_name in {"", "condo-app-dev-files"}:
                raise ValueError(f"S3_BUCKET_NAME must be set to a real bucket {where}")

            if not self.session_cookie_secure or not self.session_cookie_name.startswith("__Host-"):
                raise ValueError(
                    f"SESSION_COOKIE_SECURE must be true and SESSION_COOKIE_NAME start with "
                    f"__Host- {where}"
                )

        if self.is_production:
            if any(not origin.startswith("https://") for origin in self.trusted_origins):
                raise ValueError("TRUSTED_ORIGINS must all be https:// in production")

            if self.s3_endpoint_url is not None or self.s3_public_endpoint_url is not None:
                raise ValueError(
                    "S3_ENDPOINT_URL and S3_PUBLIC_ENDPOINT_URL must not be set in production"
                )

            if self.ses_from_email in {"", "noreply@example.com"}:
                raise ValueError(
                    "SES_FROM_EMAIL must be set to a real verified sender in production"
                )

        malformed = [origin for origin in self.trusted_origins if not _is_origin(origin)]
        if malformed:
            raise ValueError(
                f"TRUSTED_ORIGINS entries must be lowercase scheme://host[:port], with no path or "
                f"trailing slash: {malformed}"
            )

        if self.session_cookie_name.startswith("__Host-") and not self.session_cookie_secure:
            # Browsers drop a __Host- cookie that isn't Secure, so login would silently not stick.
            raise ValueError("a __Host- SESSION_COOKIE_NAME needs SESSION_COOKIE_SECURE=true")

        default_ports = [origin for origin in self.trusted_origins if _has_default_port(origin)]
        if default_ports:
            raise ValueError(
                "TRUSTED_ORIGINS entries must not name the scheme's default port (browsers omit "
                f"it from Origin, so they would never match): {default_ports}"
            )

        return self

    @property
    def is_production(self) -> bool:
        return self.app_env == "prod"


def _is_origin(origin: str) -> bool:
    if not _ORIGIN.fullmatch(origin):
        return False
    try:
        urlsplit(origin).port  # noqa: B018 (raises ValueError above 65535)
    except ValueError:
        return False
    return True


def _has_default_port(origin: str) -> bool:
    parts = urlsplit(origin)
    return parts.port is not None and parts.port == {"http": 80, "https": 443}[parts.scheme]


def _is_loopback(origin: str) -> bool:
    """localhost, *.localhost, 127.0.0.0/8, ::1 or 0.0.0.0, whatever the scheme or port."""
    host = urlsplit(origin).hostname or ""
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_loopback or address.is_unspecified


@lru_cache
def get_settings() -> Settings:
    """
    Cached settings object.

    This avoids reparsing environment variables repeatedly and makes testing
    easier because tests can call get_settings.cache_clear() after monkeypatching env vars.
    """
    return Settings()


settings = get_settings()
