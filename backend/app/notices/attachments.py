"""Who may download a notice's attachment: whoever may see its notice (ADR-0007, P6-01a).

Importing this module registers the hook; `app.main` imports it, so the server has it from the
start.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.models import File, FilePurpose
from app.files.purposes import register_can_view
from app.notices.models import NOTICE_ATTACHED_TYPE, Notice
from app.notices.queries import visible_notices
from app.tenancy.context import TenantContext


async def can_view_notice_attachment(ctx: TenantContext, file: File, db: AsyncSession) -> bool:
    """The file is attached to a notice the caller may see, and is that notice's attachment."""
    if file.attached_type != NOTICE_ATTACHED_TYPE:
        return False
    shown = visible_notices(ctx).where(
        Notice.id == file.attached_id, Notice.attachment_file_id == file.id
    )
    return bool(await db.scalar(select(shown.exists())))


register_can_view(FilePurpose.NOTICE_ATTACHMENT, can_view_notice_attachment)
