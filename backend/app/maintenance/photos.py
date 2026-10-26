"""Who may download a maintenance photo: whoever may see its request (ADR-0007, P6-03a).

Importing this module registers the hook; `app.main` imports it, so the server has it from the
start.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.models import File, FilePurpose
from app.files.purposes import register_can_view
from app.maintenance.models import (
    MAINTENANCE_REQUEST_ATTACHED_TYPE,
    MaintenanceRequest,
    MaintenanceRequestPhoto,
)
from app.maintenance.queries import visible_maintenance
from app.tenancy.context import TenantContext


async def can_view_maintenance_photo(ctx: TenantContext, file: File, db: AsyncSession) -> bool:
    """The file is attached to a request the caller may see, and that request lists it as a photo.

    Both sides must agree: the file's `attached_*` and the request's photo row. Any other
    `attached_type` is refused (P6-03d extends this if comments take photos).
    """
    if file.attached_type != MAINTENANCE_REQUEST_ATTACHED_TYPE:
        return False
    listed = (
        select(MaintenanceRequestPhoto.file_id)
        .where(
            MaintenanceRequestPhoto.building_id == MaintenanceRequest.building_id,
            MaintenanceRequestPhoto.request_id == MaintenanceRequest.id,
            MaintenanceRequestPhoto.file_id == file.id,
        )
        .exists()
    )
    shown = visible_maintenance(ctx).where(MaintenanceRequest.id == file.attached_id, listed)
    return bool(await db.scalar(select(shown.exists())))


register_can_view(FilePurpose.MAINTENANCE_PHOTO, can_view_maintenance_photo)
