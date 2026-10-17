# Explanation — P2-02 Current-user API and session management

> **PR:** #58 · **Source revision:** `f4fce17`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (1) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 58 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs. The branch
> contains `origin/main`.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `f4fce17` the diff (`git diff origin/main...HEAD`: `backend/app/auth/router.py`,
> `backend/app/auth/schemas.py`, `backend/app/auth/service.py`, `frontend/src/api/client.test.ts`), the
> ticket's Frame notes, `backend/app/auth/deps.py`, `backend/app/core/pagination.py`, and the assertions of
> every test cited below in `backend/tests/auth/test_me.py` and `backend/tests/auth/test_session_management.py`.
> Ran those two files: **38 passed**; the full backend suite: **652 passed**. The two SQL statements in §3
> were captured from `get_me` for the world's `multi` user at this revision (a scratch test with a
> `before_cursor_execute` listener, deleted afterwards). The mutation results are quoted from the PR (run at
> `f4fce17` and the commit before it), not re-run for this text. Differences from the plan: none (§2).
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 1. Walkthrough variant: A (`GET /api/auth/me`, then `DELETE /api/auth/sessions/{id}`).

## 1. What was built and why

P2-01b gave the app a session cookie and `get_current_session`, but no endpoint a logged-in user could call.
This ticket adds four, all under `/api/auth`:

- **`GET /me`**: the user plus every membership the shell must show (pending, denied, suspended, active),
  each with its sorted roles, its building and its current unit. The frontend shell (P2-06) bootstraps from
  this one call.
- **`GET /sessions`**, **`DELETE /sessions/{id}`**, **`POST /logout-all`**: see your live sessions, revoke
  one, or revoke all of them. This is the revocation story of
  [ADR-0003](../adr/0003-same-origin-server-side-sessions.md).
- **`revoke_all_sessions(db, user_id)`**: a helper that never commits, for password reset (P4-04) and
  deactivation to reuse inside their own transaction.

The decisions that matter most: memberships in an **inactive building** are hidden like deactivated ones
(D1), and revoking a session that isn't yours, or isn't live, is the **same 404** as an id that doesn't
exist (D3), decided by one conditional `UPDATE`.

## 2. Decisions

### D1. Memberships in an inactive building are left out of `/me`

- **Problem or constraint:** the ticket hides `deactivated` memberships but says nothing about a building
  with `buildings.is_active = false`.
- **Chosen:** `Building.is_active` in `get_me`'s `WHERE`.
- **Alternatives rejected:** include them as they are: the shell would offer a building whose every request
  404s, because P2-03's tenant context refuses inactive buildings. Include them with an `is_active` flag: a
  field the ticket's payload doesn't have, for a state no UI is designed for yet.
- **Tradeoffs and accepted limitations:** a user whose only building was closed gets an empty list, so the
  UI shows "no membership", not "building closed".
- **Basis:** autonomous (decision rule 3). In the inbox's "Decisions to audit".
- **Source:** recorded (ticket Frame notes D1, PR decision D1).

### D2. The session list is a standard `Page`, not a bare array

- **Problem or constraint:** the ticket describes the list as plain objects, but
  `docs/ENGINEERING_PRACTICES.md` says every list endpoint is paginated, and a user's sessions have no bound
  (one per login, each alive up to 30 days).
- **Chosen:** `Page[SessionOut]` (`{items, next_cursor}`) through
  `backend/app/core/pagination.py::paginate`, ordered `id DESC`. Ids are uuid7, so that is newest-created
  first.
- **Alternatives rejected:** a bare array: breaks the convention and has no bound. Order by `last_seen_at`:
  `paginate` orders by id only, and a keyset on a column that moves would skip or repeat rows between pages.
- **Tradeoffs and accepted limitations:** newest-created first, not most-recently-used first.
- **Basis:** decision rule 1 (convention).
- **Source:** recorded (Frame notes D2, PR decision D2).

### D3. Revoking anything but one of your own live sessions is 404

- **Problem or constraint:** the ticket gives 204 for your own session and 404 for someone else's. It
  doesn't cover your own session that is already revoked or expired.
- **Chosen:** one conditional `UPDATE … WHERE id AND user_id AND live RETURNING id`. Zero rows means 404,
  whatever the reason. This is the pattern of CLAUDE.md rule 7.
