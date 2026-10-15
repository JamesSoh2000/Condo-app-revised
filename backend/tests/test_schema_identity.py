"""P1-02: constraints on users, building_memberships and membership_roles, enforced by the database.

Rows are inserted through the models, or with raw SQL where the point is to bypass Python (the email
validator, SQLAlchemy's enum validation), and the database's verdict is asserted. Criterion numbers
refer to the ticket.
"""

import asyncio
import re
import warnings
from uuid import UUID, uuid7

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import delete, func, inspect, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import selectinload

from app.buildings.models import Building
from app.core.config import settings
from app.memberships.enums import STAFF_ROLES, MembershipStatus, Role
from app.memberships.models import BuildingMembership, MembershipRole
from app.users.models import User
from tests.conftest import BACKEND_DIR, _recreate_test_schema, assert_safe_test_database_url

pytestmark = pytest.mark.anyio

TABLES = {"users", "building_memberships", "membership_roles"}
P1_02_REVISION = "2b2e5bcaf6b4"
P1_02_DOWN_REVISION = "891dd631e5a1"

INSERT_USER = text(
    "INSERT INTO users (id, email, full_name) VALUES (gen_random_uuid(), :email, 'Someone')"
    " RETURNING id"
)
INSERT_ROLE = text(
    "INSERT INTO membership_roles (building_id, membership_id, role) VALUES (:b, :m, :role)"
)


async def _building(db: AsyncSession, slug: str) -> Building:
    building = Building(slug=slug, name=f"Building {slug}", address="1 Main St", timezone="UTC")
    db.add(building)
    await db.flush()
    return building


async def _user(db: AsyncSession, email: str) -> User:
    user = User(email=email, full_name="Someone")
    db.add(user)
    await db.flush()
    return user


async def _membership(db: AsyncSession, building: Building, user: User) -> BuildingMembership:
    membership = BuildingMembership(building_id=building.id, user_id=user.id)
    db.add(membership)
    await db.flush()
    return membership


async def _role(
    db: AsyncSession, membership: BuildingMembership, role: Role, building_id: UUID | None = None
) -> MembershipRole:
    row = MembershipRole(
        building_id=building_id or membership.building_id, membership_id=membership.id, role=role
    )
    db.add(row)
    await db.flush()
    return row


async def _roles_of(db: AsyncSession, membership_id: UUID) -> set[Role]:
    rows = await db.scalars(
        select(MembershipRole.role).where(MembershipRole.membership_id == membership_id)
    )
    return set(rows)


# --- 1, 11: email is unique case-insensitively, and stored lower-cased -------------------------


@pytest.mark.parametrize(
    ("first", "second"),
    [("Alice@Example.com", "alice@example.com"), ("ALICE@example.COM", "alice@EXAMPLE.com")],
)
async def test_email_differing_only_in_case_is_rejected_by_the_database(
    db: AsyncSession, first: str, second: str
):
    # Raw SQL: the model lower-cases emails, so only raw SQL can show the index does the job alone.
    await db.execute(INSERT_USER, {"email": first})

    with pytest.raises(IntegrityError, match="uq_users_lower_email"):
        await db.execute(INSERT_USER, {"email": second})


async def test_a_different_email_is_accepted(db: AsyncSession):
    await db.execute(INSERT_USER, {"email": "Alice@Example.com"})
    await db.execute(INSERT_USER, {"email": "bob@example.com"})

    assert await db.scalar(select(func.count()).select_from(User)) == 2


def test_user_email_is_lower_cased_before_any_sql():
    user = User(email="Alice@Example.COM", full_name="Alice")
    assert user.email == "alice@example.com"

    user.email = "BOB@Example.org"
    assert user.email == "bob@example.org"


async def test_model_insert_of_a_case_variant_is_rejected(db: AsyncSession):
    await _user(db, "alice@example.com")

    with pytest.raises(IntegrityError, match="uq_users_lower_email"):
        await _user(db, "Alice@Example.com")


async def test_stored_email_is_lower_case(db: AsyncSession):
    user = await _user(db, "Alice@Example.COM")

    stored = await db.scalar(text("SELECT email FROM users WHERE id = :id"), {"id": user.id})
    assert stored == "alice@example.com"


# --- 2: one membership per (building, user) -----------------------------------------------------


