"""What each file purpose accepts (ADR-0007 "Limits"), the magic numbers that prove a type, and
who may download an attached file: each purpose's `can_view` hook, registered by the owning domain.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.files.models import File, FilePurpose
from app.memberships.enums import STAFF_ROLES, Role
from app.tenancy.context import TenantContext

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_PDF_BYTES = 20 * 1024 * 1024
# How many leading bytes `matches_magic` needs (HEIC's brand ends at byte 12).
MAGIC_BYTES = 16

IMAGE_TYPES = frozenset({"image/jpeg", "image/png", "image/webp", "image/heic"})
# The `ftyp` major brands of HEIC/HEIF still images (ISO/IEC 23008-12). Not `avif`: that is AV1.
_HEIF_BRANDS = frozenset({b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"mif1", b"msf1"})


@dataclass(frozen=True, slots=True)
class PurposeRule:
    content_types: frozenset[str]
    max_bytes: int
    # The roles, in the URL's building, that may upload a file for this purpose.
    uploader_roles: frozenset[Role]


PURPOSES: dict[FilePurpose, PurposeRule] = {
    # Security logs packages (PRODUCT_SCOPE.md); the manager may too.
    FilePurpose.PACKAGE_PHOTO: PurposeRule(
        IMAGE_TYPES, MAX_IMAGE_BYTES, frozenset({Role.SECURITY, Role.PROPERTY_MANAGEMENT})
    ),
    # Residents submit maintenance requests; the manager runs them.
    FilePurpose.MAINTENANCE_PHOTO: PurposeRule(
        IMAGE_TYPES, MAX_IMAGE_BYTES, frozenset({Role.RESIDENT, Role.PROPERTY_MANAGEMENT})
    ),
    # The manager publishes notices.
    FilePurpose.NOTICE_ATTACHMENT: PurposeRule(
        frozenset({"application/pdf"}), MAX_PDF_BYTES, frozenset({Role.PROPERTY_MANAGEMENT})
    ),
}


def is_staff_purpose(rule: PurposeRule) -> bool:
    """Only staff upload it, so any of its uploaders may attach another one's file."""
    return rule.uploader_roles <= STAFF_ROLES


# Whether the caller may download `file`, a `ready` file of the caller's building that is attached
# to one of the domain's records (`attached_type`, `attached_id`).
CanView = Callable[[TenantContext, File, AsyncSession], Awaitable[bool]]

_CAN_VIEW: dict[FilePurpose, CanView] = {}


def register_can_view(purpose: FilePurpose, hook: CanView) -> None:
    """Called once by the domain that owns `purpose` files. Without a hook, an attached file of
    that purpose is visible to nobody."""
    if purpose in _CAN_VIEW:
        raise ValueError(f"a can_view hook for {purpose} is already registered")
    _CAN_VIEW[purpose] = hook


def can_view_hook(purpose: FilePurpose) -> CanView | None:
    return _CAN_VIEW.get(purpose)


def matches_magic(content_type: str, head: bytes) -> bool:
    """`head` (the file's first bytes) starts the way a `content_type` file must."""
    match content_type:
        case "image/jpeg":
            return head.startswith(b"\xff\xd8\xff")
        case "image/png":
            return head.startswith(b"\x89PNG\r\n\x1a\n")
        case "image/webp":
            return head[0:4] == b"RIFF" and head[8:12] == b"WEBP"
        case "image/heic":
            return head[4:8] == b"ftyp" and head[8:12] in _HEIF_BRANDS
        case "application/pdf":
            return head.startswith(b"%PDF-")
        case _:
            return False
