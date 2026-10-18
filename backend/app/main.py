import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.routing import APIRoute

from app.core.config import settings
from app.core.csrf import CSRFMiddleware
from app.core.errors import install_error_handlers
from app.logging_config import configure_logging
from app.middleware.cache_control import NoStoreMiddleware
from app.middleware.request_logging import RequestLoggingMiddleware

# Every model, so relationships can resolve their targets in the server process (the tests import
# them all anyway; tests/test_app_imports.py checks the app alone).
from app.models import registry as _registry  # noqa: F401

configure_logging()
logger = logging.getLogger("app.lifecycle")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    logger.info("application_started", extra={"environment": settings.app_env})
    yield
    logger.info("application_stopped")


def operation_id(route: APIRoute) -> str:
    """`<first tag>_<function name>` (`packages_create`): stable names for the generated client."""
    if not route.tags:
        raise ValueError(
            f"route {route.name!r} ({route.path}) has no tag; its operation id needs one"
        )
    return f"{route.tags[0]}_{route.name}"


def create_app() -> FastAPI:
    """Build the API: middleware, error handlers, OpenAPI conventions and routers.

    Tests call it to get an app of their own to add test-only routers to.
    """
    app = FastAPI(
        title=settings.project_name,
        lifespan=lifespan,
        # Off in staging and production by default (settings.api_docs_enabled). The schema itself is
        # still built by `app.openapi()`, which `make gen-api` calls.
        docs_url="/api/docs" if settings.api_docs_enabled else None,
        openapi_url="/api/openapi.json" if settings.api_docs_enabled else None,
        redoc_url=None,
        generate_unique_id_function=operation_id,
    )

    # No CORSMiddleware: the SPA and /api share an origin everywhere (ADR-0003), so browsers never
    # make a cross-origin API call. CSRF protection checks settings.trusted_origins.
    # The last added runs first: request logging wraps the CSRF check, so a rejection is logged;
    # no-store wraps both, so the CSRF 403 gets it too.
    app.add_middleware(CSRFMiddleware)
    app.add_middleware(RequestLoggingMiddleware)
    app.add_middleware(NoStoreMiddleware)
    install_error_handlers(app)

    from app.auth import router as auth
    from app.buildings import router as buildings
    from app.files import router as files
    from app.routers import health, version

    app.include_router(auth.router, prefix="/api")
    app.include_router(health.router, prefix="/api")
    app.include_router(version.router, prefix="/api")
    # Building routers carry their full prefix (app/tenancy/router.py).
    app.include_router(buildings.router)
    app.include_router(files.router)
    return app


app = create_app()
