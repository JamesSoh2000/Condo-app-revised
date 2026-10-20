"""Audit action names: `<domain>.<past_verb>` (CLAUDE.md conventions). Each domain adds its own."""

AUTH_LOGGED_IN = "auth.logged_in"
AUTH_LOGIN_FAILED = "auth.login_failed"
AUTH_LOGGED_OUT = "auth.logged_out"
AUTH_LOGGED_OUT_ALL = "auth.logged_out_all"
AUTH_SESSION_REVOKED = "auth.session_revoked"

UNIT_CREATED = "unit.created"
UNIT_UPDATED = "unit.updated"
UNIT_DEACTIVATED = "unit.deactivated"
UNIT_ACTIVATED = "unit.activated"

INVITATION_CREATED = "invitation.created"
INVITATION_REVOKED = "invitation.revoked"
INVITATION_RESENT = "invitation.resent"
