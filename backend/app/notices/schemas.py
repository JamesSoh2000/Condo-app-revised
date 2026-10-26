from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from pydantic import (
    AfterValidator,
    AwareDatetime,
    BeforeValidator,
    StringConstraints,
    model_validator,
)
from pydantic.json_schema import SkipJsonSchema
from pydantic_core import PydanticCustomError

from app.core.schemas import APIModel, InputModel
from app.notices.enums import NoticePriority, NoticeStatus
from app.units.schemas import multiline_before_strip, printable_before_strip

# The column lengths (`notices.title` varchar(200), `body` varchar(10000)). Stripped and required:
# `''` would pass the NOT NULLs, and the blank checks only trim spaces (the P6-01a carry). The
# BeforeValidator comes last: it runs first, on the value before the strip (app.units.schemas).
Title = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=200),
    BeforeValidator(printable_before_strip),
]
Body = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=10_000),
    BeforeValidator(multiline_before_strip),
]


def _in_utc(value: datetime) -> datetime:
    """The instant in UTC, as Postgres stores it. A time near datetime's limits can leave its range
    in UTC (`9999-12-31T23:59-01:00`), which asyncpg fails on as a 500 (review round 2, Codex)."""
    try:
        utc = value.astimezone(UTC)
    except OverflowError:
        raise PydanticCustomError(
            "datetime_range", "must be a time between years 1 and 9999 UTC"
        ) from None
    # asyncpg writes `datetime.max` as Postgres `infinity`, which reads back as something else
    # (the P6-01b carry, review round 3).
    if utc == datetime.max.replace(tzinfo=UTC):
        raise PydanticCustomError("datetime_range", "must be before 9999-12-31T23:59:59.999999Z")
    return utc


Expiry = Annotated[AwareDatetime, AfterValidator(_in_utc)]


class NoticeCreate(InputModel):
    title: Title
    body: Body
    priority: NoticePriority = NoticePriority.NORMAL
    # After it, residents no longer see the notice; it must be later than now.
    expires_at: Expiry | None = None
    # A `ready` notice attachment the caller uploaded through the files API (ADR-0007).
    attachment_file_id: UUID | None = None


class NoticeUpdate(InputModel):
    """A draft's new values: only the fields sent change. `expires_at` and `attachment_file_id`
    may be `null` to clear them; the other fields may not."""

    # Optional, never null: SkipJsonSchema keeps the None default out of the OpenAPI schema (review
    # round 1, Codex, as `UnitUpdate`), and the validator below refuses an explicit null.
    title: Title | SkipJsonSchema[None] = None
    body: Body | SkipJsonSchema[None] = None
    priority: NoticePriority | SkipJsonSchema[None] = None
    expires_at: Expiry | None = None
    attachment_file_id: UUID | None = None

    @model_validator(mode="after")
    def _something_to_change(self) -> NoticeUpdate:
        if not self.model_fields_set:
            raise ValueError("send at least one field to change")
        required = {"title", "body", "priority"} & self.model_fields_set
        cleared = sorted(name for name in required if getattr(self, name) is None)
        if cleared:
            raise ValueError(f"{', '.join(cleared)} can't be null")
        return self


class NoticeOut(APIModel):
    id: UUID
    title: str
    body: str
    priority: NoticePriority
    status: NoticeStatus
    expires_at: datetime | None
    # Downloaded through `GET /files/{id}/download-url`, by whoever may see the notice.
    attachment_file_id: UUID | None
    # Its type, so a client can show an image inline and download a PDF (P6-02b); null without one.
    attachment_content_type: str | None
    author_membership_id: UUID
    # Null until published; kept when a published notice is archived.
    published_at: datetime | None
    published_by_membership_id: UUID | None
    archived_at: datetime | None
    archived_by_membership_id: UUID | None
    created_at: datetime
    updated_at: datetime
    # When you marked it read; null if you haven't (P6-01c).
    read_at: datetime | None


class NoticeSummary(APIModel):
    """Your unread live notices in this building, for the badge and the urgent banner."""

    unread: int
    urgent_unread: int
