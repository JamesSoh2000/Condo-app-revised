"""jobs queue (P3-01a, ADR-0006): jobs enqueued in the business transaction, claimed by the worker

Revision ID: 6155f8860fc1
Revises: f2a180ecdeb7
Create Date: 2026-10-18 00:11:51.131801

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "6155f8860fc1"
down_revision: str | Sequence[str] | None = "f2a180ecdeb7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "jobs",
        sa.Column("kind", sa.String(length=64), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "status",
            sa.Enum(
                "queued",
                "running",
                "succeeded",
                "dead",
                name="job_status",
                native_enum=False,
                create_constraint=False,
            ),
            server_default="queued",
            nullable=False,
        ),
        sa.Column(
            "run_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("attempts", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("max_attempts", sa.Integer(), server_default=sa.text("8"), nullable=False),
        sa.Column("locked_by", sa.String(length=64), nullable=True),
        sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("dedupe_key", sa.String(length=200), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        # Hand-edited: autogenerate rendered this check twice (once named just "job_status"). The
        # column's Enum has create_constraint=False so it doesn't add another.
        sa.CheckConstraint(
            "status IN ('queued', 'running', 'succeeded', 'dead')", name=op.f("ck_jobs_job_status")
        ),
        sa.CheckConstraint("attempts >= 0", name=op.f("ck_jobs_attempts_not_negative")),
        sa.CheckConstraint("max_attempts >= 1", name=op.f("ck_jobs_max_attempts_positive")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_jobs")),
        sa.UniqueConstraint("dedupe_key", name=op.f("uq_jobs_dedupe_key")),
    )
    # The claim's scan: due queued jobs and running ones whose lease may have expired.
    op.create_index(
        "ix_jobs_run_at_due",
        "jobs",
        ["run_at"],
        unique=False,
        postgresql_where=sa.text("status IN ('queued', 'running')"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        "ix_jobs_run_at_due",
        table_name="jobs",
        postgresql_where=sa.text("status IN ('queued', 'running')"),
    )
    op.drop_table("jobs")
