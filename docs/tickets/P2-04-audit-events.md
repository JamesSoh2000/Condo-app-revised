# P2-04 — Audit events

| Field | Value |
|---|---|
| Phase / lane | P2 / A |
| Risk tier | 1 |
| Depends on | P2-03 |
| Replaces old | M3-T05 |
| Status | todo |

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
    - `auth.sessions_revoked_all`
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

1. **Given** a successful login, **then** one `auth.logged_in` event exists with `actor_user_id`, and its
   `request_id` equals the response's `X-Request-ID`.
2. **Given** a failed login for an unknown email, **then** an `auth.login_failed` event exists with no email
   anywhere in the row.
3. **Given** a service that records an audit event and then raises before commit, **then** no audit row
   persists.
4. **Given** `record_audit(..., metadata={"new_password": "x"})`, **then** `ValueError`.
5. **Given** events in A and B, **when** `audit --building maple` runs, **then** only A's events are printed.
6. The grep fitness test passes, and fails when an `update(AuditEvent)` line is added.

## Test plan

- `tests/audit/test_audit.py`, `tests/audit/test_cli_audit.py`
- Commands: `make test`; manual `make cli audit --since 1d` after logging in locally.

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

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