async def test_second_membership_in_the_same_building_is_rejected(db: AsyncSession):
    a = await _building(db, "a")
    alice = await _user(db, "alice@example.com")
    await _membership(db, a, alice)

    with pytest.raises(IntegrityError, match="uq_building_memberships_building_id_user_id"):
        await _membership(db, a, alice)


async def test_membership_in_another_building_is_allowed(db: AsyncSession):
    a = await _building(db, "a")
    b = await _building(db, "b")
    alice = await _user(db, "alice@example.com")
    await _membership(db, a, alice)

    await _membership(db, b, alice)

    count = await db.scalar(
        select(func.count())
        .select_from(BuildingMembership)
        .where(BuildingMembership.user_id == alice.id)
    )
    assert count == 2


# --- 3: a role can't belong to a membership in another building (composite FK) -----------------


async def test_role_pointing_at_a_membership_in_another_building_is_rejected(db: AsyncSession):
    a = await _building(db, "a")
    b = await _building(db, "b")
    m = await _membership(db, a, await _user(db, "alice@example.com"))

    with pytest.raises(IntegrityError, match="fk_membership_roles_building_id_membership_id"):
        await db.execute(INSERT_ROLE, {"b": b.id, "m": m.id, "role": "resident"})


async def test_model_role_pointing_at_a_membership_in_another_building_is_rejected(
    db: AsyncSession,
):
    a = await _building(db, "a")
    b = await _building(db, "b")
    m = await _membership(db, a, await _user(db, "alice@example.com"))

    with pytest.raises(IntegrityError, match="fk_membership_roles_building_id_membership_id"):
        await _role(db, m, Role.SECURITY, building_id=b.id)


async def test_role_in_the_memberships_own_building_is_accepted(db: AsyncSession):
    a = await _building(db, "a")
    m = await _membership(db, a, await _user(db, "alice@example.com"))

    await db.execute(INSERT_ROLE, {"b": a.id, "m": m.id, "role": "resident"})
    await _role(db, m, Role.SECURITY)

    assert await _roles_of(db, m.id) == {Role.RESIDENT, Role.SECURITY}


# --- 4: one row per (membership, role); several roles allowed ----------------------------------


async def test_duplicate_role_on_a_membership_is_rejected(db: AsyncSession):
    a = await _building(db, "a")
    m = await _membership(db, a, await _user(db, "alice@example.com"))
    await _role(db, m, Role.RESIDENT)

    with pytest.raises(IntegrityError, match="pk_membership_roles"):
        await db.execute(INSERT_ROLE, {"b": a.id, "m": m.id, "role": "resident"})


async def test_membership_may_hold_several_roles(db: AsyncSession):
    a = await _building(db, "a")
    m = await _membership(db, a, await _user(db, "alice@example.com"))
    await _role(db, m, Role.RESIDENT)

    await _role(db, m, Role.COUNCIL)

    assert await _roles_of(db, m.id) == {Role.RESIDENT, Role.COUNCIL}


# --- 5: check constraints on status and role ---------------------------------------------------


async def test_status_outside_the_enum_is_rejected_by_the_database(db: AsyncSession):
    a = await _building(db, "a")
    alice = await _user(db, "alice@example.com")

    # Raw SQL, so SQLAlchemy's enum validation can't catch it first: the CHECK constraint must.
    with pytest.raises(IntegrityError, match="ck_building_memberships_status"):
        await db.execute(
            text(
                "INSERT INTO building_memberships (id, building_id, user_id, status)"
                " VALUES (gen_random_uuid(), :b, :u, 'approved')"
            ),
            {"b": a.id, "u": alice.id},
        )


async def test_role_outside_the_enum_is_rejected_by_the_database(db: AsyncSession):
    a = await _building(db, "a")
    m = await _membership(db, a, await _user(db, "alice@example.com"))

    with pytest.raises(IntegrityError, match="ck_membership_roles_role"):
        await db.execute(INSERT_ROLE, {"b": a.id, "m": m.id, "role": "admin"})


async def _check_definition(db: AsyncSession, name: str) -> str:
    definition = await db.scalar(
        text("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = :name"),
        {"name": name},
    )
    assert definition is not None, f"constraint {name} is missing"
    return str(definition)


