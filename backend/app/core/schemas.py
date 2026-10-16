"""Base classes for API schemas: `XOut(APIModel)` for responses, `XCreate(InputModel)` for input."""

from pydantic import BaseModel, ConfigDict


class APIModel(BaseModel):
    # from_attributes: build an XOut from an ORM row (the row itself is never returned).
    model_config = ConfigDict(from_attributes=True, str_strip_whitespace=True)


class InputModel(APIModel):
    # A misspelled or unexpected field is a 422, not silently dropped.
    model_config = ConfigDict(extra="forbid")
