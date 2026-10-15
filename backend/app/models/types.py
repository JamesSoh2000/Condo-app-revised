from enum import Enum as PythonEnum

from sqlalchemy import Enum as SQLAlchemyEnum


def database_enum(
    enum_class: type[PythonEnum],
    *,
    name: str,
) -> SQLAlchemyEnum:
    return SQLAlchemyEnum(
        enum_class,
        name=name,
        native_enum=False,
        create_constraint=True,
        validate_strings=True,
        values_callable=lambda members: [member.value for member in members],
    )
