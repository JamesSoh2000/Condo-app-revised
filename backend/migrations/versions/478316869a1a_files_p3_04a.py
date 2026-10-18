"""files (P3-04a): the server-owned registry of private uploads (ADR-0007)

Revision ID: 478316869a1a
Revises: 6155f8860fc1
Create Date: 2026-10-18 01:46:45.106749

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "478316869a1a"
down_revision: str | Sequence[str] | None = "6155f8860fc1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "files",
        sa.Column("building_id", sa.Uuid(), nullable=False),
        sa.Column("uploaded_by_user_id", sa.Uuid(), nullable=False),
        sa.Column(
            "purpose",
            sa.Enum(
                "package_photo",
                "maintenance_photo",
                "notice_attachment",
                name="file_purpose",
                native_enum=False,
                create_constraint=False,
            ),
            nullable=False,
        ),
        sa.Column("s3_key", sa.String(length=200), nullable=False),
        sa.Column("s3_version_id", sa.String(length=1024), nullable=True),
        sa.Column("content_type", sa.String(length=100), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("original_name", sa.String(length=255), nullable=False),
        sa.Column(
            "status",
            sa.Enum(
                "pending", "ready", name="file_status", native_enum=False, create_constraint=False
            ),
            nullable=False,
        ),
        sa.Column("attached_type", sa.String(length=40), nullable=True),
        sa.Column("attached_id", sa.Uuid(), nullable=True),
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
            "(status = 'ready') = (s3_version_id IS NOT NULL)",
            name=op.f("ck_files_version_iff_ready"),
        ),
        sa.CheckConstraint(
            "attached_id IS NULL OR status = 'ready'",
            name=op.f("ck_files_attached_only_when_ready"),
        ),
        # Hand-edited: autogenerate rendered the two enum checks twice (once named just
        # "file_purpose" / "file_status"). The columns' Enums have create_constraint=False so they
        # don't add more.
        sa.CheckConstraint(
            "purpose IN ('package_photo', 'maintenance_photo', 'notice_attachment')",
            name=op.f("ck_files_file_purpose"),
        ),
        sa.CheckConstraint("status IN ('pending', 'ready')", name=op.f("ck_files_file_status")),
        sa.CheckConstraint(
            "(attached_type IS NULL) = (attached_id IS NULL)",
            name=op.f("ck_files_attachment_complete"),
        ),
        sa.CheckConstraint("size_bytes > 0", name=op.f("ck_files_size_positive")),
        sa.ForeignKeyConstraint(
            ["building_id"],
            ["buildings.id"],
            name=op.f("fk_files_building_id_buildings"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["uploaded_by_user_id"],
            ["users.id"],
            name=op.f("fk_files_uploaded_by_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_files")),
        sa.UniqueConstraint("building_id", "id", name=op.f("uq_files_building_id_id")),
        sa.UniqueConstraint("s3_key", name=op.f("uq_files_s3_key")),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table("files")