- **Alternatives rejected:** an idempotent 204 for your own dead session. It needs a second query to tell
  "yours but dead" from "not yours", and that query is exactly what must not change the answer for someone
  else's id.
- **Tradeoffs and accepted limitations:** a client that retries a DELETE whose first response it lost gets
  404, though the session is revoked either way.
- **Basis:** autonomous (rule 3).
- **Source:** recorded (Frame notes D3, PR decision D3).

### D4. Revoking the current session also deletes the cookie

- **Problem or constraint:** `DELETE /sessions/{id}` may name the session making the request.
- **Chosen:** revoke it, and send the same deleting `Set-Cookie` that logout sends.
- **Alternatives rejected:** refuse it with a 409 ("use logout"): an extra error code for something the user
  plainly asked for. Revoke but keep the cookie: leaves a dead cookie in the browser.
- **Tradeoffs and accepted limitations:** none recorded.
- **Basis:** autonomous (rule 3).
- **Source:** recorded (Frame notes D4, PR decision D4).

### D5. `/me` is two queries

- **Problem or constraint:** the ticket asks for "one or two queries, not N+1".
- **Chosen:** query 1 joins memberships to buildings, then outer-joins the current occupancy
  (`ended_at IS NULL`) and its unit. Query 2 reads `membership_roles` for those membership ids, and is skipped
  when there are none. The partial unique index `uq_unit_occupancies_current_membership` (P1-03) allows at
  most one current occupancy per membership, so the outer joins never repeat a membership row.
- **Alternatives rejected:** one query with `array_agg(role)` and `GROUP BY`: more SQL to read, for no gain
  at this size. ORM `selectinload`: three or more queries, and the relationships are `lazy="raise"`.
- **Tradeoffs and accepted limitations:** none recorded.
- **Basis:** ticket.
- **Source:** recorded (Frame notes D6, PR decision D5).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Memberships ordered by building name, then id; roles sorted by value in Python | database order | not stable; Postgres orders an enum by declaration order, not by name | autonomous | PR table, Frame notes D5 |
| Response schemas filled field by field from selected columns | `from_attributes` on a `User`/`AuthSession` | a column added to the row later can't leak into a response | criterion 8 | PR table |
| `SessionOut` has no `ip` | include it | not in the ticket's field list, and it is PII | ticket | PR table |
| `revoke_all_sessions` stamps every not-yet-revoked row, expired ones too, and returns the count | only live rows | simpler, and stamping an expired row changes nothing | autonomous | PR table |
| A non-UUID session id is FastAPI's 422 `validation_error` | 404 | the P1-04 convention for path validation | convention | PR table |
| `client.test.ts` lists the two new GET paths in its exact path set | loosen it to "includes" | an exact equality stays as strict as before | protected-gate rule | PR "Gate changes" |

**Framing changes:** criteria 1–8 sharpened (exact payloads, `multi`'s roles and occupancy per building,
logout-all also kills the caller's replayed cookie and spares other users, identical 404 bodies, 401 on all
four routes, the secret-field check on both the OpenAPI schemas and the real bodies). Criteria 9–16 added
(statuses shown or hidden, ≤ 2 statements, moved out → `null`, a live-only paginated list without `ip`,
the four DELETE cases, CSRF on both unsafe routes, `revoke_all_sessions` never commits, a non-UUID id → 422).
Nothing loosened.

**Plan versus final code:** compared the Plan's files, interfaces, operation ids and risks with the diff.
They match. The one code change after the first implementation commit is a test, not a deviation:
`test_roles_are_sorted_whatever_order_they_were_stored_in` (`f4fce17`), added when a mutation that removed
`sorted()` survived.

## 3. How it is implemented

### Overview

- `backend/app/auth/router.py` holds the four routes. Each takes `Current`, an alias for
  `Depends(get_current_session)`, as its **first** parameter, so the dependency's activity refresh (which
  commits) runs before anything else touches the request's session. That rule is in the docstring of
  `backend/app/auth/deps.py::get_current_session`.
- `backend/app/auth/service.py` holds the work: `get_me`, `list_sessions`, `revoke_session`,
  `revoke_all_sessions`, `logout_all`. A shared `_is_live` condition is now used by `resolve_session` too,
  so "live" means the same thing everywhere.
