# Explanation — P1-04 API conventions: errors, pagination, schemas

> **PR:** #49 · **Source revision:** `b281bc6` (pre-merge), the PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (3) reviewed this commit (`b281bc6`).
> **Merge commit:** not known when written; after the merge, `gh pr view 49 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs. The branch
> is rebased onto `origin/main` (`d033334`).
> This is a snapshot: if the code changes later, write a new explanation; do not update this one. Lasting
> decisions live in ADRs.
> Form: full. Tier: 2. Walkthrough variant: A (one real request: an unknown route; the 500 path and the
> pagination SQL in `<details>`).

**What I ran** (2026-10-16, this worktree at `b281bc6`, compose db on port 55432):
`make test DB_PORT=55432` gave **313 passed**. Against the running stack:
`curl -si http://localhost:8000/api/nope -H "X-Request-ID: explain-404"` returned a 404
`application/problem+json` body with `"request_id":"explain-404"`; a 129-character `X-Request-ID` came back
replaced by a UUID; `/api/openapi.json` had operation ids `health_health`, `health_ready`, `version_version`
and component schemas `Problem`, `ProblemError` only. I captured the SQL `paginate` emits (§3). I re-ran two
of the PR's mutations, each reverted: deleting `request.state.request_id = request_id` fails
`test_unhandled_error_is_generic_500_and_logged_with_traceback`; deleting `.offset(None)` fails
`test_paginate_replaces_the_callers_order_and_limit`. Other mutation and red-run results below are quoted
from the PR.

## 1. What was built and why

Every API error now has one shape: an RFC 9457 **problem details** body (media type
`application/problem+json`), with a stable snake_case `code` for frontend logic and the request's
`request_id`. That covers domain errors raised by services, request validation errors, Starlette
`HTTPException`s (unknown route, wrong method) and unhandled exceptions. Lists get one **keyset pagination**
helper (`?limit=&cursor=` → `{items, next_cursor}`, newest first). Operation ids become `<tag>_<function>`,
and OpenAPI documents the real error body, so P1-07 can generate correct TypeScript. CORS middleware is
removed (same-origin, [ADR-0003](../adr/0003-same-origin-server-side-sessions.md)) and `ALLOWED_ORIGINS`
becomes a validated `TRUSTED_ORIGINS` for P2-01's CSRF check.

The two decisions that matter most: how the 500 response gets its `request_id` even though it is built
outside the logging middleware (D1), and the cursor format (D3).

## 2. Decisions

