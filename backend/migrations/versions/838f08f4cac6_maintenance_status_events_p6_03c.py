"""maintenance status events (P6-03c): the table, its composite FKs, its checks and the timeline
index

Revision ID: 838f08f4cac6
Revises: 27ffbfae7d14
Create Date: 2026-10-30 02:40:54.650289

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "838f08f4cac6"
down_revision: str | Sequence[str] | None = "27ffbfae7d14"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "maintenance_status_events",
        sa.Column("building_id", sa.Uuid(), nullable=False),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column(
            "from_status",
            sa.Enum(
                "submitted",
                "in_progress",
                "on_hold",
                "resolved",
                "cancelled",
                name="maintenance_from_status",
                native_enum=False,
                create_constraint=False,
            ),
            nullable=False,
        ),
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
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("by_membership_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.CheckConstraint(
            "from_status IN ('submitted', 'in_progress', 'on_hold', 'resolved', 'cancelled')",
            name=op.f("ck_maintenance_status_events_maintenance_from_status"),
        ),
        sa.CheckConstraint(
            "status IN ('submitted', 'in_progress', 'on_hold', 'resolved', 'cancelled')",
            name=op.f("ck_maintenance_status_events_maintenance_status"),
        ),
        sa.CheckConstraint(
            "from_status <> status", name=op.f("ck_maintenance_status_events_status_changes")
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "by_membership_id"],
            ["building_memberships.building_id", "building_memberships.id"],
            name="fk_maintenance_status_events_building_id_by_membership_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "request_id"],
            ["maintenance_requests.building_id", "maintenance_requests.id"],
            name="fk_maintenance_status_events_building_id_request_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id"],
            ["buildings.id"],
            name=op.f("fk_maintenance_status_events_building_id_buildings"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_maintenance_status_events")),
    )
    op.create_index(
        "ix_maintenance_status_events_building_id_request_id_id",
        "maintenance_status_events",
        ["building_id", "request_id", "id"],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        "ix_maintenance_status_events_building_id_request_id_id",
        table_name="maintenance_status_events",
    )
    op.drop_table("maintenance_status_events")
