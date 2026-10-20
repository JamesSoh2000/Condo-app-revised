"""invitations.created_by_user_id nullable (P4-03)

An invitation created by an operator command (`bootstrap-building`) has no inviting user. Expand
only: the previous release always writes the column.

Revision ID: 85cc5c7f420d
Revises: 87a5795f265e
Create Date: 2026-10-20 12:11:56.430201

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "85cc5c7f420d"
down_revision: str | Sequence[str] | None = "87a5795f265e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.alter_column("invitations", "created_by_user_id", existing_type=sa.UUID(), nullable=True)


def downgrade() -> None:
    """Downgrade schema. Fails while an operator's invitation (a NULL creator) exists."""
    op.alter_column("invitations", "created_by_user_id", existing_type=sa.UUID(), nullable=False)