Terms. A **middleware** wraps the app and sees every request and response. Starlette (FastAPI's base)
builds the stack as `ServerErrorMiddleware` (outermost) → the app's own middleware → `ExceptionMiddleware`
→ the router (Starlette 1.2.1 `Starlette.build_middleware_stack`; I read it). A handler registered for
`Exception` runs in `ServerErrorMiddleware`; every other handler runs in `ExceptionMiddleware`. A
**context variable** (`contextvars.ContextVar`) is a per-request global. A **cursor** is an opaque string the
client sends back to get the next page. **base64url** is base64 with `-` and `_` instead of `+` and `/`.

### D1. The 500 response reads the request id from `request.state`; the middleware's log line is the only one

- **Problem or constraint:** the unhandled-exception handler runs in `ServerErrorMiddleware`, outside
  `backend/app/middleware/request_logging.py::RequestLoggingMiddleware`. By then the middleware's `finally`
  has reset `request_id_ctx`, and the `X-Request-ID` header it sets on normal responses never reaches the
  500.
- **Chosen:** the middleware also stores the id on `request.state` (the ASGI scope's state dict, shared with
  the outer handler). `backend/app/core/errors.py::problem_response` reads `request.state` first, then the
  context variable, then generates one, and sets `X-Request-ID` itself on every problem response. The 500's
  log line is the middleware's existing `request_failed` record (traceback and `request_id`);
  `backend/app/core/errors.py::_unhandled_error` doesn't log.
- **Alternatives rejected:** catch the exception inside the middleware and return the 500 there. Rejected
  because the ticket asks for an exception handler, and the logging middleware would also own error
  rendering (PR D1).
- **Tradeoffs and accepted limitations:** `ServerErrorMiddleware` re-raises after sending the 500, so
  uvicorn may log a second, unstructured traceback. Pre-existing; not checked on the stack (PR D1).
- **Basis:** ticket ("store it on `request.state`"); autonomous on not logging twice (Frame notes).
- **Source:** recorded (ticket, Frame notes, PR D1). Evidence:
  `backend/tests/test_errors.py::test_unhandled_error_is_generic_500_and_logged_with_traceback`; I re-ran the
  mutation that removes the `request.state` line and it fails.

### D2. OpenAPI documents `Problem` under `application/problem+json`, including every 422

- **Problem or constraint:** FastAPI files a `responses={…: {"model": …}}` model only under
  `application/json`, and adds its own 422 `HTTPValidationError` schema to every route with parameters, a
  body this API never sends. P1-07 generates TypeScript from this document.
- **Chosen:** `backend/app/core/errors.py::problem_responses` returns raw `content` pointing at
  `#/components/schemas/Problem`, without `model`. `backend/app/core/errors.py::_document_problems` wraps
  `app.openapi` once: it adds `Problem` and `ProblemError` to the components, points every 422 at `Problem`,
  and drops `HTTPValidationError` (and `ValidationError` when nothing refers to it).
- **Alternatives rejected:** `model=Problem` mislabels the media type; adding 422 inside `problem_responses`
  fixes only routes that remember to call it; overriding `get_openapi` wholesale copies FastAPI internals
  (PR D2).
- **Tradeoffs and accepted limitations:** a post-processing pass over the generated document. If FastAPI
  changes its default 422, `test_no_operation_documents_fastapis_default_validation_error` catches it.
- **Basis:** autonomous (criterion 8 added while framing); in HUMAN_INBOX.
- **Source:** recorded (Frame notes, PR D2).

### D3. Cursor = base64url of the last id's 16 bytes, canonical spelling only, unsigned

- **Problem or constraint:** the cursor must be opaque, URL-safe and cheap to validate; garbage must give
  400 `invalid_cursor`.
- **Chosen:** `backend/app/core/pagination.py::encode_cursor` is unpadded base64url (22 characters).
  `backend/app/core/pagination.py::decode_cursor` requires `[A-Za-z0-9_-]{22}`, decodes, and re-encodes:
  22 characters hold 132 bits for 128, so 16 spellings decode to the same id, and only the canonical one is
  accepted. An empty `cursor=` is 400; more than 64 characters is a 422 from the query validator.
- **Alternatives rejected:** an HMAC-signed cursor: unneeded, because a crafted cursor only moves the
  `id <` bound inside the caller's own filtered query, so it can't reveal a row the query wouldn't list.
  Plain UUID text: clients would start parsing it (PR D3).
- **Tradeoffs and accepted limitations:** a cursor from one list is accepted by another list; it just starts
  at that id.
- **Basis:** ticket (opaque base64url); autonomous on the details; in HUMAN_INBOX.
- **Source:** recorded (Frame notes, PR D3).

### D4. A `create_app()` factory; an untagged route fails when declared

- **Problem or constraint:** tests need test-only routes on an app with the real middleware and handlers.
  `f"{route.tags[0]}_{route.name}"` has no answer for a route without a tag.
- **Chosen:** `backend/app/main.py::create_app` builds the app; `app = create_app()` stays the uvicorn entry
  point. `backend/tests/conftest.py::app_client` builds a fresh app per test. `backend/app/main.py::operation_id`
  raises `ValueError` naming the route. FastAPI calls it when the route is added, so the mistake surfaces
  at import time.
- **Alternatives rejected:** adding routes to the global `app` and removing them afterwards (what
  `backend/tests/test_db_isolation.py` does) leaks state if a test forgets. A fallback id like
  `default_<name>` hides the missing tag until P1-07's names come out wrong (PR D4).
- **Tradeoffs and accepted limitations:** the three probe routes in `test_db_isolation.py` needed
  `tags=["probe"]`.
- **Basis:** ticket ("a test-only router included in a test app fixture"); autonomous on the factory and on
  raising.
- **Source:** recorded (Frame notes, PR D4).

### D5. A client `X-Request-ID` is kept only if it is 1–128 characters of `[A-Za-z0-9._-]`

- **Problem or constraint:** the id now goes into every error body as well as headers and logs; before, any
  header value was trusted.
- **Chosen:** anything else is replaced by a generated UUID
  (`backend/app/middleware/request_logging.py::_REQUEST_ID`).
- **Alternatives rejected:** truncating or escaping keeps a client-controlled value we can't trust;
  UUID-only rejects ids proxies commonly send (PR D5).
- **Tradeoffs:** a client with an exotic id loses correlation.
- **Basis:** autonomous (criterion 10); in HUMAN_INBOX. **Source:** recorded (PR D5).

### D6. `TRUSTED_ORIGINS` entries must be bare origins everywhere; production needs `https://`, no loopback

- **Problem or constraint:** P2-01 will compare the browser's `Origin` header to these entries exactly. A
  trailing slash, a path or upper case would silently never match.
- **Chosen:** in every environment each entry must be lowercase `scheme://host[:port]`, http or https,
  with valid labels and a port 1–65535 (`backend/app/core/config.py::_is_origin`). Production also rejects
  an empty list, `*`, any loopback host on any scheme (`backend/app/core/config.py::_is_loopback`) and
  `http://`. The old `allowed_origins` field and `cors_allow_credentials` are gone.
- **Alternatives rejected:** normalising entries (strip slashes, lower-case) is hidden behaviour in a
  security setting (PR D6).
- **Tradeoffs and accepted limitations:** IPv6 literal hosts are rejected as malformed. An old
  `ALLOWED_ORIGINS` line in an untracked `backend/.env` is silently ignored (`extra="ignore"`); the defaults
  are the same. `https://127.1` is still accepted (browsers never send it, so it can never match).
  `https://host:443` is accepted but can never equal a browser `Origin` (round 3 L1, deferred).
- **Basis:** ticket (rename, extend the production validator); autonomous on the format rule; review rounds
  1 (F2) and 2 (F5) tightened it.
- **Source:** recorded (PR D6, review log).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| `type` = `/problems/<code with dashes>` | `about:blank` | The ticket's interface example | ticket | recorded (Frame notes) |
| Default titles are HTTP status phrases; 422 is "Validation Error" | Sentence-case titles | One rule, matching the titles mapped from `HTTPException` | autonomous | recorded (PR table) |
| `HTTPException.detail` kept only below 500, only when a string different from the title | Always keep it | A 5xx detail may describe internals | autonomous | recorded (PR table) |
| An `extra` key that would overwrite a standard member raises `ValueError` at construction | Let `extra` win, or drop it | A spoofed `code` or `request_id` would be a silent bug | autonomous | recorded (PR table) |
| `paginate` replaces the caller's `ORDER BY`, `OFFSET` and `LIMIT`; keeps its `WHERE` | Keep them | The cursor is only correct for `id DESC` | ARCHITECTURE §8 | recorded (PR table, round 2 F3) |
| Problem bodies encoded with `pydantic_core.to_jsonable_python` | `fastapi.encoders.jsonable_encoder` | It writes UTC as `+00:00`; §8 uses `Z` | review round 1 F1 | recorded |
| `problem_response` takes extra members as one `members` dict | Reserve `request`/`headers` as forbidden `extra` keys | A dict can't clash with a parameter name | review round 2 F1 | recorded |
| `HTTPException(204/304)` sends no body | A problem body | Those statuses carry no body (Starlette's default agrees) | review round 2 F2 | recorded |
| `InputModel` extends `APIModel` | Separate bases | Inputs get whitespace stripping too | autonomous | recorded (PR table) |
| `Problem` model has `extra="allow"` | Closed schema | Some codes add members (`retry_after`) | docstring | recorded (code: `backend/app/core/errors.py::Problem`) |

**Framing changes:** commit `f56ceef`. Sharpened: the common problem+json members for every criterion,
and criteria 1–7 (echoed and generated request ids, 405 keeps `Allow`, exact `loc`, no echoed input,
subclass table, `Retry-After`, reserved `extra` keys, `HTTPException` mapping, page sizes and boundaries,
cursor cases, a failing operation-id check). Added: 8 (OpenAPI errors), 9 (no CORS, origin validation), 10
(request-id hygiene), 11 (`APIModel`). Loosened: none.

## 3. How it is implemented

### Overview

- `backend/app/core/errors.py`: the `DomainError` family, four exception handlers, one body builder
  (`problem_response`), and the OpenAPI rewrite. `install_error_handlers` wires them.
- `backend/app/middleware/request_logging.py`: sanitises the request id and puts it on `request.state` and
  in `request_id_ctx`.
- `backend/app/core/pagination.py`: `CursorParams` (query dependency), `Page[T]`, cursor encode/decode and
  `paginate`.
- `backend/app/core/schemas.py`: `APIModel` and `InputModel` bases.
- `backend/app/main.py`: `create_app()`, `operation_id`, no `CORSMiddleware`.
- `backend/app/core/config.py`: `trusted_origins` and its validation.

### Walkthrough (Variant A): `GET /api/nope` with `X-Request-ID: explain-404`

No business endpoint was added; this is the request every client can make today, run on the stack.

1. **HTTP:** the request enters `ServerErrorMiddleware`, then
   `backend/app/middleware/request_logging.py::RequestLoggingMiddleware`. `explain-404` matches
   `_REQUEST_ID`, so it is kept, stored on `request.state.request_id` and set in `request_id_ctx`.
2. **Routing:** no route matches. Starlette's router raises `HTTPException(404)`; `ExceptionMiddleware`
   finds the handler registered for Starlette's `HTTPException`.
3. **Handler:** `backend/app/core/errors.py::_http_exception`. The status isn't 204/304. The title is the
   status phrase "Not Found"; the code is the phrase lower-cased with non-alphanumerics as `_`
   (`not_found`). The detail ("Not Found") equals the title, so it is dropped.
4. **Body:** `problem_response` builds `type` `/problems/not-found`, adds `request_id` last (so nothing can
   overwrite it), encodes with `to_jsonable_python`, sets media type `application/problem+json` and the
   `X-Request-ID` header.
5. **Back out:** the middleware sets `X-Request-ID` again (same value) and logs `request_completed` with
   status 404. Database: none.
6. **Response** (from the stack):

```
HTTP/1.1 404 Not Found
x-request-id: explain-404
content-type: application/problem+json

{"type":"/problems/not-found","title":"Not Found","status":404,"code":"not_found","request_id":"explain-404"}
```

A `DomainError` raised in a service or dependency takes the same path at step 2, but `ExceptionMiddleware`
picks `_domain_error`. A `RequestValidationError` (bad query or body) picks `_validation_error`, which keeps
only `loc`, `msg` and `type` from each pydantic error.

<details><summary>Deeper: the unhandled-exception (500) path</summary>

1. The route raises `RuntimeError("secret dsn")`. `ExceptionMiddleware` has no handler for it and re-raises.
2. `RequestLoggingMiddleware`'s `except` logs `request_failed` with `logger.exception` (so `exc_info` and
   the traceback are on the record) and `request_id`, then re-raises. Its `finally` resets `request_id_ctx`.
3. `ServerErrorMiddleware` calls `_unhandled_error`. The context variable is now empty, but
   `request.state.request_id` survives, so `problem_response` uses it and sets the header itself. The body
   is the fixed title "Internal Server Error" and `code="internal_error"`; the exception text never enters
   it.
4. `ServerErrorMiddleware` then re-raises to the server (uvicorn), which may log its own traceback (not
   verified, §7).

Proved by `backend/tests/test_errors.py::test_unhandled_error_is_generic_500_and_logged_with_traceback`,
which uses `app_client(..., raise_app_exceptions=False)` so the test client returns the 500 instead of
raising.
</details>

<details><summary>Deeper: the SQL paginate runs (captured from Postgres, test-only route shape)</summary>

The caller passed `select(Building).where(Building.slug.startswith("page-")).order_by(Building.slug).offset(3)`
with `limit=25` and a cursor. The statement that reached Postgres:

```sql
SELECT buildings.slug, buildings.name, ..., buildings.id, buildings.created_at, buildings.updated_at
FROM buildings
WHERE (buildings.slug LIKE $1::VARCHAR || '%') AND buildings.id < $2::UUID ORDER BY buildings.id DESC
 LIMIT $3::INTEGER
-- ('page-', UUID('01920000-0000-7000-8000-000000000001'), 26)
```

The caller's filter survived; its `ORDER BY slug` and `OFFSET 3` are gone; `LIMIT` is `limit + 1` (26), and
the 26th row only signals that another page exists.
</details>

### Data model changes

None. No migration.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/core/errors.py` | New: domain errors, handlers, `Problem`, OpenAPI rewrite | +258 / −0 |
| `backend/app/core/pagination.py` | New: `CursorParams`, `Page`, cursor codec, `paginate` | +82 / −0 |
| `backend/app/core/schemas.py` | New: `APIModel`, `InputModel` | +13 / −0 |
| `backend/app/main.py` | `create_app()`, `operation_id`, CORS removed | +35 / −19 |
| `backend/app/middleware/request_logging.py` | Request-id sanitising; `request.state.request_id` | +8 / −1 |
| `backend/app/core/config.py` | `trusted_origins` and validation | +46 / −16 |
| `backend/.env.example`, `backend/.env.dev` | `ALLOWED_ORIGINS` → `TRUSTED_ORIGINS` | +3 / −2 |
| `backend/tests/conftest.py` | `app_client` fixture; shared session override | +44 / −7 |
| `backend/tests/test_errors.py`, `test_pagination.py`, `test_openapi.py`, `test_same_origin.py` | New tests | +696 / −0 |
| `backend/tests/test_config.py` | Renamed fields; new origin tests | +83 / −7 |
| `backend/tests/test_db_isolation.py` | Probe routes tagged | +3 / −3 |
| `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/HUMAN_INBOX.md`, ticket | Docs, inbox rows, framing | +77 / −14 |

**Key excerpts**

`backend/app/core/errors.py::problem_response`
([permalink](https://github.com/JamesSoh2000/Condo-app-revised/blob/b281bc6e3a90ad3d3c3fce79fa41ee3717ad835c/backend/app/core/errors.py#L133-L177))

```python
def problem_response(
    request: Request,
    *,
    status: int,
    code: str,
    title: str,
    detail: str | None = None,
    headers: dict[str, str] | None = None,
    members: Mapping[str, Any] | None = None,
) -> JSONResponse:
    # Set by RequestLoggingMiddleware. request.state survives to the 500 handler, which runs outside
    # the middleware, after the context variable is reset.
    request_id = (
        getattr(request.state, "request_id", None) or request_id_ctx.get() or str(uuid.uuid4())
    )
    body: dict[str, Any] = {
        "type": "/problems/" + code.replace("_", "-"),
        "title": title,
        "status": status,
        "code": code,
    }
    if detail is not None:
        body["detail"] = detail
    body.update(members or {})
    body["request_id"] = request_id
    return JSONResponse(
        # extra members are often UUIDs and datetimes; encoded as response models are (UTC as `Z`).
        to_jsonable_python(body),
        status_code=status,
        headers={**(headers or {}), "X-Request-ID": request_id},
        media_type=PROBLEM_MEDIA_TYPE,
    )


async def _domain_error(request: Request, exc: DomainError) -> JSONResponse:
    return problem_response(
        request,
        status=exc.status,
        code=exc.code,
        title=exc.title,
        detail=exc.detail,
        headers=exc.headers,
        # A dict, not keywords: an extra named like a parameter (`request`, `headers`) can't clash.
        members=exc.extra,
    )
```

- The single builder for every error body; every handler goes through it.
- `request.state` first is D1; `to_jsonable_python` is round 1 F1; `members=` as one dict is round 2 F1.
- Remove `to_jsonable_python` and `Conflict(extra={"package_id": <UUID>})` becomes a 500 (Starlette's
  `json.dumps` raises `TypeError`). Remove the `request.state` read and the 500 gets a different
  `request_id` from its log line.

`backend/app/core/errors.py::DomainError` and `_StatusError` (trimmed)

```python
class DomainError(Exception):
    # ...
    def __init__(
        self,
        code: str,
        status: int,
        title: str,
        detail: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        reserved = _MEMBERS.intersection(extra or {})
        if reserved:
            raise ValueError(f"extra must not overwrite problem members: {sorted(reserved)}")
        # ...


class _StatusError(DomainError):
    """A `DomainError` whose subclass fixes the status and gives the default code and title."""

    def __init__(
        self,
        code: str | None = None,
        title: str | None = None,
        detail: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(code or self.code, self.status, title or self.title, detail, extra)
# ...
class Conflict(_StatusError):
    status, code, title = 409, "conflict", "Conflict"
```

A subclass fixes the status and supplies defaults; the reserved-key check runs at construction, so a bad
`extra` fails where it is written, not in the handler. `code` is the **first positional** parameter, which
is why `NotFound("Package not found")` silently becomes `code="Package not found"` (round 3 M1, deferred;
§7).

`backend/app/core/errors.py::_document_problems` (trimmed)

```python
    build = app.openapi

    def openapi() -> dict[str, Any]:
        if app.openapi_schema is not None:
            return app.openapi_schema
        document = build()  # also caches it in app.openapi_schema, edited in place below
        schemas = document.setdefault("components", {}).setdefault("schemas", {})
        problem = Problem.model_json_schema(ref_template="#/components/schemas/{model}")
        schemas.update(problem.pop("$defs", {}))
        schemas["Problem"] = problem
        for path_item in document.get("paths", {}).values():
            for operation in path_item.values():
                if "422" in operation.get("responses", {}):
                    operation["responses"]["422"]["content"] = copy.deepcopy(_PROBLEM_CONTENT)
        schemas.pop("HTTPValidationError", None)
        if "#/components/schemas/ValidationError" not in json.dumps(document):
            schemas.pop("ValidationError", None)
        return document

    app.openapi = openapi  # type: ignore[method-assign]
```

- D2. Runs once per app (the first call fills FastAPI's cache, which is edited in place).
- Without it, P1-07's generated client would type 422s as `HTTPValidationError` and `problem_responses`'
  `$ref` would point at a schema that doesn't exist.

`backend/app/core/pagination.py::decode_cursor` and `paginate`
([permalink](https://github.com/JamesSoh2000/Condo-app-revised/blob/b281bc6e3a90ad3d3c3fce79fa41ee3717ad835c/backend/app/core/pagination.py#L36-L82))

```python
def decode_cursor(cursor: str) -> UUID:
    """The id a cursor stands for; `BadRequest` `invalid_cursor` if it isn't one we issued."""
    if _CURSOR.fullmatch(cursor):
        last_id = UUID(bytes=base64.urlsafe_b64decode(cursor + "=="))
        # 22 characters hold 4 spare bits; only the canonical spelling is accepted.
        if encode_cursor(last_id) == cursor:
            return last_id
    raise BadRequest(
        code="invalid_cursor",
        title="Invalid cursor",
        detail="Use the next_cursor of a previous page.",
    )
# ...
async def paginate[M, T](
    db: AsyncSession,
    stmt: Select[M],
    id_col: InstrumentedAttribute[UUID],
    params: CursorParams,
    mapper: Callable[[M], T],
) -> Page[T]:
    # ...
    stmt = stmt.order_by(None).order_by(id_col.desc()).offset(None).limit(params.limit + 1)
    if params.after_id is not None:
        stmt = stmt.where(id_col < params.after_id)
    rows = list((await db.scalars(stmt)).all())
    # The extra row only says whether another page exists.
    has_more = len(rows) > params.limit
    rows = rows[: params.limit]
    next_cursor = encode_cursor(getattr(rows[-1], id_col.key)) if has_more else None
    return Page[T](items=[mapper(row) for row in rows], next_cursor=next_cursor)
```

- `decode_cursor` runs inside `CursorParams.__init__`, a FastAPI dependency, so its `BadRequest` reaches
  `_domain_error` like any service error.
- `.where(...)` is added to the caller's statement, so the caller's tenant filter (`building_id`) stays
  (Frame notes). `order_by(None)` and `offset(None)` clear the caller's; the cursor is meaningless under any
  order but `id DESC`.
- Drop `limit + 1` and the last page can't tell "exactly `limit` left" from "more", giving an empty extra
  page. Drop the canonical re-encode check and 15 other strings decode to the same id (the PR's mutation
  fails `test_garbage_cursor_is_400_invalid_cursor[AAAAAAAAAAAAAAAAAAAABx]`).

`backend/app/middleware/request_logging.py::RequestLoggingMiddleware` (first lines of `dispatch`)

```python
_REQUEST_ID = re.compile(r"[A-Za-z0-9._-]{1,128}")


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        request_id = request.headers.get("x-request-id", "")
        if not _REQUEST_ID.fullmatch(request_id):
            request_id = str(uuid.uuid4())
        request.state.request_id = request_id
        token = request_id_ctx.set(request_id)
```

D5 and D1. Without the `request.state` line, the 500 test fails (I re-ran it).

`backend/app/core/config.py::_is_origin` and `_is_loopback`
([permalink](https://github.com/JamesSoh2000/Condo-app-revised/blob/b281bc6e3a90ad3d3c3fce79fa41ee3717ad835c/backend/app/core/config.py#L123-L142))

```python
_LABEL = r"[a-z0-9]([a-z0-9-]*[a-z0-9])?"
_ORIGIN = re.compile(rf"https?://{_LABEL}(\.{_LABEL})*(:[1-9][0-9]{{0,4}})?")
# ...
def _is_origin(origin: str) -> bool:
    if not _ORIGIN.fullmatch(origin):
        return False
    try:
        urlsplit(origin).port  # noqa: B018 (raises ValueError above 65535)
    except ValueError:
        return False
    return True


def _is_loopback(origin: str) -> bool:
    """localhost, *.localhost, 127.0.0.0/8, ::1 or 0.0.0.0, whatever the scheme or port."""
    host = urlsplit(origin).hostname or ""
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_loopback or address.is_unspecified
```

D6. `_is_origin` applies in every environment (called at the end of `validate_production_settings`);
`_is_loopback` only in production. The old check was a prefix match on `http://localhost` and
`http://127.0.0.1`, which let `https://localhost` through (round 1 F2).

`backend/app/main.py::operation_id`

```python
def operation_id(route: APIRoute) -> str:
    """`<first tag>_<function name>` (`packages_create`): stable names for the generated client."""
    if not route.tags:
        raise ValueError(
            f"route {route.name!r} ({route.path}) has no tag; its operation id needs one"
        )
    return f"{route.tags[0]}_{route.name}"
```

Passed as `generate_unique_id_function` in `create_app`. Note: the id is the *function name*, so the
`packages_create` convention in CLAUDE.md holds only if the handler is named `create` (a handler named
`create_package` gives `packages_create_package`). See §8.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| A domain error's `extra` holds a UUID or datetime | Encoded like response models (UTC as `Z`) | `test_extra_with_uuid_and_datetime_values_is_still_the_domain_error` |
| An `extra` key named `request`, `headers`, `members`… | Passed as a dict; no clash | `test_extra_named_like_a_parameter_is_still_the_domain_error` (5 cases) |
| `extra` tries to overwrite `code`, `request_id`… | `ValueError` at construction | `test_extra_cannot_overwrite_a_standard_member` (6 members; `errors`, also reserved, isn't in the list) |
| A password fails validation | Only `loc`/`msg`/`type` kept; value absent | `test_validation_error_never_echoes_the_submitted_value` |
| An unexpected body field | 422 `extra_forbidden` | `test_unknown_body_field_on_input_model_is_rejected` |
| `HTTPException(503, detail=…)` | Detail dropped | `test_http_exception_5xx_drops_its_detail` |
| `HTTPException(204/304)` | No body | `test_http_exception_without_a_body_status_sends_no_body` |
| `HTTPException` with a non-string (dict) detail below 500 | Detail dropped | **No test** |
| A status with no HTTP phrase (e.g. 499) | Title "HTTP Error", code `http_error` | **No test** |
| 405 on an existing route | Problem body; `Allow` kept | `test_wrong_method_is_problem_405_and_keeps_allow_header` |
| Malformed `X-Request-ID` (space, 129 chars, `;`, non-ASCII) | Replaced by a UUID | `test_malformed_client_request_id_is_replaced` (4 cases) |
| Row inserted between page requests | Later pages unchanged | `test_row_inserted_between_requests_does_not_shift_later_pages` |
| Exactly `limit` rows left | `next_cursor` null; no empty page | `test_exact_multiple_of_limit_has_no_empty_last_page` |
| Caller's `ORDER BY`/`LIMIT`/`OFFSET` | Replaced | `test_paginate_replaces_the_callers_order_and_limit` |
| Non-canonical, wrong-length, padded, `+/`, empty cursor | 400 `invalid_cursor` | `test_garbage_cursor_is_400_invalid_cursor` (7 cases) |
| Cursor over 64 chars | 422 on `["query","cursor"]` | `test_overlong_cursor_is_validation_error` |
| Untagged route | `ValueError` naming the route, at declaration | `test_route_without_a_tag_fails_when_declared` |
| Operation-id check passing vacuously | Check proved on a bad document | `test_operation_id_check_reports_duplicate_and_malformed_ids` |
| `https://localhost`, `https://127.4.5.6:8443`, `https://0.0.0.0`, `https://app.localhost` in prod | Rejected | `test_prod_rejects_unsafe_trusted_origins` (11 cases) |
| `https://[::1]` in prod | Rejected (loopback, and malformed anyway) | **No test** for IPv6 |
| Hosts that only look like loopback | Accepted | `test_prod_accepts_hosts_that_only_look_like_loopback` |
| Cross-origin preflight or `Origin` header | No `Access-Control-*` headers | `test_cross_origin_preflight_gets_no_cors_headers`, `test_request_with_an_origin_gets_no_cors_headers` |

All tests above are in `backend/tests/test_errors.py`, `test_pagination.py`, `test_openapi.py`,
`test_same_origin.py` and `test_config.py`; I ran the whole suite (313 passed).

**Acceptance criteria → tests:** 1 → `test_unknown_route_is_problem_404_with_the_clients_request_id`,
`test_unknown_route_without_request_id_gets_a_generated_one`, the 405 test. 2 →
`test_bad_query_param_is_validation_error_pointing_at_the_param` plus the two body tests. 3 →
`test_conflict_is_problem_409_with_its_code_detail_and_extra`, `test_each_domain_error_has_its_status_and_default_code`,
`test_rate_limited_sets_retry_after_header_and_member`, the `extra` and `HTTPException` tests. 4 →
`test_unhandled_error_is_generic_500_and_logged_with_traceback`. 5 →
`test_following_next_cursor_lists_every_row_once_newest_first` (60 rows, 25/25/10, 5 filtered-out rows) plus
the boundary, insert and order tests. 6 → `test_limit_outside_1_to_100_is_validation_error`, `test_no_limit_means_25`,
the cursor tests. 7 → the three operation-id tests. 8 → `test_problem_responses_document_the_problem_schema_as_problem_json`,
`test_no_operation_documents_fastapis_default_validation_error`. 9 → the same-origin and config tests. 10 →
the two request-id tests. 11 → `test_api_model_reads_attributes_and_strips_whitespace`,
`test_input_model_strips_whitespace_and_forbids_unknown_fields`.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | fresh Claude | `e485c9c` | BLOCK | High F1 UUID/datetime `extra` → 500; Medium F2 `https://localhost` accepted in prod; Low F3 `.env.dev` still `ALLOWED_ORIGINS`; Low F4 inbox rows missing | All fixed in `fef1536` (F4 in `0091380`) |
| 2 | fresh Claude | `0091380` | MERGE | Medium F1 `extra={"request": …}` → 500; Low F2 204/304 got a body; Low F3 caller `OFFSET` kept; Low F4 422 `msg` can quote input; Low F5 trailing dot, bad labels, port 0/99999 accepted | F1, F2, F3, F5 fixed in `b281bc6`; F4 accepted |
| 3 | fresh Claude | `b281bc6` | MERGE | Medium M1 positional `NotFound("…")` becomes the code; Low L1 explicit default ports accepted; Low L2 3xx gets a problem body; residual: a `DomainError` raised in middleware becomes a 500 | M1, L1, residual deferred to P2-01; L2 accepted |

Findings that changed the code:

- **Round 1 F1.** `Conflict(extra={"package_id": <UUID>})` → Starlette's `json.dumps` raised
  `TypeError` inside the handler → 500 `internal_error` instead of 409. Fix: encode with
  `to_jsonable_python`. Evidence (PR): `test_extra_with_uuid_and_datetime_values_is_still_the_domain_error`
  failed with 500 before, passes after. Produced the smaller decision on encoding.
- **Round 1 F2.** `TRUSTED_ORIGINS=["https://localhost:8443"]` passed the production validator (the check
  matched `http://` prefixes). Fix: `_is_loopback` parses the host. Evidence (PR): the new
  `test_prod_rejects_unsafe_trusted_origins` cases were red, now green; look-alike hosts still accepted.
- **Round 2 F1.** `Conflict(extra={"request": "r-1"})` → `problem_response() got multiple values for
  argument 'request'` → 500. The round 1 fix hadn't tested this neighbour. Fix: `members=` dict. Evidence:
  `test_extra_named_like_a_parameter_is_still_the_domain_error`, `request` and `headers` red before.
- **Round 2 F2/F3/F5.** 204/304 bodies, kept `OFFSET`, loose origin labels/ports; each with a test the PR
  says was red first (I re-ran the `OFFSET` mutation: it fails).

## 7. Not verified, accepted risks and follow-ups

Not verified:

- Whether uvicorn logs a second, unstructured traceback for a 500 (D1). No crashing route exists on the
  stack; nobody ran it. Tests use the in-process ASGI transport, not uvicorn.
- No real list endpoint exists yet: `paginate` is proved only through the test-only route in
  `backend/tests/test_pagination.py`. How `Page[T]` names itself in OpenAPI (`Page_<Item>_`, per the PR) is
  not tested.
- "Newest first" means newest by id generation (uuid7), not by commit. A row whose id was generated before
  another's but committed after it lands wherever its id falls. The tests insert one flush at a time, so
  concurrent writers aren't covered. Inferred; no record discusses it.
- The Vite proxy path (`:5173/api/...`) wasn't exercised; the PR's transcript says Vite wasn't running.
- Untested branches noted in §5 (dict detail, unknown status phrase, IPv6 loopback, `errors` as a reserved
  `extra` key).

Accepted risks and follow-ups, with where each is tracked. The "Tracked" column was updated after the
bookkeeping commit `4e8dd4c`, which recorded the follow-ups in tickets; nothing else in this explanation
changed, and the code it describes is still `b281bc6`:

| Item | Tracked |
|---|---|
| Round 3 M1: keyword-only `code`/`title`/`detail`/`extra` on subclasses, snake_case check | `docs/tickets/P2-01-sessions-login-logout-csrf.md` "Carried from P1-04"; also an open row in `docs/AGENT_MISTAKES_LOG.md`. PR #49 said "recorded in its ticket" before it was (the P2-01 ticket at `b281bc6` didn't contain it); that early claim is itself logged in `docs/AGENT_MISTAKES_LOG.md` |
| Round 3 L1: reject explicit default ports in `TRUSTED_ORIGINS` | `docs/tickets/P2-01-sessions-login-logout-csrf.md` "Carried from P1-04" |
| Round 3 residual: a `DomainError` raised from a middleware (P2-01's CSRF check is a middleware) bypasses `ExceptionMiddleware` and becomes a 500; the middleware must return `problem_response(...)` | `docs/tickets/P2-01-sessions-login-logout-csrf.md` "Carried from P1-04" (first bullet, with a test for status, code and media type) |
| Round 2 F4 / L2: 422 `msg` can quote input fragments; 3xx gets a problem body | PR only |
| `RequestLoggingMiddleware` logs `error_message=str(exc)` on a 500 (pre-existing) | PR only |
| List routes must add `problem_responses(400)` to document `invalid_cursor` (first list endpoint, P4-01) | `docs/tickets/P4-01-units-api.md` "Carried from P1-04" (with notes that `paginate` needs a one-entity select and that handlers are named by verb) |
| Handoff to P1-07: every error is `Problem` under `application/problem+json`, paged responses are `Page_<Item>_` (untested, see "Not verified"), operation ids are `<tag>_<function name>` | `docs/tickets/P1-07-openapi-types-and-api-client.md` "Carried from P1-04" |
| P1-08: add `http://localhost:8080` to `TRUSTED_ORIGINS` when CSRF lands (P1-08 uses `APP_ENV=dev`, so it passes validation) | `docs/tickets/P1-08-production-like-local-stack.md` "Carried from P1-04", which also carries the unverified D1 check (a second uvicorn traceback for a 500, under "Not verified" above) |
| Rename `ALLOWED_ORIGINS` in an untracked `backend/.env` | PR only (inbox row 41 says it's ignored) |
| D3–D6 autonomous decisions | `docs/HUMAN_INBOX.md` "Decisions to audit" |

## 8. How to change this safely

- **New domain error:** subclass `_StatusError` (or raise `DomainError` directly) and pass `code=` by
  keyword (M1). Its tests go through `app_client(router)` in `backend/tests/conftest.py::app_client`;
  `assert_problem` in `backend/tests/test_errors.py` checks every common member.
- **New problem member:** add it to `_MEMBERS` if it is standard (so `extra` can't spoof it) and to
  `Problem`; `test_problem_responses_document_the_problem_schema_as_problem_json` checks the schema.
- **Error raised in a middleware** (P2-01 CSRF): return `problem_response(request, status=403,
  code="csrf_failed", ...)`; don't raise. A raised `DomainError` there becomes a 500.
- **New list endpoint:** `params: Annotated[CursorParams, Depends()]`, filter `stmt` by the tenant, call
  `paginate(db, stmt, Model.id, params, XOut.model_validate)`, add `responses=problem_responses(400)`. Don't
  pass a multi-column select (only the first column reaches `mapper`). The id column must be uuid7.
- **New router:** give it `tags=[...]` and name handlers by verb if you want `<domain>_<verb>` operation
  ids; `test_operation_ids_are_unique_and_domain_underscore_name` rejects duplicates and bad shapes.
- **Changing `TRUSTED_ORIGINS` rules:** run `backend/tests/test_config.py`; both environments are
  parametrized.

## 9. Must explain, then quiz

**1. Why a stable machine `code` in addition to the HTTP status?** One status covers many failures: 409
can be `package_already_picked_up`, `idempotency_key_reused` or `invalid_transition` (ARCHITECTURE §8), and
403 can be a role, a feature flag or CSRF. The frontend must branch on which one happened, and `title` /
`detail` are human text that may be reworded. `code` is the contract that doesn't change
(`backend/app/core/errors.py::DomainError`); `type` is derived from it.

**2. Why is keyset pagination stable under inserts, and offset isn't?** Offset says "skip the first 25
rows". If a new row is inserted at the top between requests, every row shifts down one, so page 2 repeats
the last row of page 1. Keyset says "rows with `id <` the last id I saw" (`backend/app/core/pagination.py::paginate`):
the bound is a value, not a position, so a newer row (a larger uuid7) falls outside it and the next page is
unchanged. `test_row_inserted_between_requests_does_not_shift_later_pages` proves it. It is also cheaper:
the database seeks the index to the bound instead of reading and discarding skipped rows (Inferred).

**3. Why must a 500 never include the exception message?** An unexpected exception's text is whatever the
failing library put there: a database DSN with a password, SQL, a file path, another tenant's data. The
client can't act on it, and an attacker can probe for it. `backend/app/core/errors.py::_unhandled_error`
returns a fixed title; the client gets the `request_id`, and the operator finds the traceback in the log
line with that id (D1; CLAUDE.md rule 8). The 5xx `HTTPException` detail is dropped for the same reason.

**4. With same-origin hosting, why is CORS middleware unnecessary? What still protects us?** CORS is how a
server tells a browser to *relax* the same-origin policy for a page on another origin. The SPA calls the
relative path `/api/...` on its own origin (Vite proxy in dev, Caddy in prod; ADR-0003), so the browser never
makes a cross-origin API call and needs no permission. Without the middleware, no response carries
`Access-Control-Allow-Origin`, so the browser's default applies: other sites can't read API responses
(`test_cross_origin_preflight_gets_no_cors_headers`). CORS never stopped requests from being *sent*,
though: a hostile page can still submit a form to the API, and a `SameSite=Lax` cookie stops most, not
all, of those from carrying the session (a same-site page on another subdomain still gets it; Inferred).
P2-01 (per its ticket) adds a CSRF middleware: unsafe methods need an `Origin` in `trusted_origins` (why
D6 validates them now) and an `X-Requested-With: fetch` header. A
cross-origin page can't add that custom header without a preflight, and the preflight gets no CORS
approval (Inferred from the P2-01 ticket and this PR).

**Quiz**

1. A service raises `Conflict(code="package_already_picked_up", extra={"picked_up_at": dt})` where `dt` is
   a UTC datetime. What does the client see for `picked_up_at`, and what did it see at `e485c9c`?
2. Why does the 500 response's `request_id` match the log line, even though the context variable is reset
   before the 500 handler runs?
3. A client sends `?cursor=` with the canonical cursor's last character changed by one bit. What happens,
   and why does the code bother?
4. What would break if we removed `.order_by(None)` from `paginate`, for a caller that passes
   `select(Unit).order_by(Unit.name)`?
5. How would you extend this so P2-01's CSRF middleware rejects a request with 403 `csrf_failed` in the
   same body shape?

<details><summary>Answers</summary>

1. `"2026-10-16T12:30:00Z"`-style text, encoded by `to_jsonable_python`. At `e485c9c` the handler's
   `json.dumps` raised `TypeError` (a UUID did; a datetime does too), so the client got 500
   `internal_error` (round 1 F1).
2. `RequestLoggingMiddleware` also writes `request.state.request_id`, which lives in the ASGI scope shared
   with `ServerErrorMiddleware`; `problem_response` reads it first and sets `X-Request-ID` itself (D1).
3. 400 `invalid_cursor`. 22 base64url characters hold 4 spare bits, so 16 strings decode to the same id;
   `decode_cursor` re-encodes and accepts only the spelling the server issued, so a cursor is exactly one
   string (D3; the non-canonical case in `test_garbage_cursor_is_400_invalid_cursor`).
4. SQLAlchemy appends `ORDER BY id DESC` after `name`, so rows are ordered by name, but the cursor bound is
   `id < last_id`. Pages would skip or repeat rows whose ids aren't monotonic in name order, and
   `next_cursor` would point at the wrong row. `test_paginate_replaces_the_callers_order_and_limit` would
   fail.
5. In the middleware, `return problem_response(request, status=403, code="csrf_failed", title="Forbidden")`
   instead of raising `Forbidden` (a raise in middleware skips `ExceptionMiddleware` and becomes a 500, round
   3 residual). Test it through `app_client` with a `POST` route and a missing header, using
   `assert_problem(response, 403, "csrf_failed")`.

</details>
