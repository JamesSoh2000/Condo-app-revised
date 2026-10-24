import unicodedata
from datetime import datetime
from typing import Annotated, Any
from uuid import UUID

from pydantic import AwareDatetime, BeforeValidator, StringConstraints, model_validator
from pydantic.json_schema import SkipJsonSchema
from pydantic_core import PydanticCustomError

from app.core.schemas import APIModel, InputModel
from app.notices.enums import NoticePriority, NoticeStatus
from app.units.schemas import printable_before_strip

# Markdown keeps its line breaks and tab indents; any other control character is refused.
_BODY_CONTROLS = frozenset("\t\n\r")


def _markdown_before_strip(value: Any) -> Any:
    """As `printable_before_strip`, but allowing tabs and line breaks: NUL and the rest of `Cc`
    would fail at flush or hide text (the CLAUDE.md lesson)."""
    if isinstance(value, str) and any(
        unicodedata.category(char) == "Cc" and char not in _BODY_CONTROLS for char in value
    ):
        raise PydanticCustomError("control_characters", "must not contain control characters")
    return value


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
    BeforeValidator(_markdown_before_strip),
]


class NoticeCreate(InputModel):
    title: Title
    body: Body
    priority: NoticePriority = NoticePriority.NORMAL
    # After it, residents no longer see the notice; it must be later than now.
    expires_at: AwareDatetime | None = None
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
    expires_at: AwareDatetime | None = None
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
    author_membership_id: UUID
    # Null until published; kept when a published notice is archived.
    published_at: datetime | None
    published_by_membership_id: UUID | None
    archived_at: datetime | None
    archived_by_membership_id: UUID | None
    created_at: datetime
    updated_at: datetime
