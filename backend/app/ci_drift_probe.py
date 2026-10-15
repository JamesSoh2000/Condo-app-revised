"""P0-05 AC2 demo: a model with no migration, so `alembic check` must fail. Reverted next commit."""

from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class DriftProbe(Base):
    __tablename__ = "drift_probes"

    id: Mapped[int] = mapped_column(primary_key=True)
