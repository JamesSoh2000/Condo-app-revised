from app.models.base import Base
from app.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin


# Stub classes; P1-01 defines the real tables.
class Building(UUIDPrimaryKeyMixin, TimestampMixin, Base): ...


class BuildingFeature(UUIDPrimaryKeyMixin, TimestampMixin, Base): ...
