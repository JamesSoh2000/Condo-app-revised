"""buildings, building_features and units (P1-01)

Revision ID: 891dd631e5a1
Revises: 989e5bd83064
Create Date: 2026-10-15 17:06:55.139676

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "891dd631e5a1"
down_revision: str | Sequence[str] | None = "989e5bd83064"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "buildings",
        sa.Column("slug", sa.String(length=63), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("address", sa.Text(), nullable=False),
        sa.Column("timezone", sa.String(length=64), nullable=False),
        sa.Column("locale", sa.String(length=10), server_default="en", nullable=False),
        sa.Column("join_code", sa.String(length=16), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
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
        sa.CheckConstraint("slug ~ '^[a-z0-9-]+$'", name=op.f("ck_buildings_slug_format")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_buildings")),
        sa.UniqueConstraint("join_code", name=op.f("uq_buildings_join_code")),
        sa.UniqueConstraint("slug", name=op.f("uq_buildings_slug")),
    )
    op.create_table(
        "building_features",
        sa.Column("building_id", sa.Uuid(), nullable=False),
        sa.Column(
            "feature",
            sa.Enum(
                "packages",
                "notices",
                "maintenance",
                "amenities",
                "moves",
                "visitors",
                "reports",
                "financials",
                name="feature",
                native_enum=False,
                create_constraint=False,
            ),
            nullable=False,
        ),
        sa.Column("enabled", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column(
            "config",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
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
        # Hand-edited: autogenerate rendered this check twice (once unnamed, which the naming
        # convention also names ck_building_features_feature). The column's Enum below has
        # create_constraint=False so it doesn't add a third.
        sa.CheckConstraint(
            "feature IN ('packages', 'notices', 'maintenance', 'amenities', 'moves', 'visitors',"
            " 'reports', 'financials')",
            name=op.f("ck_building_features_feature"),
        ),
        sa.ForeignKeyConstraint(
            ["building_id"],
            ["buildings.id"],
            name=op.f("fk_building_features_building_id_buildings"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("building_id", "feature", name=op.f("pk_building_features")),
    )
    op.create_table(
        "units",
        sa.Column("building_id", sa.Uuid(), nullable=False),
        sa.Column("tower", sa.String(length=20), nullable=True),
        sa.Column("label", sa.String(length=20), nullable=False),
        sa.Column("floor", sa.Integer(), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
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
        sa.ForeignKeyConstraint(
            ["building_id"],
            ["buildings.id"],
            name=op.f("fk_units_building_id_buildings"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_units")),
        sa.UniqueConstraint("building_id", "id", name=op.f("uq_units_building_id_id")),
        # Checked by hand: renders UNIQUE NULLS NOT DISTINCT (Postgres 15+), so (NULL, '101') can't
        # repeat in one building.
        sa.UniqueConstraint(
            "building_id",
            "tower",
            "label",
            name=op.f("uq_units_building_id_tower_label"),
            postgresql_nulls_not_distinct=True,
        ),
    )


def downgrade() -> None:
    """Downgrade schema."""
    # Children first: units and building_features reference buildings.
    op.drop_table("units")
    op.drop_table("building_features")
    op.drop_table("buildings")
