from datetime import datetime
from typing import Annotated
from uuid import UUID

from pydantic import AfterValidator, BeforeValidator, Field, StringConstraints, model_validator
from pydantic_core import PydanticCustomError

from app.core.schemas import APIModel, InputModel
from app.maintenance.enums import MaintenanceCategory, MaintenanceLocation, MaintenanceStatus
from app.maintenance.models import MAX_PHOTOS
from app.units.schemas import multiline_before_strip, printable_before_strip

# The column lengths (`maintenance_requests.description` varchar(2000), `common_area` varchar(120)).
# Stripped and required: `''` would pass the NOT NULLs (the P5-01 carry). The BeforeValidator comes
# last: it runs first, on the value before the strip (app.units.schemas).
Description = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=2000),
    BeforeValidator(multiline_before_strip),
]
# `maintenance_comments.body` varchar(2000) (P6-03d D6): as a description.
CommentBody = Description
CommonArea = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=120),
    BeforeValidator(printable_before_strip),
]


def _distinct(ids: list[UUID]) -> list[UUID]:
    if len(set(ids)) != len(ids):
        raise PydanticCustomError("duplicate_photo", "each photo may be listed once")
    return ids


PhotoFileIds = Annotated[list[UUID], Field(max_length=MAX_PHOTOS), AfterValidator(_distinct)]


class MaintenanceRequestCreate(InputModel):
    location: MaintenanceLocation
    # Required iff `location = unit`: a unit the caller lives in now.
    unit_id: UUID | None = None
    # Required iff `location = common_area` ("Lobby", "Garage level 2").
    common_area: CommonArea | None = None
    category: MaintenanceCategory
    description: Description
    # `ready` maintenance photos the caller uploaded through the files API (ADR-0007), in order.
    photo_file_ids: PhotoFileIds = Field(default_factory=list)

    @model_validator(mode="after")
    def _location_shape(self) -> MaintenanceRequestCreate:
        # The schema's answer for `ck_maintenance_requests_location_matches`, never its 500.
        if self.location == MaintenanceLocation.UNIT:
            if self.unit_id is None or self.common_area is not None:
                raise ValueError("a unit request needs unit_id and no common_area")
        elif self.common_area is None or self.unit_id is not None:
            raise ValueError("a common-area request needs common_area and no unit_id")
        return self


class MaintenanceRequestColumns(APIModel):
    """A request's own columns, read from its row; `MaintenanceRequestOut` adds what other rows
    say. The idempotency columns stay out."""

    id: UUID
    requester_membership_id: UUID
    location: MaintenanceLocation
    unit_id: UUID | None
    common_area: str | None
    category: MaintenanceCategory
    description: str
    status: MaintenanceStatus
    submitted_at: datetime
    started_at: datetime | None
    on_hold_at: datetime | None
    resolved_at: datetime | None
    cancelled_at: datetime | None


class MaintenanceRequestOut(MaintenanceRequestColumns):
    # Each downloads through `GET /files/{id}/download-url`.
    photo_file_ids: list[UUID]
    # The unit's current tower and label; null for a common-area request.
    unit_tower: str | None
    unit_label: str | None
    requester_name: str | None = Field(
        description=(
            "The requester's current full name, for security and property management only; null "
            "for every other caller."
        )
    )
    emergency_phone: str | None = Field(
        description=(
            "The building's emergency phone on an `emergency` request; null for every other "
            "category, or if the building has none. Call it: the app alerts no one."
        )
    )


class MaintenanceStatusEventOut(APIModel):
    """One manager move (P6-03c), for the request's timeline (P6-04c). `from_status` tells a first
    start, a resume and a reopen apart. Who moved it stays out: no caller is shown it."""

    id: UUID
    request_id: UUID
    from_status: MaintenanceStatus
    status: MaintenanceStatus
    at: datetime


class MaintenanceCommentCreate(InputModel):
    body: CommentBody
    # Staff only (D1); a resident's `true` is 403 `internal_comment_forbidden`, never made public.
    internal: bool = False


class MaintenanceCommentOut(APIModel):
    id: UUID
    request_id: UUID
    body: str
    is_internal: bool
    created_at: datetime
    author_name: str | None = Field(
        description=(
            "The author's current full name, for security, property management and the author "
            "only; null for every other caller."
        )
    )
    author_is_staff: bool = Field(
        description=(
            'Whether the author wrote as security or property management (show "Building '
            'management" when `author_name` is null).'
        )
    )
