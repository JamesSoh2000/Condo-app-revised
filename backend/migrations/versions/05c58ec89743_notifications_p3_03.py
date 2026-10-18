"""notifications (P3-03): one in-app row per recipient, for `notify` and the notification routes

Revision ID: 05c58ec89743
Revises: 478316869a1a
Create Date: 2026-10-18 16:09:03.397908

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "05c58ec89743"
down_revision: str | Sequence[str] | None = "478316869a1a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "notifications",
        sa.Column("building_id", sa.Uuid(), nullable=False),
        sa.Column("recipient_user_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=64), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("body", sa.String(length=1000), nullable=False),
        sa.Column("link", sa.String(length=300), nullable=True),
        sa.Column("entity_type", sa.String(length=40), nullable=True),
        sa.Column("entity_id", sa.Uuid(), nullable=True),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.ForeignKeyConstraint(
            ["building_id", "recipient_user_id"],
            ["building_memberships.building_id", "building_memberships.user_id"],
            name="fk_notifications_building_id_recipient_user_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id"],
            ["buildings.id"],
            name=op.f("fk_notifications_building_id_buildings"),
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint(
            "(entity_type IS NULL) = (entity_id IS NULL)",
            name=op.f("ck_notifications_entity_complete"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_notifications")),
    )
    # id DESC: the list's order (newest first, uuid7).
    op.create_index(
        "ix_notifications_recipient_user_id_building_id_read_at_id",
        "notifications",
        ["recipient_user_id", "building_id", "read_at", sa.literal_column("id DESC")],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        "ix_notifications_recipient_user_id_building_id_read_at_id", table_name="notifications"
    )
    op.drop_table("notifications")
