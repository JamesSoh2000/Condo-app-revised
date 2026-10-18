from uuid import UUID

from app.core.errors import problem_responses
from app.files import service
from app.files.schemas import FileCreate, FileDownloadOut, FileOut, FileUploadOut
from app.tenancy.deps import Ctx, DbSession
from app.tenancy.router import building_router

router = building_router(tags=["files"])


@router.post("/files", status_code=201, responses=problem_responses(401, 403, 404, 422))
async def create(data: FileCreate, ctx: Ctx, db: DbSession) -> FileUploadOut:
    """Start an upload: a presigned POST for exactly this size and type, valid 5 minutes. The
    roles that may upload depend on `purpose`."""
    return await service.create_file(db, ctx, data)


@router.post("/files/{file_id}/complete", responses=problem_responses(401, 404, 409, 422))
async def complete(file_id: UUID, ctx: Ctx, db: DbSession) -> FileOut:
    """After the upload: check the stored object and mark the file `ready`. Uploader only;
    repeating it returns the same file."""
    return await service.complete_file(db, ctx, file_id)


@router.get("/files/{file_id}/download-url", responses=problem_responses(401, 404))
async def download_url(file_id: UUID, ctx: Ctx, db: DbSession) -> FileDownloadOut:
    """A link to a `ready` file, valid 60 seconds. Until the file is attached, only its uploader
    may have one; afterwards, the record it is attached to decides."""
    return await service.download_url(db, ctx, file_id)