# `alembic check` doesn't compare CHECK constraints, so an enum change without a migration would
# otherwise go unnoticed.
@pytest.mark.parametrize(
    ("constraint", "enum"),
    [("ck_building_memberships_status", MembershipStatus), ("ck_membership_roles_role", Role)],
)
async def test_check_in_the_database_lists_exactly_the_enum_values(
    db: AsyncSession, constraint: str, enum: type[MembershipStatus] | type[Role]
):
    definition = await _check_definition(db, constraint)

    assert set(re.findall(r"'([^']*)'", definition)) == {member.value for member in enum}


# --- 6: deleting a membership cascades to its roles, not to the user ---------------------------


async def test_deleting_a_membership_deletes_its_roles_and_keeps_the_user(db: AsyncSession):
    a = await _building(db, "a")
    alice = await _user(db, "alice@example.com")
    m = await _membership(db, a, alice)
    await _role(db, m, Role.RESIDENT)
    await _role(db, m, Role.COUNCIL)

    await db.execute(delete(BuildingMembership).where(BuildingMembership.id == m.id))

    remaining = await db.scalar(
        text("SELECT count(*) FROM membership_roles WHERE membership_id = :m"), {"m": m.id}
    )
    assert remaining == 0
    assert await db.scalar(text("SELECT id FROM users WHERE id = :u"), {"u": alice.id}) == alice.id


# --- 7: roles and buildings live on the membership, never on the user --------------------------


async def test_users_table_has_no_role_or_building_column(db: AsyncSession):
    columns = await db.run_sync(
        lambda sync: [c["name"] for c in inspect(sync.connection()).get_columns("users")]
    )

    assert "email" in columns  # the table really was inspected
    assert [c for c in columns if "role" in c or "building" in c] == []


# --- 8: defaults ----------------------------------------------------------------------------------


async def test_user_and_membership_defaults(db: AsyncSession):
    a = await _building(db, "a")
    alice = await _user(db, "alice@example.com")
    m = await _membership(db, a, alice)
    db.expunge_all()  # re-read from the database, not the objects just added

    user = await db.get_one(User, alice.id)
    assert (user.locale, user.is_active, user.password_hash, user.email_verified_at) == (
        "en",
        True,
        None,
        None,
    )
    membership = await db.get_one(BuildingMembership, m.id)
    assert membership.status is MembershipStatus.PENDING
    assert membership.status_changed_at is not None
    assert membership.status_changed_by_user_id is None


async def test_raw_inserts_get_server_defaults(db: AsyncSession):
    a = await _building(db, "a")
    user_id = (await db.execute(INSERT_USER, {"email": "raw@example.com"})).scalar_one()
    membership_row = (
        await db.execute(
            text(
                "INSERT INTO building_memberships (id, building_id, user_id)"
                " VALUES (gen_random_uuid(), :b, :u) RETURNING status, status_changed_at"
            ),
            {"b": a.id, "u": user_id},
        )
    ).one()
    user_row = (
        await db.execute(
            text(
                "SELECT locale, is_active, password_hash, email_verified_at FROM users"
                " WHERE id = :u"
            ),
            {"u": user_id},
        )
    ).one()

    assert tuple(user_row) == ("en", True, None, None)
    assert membership_row.status == "pending"
    assert membership_row.status_changed_at is not None


# --- 9: users and buildings with memberships aren't deleted; status_changed_by is a user --------


async def test_deleting_a_user_with_a_membership_is_restricted(db: AsyncSession):
    a = await _building(db, "a")
    alice = await _user(db, "alice@example.com")
    m = await _membership(db, a, alice)

    with pytest.raises(IntegrityError, match="fk_building_memberships_user_id_users"):
        async with db.begin_nested():
            await db.execute(delete(User).where(User.id == alice.id))

    assert await db.scalar(select(User.id).where(User.id == alice.id)) == alice.id
    assert await db.scalar(select(BuildingMembership.id).where(BuildingMembership.id == m.id))


async def test_deleting_a_building_with_memberships_is_restricted(db: AsyncSession):
    a = await _building(db, "a")
    m = await _membership(db, a, await _user(db, "alice@example.com"))

    with pytest.raises(IntegrityError, match="fk_building_memberships_building_id_buildings"):
        async with db.begin_nested():
            await db.execute(delete(Building).where(Building.id == a.id))

    assert await db.scalar(select(Building.id).where(Building.id == a.id)) == a.id
    assert await db.scalar(select(BuildingMembership.id).where(BuildingMembership.id == m.id))


