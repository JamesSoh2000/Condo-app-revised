"""unit_occupancies (P1-03)

Revision ID: 8887ac143e98
Revises: 2b2e5bcaf6b4
Create Date: 2026-10-15 18:17:32.911659

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "8887ac143e98"
down_revision: str | Sequence[str] | None = "2b2e5bcaf6b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "unit_occupancies",
        sa.Column("building_id", sa.Uuid(), nullable=False),
        sa.Column("unit_id", sa.Uuid(), nullable=False),
        sa.Column("membership_id", sa.Uuid(), nullable=False),
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
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
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
        # Hand-edited: autogenerate rendered this check twice (once named just "relationship"). The
        # column's Enum has create_constraint=False so it doesn't add another.
        sa.CheckConstraint(
            "relationship IN ('owner', 'tenant', 'household')",
            name=op.f("ck_unit_occupancies_relationship"),
        ),
        sa.CheckConstraint(
            "ended_at IS NULL OR ended_at >= started_at",
            name=op.f("ck_unit_occupancies_ended_after_started"),
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "membership_id"],
            ["building_memberships.building_id", "building_memberships.id"],
            name="fk_unit_occupancies_building_id_membership_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "unit_id"],
            ["units.building_id", "units.id"],
            name="fk_unit_occupancies_building_id_unit_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["building_id"],
            ["buildings.id"],
            name=op.f("fk_unit_occupancies_building_id_buildings"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_unit_occupancies")),
    )
    op.create_index(
        "ix_unit_occupancies_building_id_unit_id_ended_at",
        "unit_occupancies",
        ["building_id", "unit_id", "ended_at"],
        unique=False,
    )
    op.create_index(
        "ix_unit_occupancies_membership_id_unit_id_started_at",
        "unit_occupancies",
        ["membership_id", "unit_id", "started_at"],
        unique=False,
    )
    # Checked by hand: partial, so only current rows (ended_at IS NULL) compete for uniqueness.
    op.create_index(
        "uq_unit_occupancies_current_membership",
        "unit_occupancies",
        ["membership_id"],
        unique=True,
        postgresql_where=sa.text("ended_at IS NULL"),
    )
    # Hand-written: the occupancy-window test (ADR-0016), behind
    # app.memberships.occupancy.occupancy_window_clause. A function, so its arguments arrive as
    # values: no name in the caller's query (unqualified columns, aliases, CTEs) can resolve to this
    # table instead of the caller's record. The SQL-standard body is parsed and bound to
    # public.unit_occupancies when it's created, so neither the search path nor a temporary table
    # can redirect it, and the table can't be dropped while the function exists. Half-open window;
    # STABLE (reads the table); not STRICT, so a NULL argument gives false.
    op.execute(
        """
        CREATE FUNCTION public.occupancy_window(
            p_membership_id uuid, p_unit_id uuid, p_at timestamptz
        )
        RETURNS boolean
        LANGUAGE sql
        STABLE
        PARALLEL SAFE
        RETURN EXISTS (
            SELECT 1
            FROM public.unit_occupancies AS o
            WHERE o.membership_id = p_membership_id
              AND o.unit_id = p_unit_id
              AND o.started_at <= p_at
              AND (o.ended_at IS NULL OR o.ended_at > p_at)
        )
        """
    )


def downgrade() -> None:
    """Downgrade schema."""
    # First: the function's body depends on the table.
    op.execute("DROP FUNCTION public.occupancy_window(uuid, uuid, timestamptz)")
    op.drop_index(
        "uq_unit_occupancies_current_membership",
        table_name="unit_occupancies",
        postgresql_where=sa.text("ended_at IS NULL"),
    )
    op.drop_index(
        "ix_unit_occupancies_membership_id_unit_id_started_at", table_name="unit_occupancies"
    )
    op.drop_index("ix_unit_occupancies_building_id_unit_id_ended_at", table_name="unit_occupancies")
    op.drop_table("unit_occupancies")
