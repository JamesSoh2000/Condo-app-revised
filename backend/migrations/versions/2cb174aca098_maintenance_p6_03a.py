"""maintenance requests and their photos (P6-03a): the tables, state checks and list indexes

Revision ID: 2cb174aca098
Revises: b006d25a3f56
Create Date: 2026-10-25 23:27:16.460638

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "2cb174aca098"
down_revision: str | Sequence[str] | None = "b006d25a3f56"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "maintenance_requests",
        sa.Column("building_id", sa.Uuid(), nullable=False),
        sa.Column("requester_membership_id", sa.Uuid(), nullable=False),
        sa.Column(
            "location",
            sa.Enum(
                "unit",
                "common_area",
                name="maintenance_location",
                native_enum=False,
                create_constraint=False,
            ),
            nullable=False,
        ),
        sa.Column("unit_id", sa.Uuid(), nullable=True),
        sa.Column("common_area", sa.String(length=120), nullable=True),
        sa.Column(
            "category",
            sa.Enum(
                "plumbing",
                "electrical",
                "heating_cooling",
                "appliance",
                "doors_windows",
                "pest_control",
                "other",
                "emergency",
                name="maintenance_category",
                native_enum=False,
                create_constraint=False,
            ),
            nullable=False,
        ),
        sa.Column("description", sa.String(length=2000), nullable=False),
        sa.Column(
            "status",
            sa.Enum(
                "submitted",
                "in_progress",
                "on_hold",
                "resolved",
                "cancelled",
                name="maintenance_status",
                native_enum=False,
                create_constraint=False,
            ),
            nullable=False,
        ),
        sa.Column(
            "submitted_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("started_by_membership_id", sa.Uuid(), nullable=True),
        sa.Column("on_hold_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("on_hold_by_membership_id", sa.Uuid(), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolved_by_membership_id", sa.Uuid(), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancelled_by_membership_id", sa.Uuid(), nullable=True),
        sa.Column("idempotency_key", sa.String(length=80), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "(location <> 'unit' OR (unit_id IS NOT NULL AND common_area IS NULL))"
            " AND (location <> 'common_area' OR (unit_id IS NULL AND common_area IS NOT NULL))",
            name=op.f("ck_maintenance_requests_location_matches"),
        ),
        # Hand-edited: autogenerate rendered each enum check twice (once named just after the enum);
        # the columns' Enums have create_constraint=False, so the named ones below are the only
        # checks.
        sa.CheckConstraint(
            "btrim(common_area, E' \\t\\n\\r') <> ''",
            name=op.f("ck_maintenance_requests_common_area_not_blank"),
        ),
        sa.CheckConstraint(
            "btrim(description, E' \\t\\n\\r') <> ''",
            name=op.f("ck_maintenance_requests_description_not_blank"),
        ),
        sa.CheckConstraint(
            "category IN ('plumbing', 'electrical', 'heating_cooling', 'appliance',"
            " 'doors_windows', 'pest_control', 'other', 'emergency')",
            name=op.f("ck_maintenance_requests_maintenance_category"),
        ),
        sa.CheckConstraint(
            "location IN ('unit', 'common_area')",
            name=op.f("ck_maintenance_requests_maintenance_location"),
        ),
        sa.CheckConstraint(
            "status <> 'cancelled' OR (cancelled_at IS NOT NULL"
            " AND cancelled_by_membership_id IS NOT NULL AND started_at IS NULL"
            " AND started_by_membership_id IS NULL AND on_hold_at IS NULL"
            " AND on_hold_by_membership_id IS NULL AND resolved_at IS NULL"
            " AND resolved_by_membership_id IS NULL)",
            name=op.f("ck_maintenance_requests_cancelled_state"),
        ),
        sa.CheckConstraint(
            "status <> 'in_progress' OR (started_at IS NOT NULL"
            " AND started_by_membership_id IS NOT NULL AND on_hold_at IS NULL"
            " AND on_hold_by_membership_id IS NULL AND resolved_at IS NULL"
            " AND resolved_by_membership_id IS NULL AND cancelled_at IS NULL"
            " AND cancelled_by_membership_id IS NULL)",
            name=op.f("ck_maintenance_requests_in_progress_state"),
        ),
        sa.CheckConstraint(
            "status <> 'on_hold' OR (started_at IS NOT NULL"
            " AND started_by_membership_id IS NOT NULL AND on_hold_at IS NOT NULL"
            " AND on_hold_by_membership_id IS NOT NULL AND resolved_at IS NULL"
            " AND resolved_by_membership_id IS NULL AND cancelled_at IS NULL"
            " AND cancelled_by_membership_id IS NULL)",
            name=op.f("ck_maintenance_requests_on_hold_state"),
        ),
        sa.CheckConstraint(
            "status <> 'resolved' OR (started_at IS NOT NULL"
            " AND started_by_membership_id IS NOT NULL AND resolved_at IS NOT NULL"
            " AND resolved_by_membership_id IS NOT NULL AND on_hold_at IS NULL"
            " AND on_hold_by_membership_id IS NULL AND cancelled_at IS NULL"
            " AND cancelled_by_membership_id IS NULL)",
            name=op.f("ck_maintenance_requests_resolved_state"),
        ),
        sa.CheckConstraint(
            "status <> 'submitted' OR (started_at IS NULL"
            " AND started_by_membership_id IS NULL AND on_hold_at IS NULL"
            " AND on_hold_by_membership_id IS NULL AND resolved_at IS NULL"
            " AND resolved_by_membership_id IS NULL AND cancelled_at IS NULL"
            " AND cancelled_by_membership_id IS NULL)",
            name=op.f("ck_maintenance_requests_submitted_state"),
        ),
        sa.CheckConstraint(
            "status IN ('submitted', 'in_progress', 'on_hold', 'resolved', 'cancelled')",
            name=op.f("ck_maintenance_requests_maintenance_status"),
        ),
        sa.CheckConstraint(
            "cancelled_at >= submitted_at",
            name=op.f("ck_maintenance_requests_cancelled_after_submitted"),
        ),
        sa.CheckConstraint(
            "on_hold_at >= started_at", name=op.f("ck_maintenance_requests_on_hold_after_started")
        ),
        sa.CheckConstraint(
            "resolved_at >= started_at", name=op.f("ck_maintenance_requests_resolved_after_started")
        ),
        sa.CheckConstraint(
            "started_at >= submitted_at",
            name=op.f("ck_maintenance_requests_started_after_submitted"),
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "cancelled_by_membership_id"],
            ["building_memberships.building_id", "building_memberships.id"],
            name="fk_maintenance_requests_building_id_cancelled_by_membership_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "on_hold_by_membership_id"],
            ["building_memberships.building_id", "building_memberships.id"],
            name="fk_maintenance_requests_building_id_on_hold_by_membership_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "requester_membership_id"],
            ["building_memberships.building_id", "building_memberships.id"],
            name="fk_maintenance_requests_building_id_requester_membership_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "resolved_by_membership_id"],
            ["building_memberships.building_id", "building_memberships.id"],
            name="fk_maintenance_requests_building_id_resolved_by_membership_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "started_by_membership_id"],
            ["building_memberships.building_id", "building_memberships.id"],
            name="fk_maintenance_requests_building_id_started_by_membership_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "unit_id"],
            ["units.building_id", "units.id"],
            name="fk_maintenance_requests_building_id_unit_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id"],
            ["buildings.id"],
            name=op.f("fk_maintenance_requests_building_id_buildings"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_maintenance_requests")),
        sa.UniqueConstraint(
            "building_id", "id", name=op.f("uq_maintenance_requests_building_id_id")
        ),
        sa.UniqueConstraint(
            "building_id",
            "idempotency_key",
            name=op.f("uq_maintenance_requests_building_id_idempotency_key"),
        ),
    )
    op.create_index(
        "ix_maintenance_requests_building_id_status_id",
        "maintenance_requests",
        ["building_id", "status", sa.literal_column("id DESC")],
        unique=False,
    )
    op.create_index(
        "ix_maintenance_requests_building_id_unit_id_submitted_at",
        "maintenance_requests",
        ["building_id", "unit_id", sa.literal_column("submitted_at DESC")],
        unique=False,
    )
    op.create_index(
        "ix_maintenance_requests_requester_membership_id",
        "maintenance_requests",
        ["requester_membership_id"],
        unique=False,
    )
    op.create_table(
        "maintenance_request_photos",
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), autoincrement=False, nullable=False),
        sa.Column("building_id", sa.Uuid(), nullable=False),
        sa.Column("file_id", sa.Uuid(), nullable=False),
        sa.CheckConstraint(
            "position BETWEEN 0 AND 4", name=op.f("ck_maintenance_request_photos_position_range")
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "file_id"],
            ["files.building_id", "files.id"],
            name="fk_maintenance_request_photos_building_id_file_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "request_id"],
            ["maintenance_requests.building_id", "maintenance_requests.id"],
            name="fk_maintenance_request_photos_building_id_request_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id"],
            ["buildings.id"],
            name=op.f("fk_maintenance_request_photos_building_id_buildings"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint(
            "request_id", "position", name=op.f("pk_maintenance_request_photos")
        ),
        sa.UniqueConstraint(
            "building_id", "file_id", name=op.f("uq_maintenance_request_photos_building_id_file_id")
        ),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table("maintenance_request_photos")
    op.drop_index(
        "ix_maintenance_requests_requester_membership_id", table_name="maintenance_requests"
    )
    op.drop_index(
        "ix_maintenance_requests_building_id_unit_id_submitted_at",
        table_name="maintenance_requests",
    )
    op.drop_index(
        "ix_maintenance_requests_building_id_status_id", table_name="maintenance_requests"
    )
    op.drop_table("maintenance_requests")