async def test_status_changed_by_must_name_an_existing_user(db: AsyncSession):
    a = await _building(db, "a")
    manager = await _user(db, "manager@example.com")
    m = await _membership(db, a, await _user(db, "alice@example.com"))
    set_changed_by = text(
        "UPDATE building_memberships SET status_changed_by_user_id = :by WHERE id = :m"
    )

    await db.execute(set_changed_by, {"by": manager.id, "m": m.id})
    await db.execute(set_changed_by, {"by": None, "m": m.id})
    with pytest.raises(
        IntegrityError, match="fk_building_memberships_status_changed_by_user_id_users"
    ):
        await db.execute(set_changed_by, {"by": UUID(int=1), "m": m.id})


async def test_deleting_the_user_who_changed_a_status_is_restricted(db: AsyncSession):
    a = await _building(db, "a")
    manager = await _user(db, "manager@example.com")
    m = await _membership(db, a, await _user(db, "alice@example.com"))
    m.status_changed_by_user_id = manager.id
    await db.flush()

    with pytest.raises(
        IntegrityError, match="fk_building_memberships_status_changed_by_user_id_users"
    ):
        await db.execute(delete(User).where(User.id == manager.id))


# --- 10: a membership with roles can't move to another building --------------------------------


async def test_moving_a_membership_with_roles_to_another_building_is_rejected(db: AsyncSession):
    a = await _building(db, "a")
    b = await _building(db, "b")
    m = await _membership(db, a, await _user(db, "alice@example.com"))
    await _role(db, m, Role.RESIDENT)

    with pytest.raises(IntegrityError, match="fk_membership_roles_building_id_membership_id"):
        await db.execute(
            text("UPDATE building_memberships SET building_id = :b WHERE id = :m"),
            {"b": b.id, "m": m.id},
        )


async def test_moving_a_membership_without_roles_is_not_blocked_by_the_roles_fk(db: AsyncSession):
    # Control for the test above: the rejection there comes from the roles, nothing else.
    a = await _building(db, "a")
    b = await _building(db, "b")
    m = await _membership(db, a, await _user(db, "alice@example.com"))

    await db.execute(
        text("UPDATE building_memberships SET building_id = :b WHERE id = :m"),
        {"b": b.id, "m": m.id},
    )


# --- review round 1 (M1): the ORM orders these tables by their FKs, not by class name ---------
# Without relationships, the unit of work sorts mappers by `module.ClassName`, so
# `app.memberships...BuildingMembership` would be inserted before `app.users...User`.


async def test_new_user_and_their_membership_can_be_flushed_together(db: AsyncSession):
    a = await _building(db, "a")
    alice = User(id=uuid7(), email="alice@example.com", full_name="Alice")
    manager = User(id=uuid7(), email="manager@example.com", full_name="Manager")
    # Added membership-first on purpose: the flush must still insert the users first.
    db.add(
        BuildingMembership(building_id=a.id, user_id=alice.id, status_changed_by_user_id=manager.id)
    )
    db.add_all([alice, manager])

    await db.flush()

    assert await db.scalar(select(func.count()).select_from(BuildingMembership)) == 1


async def test_membership_and_its_roles_can_be_deleted_together(db: AsyncSession):
    a = await _building(db, "a")
    m = await _membership(db, a, await _user(db, "alice@example.com"))
    role = await _role(db, m, Role.RESIDENT)

    await db.delete(m)
    await db.delete(role)
    with warnings.catch_warnings():
        # The roles must be deleted before the membership, not found already gone by the cascade.
        warnings.simplefilter("error")
        await db.flush()

    assert await _roles_of(db, m.id) == set()


async def test_orm_delete_of_a_membership_leaves_unloaded_roles_to_the_cascade(db: AsyncSession):
    a = await _building(db, "a")
    m = await _membership(db, a, await _user(db, "alice@example.com"))
    await _role(db, m, Role.RESIDENT)
    db.expunge_all()  # the roles aren't in the session: the database must remove them
    membership = await db.get_one(BuildingMembership, m.id)

    await db.delete(membership)
    await db.flush()

    assert await _roles_of(db, m.id) == set()


