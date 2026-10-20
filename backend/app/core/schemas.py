"""Base classes for API schemas: `XOut(APIModel)` for responses, `XCreate(InputModel)` for input."""

from typing import Annotated

from pydantic import AfterValidator, BaseModel, ConfigDict, StringConstraints
from pydantic_core import PydanticCustomError

from app.core.config import MAX_EMAIL_ADDRESS_LENGTH, is_email_address


class APIModel(BaseModel):
    # from_attributes: build an XOut from an ORM row (the row itself is never returned).
    model_config = ConfigDict(from_attributes=True, str_strip_whitespace=True)


class InputModel(APIModel):
    # A misspelled or unexpected field is a 422, not silently dropped.
    model_config = ConfigDict(extra="forbid")


def _email(value: str) -> str:
    # One bare ASCII address `queue_email` will send to (P3-02), so the length limits are octets
    # and no NUL or lone surrogate reaches the database. Not stripped: a padded address is refused,
    # not silently changed (the P1-02 carry). Lowered once, here, as `users.email` is.
    if not is_email_address(value):
        raise PydanticCustomError("email_address", "must be one email address")
    return value.lower()


# An email address that is stored and mailed to: invitations (P4-02a) and signup (P4-05a).
EmailAddress = Annotated[
    str,
    StringConstraints(strip_whitespace=False, min_length=1, max_length=MAX_EMAIL_ADDRESS_LENGTH),
    AfterValidator(_email),
]
