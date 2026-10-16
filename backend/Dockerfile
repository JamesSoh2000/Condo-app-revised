# syntax=docker/dockerfile:1

FROM python:3.14-slim

COPY --from=ghcr.io/astral-sh/uv:0.11.17 /uv /uvx /bin/

# The venv lives outside /app: compose bind-mounts ./backend over /app in dev, which would hide a venv
# there (P0-07). UV_PROJECT_ENVIRONMENT points uv's `sync` and `run` at it.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000 \
    WEB_CONCURRENCY=1 \
    FORWARDED_ALLOW_IPS=127.0.0.1 \
    UV_NO_DEV=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH"

WORKDIR /app

RUN addgroup --system app && adduser --system --ingroup app app

COPY pyproject.toml uv.lock ./

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-install-project

COPY --chown=app:app app ./app
# Migrations ship in the image: deploy runs `alembic upgrade head` from it before starting the API (P1-08).
COPY --chown=app:app alembic.ini ./
COPY --chown=app:app migrations ./migrations

# Build metadata, reported by /api/version. Declared last so a new commit doesn't invalidate the cached
# dependency layers above.
ARG GIT_SHA=local IMAGE_TAG=local BUILD_TIME=local
ENV GIT_SHA=$GIT_SHA IMAGE_TAG=$IMAGE_TAG BUILD_TIME=$BUILD_TIME

USER app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os, urllib.request; port = os.getenv('PORT', '8000'); urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health', timeout=3).read()" || exit 1

# One API process (ADR-0008). Forwarded headers (client address, scheme) are trusted only from
# FORWARDED_ALLOW_IPS, the reverse proxy: 127.0.0.1 for host Caddy on staging, Caddy's address in
# compose.prodlike.yml.
CMD ["sh", "-c", "exec gunicorn app.main:app --worker-class uvicorn.workers.UvicornWorker --workers ${WEB_CONCURRENCY:-1} --bind 0.0.0.0:${PORT:-8000} --forwarded-allow-ips \"${FORWARDED_ALLOW_IPS:-127.0.0.1}\" --access-logfile - --error-logfile - --timeout 60"]
