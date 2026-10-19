import re
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import Field, field_validator

from app.core.schemas import APIModel, InputModel
from app.files.models import FilePurpose, FileStatus

# C0 and C1 controls, DEL, and the Unicode line and paragraph separators: none belongs in a
# filename, and P3-04b puts the name in a Content-Disposition header.
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]")


class FileCreate(InputModel):
    """Start an upload. The server picks the key; a body that names one is a 422."""

    purpose: FilePurpose
    filename: str = Field(min_length=1, max_length=255)
    content_type: str = Field(min_length=1, max_length=100)
    size_bytes: int = Field(ge=1)

    # "before": on the raw value, since the inherited whitespace stripping would remove a control
    # character at either end first (review round 1).
    @field_validator("filename", mode="before")
    @classmethod
    def _no_control_characters(cls, value: object) -> object:
        if isinstance(value, str) and _CONTROL.search(value):
            raise ValueError("must not contain control characters")
        return value


class PresignedUpload(APIModel):
    """POST `fields` and then the file (as the last field, named `file`) to `url`."""

    url: str
    fields: dict[str, str]


class FileUploadOut(APIModel):
    file_id: UUID
    upload: PresignedUpload
    # When the form stops working; then create another file.
    expires_at: datetime


class FileOut(APIModel):
    id: UUID
    purpose: FilePurpose
    # Never `deleting`: such a file is not found.
    status: Literal[FileStatus.PENDING, FileStatus.READY]
    content_type: str
    size_bytes: int
    original_name: str
    created_at: datetime


class FileDownloadOut(APIModel):
    # A GET for the file's checked version; it stops working at `expires_at`.
    url: str
    expires_at: datetime
