"""Imports every models module, so `Base.metadata` holds every table.

`migrations/env.py` imports only this module: a table whose module is missing here is invisible to
autogenerate. `tests/test_schema_buildings_units.py` fails if an `app/**/models.py` isn't listed.
"""

import app.buildings.models
import app.memberships.models
import app.units.models
import app.users.models

__all__ = ["app"]
