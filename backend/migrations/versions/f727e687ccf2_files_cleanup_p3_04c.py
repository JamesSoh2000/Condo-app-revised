"""files cleanup (P3-04c): the `deleting` status, and an index for `files.cleanup`'s query

Revision ID: f727e687ccf2
Revises: 05c58ec89743
Create Date: 2026-10-18 20:49:09.607812

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f727e687ccf2"
down_revision: str | Sequence[str] | None = "05c58ec89743"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    # Hand-written: autogenerate compares neither check constraints nor non-native enum values.
    # A non-native enum is VARCHAR(its longest value): "deleting" needs 8.
    op.alter_column(
        "files",
        "status",
        type_=sa.String(length=8),
        existing_type=sa.String(length=7),
        existing_nullable=False,
    )
    op.drop_constraint(op.f("ck_files_file_status"), "files", type_="check")
    op.create_check_constraint(
        op.f("ck_files_file_status"), "files", "status IN ('pending', 'ready', 'deleting')"
    )
    op.drop_constraint(op.f("ck_files_version_iff_ready"), "files", type_="check")
    op.create_check_constraint(
        op.f("ck_files_version_iff_ready"),
        "files",
        "status = 'deleting' OR (status = 'ready') = (s3_version_id IS NOT NULL)",
    )
    # Every file `files.cleanup` may mark is unattached.
    op.create_index(
        "ix_files_unattached_created_at",
        "files",
        ["created_at"],
        unique=False,
        postgresql_where="attached_id IS NULL",
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        "ix_files_unattached_created_at", table_name="files", postgresql_where="attached_id IS NULL"
    )
    # Files still being deleted go back to what they were (their version says which); the next
    # cleanup of a release with this revision marks them again.
    op.execute(
        "UPDATE files SET status = CASE WHEN s3_version_id IS NULL THEN 'pending' ELSE 'ready' END"
        " WHERE status = 'deleting'"
    )
    op.drop_constraint(op.f("ck_files_version_iff_ready"), "files", type_="check")
    op.create_check_constraint(
        op.f("ck_files_version_iff_ready"),
        "files",
        "(status = 'ready') = (s3_version_id IS NOT NULL)",
    )
    op.drop_constraint(op.f("ck_files_file_status"), "files", type_="check")
    op.create_check_constraint(
        op.f("ck_files_file_status"), "files", "status IN ('pending', 'ready')"
    )
    op.alter_column(
        "files",
        "status",
        type_=sa.String(length=7),
        existing_type=sa.String(length=8),
        existing_nullable=False,
    )
