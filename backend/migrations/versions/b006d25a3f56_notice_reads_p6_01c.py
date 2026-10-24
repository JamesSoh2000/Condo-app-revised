"""notice_reads: a member's read marker per notice (P6-01c)

Composite FKs keep the notice and the membership in the read's building (ADR-0005); the primary
key `(notice_id, membership_id)` is what `INSERT … ON CONFLICT DO NOTHING` keeps once. Read and
edited after autogenerate: nothing to change beyond the comments.

Revision ID: b006d25a3f56
Revises: eb75c7d9b747
Create Date: 2026-10-24 16:06:48.029223

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b006d25a3f56"
down_revision: str | Sequence[str] | None = "eb75c7d9b747"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "notice_reads",
        sa.Column("notice_id", sa.Uuid(), nullable=False),
        sa.Column("membership_id", sa.Uuid(), nullable=False),
        sa.Column("building_id", sa.Uuid(), nullable=False),
        sa.Column(
            "read_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "membership_id"],
            ["building_memberships.building_id", "building_memberships.id"],
            name=op.f("fk_notice_reads_building_id_membership_id_building_memberships"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "notice_id"],
            ["notices.building_id", "notices.id"],
            name=op.f("fk_notice_reads_building_id_notice_id_notices"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id"],
            ["buildings.id"],
            name=op.f("fk_notice_reads_building_id_buildings"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("notice_id", "membership_id", name=op.f("pk_notice_reads")),
    )


def downgrade() -> None:
    op.drop_table("notice_reads")
