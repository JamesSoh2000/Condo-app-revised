from enum import StrEnum


class MaintenanceStatus(StrEnum):
    """Where a request is (`maintenance_requests.status`); `app.maintenance.state` says how it may
    move."""

    SUBMITTED = "submitted"  # filed, not started
    IN_PROGRESS = "in_progress"
    ON_HOLD = "on_hold"  # waiting (parts, access); resumes to in_progress
    RESOLVED = "resolved"  # may be reopened within 14 days (P6-03c)
    CANCELLED = "cancelled"  # withdrawn by the requester before work started; final


class MaintenanceLocation(StrEnum):
    UNIT = "unit"  # `unit_id` names it
    COMMON_AREA = "common_area"  # `common_area` describes it


class MaintenanceCategory(StrEnum):
    """The trade a request needs (P6-03a D6). Adding a value is an expand-only migration."""

    PLUMBING = "plumbing"
    ELECTRICAL = "electrical"
    HEATING_COOLING = "heating_cooling"
    APPLIANCE = "appliance"
    DOORS_WINDOWS = "doors_windows"
    PEST_CONTROL = "pest_control"
    OTHER = "other"
    EMERGENCY = "emergency"  # P6-03b shows the building's emergency phone
