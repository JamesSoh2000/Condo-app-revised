# P2-04 — Audit events

| Field | Value |
|---|---|
| Phase / lane | P2 / A |
| Risk tier | 1 |
| Depends on | P2-03 |
| Replaces old | M3-T05 |
| Status | done |

## Goal

Sensitive actions write append-only audit events in the same transaction as the action, and operators can
query them from the CLI.

## Why

Audit trails answer "who did what, when". Building managers and privacy law expect that answer. Writing the
event in the same transaction means the record can never claim something happened that didn't, or miss
something that did.

## Scope

- In:
  - **`audit_events` table** (`app/audit/models.py`):
    - `building_id` nullable (identity events have none)
    - `actor_user_id` nullable (system or operator)
    - `action` String(64), `entity_type` String(40), `entity_id` UUID nullable
    - `request_id` String(64), `metadata` JSONB default `{}`, `created_at`
    - indexes `(building_id, created_at DESC)`, `(entity_type, entity_id)`, `(actor_user_id, created_at DESC)`
  - **`record_audit(db, *, action, entity_type, entity_id=None, building_id=None, actor_user_id=None,
    metadata=None)`:**
    - never commits
    - reads `request_id` from the logging contextvar
    - **sanitizes metadata:** raises `ValueError` if a key matches
      `password|token|secret|cookie|authorization` (case-insensitive) or a value is over 1 KiB
  - **Action naming:** `<domain>.<past_verb>`. Constants live in `app/audit/actions.py`.
  - **Wire the auth events now** (P2-01 and P2-02 services):
    - `auth.logged_in`
    - `auth.login_failed` (actor null; metadata `{user_id?}` only when a user matched; never the attempted
      email or password)
    - `auth.logged_out`
    - `auth.logged_out_all` (named `auth.sessions_revoked_all` here before framing; see Frame notes)
    - `auth.session_revoked`
  - **CLI** `python -m app.cli audit [--building SLUG] [--actor EMAIL] [--entity TYPE:ID] [--action PREFIX]
    [--since 7d] [--json]`. It prints the newest first, limit 200.
  - **Append-only by convention:** no update or delete code paths. A fitness test greps for
    `update(AuditEvent` and `delete(AuditEvent`.
- Out:
  - an audit UI (later)
  - retention policy (pilot)
  - domain events (each domain ticket adds its own)

## Interfaces

`record_audit()`, `app/audit/actions.py`, CLI `audit`.

## Acceptance criteria

1. **Given** a successful login, **then** exactly one `auth.logged_in` event exists with `actor_user_id` = the
   user, `entity_type` `session`, `entity_id` = the new session's id, no `building_id`, and its `request_id`
   equals the response's `X-Request-ID`.
2. **Given** a failed login for an unknown email, **then** after the 401 one `auth.login_failed` event is
   committed with `actor_user_id`, `entity_id` and `building_id` null and empty `metadata`, and neither the
   email nor the password appears anywhere in the row (every column, metadata included).
   - 2a. *(added)* A wrong password for a known user, and a correct password for an inactive user: one
     `auth.login_failed` with `metadata == {"user_id": "<id>"}` and `entity_type` `user`; still no email or
     password in the row; the response is the same 401 as for an unknown email.
3. **Given** a service that records an audit event and then raises before commit, **then** no audit row
   persists (a test-only route through the real app: the 500 response, then zero rows).
4. **Given** `record_audit(..., metadata={"new_password": "x"})`, **then** `ValueError`, and nothing is added
   to the session.
   - 4a. *(added)* The same for every listed word in any case (`Token`, `SECRET`, `Cookie`,
     `Authorization`), for a key nested inside a dict or a list value, for a value whose JSON form is over
     1 KiB (1,024 bytes UTF-8), and for a value that isn't JSON (other than `UUID`, stored as its string). A
     value of exactly 1,024 bytes is accepted.
   - 4b. *(added)* `record_audit` never commits: a row it adds is gone after `rollback()`.
5. **Given** events in A, B and an identity event (no building), **when** `audit --building maple` runs,
   **then** only A's events are printed. *(sharpened)* `--actor EMAIL` (case-insensitive), `--entity TYPE:ID`,
   `--action PREFIX` (a literal prefix: `_` and `%` are not wildcards) and `--since 7d` (`<n>m|h|d`) each
   narrow the result and combine with AND; the output is newest first (`created_at`, then `id`) and at most
   200 rows; `--json` prints a JSON array of the same rows. An unknown building slug or actor email exits 1
   with an error; a malformed `--since` or `--entity` exits 2 (usage error) without opening a session.
6. The grep fitness test passes, and fails when an `update(AuditEvent)` line is added. *(sharpened)* It also
   reports `delete(AuditEvent`, `AuditEvent.__table__.update(` / `.delete(`, and raw SQL
   `UPDATE audit_events` / `DELETE FROM audit_events` (case-insensitive), each proven by a meta-test.