# --- review round 2 (Codex M1): the ORM path must not depend on whether roles are loaded --------


async def _membership_with_roles_loaded(
    db: AsyncSession, membership_id: UUID
) -> BuildingMembership:
    db.expunge_all()
    query = (
        select(BuildingMembership)
        .where(BuildingMembership.id == membership_id)
        .options(selectinload(BuildingMembership.roles))
    )
    return (await db.scalars(query)).one()


async def test_orm_delete_of_a_membership_with_loaded_roles_deletes_them(db: AsyncSession):
    a = await _building(db, "a")
    alice = await _user(db, "alice@example.com")
    m = await _membership(db, a, alice)
    await _role(db, m, Role.RESIDENT)
    await _role(db, m, Role.COUNCIL)
    membership = await _membership_with_roles_loaded(db, m.id)
    assert len(membership.roles) == 2

    await db.delete(membership)
    await db.flush()

    assert await db.get(BuildingMembership, m.id) is None
    assert await _roles_of(db, m.id) == set()
    assert await db.get(User, alice.id) is not None


async def test_removing_a_role_from_a_loaded_membership_deletes_the_row(db: AsyncSession):
    a = await _building(db, "a")
    m = await _membership(db, a, await _user(db, "alice@example.com"))
    await _role(db, m, Role.RESIDENT)
    await _role(db, m, Role.COUNCIL)
    membership = await _membership_with_roles_loaded(db, m.id)

    (council,) = (r for r in membership.roles if r.role is Role.COUNCIL)
    membership.roles.remove(council)
    await db.flush()

    assert await _roles_of(db, m.id) == {Role.RESIDENT}


async def test_role_appended_to_a_membership_takes_the_memberships_building(db: AsyncSession):
    a = await _building(db, "a")
    m = await _membership(db, a, await _user(db, "alice@example.com"))
    membership = await _membership_with_roles_loaded(db, m.id)

    membership.roles.append(MembershipRole(role=Role.SECURITY))
    await db.flush()

    stored = await db.scalar(
        text("SELECT building_id FROM membership_roles WHERE membership_id = :m"), {"m": m.id}
    )
    assert stored == a.id


# --- 13: enum values ---------------------------------------------------------------------------


def test_membership_status_values_are_the_lowercase_ticket_list():
    assert [s.value for s in MembershipStatus] == [
        "pending",
        "active",
        "denied",
        "suspended",
        "deactivated",
    ]


def test_role_values_are_the_lowercase_ticket_list():
    assert [r.value for r in Role] == ["resident", "security", "property_management", "council"]


def test_staff_roles_are_every_role_but_resident_and_immutable():
    assert {Role.SECURITY, Role.PROPERTY_MANAGEMENT, Role.COUNCIL} == STAFF_ROLES
    assert isinstance(STAFF_ROLES, frozenset)


# --- 12: the migration round-trips, and models match it ------------------------------------------


async def _table_names(url: str) -> set[str]:
    engine = create_async_engine(url)
    try:
        async with engine.connect() as conn:
            return set(await conn.run_sync(lambda sync: inspect(sync).get_table_names()))
    finally:
        await engine.dispose()


def test_migration_upgrades_downgrades_and_upgrades_again():
    # A scratch database, so dropping tables never disturbs the session's test schema.
    url = make_url(settings.test_database_url).set(database="condo_migrations_test")
    scratch = url.render_as_string(hide_password=False)
    assert_safe_test_database_url(scratch, settings.database_url)
    asyncio.run(_recreate_test_schema(scratch))

    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    cfg.attributes["database_url"] = scratch
    cfg.attributes["configure_logger"] = False

    # Pinned revisions, not `-1`: later migrations stack on top and must not change what this tests.
    command.upgrade(cfg, P1_02_REVISION)
    assert asyncio.run(_table_names(scratch)) >= TABLES

    command.downgrade(cfg, P1_02_DOWN_REVISION)
    tables = asyncio.run(_table_names(scratch))
    assert tables & TABLES == set()
    assert "buildings" in tables  # only this revision was undone

    command.upgrade(cfg, "head")
    assert asyncio.run(_table_names(scratch)) >= TABLES
    command.check(cfg)  # raises if the models and the migrated schema differ
