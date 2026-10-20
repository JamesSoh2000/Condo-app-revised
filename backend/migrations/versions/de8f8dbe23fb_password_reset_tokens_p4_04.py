"""password_reset_tokens (P4-04): emailed reset links, storing only the token's sha256

A new table only (expand): the previous release never reads it. At most one live token per user
(`uq_password_reset_tokens_user_id_live`).

Revision ID: de8f8dbe23fb
Revises: 85cc5c7f420d
Create Date: 2026-10-20 13:36:20.931893

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "de8f8dbe23fb"
down_revision: str | Sequence[str] | None = "85cc5c7f420d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "password_reset_tokens",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "token_hash ~ '^[0-9a-f]{64}$'",
            name=op.f("ck_password_reset_tokens_token_hash_is_sha256_hex"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_password_reset_tokens_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_password_reset_tokens")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_password_reset_tokens_token_hash")),
    )
    op.create_index(
        "uq_password_reset_tokens_user_id_live",
        "password_reset_tokens",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("used_at IS NULL AND revoked_at IS NULL"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        "uq_password_reset_tokens_user_id_live",
        table_name="password_reset_tokens",
        postgresql_where=sa.text("used_at IS NULL AND revoked_at IS NULL"),
    )
    op.drop_table("password_reset_tokens")
