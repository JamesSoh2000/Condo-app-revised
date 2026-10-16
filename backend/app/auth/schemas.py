from typing import Annotated

from pydantic import Field, StringConstraints, field_validator

from app.core.schemas import InputModel
from app.core.security import PASSWORD_MAX_LENGTH


class LoginIn(InputModel):
    # A plain string: a malformed email is an unknown one (401), not a 422 that tells it apart.
    email: str = Field(min_length=1, max_length=320)
    # Not stripped (InputModel strips strings): spaces are part of a password. Capped before it
    # reaches argon2; no password over the policy's maximum can have been set.
    password: Annotated[
        str,
        StringConstraints(strip_whitespace=False, min_length=1, max_length=PASSWORD_MAX_LENGTH),
    ]

    @field_validator("email")
    @classmethod
    def _no_nul(cls, email: str) -> str:
        # Postgres text can't hold NUL: the lookup would fail with a 500 (P2-01b review round 1).
        if "\x00" in email:
            raise ValueError("must not contain NUL characters")
        return email
