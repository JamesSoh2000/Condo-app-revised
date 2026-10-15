from app.models.base import Base
from app.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin


# Stub class; P1-01 defines the real table.
class Unit(UUIDPrimaryKeyMixin, TimestampMixin, Base): ...
