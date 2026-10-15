"""users, building_memberships and membership_roles (P1-02)

Revision ID: 2b2e5bcaf6b4
Revises: 891dd631e5a1
Create Date: 2026-10-15 17:40:01.058664

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "2b2e5bcaf6b4"
down_revision: str | Sequence[str] | None = "891dd631e5a1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "users",
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("password_hash", sa.String(length=255), nullable=True),
        sa.Column("full_name", sa.String(length=200), nullable=False),
        sa.Column("phone", sa.String(length=32), nullable=True),
        sa.Column("locale", sa.String(length=10), server_default="en", nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("email_verified_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.PrimaryKeyConstraint("id", name=op.f("pk_users")),
    )
    # Checked by hand: a unique index on the expression lower(email), so emails differing only in
    # case can't both exist, whoever writes them.
    op.create_index("uq_users_lower_email", "users", [sa.text("lower(email)")], unique=True)
    op.create_table(
        "building_memberships",
        sa.Column("building_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column(
            "status",
            sa.Enum(
                "pending",
                "active",
                "denied",
                "suspended",
                "deactivated",
                name="status",
                native_enum=False,
                create_constraint=False,
            ),
            server_default="pending",
            nullable=False,
        ),
        sa.Column(
            "status_changed_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("status_changed_by_user_id", sa.Uuid(), nullable=True),
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
        # Hand-edited: autogenerate rendered this check twice (once named just "status"). The
        # column's Enum has create_constraint=False so it doesn't add another.
        sa.CheckConstraint(
            "status IN ('pending', 'active', 'denied', 'suspended', 'deactivated')",
            name=op.f("ck_building_memberships_status"),
        ),
        sa.ForeignKeyConstraint(
            ["building_id"],
            ["buildings.id"],
            name=op.f("fk_building_memberships_building_id_buildings"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["status_changed_by_user_id"],
            ["users.id"],
            name=op.f("fk_building_memberships_status_changed_by_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_building_memberships_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_building_memberships")),
        sa.UniqueConstraint(
            "building_id", "id", name=op.f("uq_building_memberships_building_id_id")
        ),
        sa.UniqueConstraint(
            "building_id", "user_id", name=op.f("uq_building_memberships_building_id_user_id")
        ),
    )
    op.create_index(
        op.f("ix_building_memberships_user_id"), "building_memberships", ["user_id"], unique=False
    )
    op.create_table(
        "membership_roles",
        sa.Column("building_id", sa.Uuid(), nullable=False),
        sa.Column("membership_id", sa.Uuid(), nullable=False),
        sa.Column(
            "role",
            sa.Enum(
                "resident",
                "security",
                "property_management",
                "council",
                name="role",
                native_enum=False,
                create_constraint=False,
            ),
            nullable=False,
        ),
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
        # Hand-edited: autogenerate rendered this check twice (once named just "role"). The
        # column's Enum has create_constraint=False so it doesn't add another.
        sa.CheckConstraint(
            "role IN ('resident', 'security', 'property_management', 'council')",
            name=op.f("ck_membership_roles_role"),
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "membership_id"],
            ["building_memberships.building_id", "building_memberships.id"],
            name="fk_membership_roles_building_id_membership_id",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["building_id"],
            ["buildings.id"],
            name=op.f("fk_membership_roles_building_id_buildings"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("membership_id", "role", name=op.f("pk_membership_roles")),
    )


def downgrade() -> None:
    """Downgrade schema."""
    # Children first: membership_roles references building_memberships, which references users.
    op.drop_table("membership_roles")
    op.drop_index(op.f("ix_building_memberships_user_id"), table_name="building_memberships")
    op.drop_table("building_memberships")
    op.drop_index("uq_users_lower_email", table_name="users")
    op.drop_table("users")
