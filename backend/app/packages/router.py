from typing import Annotated
from uuid import UUID

from fastapi import Depends, Header, Query, Response

from app.buildings.enums import Feature
from app.core.errors import problem_responses
from app.core.pagination import CursorParams, Page
from app.memberships.enums import Role
from app.packages import service
from app.packages.enums import PackageStatus
from app.packages.schemas import (
    Carrier,
    PackageCreate,
    PackageOut,
    PackagePickup,
    PackageReturn,
    PackageSummary,
)
from app.tenancy.deps import Ctx, DbSession, require_feature, require_roles
from app.tenancy.router import building_router

router = building_router(tags=["packages"])
_FEATURE = Depends(require_feature(Feature.PACKAGES))
# The desk: security logs packages (PRODUCT_SCOPE.md), and the manager may too. Reads are open to
# every member; `visible_packages` decides what each one sees.
_DESK = [_FEATURE, Depends(require_roles(Role.SECURITY, Role.PROPERTY_MANAGEMENT))]


@router.post(
    "/packages",
    status_code=201,
    dependencies=_DESK,
    responses=problem_responses(400, 401, 403, 404, 409, 422),
)
async def create(
    ctx: Ctx,
    db: DbSession,
    body: PackageCreate,
    response: Response,
    idempotency_key: Annotated[
        str | None,
        Header(description="8-80 visible ASCII characters; repeat it to retry the same request."),
    ] = None,
) -> PackageOut:
    """Log a package and notify its recipient, or the unit's current occupants.

    A retry with the same `Idempotency-Key` and body answers 201 with the same package and
    `Idempotent-Replayed: true`, writing nothing; the key with another body is 409
    `idempotency_key_reused`.
    """
    created = await service.create_package(db, ctx, body, idempotency_key)
    if created.replayed:
        response.headers["Idempotent-Replayed"] = "true"
    return created.package


@router.get("/packages", dependencies=[_FEATURE], responses=problem_responses(400, 401, 403, 404))
async def list(
    ctx: Ctx,
    db: DbSession,
    params: Annotated[CursorParams, Depends()],
    status: Annotated[
        list[PackageStatus] | None, Query(description="Repeat it to list several statuses.")
    ] = None,
    unit_id: UUID | None = None,
    carrier: Annotated[Carrier | None, Query(description="The carrier, any case.")] = None,
) -> Page[PackageOut]:
    """The packages you may see in this building, newest first."""
    return await service.list_packages(
        db, ctx, params, status=status, unit_id=unit_id, carrier=carrier
    )


@router.get(
    "/packages/summary", dependencies=[_FEATURE], responses=problem_responses(401, 403, 404)
)
async def summary(ctx: Ctx, db: DbSession) -> PackageSummary:
    """How many of the packages you may see are waiting at the desk (for badges)."""
    return await service.package_summary(db, ctx)


@router.get(
    "/packages/{package_id}", dependencies=[_FEATURE], responses=problem_responses(401, 403, 404)
)
async def get(package_id: UUID, ctx: Ctx, db: DbSession) -> PackageOut:
    """One package you may see; anyone else's is a 404."""
    return await service.get_package(db, ctx, package_id)


@router.post(
    "/packages/{package_id}/pickup",
    dependencies=_DESK,
    responses=problem_responses(400, 401, 403, 404, 409, 422),
)
async def pickup(package_id: UUID, ctx: Ctx, db: DbSession, body: PackagePickup) -> PackageOut:
    """Hand a package at the desk out, to a member who may collect it (its recipient, or someone
    who lives in its unit now) or a name typed at the desk; its recipient is told in-app.

    409 `invalid_transition` unless the package is `received`; of two at once, one wins.
    """
    return await service.pickup_package(db, ctx, package_id, body)


@router.post(
    "/packages/{package_id}/return",
    # `return` is a keyword; the name keeps the operation id `packages_return`.
    name="return",
    dependencies=_DESK,
    responses=problem_responses(400, 401, 403, 404, 409, 422),
)
async def return_(package_id: UUID, ctx: Ctx, db: DbSession, body: PackageReturn) -> PackageOut:
    """Send a package at the desk back to the carrier, with a reason.

    409 `invalid_transition` unless the package is `received`; of two at once, one wins.
    """
    return await service.return_package(db, ctx, package_id, body)
