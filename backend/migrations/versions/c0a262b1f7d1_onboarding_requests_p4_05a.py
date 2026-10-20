"""onboarding_requests (P4-05a): residents' join requests, pending until a manager decides

A new table only (expand): the previous release never reads it. At most one pending request per
membership (`uq_onboarding_requests_pending_membership`).

Revision ID: c0a262b1f7d1
Revises: de8f8dbe23fb
Create Date: 2026-10-20 14:27:32.758530

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c0a262b1f7d1"
down_revision: str | Sequence[str] | None = "de8f8dbe23fb"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "onboarding_requests",
        sa.Column("building_id", sa.Uuid(), nullable=False),
        sa.Column("membership_id", sa.Uuid(), nullable=False),
        sa.Column("unit_id", sa.Uuid(), nullable=False),
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
            nullable=False,
        ),
        sa.Column(
            "status",
            sa.Enum(
                "pending",
                "approved",
                "denied",
                name="onboarding_status",
                native_enum=False,
                create_constraint=False,
            ),
            server_default="pending",
            nullable=False,
        ),
        sa.Column("decided_by_user_id", sa.Uuid(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("decision_reason", sa.String(length=500), nullable=True),
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
        sa.CheckConstraint(
            "(status = 'pending') = (decided_at IS NULL)",
            name=op.f("ck_onboarding_requests_decided_when_not_pending"),
        ),
        sa.CheckConstraint(
            "decision_reason IS NULL OR status = 'denied'",
            name=op.f("ck_onboarding_requests_reason_only_when_denied"),
        ),
        # Hand-edited: autogenerate rendered each enum check twice (once named after the enum), as
        # in 87a5795f265e. The columns' Enums have create_constraint=False so they add no third.
        sa.CheckConstraint(
            "relationship IN ('owner', 'tenant', 'household')",
            name=op.f("ck_onboarding_requests_relationship"),
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'approved', 'denied')",
            name=op.f("ck_onboarding_requests_onboarding_status"),
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "membership_id"],
            ["building_memberships.building_id", "building_memberships.id"],
            name="fk_onboarding_requests_building_id_membership_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "unit_id"],
            ["units.building_id", "units.id"],
            name="fk_onboarding_requests_building_id_unit_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id"],
            ["buildings.id"],
            name=op.f("fk_onboarding_requests_building_id_buildings"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["decided_by_user_id"],
            ["users.id"],
            name=op.f("fk_onboarding_requests_decided_by_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_onboarding_requests")),
    )
    op.create_index(
        "ix_onboarding_requests_building_id_status_id",
        "onboarding_requests",
        ["building_id", "status", "id"],
        unique=False,
    )
    op.create_index(
        "ix_onboarding_requests_membership_id_id",
        "onboarding_requests",
        ["membership_id", "id"],
        unique=False,
    )
    op.create_index(
        "uq_onboarding_requests_pending_membership",
        "onboarding_requests",
        ["membership_id"],
        unique=True,
        postgresql_where=sa.text("status = 'pending'"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        "uq_onboarding_requests_pending_membership",
        table_name="onboarding_requests",
        postgresql_where=sa.text("status = 'pending'"),
    )
    op.drop_index("ix_onboarding_requests_membership_id_id", table_name="onboarding_requests")
    op.drop_index("ix_onboarding_requests_building_id_status_id", table_name="onboarding_requests")
    op.drop_table("onboarding_requests")
