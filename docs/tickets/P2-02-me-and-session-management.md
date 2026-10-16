# P2-02 — Current-user API and session management

| Field | Value |
|---|---|
| Phase / lane | P2 / A |
| Risk tier | 1 |
| Depends on | P2-01b |
| Replaces old | M3-T03 |
| Status | todo |

## Goal

The frontend can initialize any shell (no membership, pending, denied, active, multi-building) from one
`GET /api/auth/me` call. Users can see and revoke their own sessions, or log out everywhere.

## Why

The app shell (P2-06) needs a single, trustworthy bootstrap payload. Session management is part of the
revocation story in [ADR-0003](../adr/0003-same-origin-server-side-sessions.md).

## Scope

- In:
  - **`GET /api/auth/me`** returns:
    ```json
    {
      "user": {"id", "email", "full_name", "phone", "locale"},
      "memberships": [
        {"membership_id", "status", "roles": [...],
         "building": {"id", "name", "slug", "timezone", "locale"},
         "occupancy": {"unit_id", "unit_label", "tower", "relationship"} | null}
      ]
    }
    ```
    - It includes `pending`, `denied` and `suspended` memberships, so the UI can explain the state.
    - It excludes `deactivated` memberships.
    - It uses one or two queries, not N+1.
  - **`POST /api/auth/logout-all`:** revokes every session of the user, including the current one, clears
    the cookie, returns 204.
  - **`GET /api/auth/sessions`:** own active sessions `{id, created_at, last_seen_at, user_agent, current: bool}`.
  - **`DELETE /api/auth/sessions/{id}`:** revokes one own session (204). Another user's session ID gives 404.
  - **Service `revoke_all_sessions(db, user_id)`** (no commit), reused by password reset and deactivation.
  - Response schemas never include `password_hash` or `token_hash`.
- Out:
  - profile editing (P6-06)
  - building-scoped data (P2-03)

## Interfaces

Endpoints above, with operation IDs `auth_me`, `auth_logout_all`, `auth_sessions_list` and
`auth_sessions_revoke`.

## Acceptance criteria

1. **Given** `no_membership`, **then** `/me` returns an empty `memberships` list with 200.
2. **Given** `a_pending`, **then** `/me` shows status `pending` and `occupancy: null`.
3. **Given** `multi`, **then** `/me` lists both buildings with the correct roles and A's occupancy.
4. **Given** `a_resident1`, **then** `/me` shows occupancy unit `101`, relationship `tenant`.
   `a_former`'s `/me` shows 102 as the current
   unit, not 101.
5. **Given** two sessions (two clients), **when** client 1 calls logout-all, **then** client 2's next request
   gets 401.
6. **Given** user X lists sessions, **then** only X's sessions appear. Deleting user Y's session ID gives 404.
7. **Given** no cookie, **then** `/me` returns 401 `not_authenticated`.
8. **Given** the response JSON, **then** it contains no keys named `password_hash` or `token_hash` (schema
   test).

## Test plan

- `tests/auth/test_me.py`, `tests/auth/test_session_management.py`, using the world fixture.
- Commands: `make test`, `make gen-api`.

## Likely files

`backend/app/auth/{router,service,schemas}.py`, `backend/tests/auth/*`, `frontend/src/api/schema.d.ts`
(regenerated).

## Must explain (learning checkpoint)

1. Why does `/me` include pending and denied memberships but not deactivated ones?
2. How does logout-all take effect immediately with server-side sessions? What would it take with JWTs?
3. Why return 404 (not 403) when deleting someone else's session?

## Carried from P2-01b (do while framing)

- Protect `/me` with `app/auth/deps.py::get_current_user`, listed before any dependency that adds to the
  request's session (its refresh commits). `CurrentSession.session.id` identifies the current session for
  the session list; logout-all can use `ix_sessions_user_id_live`.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
