"""files unattached index (P3-04c): serves `files.cleanup`, whose candidates are all unattached

Revision ID: f727e687ccf2
Revises: 05c58ec89743
Create Date: 2026-10-18 20:49:09.607812

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f727e687ccf2"
down_revision: str | Sequence[str] | None = "05c58ec89743"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
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