7. *(added)* `auth.logged_out` is recorded once when `POST /api/auth/logout` revokes a session (actor
   = its user, entity = the session; an expired but unrevoked session is revoked too, as before this
   ticket); a logout with no cookie, an unknown token or an already-revoked session records nothing.
8. *(added, from the P2-02 carry)* `POST /api/auth/logout-all` records one `auth.logged_out_all` (actor and
   entity = the user, `metadata == {"count": <sessions revoked>}`); `DELETE /api/auth/sessions/{id}` records
   one `auth.session_revoked` (entity = that session) on 204 and nothing on 404.
9. *(added, a case the ticket missed)* A client-supplied `X-Request-ID` of 128 characters (the longest the
   request middleware accepts) is stored whole and the login still succeeds; outside a request (CLI)
   `request_id` is null.

## Test plan

- `tests/audit/test_audit.py`, `tests/audit/test_cli_audit.py`
- Commands: `make test`; manual `make cli args="audit --since 1d"` after logging in locally.

## Likely files

`backend/app/audit/{models,service,actions}.py`, `backend/app/auth/service.py`, `backend/app/cli.py`,
`backend/migrations/versions/<new>.py`, `backend/tests/audit/*`, `backend/tests/test_architecture.py`.

## Must explain (learning checkpoint)

1. Why must the audit row be written in the same transaction as the action?
2. Why does `auth.login_failed` *not* store the attempted email? What is the trade-off?
3. What makes a log entry "append-only" in practice, and how could a real system make it tamper-evident?

## Carried from P1-06 (do while framing)

- There is no `make cli` target; the test plan's `make cli audit …` needs one (for example
  `cli: ; $(COMPOSE) exec app python -m app.cli $(args)`), or use `docker compose exec app python -m app.cli
  audit …`. `audit` is a placeholder in `backend/app/cli.py` that exits 1 until this ticket replaces it.

## Carried from P2-01b (do while framing)

- Wire the `auth.*` events into `app/auth/service.py::login` and `logout` (no audit there yet). A failed login
  must log no password and should not record whether the email exists in anything a client can read.

## Carried from P2-02 (do while framing)

- Also audit `app/auth/service.py::logout_all` (`auth.logged_out_all`, metadata: the count
  `revoke_all_sessions` returns) and `revoke_session` (`auth.session_revoked`, metadata: the session id).
  Both are use-cases that commit once; `record_audit` goes before that commit.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: 1 (exact shape of the event); 2 (every column checked, committed despite
  the 401) and 2a (known user, inactive user); 3 (through the real app); 4a (case, nesting, size boundary,
  non-JSON values) and 4b (never commits); 5 (each filter, ordering, limit, `--json`, error exits, literal
  prefix); 6 (the neighbouring ways to update or delete); 7 (logout no-ops record nothing); 8 (logout-all
  and session revoke, from the P2-02 carry); 9 (long request ids). Tenant table (ENGINEERING_PRACTICES §7):
  this ticket adds no building route, so rows 1–8 don't apply; the CLI's building filter (criterion 5)
  is the isolation check.
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - `request_id` is `String(128)` and nullable, not `String(64)`: `RequestLoggingMiddleware` keeps a
    client's `X-Request-ID` up to 128 characters, so 64 would make such a login fail with a 500; CLI
    commands have no request (autonomous, criterion 9).
  - Logout-all is `auth.logged_out_all`, not the Scope's `auth.sessions_revoked_all`: the ticket names
    both (Scope vs the P2-02 carry). The event belongs to the use-case (`logout_all`), not to the helper
    `revoke_all_sessions`, which password reset and deactivation will reuse under their own actions
    (ticket carry; autonomous choice between the two).
  - `auth.session_revoked` carries the session id in `entity_id`, not in `metadata` (the carry said
    "metadata: the session id"): the same fact, but `--entity session:<id>` can find it.
  - A failed login commits its `auth.login_failed` row before raising (the use-case's one commit on that
    path), since the router doesn't commit (CLAUDE.md rule 5).
  - `created_at` is set from `app.core.clock.now()` by `record_audit` (with `now()` as server default), so
    `--since` and the frozen test clock agree (convention: `start_session`).
  - `make cli args="…"` instead of the Carried note's `make cli audit …` (make treats extra words as
    targets) (P1-06 carry).
  - Append-only stays a convention plus the fitness test (ticket); no trigger. `seed --reset` (dev only)
    still truncates every table, `audit_events` included.
- Split: none. Estimate ~350 non-test lines (model + migration ~100, service and actions ~110, auth wiring
  ~40, CLI and report ~90, Makefile and docs ~10).
