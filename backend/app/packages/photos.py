"""Who may download a package photo: whoever may see its package (ADR-0007, P5-01).

Importing this module registers the hook; `app.main` imports it, so the server has it from the
start.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.models import File, FilePurpose
from app.files.purposes import register_can_view
from app.packages.models import PACKAGE_ATTACHED_TYPE, Package
from app.packages.queries import visible_packages
from app.tenancy.context import TenantContext


async def can_view_package_photo(ctx: TenantContext, file: File, db: AsyncSession) -> bool:
    """The file is attached to a package the caller may see, and is that package's photo."""
    if file.attached_type != PACKAGE_ATTACHED_TYPE:
        return False
    shown = visible_packages(ctx).where(
        Package.id == file.attached_id, Package.photo_file_id == file.id
    )
    return bool(await db.scalar(select(shown.exists())))


register_can_view(FilePurpose.PACKAGE_PHOTO, can_view_package_photo)
