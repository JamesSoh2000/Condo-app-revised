from datetime import datetime
from typing import Annotated, Any
from uuid import UUID

from pydantic import BeforeValidator, StringConstraints

from app.core.schemas import APIModel, InputModel
from app.packages.enums import PackageStatus
from app.units.schemas import printable_before_strip


def _blank_to_none(value: Any) -> Any:
    # Checked first, so a tab or newline is refused rather than taken for blank.
    value = printable_before_strip(value)
    return None if isinstance(value, str) and not value.strip() else value


# The column lengths (`packages.carrier` varchar(50), `description` varchar(200)). The
# BeforeValidator comes last: it runs first, on the value before the strip (app.units.schemas).
Carrier = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=50),
    BeforeValidator(printable_before_strip),
]
Description = Annotated[
    Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)] | None,
    BeforeValidator(_blank_to_none),
]
# The last four characters of a tracking number, as printed on the label.
TrackingLast4 = Annotated[
    str, StringConstraints(strip_whitespace=True, pattern=r"^[A-Za-z0-9]{4}$")
]


class PackageCreate(InputModel):
    unit_id: UUID
    # Optional: a package addressed to the unit is for whoever lives there.
    recipient_membership_id: UUID | None = None
    carrier: Carrier
    description: Description = None
    tracking_last4: TrackingLast4 | None = None
    # A `ready` package photo the caller uploaded through the files API (ADR-0007).
    photo_file_id: UUID | None = None


class PackageOut(APIModel):
    id: UUID
    unit_id: UUID
    recipient_membership_id: UUID | None
    carrier: str
    description: str | None
    tracking_last4: str | None
    photo_file_id: UUID | None
    status: PackageStatus
    received_at: datetime
    received_by_membership_id: UUID
    # Null until the package is picked up or returned (P5-02b).
    picked_up_at: datetime | None
    returned_at: datetime | None


class PackageSummary(APIModel):
    # The caller's visible packages still at the desk (`received`).
    waiting: int
