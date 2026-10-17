# P2-02 — Current-user API and session management

| Field | Value |
|---|---|
| Phase / lane | P2 / A |
| Risk tier | 1 |
| Depends on | P2-01b |
| Replaces old | M3-T03 |
| Status | in progress |

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

- Criteria added or sharpened (the numbered criteria above stay; these make them exact and add cases):
  - **1.** `no_membership`'s `/me` is 200 with its own `user` fields and `"memberships": []`.
  - **2.** `a_pending`'s `/me` has exactly one membership: building A, status `pending`, roles
    `["resident"]`, `occupancy: null`.
  - **3.** `multi`'s `/me` has exactly two memberships: A with roles `["resident"]` and occupancy A-201
    `household`; B with roles `["security"]` and `occupancy: null` (catches roles or occupancy taken from
    the wrong membership, tenant row 3).
  - **4.** `a_resident1`: occupancy `{unit_id: a_101, unit_label: "101", tower: null, relationship:
    "tenant"}`. `a_former`: unit 102, `tenant`; its ended 101 row never appears.
  - **5.** logout-all from client 1 is 204 and deletes the cookie (`Max-Age=0`, same name and flags as
    login's). Afterwards client 2 **and** client 1 replaying its old token get 401 `not_authenticated`;
    another user's session still works.
  - **6.** The list holds only the caller's live sessions, each with `current` true only for the session
    of the calling client. `DELETE` of another user's session id is 404 `not_found`, the same body as a
    random id, and that other session still works afterwards.
  - **7.** Without a cookie, all four endpoints return 401 `not_authenticated` (with CSRF headers sent on
    the unsafe ones, so the 401 is the auth check, not CSRF).
  - **8.** Checked twice: the OpenAPI schemas of all four responses (followed through `$ref`) have no
    property `password_hash`, `token_hash` or `ip`, and neither do the real response bodies.
  - **9 (added).** `/me` shows `denied` and `suspended` memberships with their status (`a_suspended` with
    its current A-201 occupancy); it omits `deactivated` memberships and memberships in an inactive
    building (decision D1 below).
  - **10 (added).** Building `/me` takes at most 2 SQL statements whatever the number of memberships
    (counted with a statement listener for a user with 3 memberships, all with roles and occupancies).
  - **11 (added).** A membership whose only occupancy has ended shows `occupancy: null`.
  - **12 (added).** The session list leaves out revoked, absolutely expired and idle-expired sessions. It
    is a page `{items, next_cursor}` (newest first, `?limit=&cursor=`), like every list (D2). Items carry
    `user_agent`, never `ip`.
  - **13 (added).** `DELETE` of one of the caller's other sessions: 204, that session's client then gets
    401, the caller keeps working. `DELETE` of the caller's own revoked or expired session: 404 (D3).
    `DELETE` of the current session: 204, deletes the cookie, and the next request is 401 (D4).
  - **14 (added).** logout-all and `DELETE` without the CSRF headers get 403 from the middleware and
    revoke nothing.
  - **15 (added).** `revoke_all_sessions(db, user_id)` never commits (a test makes `commit` fail) and
    returns how many sessions it revoked; it skips already-revoked rows.
  - **16 (added).** A session id that isn't a UUID is 422 `validation_error` (problem+json), not a 500.
  - Tenant table (ENGINEERING_PRACTICES §7): none of these routes is building-scoped. Row 2 → criterion 7;
    row 3 → criterion 3 (`multi`); row 5 (someone else's record) → criterion 6, 404 not 403; row 6 →
    criteria 2 and 9 (pending/suspended are shown, not refused: `/me` is how the UI explains them).
    Rows 1, 4, 7 have no role or related id here; rows 8–10: criterion 13 (DELETE twice → 404).
- Criteria loosened: none.
- Decisions taken:
  - **D1** Memberships in an inactive building (`buildings.is_active = false`) are left out of `/me`,
    like deactivated memberships: P2-03's tenant context refuses inactive buildings, so the shell would
    offer a building every request 404s. Autonomous (rule 3); in the inbox.
  - **D2** `GET /api/auth/sessions` returns the standard `Page` (`{items, next_cursor}`, `id DESC`) instead
    of a bare array: ENGINEERING_PRACTICES says every list endpoint is paginated, and a user's sessions
    are unbounded (one per login for 30 days). Basis: rule 1 (convention).
  - **D3** `DELETE` on a session that is the caller's but no longer live is 404, like an unknown id: only
    sessions in the list exist for the caller. Autonomous (rule 3).
  - **D4** `DELETE` of the current session also deletes the cookie, as logout does. Autonomous (rule 3).
  - **D5** Memberships are ordered by building name then building id; roles sorted by value: a stable
    payload for the UI and the tests. Autonomous (rule 3).
  - **D6** `/me` = one query (memberships ⋈ buildings ⟕ current occupancy ⟕ unit) plus one for roles;
    "one or two queries" (ticket).
- Split: none; estimated ~250 non-test lines (schemas ~60, service ~100, router ~70, plus the regenerated
  `schema.d.ts`).
