"""rate limits (P2-05): one row per key and fixed window, counted by an atomic upsert

Revision ID: f2a180ecdeb7
Revises: 91af698c06d2
Create Date: 2026-10-17 02:06:52.276922

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f2a180ecdeb7"
down_revision: str | Sequence[str] | None = "91af698c06d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "rate_limits",
        sa.Column("key", sa.String(length=200), nullable=False),
        sa.Column("window_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("count", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("key", "window_start", name=op.f("pk_rate_limits")),
    )
    # For the cleanup, which deletes old windows across all keys.
    op.create_index("ix_rate_limits_window_start", "rate_limits", ["window_start"], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_rate_limits_window_start", table_name="rate_limits")
    op.drop_table("rate_limits")
