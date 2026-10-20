"""invitations (P4-02a)

Revision ID: 87a5795f265e
Revises: f727e687ccf2
Create Date: 2026-10-19 22:56:47.719091

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "87a5795f265e"
down_revision: str | Sequence[str] | None = "f727e687ccf2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "invitations",
        sa.Column("building_id", sa.Uuid(), nullable=False),
        sa.Column("email", sa.String(length=254), nullable=False),
        sa.Column("roles", postgresql.ARRAY(sa.String(length=32)), nullable=False),
        sa.Column("unit_id", sa.Uuid(), nullable=True),
        sa.Column(
            "relationship",
            sa.Enum(
                "owner",
                "tenant",
                "household",
                name="relationship",
                native_enum=False,
                create_constraint=False,
            ),
            nullable=True,
        ),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("accepted_user_id", sa.Uuid(), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by_user_id", sa.Uuid(), nullable=False),
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
        # Hand-edited: autogenerate rendered this check twice (once named just "relationship"), as
        # in 8887ac143e98. The column's Enum has create_constraint=False so it doesn't add another.
        sa.CheckConstraint(
            "relationship IN ('owner', 'tenant', 'household')",
            name=op.f("ck_invitations_relationship"),
        ),
        sa.CheckConstraint(
            "roles <@ ARRAY['resident', 'security', 'property_management', 'council']::varchar[]",
            name=op.f("ck_invitations_roles_known"),
        ),
        sa.CheckConstraint(
            "(unit_id IS NULL) = (relationship IS NULL)",
            name=op.f("ck_invitations_unit_with_relationship"),
        ),
        sa.CheckConstraint("cardinality(roles) > 0", name=op.f("ck_invitations_roles_not_empty")),
        sa.CheckConstraint("email = lower(email)", name=op.f("ck_invitations_email_lowercase")),
        sa.ForeignKeyConstraint(
            ["accepted_user_id"],
            ["users.id"],
            name=op.f("fk_invitations_accepted_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "unit_id"],
            ["units.building_id", "units.id"],
            name="fk_invitations_building_id_unit_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id"],
            ["buildings.id"],
            name=op.f("fk_invitations_building_id_buildings"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
            name=op.f("fk_invitations_created_by_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_invitations")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_invitations_token_hash")),
    )
    op.create_index(
        "ix_invitations_building_id_email", "invitations", ["building_id", "email"], unique=False
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_invitations_building_id_email", table_name="invitations")
    op.drop_table("invitations")
