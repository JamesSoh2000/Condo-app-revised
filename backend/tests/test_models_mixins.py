"""The shared primary-key mixin generates RFC 9562 version-7 UUIDs from the standard library."""

import uuid

from sqlalchemy import String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.models.mixins import UUIDPrimaryKeyMixin


class _ProbeBase(DeclarativeBase):
    """A separate metadata, so the probe table never reaches the app's migrations."""


class _MixinProbe(UUIDPrimaryKeyMixin, _ProbeBase):
    __tablename__ = "mixin_probe"

    label: Mapped[str] = mapped_column(String(10))


def _new_primary_key() -> uuid.UUID:
    default = _MixinProbe.__table__.c.id.default
    assert default is not None
    assert default.is_callable
    value = default.arg(None)  # type: ignore[call-arg, operator]
    assert isinstance(value, uuid.UUID)
    return value


def test_primary_key_default_is_a_standard_library_uuid7() -> None:
    value = _new_primary_key()

    # Exactly uuid.UUID: a subclass (uuid6.UUID) would mean the third-party package is still in use.
    assert type(value) is uuid.UUID
    assert value.version == 7
    assert value.variant == uuid.RFC_4122


def test_primary_keys_sort_in_creation_order() -> None:
    values = [_new_primary_key() for _ in range(1000)]

    assert values == sorted(values)
    assert len(set(values)) == len(values)
