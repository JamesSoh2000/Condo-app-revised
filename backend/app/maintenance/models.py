from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.maintenance.enums import MaintenanceCategory, MaintenanceLocation, MaintenanceStatus
from app.memberships.occupancy import register_unit_record
from app.models.base import Base
from app.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin
from app.models.types import database_enum

# The `attached_type` of a request's photo (`app.files.service.claim_file`,
# `app.maintenance.photos`).
MAINTENANCE_REQUEST_ATTACHED_TYPE = "maintenance_request"
# The `entity_type` of a comment's notifications. Comments take no photos (P6-03d D3): the photo
# hook refuses any `attached_type` but the request's.
MAINTENANCE_COMMENT_ENTITY_TYPE = "maintenance_comment"
# Photos per request: `maintenance_request_photos.position` runs 0 to MAX_PHOTOS - 1 (P6-03a D5).
MAX_PHOTOS = 5

_STARTED = ("started_at", "started_by_membership_id")
_ON_HOLD = ("on_hold_at", "on_hold_by_membership_id")
_RESOLVED = ("resolved_at", "resolved_by_membership_id")
_CANCELLED = ("cancelled_at", "cancelled_by_membership_id")
# Each status's own columns (ADR-0020); every other status column is NULL.
_OWN: dict[MaintenanceStatus, tuple[str, ...]] = {
    MaintenanceStatus.SUBMITTED: (),
    MaintenanceStatus.IN_PROGRESS: _STARTED,
    MaintenanceStatus.ON_HOLD: _STARTED + _ON_HOLD,
    MaintenanceStatus.RESOLVED: _STARTED + _RESOLVED,
    MaintenanceStatus.CANCELLED: _CANCELLED,
}


def _state_check(status: MaintenanceStatus) -> CheckConstraint:
    own = _OWN[status]
    others = [c for c in _STARTED + _ON_HOLD + _RESOLVED + _CANCELLED if c not in own]
    tests = [f"{c} IS NOT NULL" for c in own] + [f"{c} IS NULL" for c in others]
    return CheckConstraint(
        f"status <> '{status}' OR ({' AND '.join(tests)})", name=f"{status}_state"
    )


def _composite_fk(column: str, table: str) -> ForeignKeyConstraint:
    # Composite, so the referenced row is in the request's building (ADR-0005). RESTRICT: requests
    # are history, so what they name isn't deleted.
    return ForeignKeyConstraint(
        ["building_id", column],
        [f"{table}.building_id", f"{table}.id"],
        ondelete="RESTRICT",
        name=f"fk_maintenance_requests_building_id_{column}",
    )


