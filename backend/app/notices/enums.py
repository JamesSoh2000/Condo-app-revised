from enum import StrEnum


class NoticePriority(StrEnum):
    """How loud a notice is (`notices.priority`): P6-01c emails only `urgent` ones."""

    NORMAL = "normal"
    URGENT = "urgent"


class NoticeStatus(StrEnum):
    """Where a notice is (`notices.status`); `app.notices.state` says how it may move."""

    DRAFT = "draft"  # the manager's, being written
    PUBLISHED = "published"  # shown to every member until it expires
    ARCHIVED = "archived"  # withdrawn, or a draft discarded; final
