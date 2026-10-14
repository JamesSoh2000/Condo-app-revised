# P1-04 — API conventions: errors, pagination, schemas

| Field | Value |
|---|---|
| Phase / lane | P1 / B (moved from A to shorten lane A's critical path) |
| Risk tier | 2 |
| Depends on | P0-02 |
| Replaces old | M2-T09 |
| Status | todo |

## Goal

Every API error is RFC 9457 `application/problem+json` with a stable `code`. Lists paginate by keyset
cursor. Operation IDs are predictable for type generation. Same-origin replaces CORS.

## Why

The frontend can then handle every error and list the same way (P1-07), and agents copy one pattern instead
of inventing new ones. See [02 §8](../ARCHITECTURE.md#8-api-conventions).

## Scope

- In:
  - **`app/core/errors.py`:**
    - `DomainError(code, status, title, detail=None, extra=None)` and its subclasses `NotFound` (404),
      `Forbidden` (403), `Unauthorized` (401), `Conflict` (409), `RateLimited` (429, `retry_after`),
      `BadRequest` (400)
    - exception handlers for `DomainError`, `RequestValidationError` (422, `code="validation_error"`,
      `errors=[{loc,msg,type}]`), Starlette `HTTPException` (mapped to problem+json), and unhandled
      `Exception` (500, generic body; full traceback logged)
    - every body includes `request_id`, taken from the request-logging middleware. Store it on
      `request.state` and in a `contextvars.ContextVar` if not already done.
  - **`app/core/pagination.py`:**
    - `CursorParams` dependency: `limit` 1–100, default 25; `cursor` is an opaque base64url string
    - `Page[T]` generic model `{items: list[T], next_cursor: str | None}`
    - `async paginate(db, stmt, id_col, params, mapper)` with keyset `WHERE id < :cursor ORDER BY id DESC
      LIMIT limit+1`
    - an invalid cursor gives 400 `invalid_cursor`
  - **`app/core/schemas.py`:** `APIModel` (from_attributes, str_strip_whitespace) and `InputModel`
    (extra='forbid').
  - **OpenAPI:**
    - `generate_unique_id_function` gives `operation_id = f"{route.tags[0]}_{route.name}"`
    - a helper `problem_responses(*codes)` for route `responses=` documentation
  - **Same-origin:**
    - remove `CORSMiddleware` from `app/main.py`
    - rename `allowed_origins` to `trusted_origins` (used by CSRF in P2-01)
    - update the production validator and `.env.example`
- Out:
  - CSRF middleware (P2-01)
  - auth

## Interfaces

Error body:

```json
{"type": "/problems/package-already-picked-up", "title": "Package already picked up", "status": 409,
 "code": "package_already_picked_up", "detail": "…", "request_id": "…"}
```

## Acceptance criteria

1. **Given** an unknown route, **then** 404 problem+json with `code="not_found"` and a `request_id` equal to
   the `X-Request-ID` response header.
2. **Given** a test route with an int query param called with `abc`, **then** 422 with
   `code="validation_error"` and an `errors[0].loc` pointing to the param.
3. **Given** a test route raising `Conflict(code="x_conflict")`, **then** 409 with `code="x_conflict"` and
   media type `application/problem+json`.
4. **Given** a test route raising `RuntimeError("secret dsn")`, **then** 500 whose body does not contain
   "secret", while the log line has the traceback and `request_id`.
5. **Given** 60 rows and `limit=25`, **when** following `next_cursor`, **then** 3 pages, 60 unique ids, with
   the last page's `next_cursor` null.
6. `limit=101` gives 422. A garbage cursor gives 400 `invalid_cursor`.
7. **Given** the OpenAPI document, **then** all operation IDs are unique and match `^[a-z]+_[a-z_]+$`.

## Test plan

- `tests/test_errors.py` and `tests/test_pagination.py`, using a test-only router included in a test app
  fixture.
- `tests/test_openapi.py`
- Commands: `make test`

## Likely files

`backend/app/core/{errors,pagination,schemas}.py`, `backend/app/main.py`,
`backend/app/middleware/request_logging.py`, `backend/app/core/config.py`, `backend/.env.example`,
`backend/tests/test_{errors,pagination,openapi}.py`.

## Must explain (learning checkpoint)

1. Why give clients a stable machine `code` in addition to the HTTP status?
2. Why is keyset pagination stable when rows are inserted between page requests, and offset pagination isn't?
3. Why must a 500 response never include the exception message?
4. With same-origin hosting, why is CORS middleware unnecessary? What still protects us from cross-site
   requests (preview of P2-01)?

## Frame notes (filled by the human in step 1)

- Design prediction:
- Extra cases added:
