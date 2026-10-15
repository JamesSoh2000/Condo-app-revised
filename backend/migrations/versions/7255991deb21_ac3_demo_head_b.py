"""ac3 demo head b

Revision ID: 7255991deb21
Revises: 989e5bd83064
Create Date: 2026-10-14 22:03:03.152733

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "7255991deb21"
down_revision: str | Sequence[str] | None = "989e5bd83064"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
