"""ac3 demo head a

Revision ID: 20d677a08e4a
Revises: 989e5bd83064
Create Date: 2026-10-14 22:03:02.731116

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "20d677a08e4a"
down_revision: str | Sequence[str] | None = "989e5bd83064"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