class MaintenanceRequest(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A repair a member asked for, in a unit or a common area (P6-03a). Read it through
    `visible_maintenance(ctx)`.

    The row is the request's current state (ADR-0020): each status has its own columns and no other
    status's (the checks below). `started_*` is the first start, kept through hold, resolve and
    reopen; leaving `on_hold` or `resolved` clears its columns. The history of status changes is
    P6-03c's status events. `app.maintenance.state` says which status may follow which.
    """

    __tablename__ = "maintenance_requests"
    __table_args__ = (
        _composite_fk("requester_membership_id", "building_memberships"),
        _composite_fk("unit_id", "units"),
        _composite_fk("started_by_membership_id", "building_memberships"),
        _composite_fk("on_hold_by_membership_id", "building_memberships"),
        _composite_fk("resolved_by_membership_id", "building_memberships"),
        _composite_fk("cancelled_by_membership_id", "building_memberships"),
        # The target of the photos' (and P6-03d's comments') composite FK (ADR-0005).
        UniqueConstraint("building_id", "id"),
        # P6-03b's `POST /maintenance-requests`: one request per Idempotency-Key in a building.
        UniqueConstraint("building_id", "idempotency_key"),
        CheckConstraint(
            "(location <> 'unit' OR (unit_id IS NOT NULL AND common_area IS NULL))"
            " AND (location <> 'common_area' OR (unit_id IS NULL AND common_area IS NOT NULL))",
            name="location_matches",
        ),
        *(_state_check(status) for status in MaintenanceStatus),
        # on_hold_at and resolved_at need started_at (the state checks), so they also follow
        # submitted_at.
        CheckConstraint("started_at >= submitted_at", name="started_after_submitted"),
        CheckConstraint("on_hold_at >= started_at", name="on_hold_after_started"),
        CheckConstraint("resolved_at >= started_at", name="resolved_after_started"),
        CheckConstraint("cancelled_at >= submitted_at", name="cancelled_after_submitted"),
        # The API strips its strings, so `''` would otherwise pass the NOT NULLs (the P5-01 carry);
        # a description keeps its newlines, so those count as blank too.
        CheckConstraint("btrim(description, E' \\t\\n\\r') <> ''", name="description_not_blank"),
        CheckConstraint("btrim(common_area, E' \\t\\n\\r') <> ''", name="common_area_not_blank"),
        # The manager's list by status, newest first: `paginate` orders by id (P6-03b).
        Index(
            "ix_maintenance_requests_building_id_status_id",
            "building_id",
            "status",
            text("id DESC"),
        ),
        # A unit's requests by time, for the occupancy clause.
        Index(
            "ix_maintenance_requests_building_id_unit_id_submitted_at",
            "building_id",
            "unit_id",
            text("submitted_at DESC"),
        ),
        # visible_maintenance(): a resident's own requests.
        Index("ix_maintenance_requests_requester_membership_id", "requester_membership_id"),
    )

    building_id: Mapped[UUID] = mapped_column(ForeignKey("buildings.id", ondelete="RESTRICT"))
    requester_membership_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True))
    location: Mapped[MaintenanceLocation] = mapped_column(
        database_enum(MaintenanceLocation, name="maintenance_location")
    )
    unit_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True))
    # Free text ("Lobby", "Garage level 2"), ADR-0020.
    common_area: Mapped[str | None] = mapped_column(String(120))
    category: Mapped[MaintenanceCategory] = mapped_column(
        database_enum(MaintenanceCategory, name="maintenance_category")
    )
    description: Mapped[str] = mapped_column(String(2000))
    status: Mapped[MaintenanceStatus] = mapped_column(
        database_enum(MaintenanceStatus, name="maintenance_status")
    )
    # timestamptz, like the occupancy window it is compared with (P1-03 review round 5).
    submitted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_by_membership_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True))
    on_hold_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    on_hold_by_membership_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_by_membership_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_by_membership_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True))
    idempotency_key: Mapped[str] = mapped_column(String(80))
    # sha256 of the create request's canonical body (P6-03b), hex.
    request_hash: Mapped[str] = mapped_column(String(64))


# The record fence (ADR-0021): an occupancy write that began before a request of its unit was
# submitted is refused. Here, not in a module the server imports, so scripts and tests have it too.
register_unit_record(
    MaintenanceRequest.building_id, MaintenanceRequest.unit_id, MaintenanceRequest.submitted_at
)


class MaintenanceRequestPhoto(Base):
    """One photo of a request, in order (P6-03a D5). The file is also attached to the request
    (`files.attached_*`); `app.maintenance.photos` grants it only when both agree."""

    __tablename__ = "maintenance_request_photos"
    __table_args__ = (
        ForeignKeyConstraint(
            ["building_id", "request_id"],
            ["maintenance_requests.building_id", "maintenance_requests.id"],
            ondelete="RESTRICT",
            name="fk_maintenance_request_photos_building_id_request_id",
        ),
        ForeignKeyConstraint(
            ["building_id", "file_id"],
            ["files.building_id", "files.id"],
            ondelete="RESTRICT",
            name="fk_maintenance_request_photos_building_id_file_id",
        ),
        # A file is the photo of one request.
        UniqueConstraint("building_id", "file_id"),
        # With the primary key, the database caps a request's photos at MAX_PHOTOS.
        CheckConstraint(f"position BETWEEN 0 AND {MAX_PHOTOS - 1}", name="position_range"),
    )

    request_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    building_id: Mapped[UUID] = mapped_column(ForeignKey("buildings.id", ondelete="RESTRICT"))
    file_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True))


class MaintenanceComment(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A member's comment on a request (P6-03d). Read it through
    `visible_maintenance_comments(ctx)`: an internal one is for staff only, and no comment is seen
    without its request."""

    __tablename__ = "maintenance_comments"
    __table_args__ = (
        ForeignKeyConstraint(
            ["building_id", "request_id"],
            ["maintenance_requests.building_id", "maintenance_requests.id"],
            ondelete="RESTRICT",
            name="fk_maintenance_comments_building_id_request_id",
        ),
        ForeignKeyConstraint(
            ["building_id", "author_membership_id"],
            ["building_memberships.building_id", "building_memberships.id"],
            ondelete="RESTRICT",
            name="fk_maintenance_comments_building_id_author_membership_id",
        ),
        # As `description_not_blank`: the API strips, and a body keeps its newlines.
        CheckConstraint("btrim(body, E' \\t\\n\\r') <> ''", name="body_not_blank"),
        # Only staff write internal comments (D1); the service refuses a resident's with a 403.
        CheckConstraint("NOT is_internal OR author_is_staff", name="internal_needs_staff"),
        # A request's thread in order: `paginate` orders by id (uuid7, D8).
        Index(
            "ix_maintenance_comments_building_id_request_id_id", "building_id", "request_id", "id"
        ),
    )

    building_id: Mapped[UUID] = mapped_column(ForeignKey("buildings.id", ondelete="RESTRICT"))
    request_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True))
    author_membership_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True))
    # Whether the author held security or property management here when writing (D7), so the
    # label shown to residents doesn't change with later role changes.
    author_is_staff: Mapped[bool] = mapped_column(Boolean)
    body: Mapped[str] = mapped_column(String(2000))
    is_internal: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