- `backend/app/auth/schemas.py` holds the response models (`MeOut` and its parts, `SessionOut`). None of
  them has a `password_hash`, `token_hash` or `ip` field.

### Walkthrough (variant A)

**Request 1: `GET /api/auth/me` with a session cookie.**

1. **HTTP → route:** `backend/app/auth/router.py::me`.
2. **Dependency:** `get_current_session` hashes the cookie and finds the live session and its active user
   (`resolve_session`, one query whose `WHERE` now uses `_is_live`). If the session wasn't seen in the last
   5 minutes, `touch_session` writes `last_seen_at` and commits. No cookie, or a dead one: 401
   `not_authenticated`.
3. **Service:** `backend/app/auth/service.py::get_me` runs these two statements (captured for `multi`):

   ```sql
   SELECT building_memberships.id, building_memberships.status, buildings.id AS building_id,
          buildings.name, buildings.slug, buildings.timezone, buildings.locale,
          unit_occupancies.unit_id, units.label, units.tower, unit_occupancies.relationship
   FROM building_memberships
   JOIN buildings ON buildings.id = building_memberships.building_id
   LEFT OUTER JOIN unit_occupancies ON unit_occupancies.membership_id = building_memberships.id
                                   AND unit_occupancies.ended_at IS NULL
   LEFT OUTER JOIN units ON units.building_id = unit_occupancies.building_id
                        AND units.id = unit_occupancies.unit_id
   WHERE building_memberships.user_id = $1::UUID AND building_memberships.status != $2
     AND buildings.is_active
   ORDER BY buildings.name, buildings.id
   ---
   SELECT membership_roles.membership_id, membership_roles.role
   FROM membership_roles
   WHERE membership_roles.membership_id IN ($1::UUID, $2::UUID)
   ```

   The `units` join is on both `building_id` and `id`, matching the composite foreign key from occupancies
   to units (ADR-0005).
4. **Side effects:** none. It is a read; only the dependency's refresh may have written.
5. **Response:** `MeOut`, 200. For the stack's resident1, the transcript in the PR shows
   `"occupancy":{"unit_id":"…","unit_label":"101","tower":null,"relationship":"owner"}`.

**Request 2: `DELETE /api/auth/sessions/{session_id}`.**

1. **CSRF middleware** (P2-01a) runs first: without `X-Requested-With: fetch` and a trusted `Origin` it's
   403 and nothing below runs (`test_revoking_without_csrf_headers_is_refused`).
2. **Dependency:** as above, 401 if not logged in. Then FastAPI parses `session_id` as a UUID, or returns
   422.
3. **Service:** `backend/app/auth/service.py::revoke_session` runs
   `UPDATE sessions SET revoked_at = now WHERE id = :id AND user_id = :caller AND <live> RETURNING id`.
   No row means `NotFound` (404 `not_found`, "Session not found."). One row means commit.
4. **Response:** 204. If the revoked id is the current session, the route also sends the deleting cookie
   (D4).

### Data model changes

None. No migration. The session queries filter on `user_id` with `revoked_at IS NULL`, which the existing
partial index `ix_sessions_user_id_live` (P2-01b) covers.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/auth/service.py` | `get_me`, `list_sessions`, `revoke_session`, `revoke_all_sessions`, `logout_all`, `_is_live` | +179 −14 |
| `backend/app/auth/schemas.py` | response models | +52 −1 |
| `backend/app/auth/router.py` | four routes, the `Current` alias | +41 −3 |
| `frontend/src/api/schema.d.ts` | regenerated (`make gen-api`) | +345 |
| `frontend/src/api/client.test.ts` | exact GET path set gains the two new paths | +5 −1 |
| `backend/tests/auth/test_me.py` | `/me` tests | +246 |
| `backend/tests/auth/test_session_management.py` | session list, revoke, logout-all, schema checks | +398 |
| `docs/tickets/P2-02-me-and-session-management.md` | Frame notes | +58 −5 |

**Key excerpts**

`backend/app/auth/service.py::revoke_session`

```python
async def revoke_session(db: AsyncSession, user_id: UUID, session_id: UUID) -> None:
    """Revoke one live session of the user. Anyone else's, or one no longer live: `NotFound`."""
    revoked = await db.scalar(
        update(AuthSession)
        .where(
            AuthSession.id == session_id,
            AuthSession.user_id == user_id,
            _is_live(clock.now()),
        )
        .values(revoked_at=clock.now())
        .returning(AuthSession.id)
    )
    if revoked is None:
        # The same answer whether the session is someone else's or doesn't exist (ADR-0004).
        raise NotFound(detail="Session not found.")
    await db.commit()
