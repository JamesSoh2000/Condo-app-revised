"""maintenance comments (P6-03d): the table, its composite FKs, its checks and the thread index

Revision ID: 27ffbfae7d14
Revises: 2cb174aca098
Create Date: 2026-10-29 21:09:21.012264

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "27ffbfae7d14"
down_revision: str | Sequence[str] | None = "2cb174aca098"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "maintenance_comments",
        sa.Column("building_id", sa.Uuid(), nullable=False),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("author_membership_id", sa.Uuid(), nullable=False),
        sa.Column("author_is_staff", sa.Boolean(), nullable=False),
        sa.Column("body", sa.String(length=2000), nullable=False),
        sa.Column("is_internal", sa.Boolean(), server_default=sa.text("false"), nullable=False),
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
            "btrim(body, E' \\t\\n\\r') <> ''", name=op.f("ck_maintenance_comments_body_not_blank")
        ),
        sa.CheckConstraint(
            "NOT is_internal OR author_is_staff",
            name=op.f("ck_maintenance_comments_internal_needs_staff"),
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "author_membership_id"],
            ["building_memberships.building_id", "building_memberships.id"],
            name="fk_maintenance_comments_building_id_author_membership_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "request_id"],
            ["maintenance_requests.building_id", "maintenance_requests.id"],
            name="fk_maintenance_comments_building_id_request_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id"],
            ["buildings.id"],
            name=op.f("fk_maintenance_comments_building_id_buildings"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_maintenance_comments")),
    )
    op.create_index(
        "ix_maintenance_comments_building_id_request_id_id",
        "maintenance_comments",
        ["building_id", "request_id", "id"],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        "ix_maintenance_comments_building_id_request_id_id", table_name="maintenance_comments"
    )
    op.drop_table("maintenance_comments")
