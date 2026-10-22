from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin
from app.models.types import database_enum
from app.packages.enums import PackageStatus

# `attached_type` of a package's photo (`app.files.service.claim_file`); `app.packages.photos` reads it.
PACKAGE_ATTACHED_TYPE = "package"

_PICKUP_COLUMNS = (
    "picked_up_at",
    "picked_up_by_name",
    "picked_up_by_membership_id",
    "handed_out_by_membership_id",
)
_RETURN_COLUMNS = ("returned_at", "return_reason")


def _null(columns: tuple[str, ...]) -> str:
    return " AND ".join(f"{column} IS NULL" for column in columns)


def _composite_fk(column: str, table: str) -> ForeignKeyConstraint:
    # Composite, so the referenced row is in the package's building (ADR-0005). RESTRICT: packages
    # are history, so what they name isn't deleted.
    return ForeignKeyConstraint(
        ["building_id", column],
        [f"{table}.building_id", f"{table}.id"],
        ondelete="RESTRICT",
        name=f"fk_packages_building_id_{column}",
    )


class Package(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A parcel logged at the desk for a unit (P5-01). Read it through `visible_packages(ctx)`.

    Each status's columns belong to it alone: a `received` row has no pickup or return columns, and
    so on (the checks below). `app.packages.state` says which status may follow which.
    """

    __tablename__ = "packages"
    __table_args__ = (
        _composite_fk("unit_id", "units"),
        _composite_fk("recipient_membership_id", "building_memberships"),
        _composite_fk("received_by_membership_id", "building_memberships"),
        _composite_fk("picked_up_by_membership_id", "building_memberships"),
        _composite_fk("handed_out_by_membership_id", "building_memberships"),
        _composite_fk("photo_file_id", "files"),
        # P5-02a's `POST /packages`: one package per Idempotency-Key in a building.
        UniqueConstraint("building_id", "idempotency_key"),
        CheckConstraint(
            f"status <> 'received' OR ({_null(_PICKUP_COLUMNS + _RETURN_COLUMNS)})",
            name="received_state",
        ),
        CheckConstraint(
            "status <> 'picked_up' OR (picked_up_at IS NOT NULL"
            " AND handed_out_by_membership_id IS NOT NULL"
            " AND (picked_up_by_membership_id IS NOT NULL OR picked_up_by_name IS NOT NULL)"
            f" AND {_null(_RETURN_COLUMNS)})",
            name="picked_up_state",
        ),
        CheckConstraint(
            "status <> 'returned' OR (returned_at IS NOT NULL AND return_reason IS NOT NULL"
            f" AND {_null(_PICKUP_COLUMNS)})",
            name="returned_state",
        ),
        CheckConstraint("picked_up_at >= received_at", name="picked_up_after_received"),
        CheckConstraint("returned_at >= received_at", name="returned_after_received"),
        # The desk's list by status, newest first, and a unit's packages (P5-02a).
        Index(
            "ix_packages_building_id_status_received_at",
            "building_id",
            "status",
            text("received_at DESC"),
        ),
        Index(
            "ix_packages_building_id_unit_id_received_at",
            "building_id",
            "unit_id",
            text("received_at DESC"),
        ),
        # visible_packages(): a resident's packages by name.
        Index("ix_packages_recipient_membership_id", "recipient_membership_id"),
    )

    building_id: Mapped[UUID] = mapped_column(ForeignKey("buildings.id", ondelete="RESTRICT"))
    unit_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True))
    # Optional: a package addressed to the unit is for whoever lived there when it arrived.
    recipient_membership_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True))
    carrier: Mapped[str] = mapped_column(String(50))
    description: Mapped[str | None] = mapped_column(String(200))
    tracking_last4: Mapped[str | None] = mapped_column(String(4))
    photo_file_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True))
    status: Mapped[PackageStatus] = mapped_column(
        database_enum(PackageStatus, name="package_status")
    )
    # timestamptz, like the occupancy window it is compared with: a naive time would be read in the
    # session's time zone and move the window (P1-03 review round 5).
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    received_by_membership_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True))
    picked_up_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Who collected it: a member, or a name typed at the desk (a neighbour, a courier).
    picked_up_by_name: Mapped[str | None] = mapped_column(String(120))
    picked_up_by_membership_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True))
    handed_out_by_membership_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True))
    returned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    return_reason: Mapped[str | None] = mapped_column(String(300))
    idempotency_key: Mapped[str] = mapped_column(String(80))
    # sha256 of the create request's canonical body (P5-02a), hex.
    request_hash: Mapped[str] = mapped_column(String(64))
