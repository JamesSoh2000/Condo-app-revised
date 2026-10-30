"""The notification kinds (P3-03). `notify` refuses a kind that isn't here; a ticket that adds a
notification adds its kind, and, if it emails, its template under `app/email/templates/`."""

from dataclasses import dataclass


@dataclass(frozen=True)
class NotificationKind:
    name: str
    description: str
    # The email each recipient also gets (`queue_email`), or None for in-app only. `notification`
    # renders the notification's own title, body and link.
    email_template: str | None


KINDS: dict[str, NotificationKind] = {
    kind.name: kind
    for kind in (
        NotificationKind(
            "membership.approved", "A manager approved the user's membership", "notification"
        ),
        NotificationKind(
            "membership.denied", "A manager denied the user's membership request", "notification"
        ),
        NotificationKind(
            "onboarding.submitted", "A resident asked to join the building (managers)", None
        ),
        NotificationKind(
            "package.arrived", "Security logged a package for the user's unit", "package_arrived"
        ),
        NotificationKind(
            "package.picked_up", "A package for the user or their unit was picked up", None
        ),
        # Two kinds, not one with a flag: the kind fixes the email (P6-01c D2).
        NotificationKind("notice.published", "The manager published a notice", None),
        NotificationKind(
            "notice.published_urgent", "The manager published an urgent notice", "notification"
        ),
        # Managers only, never the requester (P6-03b D5); an emergency also emails.
        NotificationKind("maintenance.submitted", "A resident filed a maintenance request", None),
        NotificationKind(
            "maintenance.submitted_emergency",
            "A resident filed an emergency maintenance request",
            "notification",
        ),
        # A public comment (P6-03d D2): staff's tells the requester and emails, a resident's tells
        # the managers in-app. An internal comment tells no one.
        NotificationKind(
            "maintenance.staff_commented",
            "Staff replied on the user's maintenance request",
            "notification",
        ),
        NotificationKind(
            "maintenance.resident_commented",
            "A resident commented on a maintenance request (managers)",
            None,
        ),
        # A manager's start, hold, resolve or reopen tells the requester (P6-03c): one kind, the
        # title says which.
        NotificationKind(
            "maintenance.status_changed",
            "A manager moved the user's maintenance request to a new status",
            "notification",
        ),
    )
}