```

- Ownership, liveness and the write are one statement, so no earlier read can answer differently for
  another user's id (D3).
- Without `AuthSession.user_id == user_id`, any logged-in user could log anyone out by id. The mutation
  probe that removed it failed `test_revoking_another_users_session_is_not_found_and_changes_nothing`.
- Without `_is_live`, a second DELETE would be 204, not 404 (two tests failed under that mutation).

`backend/app/auth/service.py::revoke_all_sessions` and `logout_all`

```python
async def revoke_all_sessions(db: AsyncSession, user_id: UUID) -> int:
    """Revoke every session of the user not yet revoked; return how many. Never commits.
    # ...
    """
    revoked = await db.scalars(
        update(AuthSession)
        .where(AuthSession.user_id == user_id, AuthSession.revoked_at.is_(None))
        .values(revoked_at=clock.now())
        .returning(AuthSession.id)
    )
    return len(revoked.all())


async def logout_all(db: AsyncSession, user_id: UUID) -> None:
    await revoke_all_sessions(db, user_id)
    await db.commit()
```

- The helper only flushes an `UPDATE`. The use-case commits once (CLAUDE.md rule 5), so P4-04 can call the
  helper inside its own password-reset transaction.
- Logout-all takes effect on the next request because `resolve_session` checks `revoked_at` every time.
  Nothing is cached.

`backend/app/auth/service.py::get_me` (the query; the mapping into `MeOut` is trimmed)

```python
    rows = (
        await db.execute(
            select(
                BuildingMembership.id,
                BuildingMembership.status,
                Building.id.label("building_id"),
                # ... name, slug, timezone, locale, unit_id, label, tower, relationship
            )
            .join(Building, Building.id == BuildingMembership.building_id)
            # At most one current occupancy per membership (uq_unit_occupancies_current_membership),
            # so these outer joins never repeat a membership.
            .outerjoin(
                UnitOccupancy,
                and_(
                    UnitOccupancy.membership_id == BuildingMembership.id,
                    UnitOccupancy.ended_at.is_(None),
                ),
            )
            # ... outer join units on (building_id, id)
            .where(
                BuildingMembership.user_id == user.id,
                BuildingMembership.status != MembershipStatus.DEACTIVATED,
                Building.is_active,
            )
            .order_by(Building.name, Building.id)
        )
    ).all()
    roles: defaultdict[UUID, list[Role]] = defaultdict(list)
    if rows:
        for membership_id, role in await db.execute(
            select(MembershipRole.membership_id, MembershipRole.role).where(
                MembershipRole.membership_id.in_([row.id for row in rows])
            )
        ):
            roles[membership_id].append(role)
```

- Drop `ended_at.is_(None)` and `a_former` (who left 101 for 102) gets two rows, one per occupancy, and
  someone who moved out shows a unit. Two tests failed under that mutation.
- Roles are sorted later with `sorted(roles[row.id])`. `Role` is a `StrEnum`, so the sort is by value.

`backend/app/auth/router.py::sessions_revoke`

```python
@router.delete("/sessions/{session_id}", status_code=204, responses=problem_responses(401, 404))
async def sessions_revoke(
    current: Current, session_id: UUID, response: Response, db: DbSession
) -> None:
    """Revoke one of the current user's live sessions; 404 for any other id. Revoking this one
    also deletes the cookie, as logout does."""
    await service.revoke_session(db, current.user.id, session_id)
    if session_id == current.session.id:
        _set_session_cookie(response, "", max_age=0)
