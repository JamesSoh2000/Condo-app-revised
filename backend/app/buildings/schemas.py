from uuid import UUID

from app.buildings.enums import Feature
from app.core.schemas import APIModel
from app.memberships.enums import Role


class BuildingOut(APIModel):
    """A building as its member sees it: the caller's roles there and its enabled features."""

    id: UUID
    name: str
    slug: str
    timezone: str
    locale: str
    my_roles: list[Role]
    features: list[Feature]
