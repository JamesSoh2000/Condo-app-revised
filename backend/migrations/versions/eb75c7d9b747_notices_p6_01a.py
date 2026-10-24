"""notices (P6-01a): the table, its state checks and the list index

Revision ID: eb75c7d9b747
Revises: 87e4d8b897e7
Create Date: 2026-10-24 02:30:04.937651

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "eb75c7d9b747"
down_revision: str | Sequence[str] | None = "87e4d8b897e7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "notices",
        sa.Column("building_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("body", sa.String(length=10000), nullable=False),
        sa.Column(
            "priority",
            sa.Enum(
                "normal",
                "urgent",
                name="notice_priority",
                native_enum=False,
                create_constraint=False,
            ),
            nullable=False,
        ),
        sa.Column(
            "status",
            sa.Enum(
                "draft",
                "published",
                "archived",
                name="notice_status",
                native_enum=False,
                create_constraint=False,
            ),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attachment_file_id", sa.Uuid(), nullable=True),
        sa.Column("author_membership_id", sa.Uuid(), nullable=False),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("published_by_membership_id", sa.Uuid(), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("archived_by_membership_id", sa.Uuid(), nullable=True),
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
            "btrim(body, E' \\t\\n\\r') <> ''", name=op.f("ck_notices_body_not_blank")
        ),
        sa.CheckConstraint("btrim(title) <> ''", name=op.f("ck_notices_title_not_blank")),
        # Hand-edited: autogenerate rendered each enum check twice (once named just after the enum);
        # the columns' Enums have create_constraint=False, so these named ones are the only checks.
        sa.CheckConstraint(
            "priority IN ('normal', 'urgent')", name=op.f("ck_notices_notice_priority")
        ),
        sa.CheckConstraint(
            "status <> 'archived' OR (archived_at IS NOT NULL"
            " AND archived_by_membership_id IS NOT NULL"
            " AND (published_at IS NULL) = (published_by_membership_id IS NULL))",
            name=op.f("ck_notices_archived_state"),
        ),
        sa.CheckConstraint(
            "status <> 'draft' OR (published_at IS NULL AND published_by_membership_id IS NULL"
            " AND archived_at IS NULL AND archived_by_membership_id IS NULL)",
            name=op.f("ck_notices_draft_state"),
        ),
        sa.CheckConstraint(
            "status <> 'published' OR (published_at IS NOT NULL"
            " AND published_by_membership_id IS NOT NULL"
            " AND archived_at IS NULL AND archived_by_membership_id IS NULL)",
            name=op.f("ck_notices_published_state"),
        ),
        sa.CheckConstraint(
            "status IN ('draft', 'published', 'archived')", name=op.f("ck_notices_notice_status")
        ),
        sa.CheckConstraint(
            "archived_at >= published_at", name=op.f("ck_notices_archived_after_published")
        ),
        sa.CheckConstraint(
            "expires_at > published_at", name=op.f("ck_notices_expires_after_published")
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "archived_by_membership_id"],
            ["building_memberships.building_id", "building_memberships.id"],
            name="fk_notices_building_id_archived_by_membership_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "attachment_file_id"],
            ["files.building_id", "files.id"],
            name="fk_notices_building_id_attachment_file_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "author_membership_id"],
            ["building_memberships.building_id", "building_memberships.id"],
            name="fk_notices_building_id_author_membership_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "published_by_membership_id"],
            ["building_memberships.building_id", "building_memberships.id"],
            name="fk_notices_building_id_published_by_membership_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id"],
            ["buildings.id"],
            name=op.f("fk_notices_building_id_buildings"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_notices")),
        sa.UniqueConstraint("building_id", "id", name=op.f("uq_notices_building_id_id")),
    )
    op.create_index(
        "ix_notices_building_id_status_id",
        "notices",
        ["building_id", "status", sa.literal_column("id DESC")],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_notices_building_id_status_id", table_name="notices")
    op.drop_table("notices")
