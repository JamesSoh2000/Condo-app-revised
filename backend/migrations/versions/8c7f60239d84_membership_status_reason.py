"""membership status reason (P4-06a): why a membership was suspended, for managers

Nullable and without a default: adding it rewrites no rows and the previous release ignores it
(expand only).

Revision ID: 8c7f60239d84
Revises: c0a262b1f7d1
Create Date: 2026-10-20 17:34:44.949325

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "8c7f60239d84"
down_revision: str | Sequence[str] | None = "c0a262b1f7d1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "building_memberships", sa.Column("status_reason", sa.String(length=500), nullable=True)
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("building_memberships", "status_reason")
