# P1-04 — API conventions: errors, pagination, schemas

| Field | Value |
|---|---|
| Phase / lane | P1 / B (moved from A to shorten lane A's critical path) |
| Risk tier | 2 |
| Depends on | P0-02 |
| Replaces old | M2-T09 |
| Status | done |

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

Every error response below has media type `application/problem+json`, the members `type`, `title`,
`status`, `code`, `request_id` (plus `detail` when there is one), `status` equal to the HTTP status, and
`request_id` equal to the `X-Request-ID` response header. *(sharpened: applies to every criterion)*

1. **Given** an unknown route, **then** 404 problem+json with `code="not_found"` and a `request_id` equal to
   the `X-Request-ID` response header. *(sharpened)* A request sent with `X-Request-ID: req-abc` gets
   `req-abc` back in both places; a request without one gets a generated id in both. *(added, missed
   case)* A wrong method on an existing route gives 405 `code="method_not_allowed"` and keeps the `Allow`
   header.
2. **Given** a test route with an int query param called with `abc`, **then** 422 with
   `code="validation_error"` and an `errors[0].loc` pointing to the param. *(sharpened)* `errors[0].loc ==
   ["query", "<param>"]`, and each item has exactly the keys `loc`, `msg`, `type`. *(added, missed case)* A
   body field that fails validation (an `InputModel` with a too-short `password`) is reported without its
   value: the submitted value appears nowhere in the response. An unknown body field on an `InputModel`
   gives 422 with `type="extra_forbidden"`.
3. **Given** a test route raising `Conflict(code="x_conflict")`, **then** 409 with `code="x_conflict"` and
   media type `application/problem+json`. *(sharpened)* `type` is `/problems/x-conflict`; `title` defaults to
   "Conflict"; `detail` and `extra` members are passed through. *(added)* Each subclass has its status and a
   snake_case default code (`NotFound` 404 `not_found`, `Forbidden` 403 `forbidden`, `Unauthorized` 401
   `unauthorized`, `BadRequest` 400 `bad_request`, `RateLimited` 429 `rate_limited`); `RateLimited(
   retry_after=30)` sets the `Retry-After: 30` header and `retry_after: 30` in the body. An `extra` key that
   would overwrite a standard member raises `ValueError` when the error is created. Starlette/FastAPI
   `HTTPException`s map to problem+json with a code derived from the status (`404` → `not_found`), and their
   string `detail` is kept below 500 and dropped from 5xx.
4. **Given** a test route raising `RuntimeError("secret dsn")`, **then** 500 whose body does not contain
   "secret", while the log line has the traceback and `request_id`. *(sharpened)* The body is
   `code="internal_error"` with the generic title, and its `request_id` equals the `X-Request-ID` header
   (sent by the client); the `app.request` log record for it has that `request_id` and `exc_info` of the
   `RuntimeError`, and its JSON line has an `exception` field with the traceback.
5. **Given** 60 rows and `limit=25`, **when** following `next_cursor`, **then** 3 pages, 60 unique ids, with
   the last page's `next_cursor` null. *(sharpened)* The pages hold 25, 25 and 10 items, all ids in `id DESC`
   order across pages. *(added)* A row inserted with a newer id between page requests doesn't shift or
   repeat later pages; a query that already has `ORDER BY`/`LIMIT` gets `paginate`'s order and limit; with
   exactly `limit` rows left, `next_cursor` is null (no empty last page); filters in the caller's statement
   still apply.
6. `limit=101` gives 422. A garbage cursor gives 400 `invalid_cursor`. *(sharpened)* `limit=0` gives 422; no
   `limit` means 25. `invalid_cursor` covers non-base64url text, the wrong length, a non-canonical
   encoding of an otherwise valid id, and an empty `cursor=`. A cursor longer than 64 characters gives 422.
7. **Given** the OpenAPI document, **then** all operation IDs are unique and match `^[a-z]+_[a-z_]+$`.
   *(added)* Proved able to fail: the same check reports a document with a duplicate or malformed id; a route
   with no tag fails when it is declared, with a message naming the route.
8. *(added)* OpenAPI documents the real error format: `problem_responses(404, 409)` documents those statuses
   with the `Problem` schema under `application/problem+json`; no operation documents FastAPI's default
   `HTTPValidationError` (422s reference `Problem` too).
9. *(added)* Same-origin: a cross-origin preflight (`OPTIONS` with `Origin: http://evil.example`) gets no
   `Access-Control-Allow-Origin` header, nor does a simple request with an `Origin`. `TRUSTED_ORIGINS` parses
   from JSON like the old `ALLOWED_ORIGINS`. Each entry must be an origin (`scheme://host[:port]`: no path,
   no trailing slash) in every environment; production also rejects `*`, an empty list, localhost and
   `http://` entries.
10. *(added)* A client `X-Request-ID` that isn't 1–128 characters of `[A-Za-z0-9._-]` is replaced by a
    generated id (it is echoed into headers, logs and bodies).
11. *(added)* `APIModel` strips whitespace from strings and builds from ORM attributes.

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

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: the common problem+json members (all); 1 (echoed and generated
  request ids; 405 with `Allow`), 2 (exact `loc`, item keys, no echoed input, `extra_forbidden`), 3 (type,
  default title, subclass table, `Retry-After`, reserved `extra` keys, `HTTPException` mapping, 5xx detail
  dropped), 4 (`internal_error`, header, which log record), 5 (page sizes, order, concurrent insert,
  caller ordering, exact-multiple boundary, filters), 6 (`limit=0`, default, cursor cases), 7 (the check can
  fail; untagged routes); new 8 (OpenAPI error documentation), 9 (CORS gone, origin validation), 10
  (request-id hygiene), 11 (`APIModel`).
- Tenant table (ENGINEERING_PRACTICES §7): no tenant endpoint here. `paginate` keeps the caller's `WHERE`
  (criterion 5), which is how later list endpoints keep their `building_id` filter.
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - `type` is `/problems/<code with dashes>` (ticket's interface example).
  - The cursor is the base64url (no padding) of the last id's 16 bytes; unsigned, because `paginate` only
    narrows the caller's own filtered query (autonomous; reversible).
  - Tests get the app from a `create_app()` factory in `app/main.py`, so test routers never touch the real
    app (ticket: "a test-only router included in a test app fixture"; autonomous on the factory).
  - The 500 log line is the request-logging middleware's existing `request_failed` record; the handler
    doesn't log a second one (autonomous).
  - Criterion 8 adds an `openapi()` override because FastAPI files additional-response models only under
    `application/json` (fastapi 0.136 `openapi/utils.py`), and the default 422 schema would hand P1-07
    a type that never occurs (autonomous).
- Split: none; estimate ~330 non-test lines.
