import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.logging_config import configure_logging
from app.middleware.request_logging import RequestLoggingMiddleware

configure_logging()
logger = logging.getLogger("app.lifecycle")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    logger.info("application_started", extra={"environment": settings.app_env})
    yield
    logger.info("application_stopped")


app = FastAPI(
    title=settings.project_name,
    lifespan=lifespan,
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=settings.cors_allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(RequestLoggingMiddleware)

from app.routers import health, version  # noqa: E402

app.include_router(health.router, prefix="/api")
app.include_router(version.router, prefix="/api")
