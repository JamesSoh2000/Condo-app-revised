"""ORM relationship rules, carried from the P1-02 reviews (PR #44) into P1-05.

- Fitness: a one-to-many relationship whose child FK is part of the child's primary key must cascade
  `delete-orphan`. Without it, removing a child from the collection makes the ORM set its FK, a
  primary-key column, to NULL (P1-02 round 2 crashed that way).
- `BuildingMembership.roles` leaves unloaded roles to the database's cascade (`passive_deletes`).
- `BuildingMembership.user` orders a new user before its membership in one flush on its own.
"""

from typing import Any

import pytest
from sqlalchemy import ForeignKey, event, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    RelationshipDirection,
    RelationshipProperty,
    mapped_column,
    registry,
    relationship,
)

from app.memberships.enums import Role
from app.memberships.models import BuildingMembership, MembershipRole
from app.models.base import Base
from app.users.models import User
from tests.factories import make_building, make_membership, make_user


def _pk_child_relationships(reg: registry) -> list[RelationshipProperty[Any]]:
    """One-to-many relationships whose child-side FK columns include a child primary-key column."""
    found = []
    for mapper in reg.mappers:
        for rel in mapper.relationships:
            if rel.direction is not RelationshipDirection.ONETOMANY:
                continue
            child_fk_columns = {remote for _local, remote in rel.local_remote_pairs}
            if child_fk_columns & set(rel.mapper.local_table.primary_key.columns):
                found.append(rel)
    return found


def _missing_delete_orphan(reg: registry) -> list[str]:
    return [str(rel) for rel in _pk_child_relationships(reg) if not rel.cascade.delete_orphan]


def test_one_to_many_relationships_into_a_childs_primary_key_cascade_delete_orphan():
    assert _missing_delete_orphan(Base.registry) == []


def test_the_fitness_check_covers_membership_roles():
    # Not vacuous: the app's one such relationship today is found.
    assert "BuildingMembership.roles" in {
        str(rel) for rel in _pk_child_relationships(Base.registry)
    }


def test_the_fitness_check_flags_a_relationship_without_delete_orphan():
    class ProbeBase(DeclarativeBase):
        pass

    class Parent(ProbeBase):
        __tablename__ = "probe_parents"
        id: Mapped[int] = mapped_column(primary_key=True)
        children: Mapped[list[Child]] = relationship(cascade="all")
        owned: Mapped[list[Owned]] = relationship(cascade="all, delete-orphan")
        loose: Mapped[list[Loose]] = relationship()

    class Child(ProbeBase):
        __tablename__ = "probe_children"
        parent_id: Mapped[int] = mapped_column(ForeignKey("probe_parents.id"), primary_key=True)
        name: Mapped[str] = mapped_column(primary_key=True)

    class Owned(ProbeBase):
        __tablename__ = "probe_owned"
        parent_id: Mapped[int] = mapped_column(ForeignKey("probe_parents.id"), primary_key=True)

    class Loose(ProbeBase):
        # The FK isn't in the primary key: setting it to NULL on removal is fine.
        __tablename__ = "probe_loose"
        id: Mapped[int] = mapped_column(primary_key=True)
        parent_id: Mapped[int | None] = mapped_column(ForeignKey("probe_parents.id"))

    assert _missing_delete_orphan(ProbeBase.registry) == ["Parent.children"]


@pytest.mark.anyio
async def test_deleting_a_membership_leaves_its_unloaded_roles_to_the_database_cascade(
    db: AsyncSession,
):
    building = await make_building(db)
    membership = await make_membership(
        await make_user(db), building, roles=[Role.RESIDENT, Role.COUNCIL]
    )
    db.expunge_all()
    loaded = await db.get_one(BuildingMembership, membership.id)  # roles not loaded

    statements: list[str] = []

    def record(_conn: Any, _cursor: Any, statement: str, *_args: Any) -> None:
        statements.append(statement)

    sync_conn = (await db.connection()).sync_connection
    assert sync_conn is not None
    event.listen(sync_conn, "before_cursor_execute", record)
    try:
        await db.delete(loaded)
        await db.flush()
    finally:
        event.remove(sync_conn, "before_cursor_execute", record)

    assert any(s.startswith("DELETE FROM building_memberships") for s in statements), statements
    assert not any("membership_roles" in s for s in statements), statements
    remaining = await db.scalar(
        select(func.count()).where(MembershipRole.membership_id == membership.id)
    )
    assert remaining == 0


@pytest.mark.anyio
async def test_a_new_user_and_its_membership_flush_together_through_user_alone(db: AsyncSession):
    building = await make_building(db)
    user = User(email="new@example.com", full_name="New Person")
    # Only `user` links them (no status_changed_by), and nothing is flushed before.
    membership = BuildingMembership(building_id=building.id, user=user)
    db.add(membership)
    await db.flush()
    assert membership.user_id == user.id
    assert membership.status_changed_by_user_id is None