```

- The cookie is deleted only after the revoke succeeds, and only for the current session. The Sonnet
  reviewer's mutation that deleted it on every DELETE failed
  `test_revoking_another_of_your_sessions_ends_only_that_one`, which asserts no `Set-Cookie`.

`backend/tests/auth/test_session_management.py::test_logout_all_ends_every_session_of_the_user_at_once`

```python
    async with app_client() as other_device, app_client() as someone_else:
        token_1 = await login_as(db, client, user)
        await login_as(db, other_device, user)
        await login_as(db, someone_else, world.a_resident2.user)
        assert (await other_device.get(ME)).status_code == 200

        response = await client.post(LOGOUT_ALL)

        assert response.status_code == 204
        assert_cookie_deleted(response)
        assert_not_authenticated(await other_device.get(ME))
        client.cookies.set(COOKIE, token_1)  # replaying the old cookie
        assert_not_authenticated(await client.get(ME))
        assert (await someone_else.get(ME)).status_code == 200
```

- Three clients, each with its own cookie jar. It proves the caller's own replayed cookie is dead too (the
  cookie deletion alone would not prove that), and that another user is untouched.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Deactivated membership shown | filtered out by status | `test_denied_memberships_are_shown_and_deactivated_ones_are_not`, `test_every_status_but_deactivated_is_shown` |
| Building closed, still offered | filtered by `Building.is_active` | `test_memberships_in_an_inactive_building_are_not_shown` |
| Roles or unit taken from the wrong building's membership | roles keyed by membership id; occupancy joined on membership id | `test_multi_building_user_gets_each_buildings_own_roles_and_occupancy` |
| Past unit shown | `ended_at IS NULL` in the join | `test_former_occupant_sees_only_the_unit_they_live_in_now`, `test_member_who_moved_out_has_no_occupancy` |
| N+1 queries | 2 statements whatever the count | `test_me_takes_at_most_two_statements_however_many_memberships` (3 memberships, statements counted) |
| Unstable role order | Python `sorted` | `test_roles_are_sorted_whatever_order_they_were_stored_in` |
| Listing someone else's sessions | `user_id` filter | `test_session_list_holds_only_the_callers_sessions` |
| Dead sessions listed | `_is_live` | `test_session_list_leaves_out_revoked_and_expired_sessions` (revoked, absolute, idle) |
| Paging skips or repeats | keyset on id | `test_session_list_is_paginated_newest_first` |
| IP leaked | not in `SessionOut` | `test_session_list_keeps_the_user_agent_and_hides_the_ip`, `test_responses_have_no_secret_fields`, `test_response_schemas_have_no_secret_fields` |
| Logging another user out by id | `user_id` in the `UPDATE`; same 404 body as a random id | `test_revoking_another_users_session_is_not_found_and_changes_nothing` |
| Second revoke, or your own expired session | `_is_live` in the `UPDATE` → 404 | `test_revoking_a_session_twice_is_not_found`, `test_revoking_your_own_expired_session_is_not_found` |
| Revoking yourself leaves a dead cookie | cookie deleted | `test_revoking_the_current_session_logs_you_out` |
| Cross-site logout-all or revoke | CSRF middleware 403, nothing revoked | `test_logout_all_without_csrf_headers_is_refused_and_revokes_nothing`, `test_revoking_without_csrf_headers_is_refused` |
| Helper commits inside a caller's transaction | no commit (the test replaces `commit` with a failure) | `test_revoke_all_sessions_revokes_live_ones_and_never_commits` |
| Garbage id → 500 | 422 `validation_error` | `test_a_session_id_that_is_not_a_uuid_is_a_validation_error` |
| Two revocations, or login vs logout-all, at the same instant on two connections | conditional `UPDATE`s | **No test** (§7) |

Acceptance criteria → tests:

1. `test_user_without_memberships_gets_their_profile_and_no_memberships`
2. `test_pending_member_sees_the_pending_membership_without_occupancy`
3. `test_multi_building_user_gets_each_buildings_own_roles_and_occupancy`, `test_memberships_are_ordered_by_building_name_and_roles_sorted`
4. `test_resident_sees_their_current_unit`, `test_former_occupant_sees_only_the_unit_they_live_in_now`, `test_occupancy_carries_the_units_tower`
5. `test_logout_all_ends_every_session_of_the_user_at_once`, plus the stack transcript in the PR
6. `test_session_list_holds_only_the_callers_sessions`, `test_revoking_another_users_session_is_not_found_and_changes_nothing`
7. `test_me_without_a_cookie_is_not_authenticated`, `test_session_endpoints_without_a_cookie_are_not_authenticated`, `test_logout_all_without_a_cookie_is_not_authenticated`
8. `test_response_schemas_have_no_secret_fields` (4 operations, following `$ref`), `test_responses_have_no_secret_fields`
9. `test_suspended_member_sees_the_status_and_their_unit`, `test_denied_memberships_are_shown_and_deactivated_ones_are_not`, `test_every_status_but_deactivated_is_shown`, `test_memberships_in_an_inactive_building_are_not_shown`
10. `test_me_takes_at_most_two_statements_however_many_memberships`
11. `test_member_who_moved_out_has_no_occupancy`
12. `test_session_list_leaves_out_revoked_and_expired_sessions`, `test_session_list_is_paginated_newest_first`, `test_session_list_keeps_the_user_agent_and_hides_the_ip`
13. `test_revoking_another_of_your_sessions_ends_only_that_one`, `test_revoking_a_session_twice_is_not_found`, `test_revoking_your_own_expired_session_is_not_found`, `test_revoking_the_current_session_logs_you_out`
14. `test_logout_all_without_csrf_headers_is_refused_and_revokes_nothing`, `test_revoking_without_csrf_headers_is_refused`
15. `test_revoke_all_sessions_revokes_live_ones_and_never_commits`, `test_revoke_all_sessions_for_a_user_without_sessions_is_zero`
16. `test_a_session_id_that_is_not_a_uuid_is_a_validation_error`

Operation ids: `test_operation_ids`.

**How strong these are:** before implementation, 35 of 37 tests failed. The two that passed early were
`test_revoking_your_own_expired_session_is_not_found` (404 because the route didn't exist) and
`test_revoking_without_csrf_headers_is_refused` (the existing middleware). The first is pinned by the
`_is_live` mutation in `revoke_session`, which fails it. Ten mutations of the service were run (PR "Mutation
probes"). Nine were caught at once. The tenth, removing `sorted()`, survived and led to a new test that
catches it.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Fresh Claude (Sonnet 5.5, high effort), with the security pass | `f4fce17` | MERGE | Low 1: no `Cache-Control: no-store` on `GET /me` and `GET /sessions`. Low 2: no audit events | Low 1 deferred to a follow-up for all authenticated responses (§7). Low 2 already a P2-04 follow-up |
| 1 | Codex `gpt-6-astra`, medium effort | `f4fce17` | MERGE | none | Residual risk noted: no separate-connection concurrency tests (§7) |

No finding changed the code. The Sonnet reviewer ran five mutations of its own (all caught) and a proof test
for a suspected stale `last_seen_at` in the session list. The suspicion didn't hold: the response was fresh.

## 7. Not verified, accepted risks and follow-ups

**Not verified:**

- **Concurrency on separate connections.** The test harness runs every request on one connection, so two
  simultaneous revocations, or a login racing logout-all, were never run in parallel. Inferred: the
  conditional `UPDATE`s make each outcome independent of order. A login that commits after logout-all's
  `UPDATE` leaves a new live session, which is what "log out everywhere *now*" means. No test proves it.
- **`__Host-session` and `Secure` on the deleting cookie in staging.** Same as P2-01b: D-06 checks it
  over HTTPS. Here it was seen only as the plain `session` cookie, in tests and on the local stack.
- **Caching.** `/me` (email, phone, memberships) and the session list are sent without
  `Cache-Control: no-store` (review round 1, Low 1). Browsers don't heuristically cache a JSON response
  without validators, but nothing forbids a cache from keeping it.

**Accepted risks:**

- A user whose only building is inactive sees an empty membership list (D1).
- The session list is newest-created first, not most-recently-used (D2).
- A lost DELETE response, when retried, gives 404 (D3).

**Follow-ups** (added in the bookkeeping commit):

- `Cache-Control: no-store` for authenticated API responses: in P2-03's ticket.
- P2-04: audit `auth.logged_out_all` and `auth.session_revoked`: in P2-04's ticket.
- P4-04 and deactivation: call `revoke_all_sessions` inside their own use-case. P4-04's ticket already names
  the helper.

## 8. How to change this safely

- **A new field in `/me`:** add it to the right `Me*Out` model in `backend/app/auth/schemas.py`, select the
  column in `get_me`'s first query (not another query), map it, then `make gen-api`.
  `test_me_takes_at_most_two_statements_however_many_memberships` fails if you add a query per membership.
  The exact-payload tests (`test_user_without_memberships_gets_their_profile_and_no_memberships`,
  `test_pending_member_sees_the_pending_membership_without_occupancy`) will need the new key.
- **Never** return a `User` or `AuthSession` row or `model_validate` one: `test_response_schemas_have_no_secret_fields`
  catches a secret field name, but not a new PII column.
- **Another way to revoke** (password reset, deactivation): call `revoke_all_sessions` and commit in your
  own use-case. Don't call `logout_all`, which commits.
- **Changing what "live" means:** edit `_is_live` only, so resolve, list and revoke stay in agreement.
- **A new authenticated route:** put `Current` first in its signature.

## 9. Must explain, then quiz

**1. Why does `/me` include pending and denied memberships but not deactivated ones?**
The shell must explain each state: "your request is waiting" (pending), "your request was declined"
(denied), "your access is suspended". Each needs the membership to reach the UI. A deactivated membership
is history: the person left or was removed, there is nothing to act on, and showing it would offer a
building they no longer belong to. The filter is `BuildingMembership.status != MembershipStatus.DEACTIVATED`
in `backend/app/auth/service.py::get_me`. The same reasoning hides inactive buildings (D1). Source: the
ticket's Scope ("so the UI can explain the state").

**2. How does logout-all take effect immediately with server-side sessions? What would it take with JWTs?**
Every request resolves its cookie through `backend/app/auth/service.py::resolve_session`, whose `WHERE`
includes `_is_live` (`revoked_at IS NULL`). `revoke_all_sessions` stamps `revoked_at`, so the next request
from any device finds no row and gets 401. A JWT is checked by its signature and expiry alone, so a token
already issued stays valid until it expires. To revoke one early you need server state anyway: a deny-list
of token ids checked on every request, or a per-user "tokens issued before T are invalid" counter, plus
short access-token lifetimes and refresh-token rotation. That is the complexity ADR-0003 rejected.

**3. Why return 404 (not 403) when deleting someone else's session?**
A 403 says "this exists, but it isn't yours", which tells an attacker that a guessed id is a real session.
A 404 that is identical for someone else's id and a random one reveals nothing. It is the same rule as
ADR-0004's cross-building 404. Here it costs nothing, because the ownership check is inside the one
`UPDATE` in `revoke_session`. `test_revoking_another_users_session_is_not_found_and_changes_nothing`
compares the two bodies.

**Quiz**

1. Why must `Current` be the first parameter of each route in `backend/app/auth/router.py`, and what could
   go wrong if a dependency that adds rows came before it?
2. `a_former` lived in 101, then moved to 102. Without `ended_at IS NULL` in the occupancy join, what does
   `/me` return for them, and which test fails?
3. Why does `revoke_all_sessions` return a count and never commit, while `logout_all` commits?
4. What would break if `AuthSession.user_id == user_id` were removed from `revoke_session`'s `UPDATE`?
5. How would you add a "last used from" city to each session in the list without leaking the raw IP?

<details><summary>Answers</summary>

1. `get_current_session` may call `touch_session`, which commits. Anything another dependency had already
   added to the request's session would be committed with that refresh, even if the endpoint later failed.
   With `Current` first, the refresh's commit holds only the refresh.
2. Two rows for one membership: the join matches both the ended 101 row and the current 102 row, so `/me`
   lists the membership twice, once with each unit. `test_former_occupant_sees_only_the_unit_they_live_in_now`
   fails, and so does `test_member_who_moved_out_has_no_occupancy`, where a moved-out user shows a unit.
3. Password reset and deactivation must revoke sessions in the same transaction as their own change, so
   both happen or neither does. A helper that committed would split that (CLAUDE.md rule 5). The count lets
   a caller report or audit how many it revoked.
4. Any logged-in user could revoke anyone's session by id: a forced logout of other users.
   `test_revoking_another_users_session_is_not_found_and_changes_nothing` fails (the mutation probe showed
   it).
5. Resolve the city when the session starts (or in the worker), store it in a new column, and add only that
   field to `SessionOut`. Keep `ip` out of the schema; `test_response_schemas_have_no_secret_fields` keeps
   checking that it never appears.

</details>
