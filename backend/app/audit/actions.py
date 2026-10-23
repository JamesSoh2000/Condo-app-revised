"""Audit action names: `<domain>.<past_verb>` (CLAUDE.md conventions). Each domain adds its own."""

AUTH_LOGGED_IN = "auth.logged_in"
AUTH_LOGIN_FAILED = "auth.login_failed"
AUTH_LOGGED_OUT = "auth.logged_out"
AUTH_LOGGED_OUT_ALL = "auth.logged_out_all"
AUTH_SESSION_REVOKED = "auth.session_revoked"
AUTH_SIGNED_UP = "auth.signed_up"

AUTH_PASSWORD_RESET_REQUESTED = "auth.password_reset_requested"  # noqa: S105
AUTH_PASSWORD_RESET_COMPLETED = "auth.password_reset_completed"  # noqa: S105

BUILDING_BOOTSTRAPPED = "building.bootstrapped"

UNIT_CREATED = "unit.created"
UNIT_UPDATED = "unit.updated"
UNIT_DEACTIVATED = "unit.deactivated"
UNIT_ACTIVATED = "unit.activated"

INVITATION_CREATED = "invitation.created"
INVITATION_REVOKED = "invitation.revoked"
INVITATION_RESENT = "invitation.resent"
INVITATION_ACCEPTED = "invitation.accepted"

MEMBERSHIP_ACTIVATED = "membership.activated"
MEMBERSHIP_ROLES_CHANGED = "membership.roles_changed"
MEMBERSHIP_SUSPENDED = "membership.suspended"
MEMBERSHIP_REACTIVATED = "membership.reactivated"
MEMBERSHIP_DEACTIVATED = "membership.deactivated"
OCCUPANCY_TRANSFERRED = "occupancy.transferred"

ONBOARDING_SUBMITTED = "onboarding.submitted"
ONBOARDING_APPROVED = "onboarding.approved"
ONBOARDING_DENIED = "onboarding.denied"

PACKAGE_RECEIVED = "package.received"
