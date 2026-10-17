"""The one way to declare building-scoped routes (ADR-0004, CLAUDE.md rule 1)."""

from enum import Enum

from fastapi import APIRouter, Depends

from app.tenancy.deps import get_tenant_context

BUILDING_PREFIX = "/api/buildings/{building_id}"


def building_router(*, tags: list[str | Enum]) -> APIRouter:
    """A router whose every route sits under the building prefix and depends on
    `get_tenant_context`. Include it in the app without a prefix of its own."""
    return APIRouter(
        prefix=BUILDING_PREFIX, tags=tags, dependencies=[Depends(get_tenant_context)]
    )
