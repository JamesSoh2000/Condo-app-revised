"""packages (P5-01): the table, its state checks and the visibility indexes

Revision ID: 87e4d8b897e7
Revises: 8c7f60239d84
Create Date: 2026-10-22 14:06:46.935727

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "87e4d8b897e7"
down_revision: str | Sequence[str] | None = "8c7f60239d84"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "packages",
        sa.Column("building_id", sa.Uuid(), nullable=False),
        sa.Column("unit_id", sa.Uuid(), nullable=False),
        sa.Column("recipient_membership_id", sa.Uuid(), nullable=True),
        sa.Column("carrier", sa.String(length=50), nullable=False),
        sa.Column("description", sa.String(length=200), nullable=True),
        sa.Column("tracking_last4", sa.String(length=4), nullable=True),
        sa.Column("photo_file_id", sa.Uuid(), nullable=True),
        sa.Column(
            "status",
            sa.Enum(
                "received",
                "picked_up",
                "returned",
                name="package_status",
                native_enum=False,
                create_constraint=False,
            ),
            nullable=False,
        ),
        sa.Column(
            "received_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("received_by_membership_id", sa.Uuid(), nullable=False),
        sa.Column("picked_up_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("picked_up_by_name", sa.String(length=120), nullable=True),
        sa.Column("picked_up_by_membership_id", sa.Uuid(), nullable=True),
        sa.Column("handed_out_by_membership_id", sa.Uuid(), nullable=True),
        sa.Column("returned_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("return_reason", sa.String(length=300), nullable=True),
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
            "status <> 'picked_up' OR (picked_up_at IS NOT NULL"
            " AND handed_out_by_membership_id IS NOT NULL"
            " AND (picked_up_by_membership_id IS NOT NULL OR picked_up_by_name IS NOT NULL)"
            " AND returned_at IS NULL AND return_reason IS NULL)",
            name=op.f("ck_packages_picked_up_state"),
        ),
        sa.CheckConstraint(
            "status <> 'received' OR (picked_up_at IS NULL AND picked_up_by_name IS NULL"
            " AND picked_up_by_membership_id IS NULL AND handed_out_by_membership_id IS NULL"
            " AND returned_at IS NULL AND return_reason IS NULL)",
            name=op.f("ck_packages_received_state"),
        ),
        sa.CheckConstraint(
            "status <> 'returned' OR (returned_at IS NOT NULL AND return_reason IS NOT NULL"
            " AND picked_up_at IS NULL AND picked_up_by_name IS NULL"
            " AND picked_up_by_membership_id IS NULL AND handed_out_by_membership_id IS NULL)",
            name=op.f("ck_packages_returned_state"),
        ),
        # Hand-edited: autogenerate rendered the enum check twice (once named just
        # "package_status"); the column's Enum has create_constraint=False, so no third one.
        sa.CheckConstraint(
            "status IN ('received', 'picked_up', 'returned')",
            name=op.f("ck_packages_package_status"),
        ),
        sa.CheckConstraint(
            "picked_up_at >= received_at", name=op.f("ck_packages_picked_up_after_received")
        ),
        sa.CheckConstraint(
            "returned_at >= received_at", name=op.f("ck_packages_returned_after_received")
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "handed_out_by_membership_id"],
            ["building_memberships.building_id", "building_memberships.id"],
            name="fk_packages_building_id_handed_out_by_membership_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "photo_file_id"],
            ["files.building_id", "files.id"],
            name="fk_packages_building_id_photo_file_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "picked_up_by_membership_id"],
            ["building_memberships.building_id", "building_memberships.id"],
            name="fk_packages_building_id_picked_up_by_membership_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "received_by_membership_id"],
            ["building_memberships.building_id", "building_memberships.id"],
            name="fk_packages_building_id_received_by_membership_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "recipient_membership_id"],
            ["building_memberships.building_id", "building_memberships.id"],
            name="fk_packages_building_id_recipient_membership_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "unit_id"],
            ["units.building_id", "units.id"],
            name="fk_packages_building_id_unit_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id"],
            ["buildings.id"],
            name=op.f("fk_packages_building_id_buildings"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_packages")),
        sa.UniqueConstraint(
            "building_id", "idempotency_key", name=op.f("uq_packages_building_id_idempotency_key")
        ),
    )
    op.create_index(
        "ix_packages_building_id_status_received_at",
        "packages",
        ["building_id", "status", sa.literal_column("received_at DESC")],
        unique=False,
    )
    op.create_index(
        "ix_packages_building_id_unit_id_received_at",
        "packages",
        ["building_id", "unit_id", sa.literal_column("received_at DESC")],
        unique=False,
    )
    op.create_index(
        "ix_packages_recipient_membership_id", "packages", ["recipient_membership_id"], unique=False
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_packages_recipient_membership_id", table_name="packages")
    op.drop_index("ix_packages_building_id_unit_id_received_at", table_name="packages")
    op.drop_index("ix_packages_building_id_status_received_at", table_name="packages")
    op.drop_table("packages")
