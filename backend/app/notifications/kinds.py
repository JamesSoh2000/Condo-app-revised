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
    )
}
