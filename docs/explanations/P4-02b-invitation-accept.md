# Explanation — P4-02b Invitation lookup and accept

> **PR:** #87 · **Source revision:** `2d82eb7`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (5, a verification round) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 87 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. James decided one design question in session (inbox B-6, option A) and approved review rounds
> 4 and 5. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and the squash
> merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `2d82eb7` the diff (`git diff --stat origin/main...HEAD`, 25 paths), the whole
> public half of `backend/app/invitations/service.py` (from `_TOKEN` to the end), the diffs of
> `backend/app/auth/service.py`, `backend/app/invitations/{schemas,router}.py`, `backend/app/logging_config.py`,
> `backend/app/core/{csrf,errors,config}.py`, `backend/app/middleware/request_logging.py`, the test names and
> the assertions of every test cited below, PR #87's description and the five Codex review files. Ran
> `make test PYTEST_ADDOPTS="tests/invitations tests/auth tests/test_request_logging.py tests/test_architecture.py
> tests/test_csrf.py tests/tenancy/test_context.py"`: 404 passed. Compiled the lock, claim, insert and cap
> statements with the Postgres dialect for §3. CI was green on `2d82eb7`. Differences from the plan: see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 1. Walkthrough variant: A.

## 1. What was built and why

The second half of staff invitations. P4-02a lets a manager email an invitation link; this ticket lets the
invitee open it (`GET /api/invitations/{token}`: building name, masked email, roles) and accept it
(`POST /api/invitations/{token}/accept`). A new person gets an account and is logged in; an existing account
must already be logged in as itself. The membership becomes `active` with exactly the invited roles, in one
transaction that locks and then claims the single-use token with a conditional UPDATE. Both routes are public
(no session), share one per-IP rate limit, and keep the token out of the logs.

Two decisions matter most. **D2:** read and check first, hash the password with no connection held, then
write in one transaction that re-checks everything under locks — five review findings were variations of
"the state changed between the read and the write". **D6:** when an existing account gains a staff role, its
sessions must switch to the 12-hour staff idle window; after three review rounds disproved three designs,
James chose option A: a per-user lock that every session start, refresh and role change takes, with the stored
deadline as the only rule.

## 2. Decisions

### D1. An invitation never changes an `active` or `suspended` membership

- **Problem or constraint:** the ticket says "create or reactivate the membership as active, with exactly the
  invited roles". Replacing an active member's roles could silently drop `property_management`, and an old
  invitation could lift a suspension.
- **Chosen:** `active` and `suspended` → 409 `membership_exists`, nothing written; `pending`, `denied`,
  `deactivated` → `active` with exactly the invited roles (old roles deleted).
- **Alternatives rejected:** replace an active member's roles (role administration through a side door, P4-06's
  job); union the roles (contradicts "exactly"); reactivate a suspended one (an invitation created before the
  suspension would undo it).
- **Tradeoffs and accepted limitations:** a manager can't add a role to an active member with an invitation
  until P4-06.
- **Basis:** ticket + autonomous. **Source:** recorded (PR #87 D1, ticket Frame notes).

### D2. Read, then hash with no connection held, then write under locks with a fresh clock

- **Problem or constraint:** single use under concurrency; argon2 takes tens of milliseconds and must not hold a
  pooled connection or a row lock (as `backend/app/auth/service.py::login` already avoids); `accepted_user_id`
  needs the user's id.
- **Chosen:** `backend/app/invitations/service.py::accept_invitation` validates the token, the session and the
  input on a read, ends it (`rollback`), hashes, then opens the write transaction: building `FOR SHARE` (recheck
  `is_active`), invitation row `FOR UPDATE`, **then** reads the clock, then the conditional claim
  `UPDATE … WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now RETURNING`. Zero rows → 404.
- **Alternatives rejected:** insert the user first (the loser of a same-token race would answer
  `login_required` instead of `invitation_invalid`); hash inside the transaction (holds the connection and the row
  lock through argon2); trust the read's state and clock (rounds 1-2 proved the token can expire or be revoked,
  and the building be deactivated, between the read and the write).
- **Tradeoffs and accepted limitations:** the token is checked twice; the claim decides.
- **Basis:** CLAUDE.md rule 7; review rounds 1 (F2, F3) and 2 (R2-F2). **Source:** recorded (PR #87 D2 and the
  smaller-decision rows).

### D3. A session of another user is a 403 even when no account has the email

- **Problem or constraint:** the ticket gives 403 `invitation_email_mismatch` for a different logged-in user with
  an existing account; for a new email, accepting would replace the browser's cookie with the new account's.
- **Chosen:** any live session whose user isn't the invited account → 403.
- **Alternatives rejected:** create the account and swap the cookie (silently logs the current user out of that
  browser).
- **Tradeoffs:** one extra "log out first" step. **Basis:** autonomous. **Source:** recorded (PR #87 D3).

### D4. One per-IP rate limit for both public routes

- **Chosen:** `rate_limit_invitation_ip` = 20 per 600 s (`backend/app/core/config.py::Settings`), one counter
  `invitation:ip:<ip or /64>` (`backend/app/rate_limits/service.py::ip_key`) that lookups and accepts share,
  counted before any lookup.
- **Alternatives rejected:** a counter per route (doubles an attacker's budget); the login policy (30: criterion 6
  needs a 429 before 30).
- **Tradeoffs:** people behind one NAT share 20 attempts per 10 minutes. No per-email limit: the request carries no
  email, and the token (256 bits) is the secret.
- **Basis:** ticket + autonomous. **Source:** recorded (PR #87 D4).

### D5. Tokens are redacted wherever a path is logged

- **Problem or constraint:** CLAUDE.md rule 10 (never log tokens); the token is in the URL path, which two places
  log: the request log and the CSRF middleware's `csrf_rejected` line.
- **Chosen:** `backend/app/logging_config.py::loggable_path` replaces the segment after `/api/invitations/` with
  `{token}`; `backend/app/middleware/request_logging.py::RequestLoggingMiddleware` and
  `backend/app/core/csrf.py::CSRFMiddleware` call it. Anchored at `^/api/invitations/`, so building routes'
  `/invitations/{id}` keep their path.
- **Alternatives rejected:** the token in the body (the ticket fixes it as a path parameter, and P4-07 builds on
  it); dropping the path (loses which route was hit). A Dockerfile change (dropping gunicorn's `--access-logfile`)
  was tried and reverted: running the production image with that flag logged no request line, because the uvicorn
  worker logs through `uvicorn.access`, which `backend/app/logging_config.py::configure_logging` disables.
- **Basis:** CLAUDE.md rule 10. **Source:** recorded (PR #87 D5 and "Deviations from the plan").

### D6. A role change caps the user's stored idle deadlines under a per-user lock (option A)

- **Problem or constraint:** ADR-0003 gives staff a 12-hour idle window, stored per session as `idle_expires_at`
  from the roles read when it was written. An existing account that accepts a staff role keeps sessions written
  with the resident 7-day window.
- **Chosen:** three pieces in `backend/app/auth/service.py`. `lock_idle_deadlines` locks the user row
  `FOR NO KEY UPDATE` (foreign-key checks take `FOR KEY SHARE`, which doesn't conflict). Every write that sets
  idle deadlines takes it **before** reading the roles: `_new_session` (logins and new sessions), `touch_session`
  (refresh), and `apply_role_change`. `apply_role_change`, called by the accept for an existing account after the
  roles are written, records activity on the caller's session and caps every unrevoked session to
  `least(idle_expires_at, last_seen_at + window)`. `touch_session` re-reads the clock after the lock and writes
  only while the session is still live. `_is_live` uses stored deadlines only (as on `main`), so expiry is final.
- **Alternatives rejected** (each one was built and disproved by a review round, §6): cap the stored deadlines
  without a lock (round 2: a refresh or login that read the old roles wrote 7 days after the cap); check the staff
  role on every read (round 3: an expired staff session came back when the role was removed); revoke the
  account's sessions on promotion (inbox B-6 option B: logs out other devices, and a racing login still needs the
  lock); amend ADR-0003 to judge windows by current roles (option C). **James chose A** (inbox B-6, in session,
  2026-10-20).
- **Tradeoffs and accepted limitations:** a user-row lock in each refresh (at most once per 5 minutes per
  session) and each login, held to the end of that short transaction. **Every later write that changes roles
  (P4-06) must call `apply_role_change`**, or that user's sessions keep the window read at their last write.
  Another session idle longer than 12 hours when its user becomes staff ends at once.
- **Basis:** ADR-0003; review findings rounds 1-4; James's answer to B-6. **Source:** recorded (PR #87 D6).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Accept answers 200 `{building_id, membership_id, roles}` | 204 | the SPA needs the building to route into | autonomous | PR #87 |
| A session the accept starts is audited `auth.logged_in` (`start_logged_in_session`, which login now calls too) | only the ticket's two audit actions | every session start is audited | convention | PR #87 |
| New user's `email_verified_at` = the claim time | NULL | the emailed token proves the address | autonomous | PR #87 |
| `status_changed_by_user_id` = the inviting manager | the accepting user | the manager authorised the change | autonomous | PR #87 |
| Malformed token (not 43 URL-safe characters) → the same 404 | a 422 from a path pattern | one body for every invalid token | ticket | PR #87 |
| `email_masked` = first character + `***` + `@domain` | mask the domain | the invitee recognises the address; the token is the secret | autonomous | PR #87 |
| Service-side field errors as `RequestValidationError` (`backend/app/core/errors.py::field_errors`) | a custom `weak_password` problem | P4-07 maps `errors[]` to fields; one 422 shape | autonomous | PR #87 |
| Over-long password → `password_too_long` from a schema validator | pydantic `max_length` (`string_too_long`) | one set of password error types | review round 1 (F4) | PR #87 |
| Inactive building → `invitation_invalid` | accept into it | `/me` hides inactive buildings | autonomous | PR #87 |

**Framing changes:** criteria 1-6 are P4-02's 2, 3, 4, 5, 7, 8 made exact (status codes, bodies, what is
written); 7-12 are new (lookup body, new-account input, existing-membership states, races, token logging,
allowlist and CSRF). None loosened; criterion 4 picks "rejected" of "ignored or rejected". See the ticket's Frame
notes.

**Plan versus final code** (compared with the PR's Plan):
- The write transaction now starts with the building lock and the invitation row lock, and reads the clock after
  them; the plan started with the claim (rounds 1-2).
- `apply_role_change`, `lock_idle_deadlines` and the `touch_session` changes are not in the plan (rounds 1-4, D6).
- `start_logged_in_session` was extracted so login and the accept audit a session start the same way.
- `loggable_path` and the CSRF middleware change replaced the plan's single redaction in the request log (found on
  the stack journey).
- Test names differ from the plan's map: `test_two_accepts_of_one_token_have_one_winner` and
  `test_second_building_accept_needs_login` became `test_racing_accepts_have_one_winner[one-token]` /
  `[two-buildings]` plus the sequential
  `test_second_buildings_invitation_needs_login_once_the_first_created_the_account`; `test_existing_membership_states`
  became `test_existing_membership_is_activated_with_exactly_the_invited_roles` and
  `test_active_or_suspended_membership_is_not_changed`; the occupancy and full-name tests were split.
- Size: 535 non-test lines when first opened against a ~300 estimate, more after the review fixes; not split
  (recorded under the Plan).
- Added `scripts/mutation-probe.sh` (the ticket's carried follow-up) and a `CLAUDE.md` lesson.

## 3. How it is implemented

### Overview

- `backend/app/invitations/router.py::public_router`: two public routes under `/api/invitations`, in
  `backend/app/auth/allowlist.py::AUTH_ALLOWLIST`; the accept still passes the CSRF check.
- `backend/app/invitations/service.py::get_public_invitation` and `::accept_invitation`: the use-cases;
  `::_activate_membership` writes the membership, roles and occupancy.
- `backend/app/auth/service.py::apply_role_change` / `::lock_idle_deadlines`: the session side of a role change.
- `backend/app/logging_config.py::loggable_path`: token redaction for both middlewares.

### Walkthrough (variant A): a new person accepts

1. **HTTP:** `POST /api/invitations/<43-char token>/accept` `{"full_name": "Gina Guard", "password": "…"}` with
   the SPA's CSRF headers → `backend/app/invitations/router.py::accept`. Pydantic validates
   `backend/app/invitations/schemas.py::InvitationAccept` first: unknown fields (`roles`) are a 422; `full_name`
   is stripped, 1-200 characters, no control characters; `password` is not stripped and over 128 characters is
   `password_too_long`.
2. **Rate limit:** `RateLimiter.enforce(ip_key("invitation", ip), settings.rate_limit_invitation_ip)` counts on
   its own session and commits at once; the 21st attempt in 10 minutes is 429 with `Retry-After`.
3. **Read:** `_find_valid` refuses a token that isn't 43 URL-safe characters, then selects the pending invitation
   by `token_hash` joined to an active building. The cookie's session (if any) is resolved; the account is looked
   up by `lower(email)`. Then: another user's session → 403; an existing account without a session → 409; a new
   account without `full_name`/`password` or with a password the policy refuses → 422 with `errors[]`.
4. **Hash:** `db.rollback()` ends the read; argon2 runs in a worker thread.
5. **Write transaction** (the SQL compiled with the Postgres dialect; placeholders shortened to `$n`):

   ```sql
   SELECT buildings.is_active FROM buildings WHERE buildings.id = $1 FOR SHARE;
   SELECT invitations.id FROM invitations WHERE invitations.id = $1 FOR UPDATE;
   -- clock read here
   UPDATE invitations SET accepted_at=$1, updated_at=now()
    WHERE invitations.id = $2 AND invitations.token_hash = $3
      AND invitations.accepted_at IS NULL AND invitations.revoked_at IS NULL
      AND invitations.expires_at > $4
   RETURNING invitations.id;
   INSERT INTO users (email, password_hash, full_name, locale, is_active, email_verified_at, id)
   VALUES (...) ON CONFLICT (lower(email)) DO NOTHING RETURNING users.id;
   ```

   Then `accepted_user_id`, `_activate_membership` (insert `ON CONFLICT (building_id, user_id) DO NOTHING`, else a
   conditional UPDATE from `pending|denied|deactivated`; roles replaced; occupancy started, moved or ended), the
   audits `invitation.accepted` and `membership.activated`, and `start_logged_in_session`, which takes
   `SELECT users.id … FOR NO KEY UPDATE`, reads the roles (staff now, so 12 h) and inserts the session.
6. **Commit once; response:** 200 `InvitationAcceptedOut` and, for a new account, the session cookie
   (`backend/app/auth/router.py::set_session_cookie`).

For an **existing account** step 5 skips the user insert and calls `apply_role_change` instead of starting a
session (the lock and the cap compiled as above; the middle statement written out by hand, `<live>` standing for
`_is_live`):

```sql
SELECT users.id FROM users WHERE users.id = $1 FOR NO KEY UPDATE;
UPDATE sessions SET last_seen_at=$now, idle_expires_at=$now + $window WHERE id = $caller AND <live>;
UPDATE sessions SET idle_expires_at=least(sessions.idle_expires_at, sessions.last_seen_at + $window)
 WHERE sessions.user_id = $1 AND sessions.revoked_at IS NULL;
```

### Data model changes

None (no migration). Tables used: `invitations` (P4-02a), `users`, `building_memberships`, `membership_roles`,
`unit_occupancies`, `sessions`, `audit_events`, `rate_limits`.

## 4. The code

**Files changed** (non-test)

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/invitations/service.py` | public lookup, accept, membership activation | +360/−6 |
| `backend/app/auth/service.py` | `lock_idle_deadlines`, `apply_role_change`, `start_logged_in_session`; lock in `_new_session`, `touch_session` | +66/−5 |
| `backend/app/invitations/router.py` | `public_router`: `get_public`, `accept` | +53/−2 |
| `backend/app/invitations/schemas.py` | `InvitationPublicOut`, `InvitationAccept`, `InvitationAcceptedOut` | +45 |
| `backend/app/logging_config.py`, `backend/app/core/csrf.py`, `backend/app/middleware/request_logging.py` | `loggable_path` at both log sites | +16/−3 |
| `backend/app/core/errors.py` | `field_errors` | +9 |
| `backend/app/auth/{router,allowlist}.py`, `backend/app/core/config.py`, `backend/app/audit/actions.py`, `backend/app/main.py`, `backend/.env.example`, `backend/app/invitations/models.py` | public cookie/IP helpers, allowlist, policy, actions, wiring, comment fix | small |
| `frontend/src/api/schema.d.ts` | generated | +201 |
| `scripts/mutation-probe.sh` | new probe helper | +51 |
| `CLAUDE.md` | one lesson added, reflowed to 150 lines | +7/−7 |

`backend/app/invitations/service.py::accept_invitation` — the write transaction
([permalink](https://github.com/JamesSoh2000/Condo-app-revised/blob/2d82eb7/backend/app/invitations/service.py#L436-L567))

```python
    new_account = _new_account_input(data) if account_id is None else None
    await db.rollback()
    password_hash = await to_thread.run_sync(hash_password, new_account[1]) if new_account else None

    # The building first, as create and resend lock it (building, then invitation): FOR SHARE, so
    # a deactivation waits for this accept, or this waits for it and reads it as committed
    # (review round 1, F3).
    building_active = await db.scalar(
        select(Building.is_active)
        .where(Building.id == invitation.building_id)
        .with_for_update(read=True)
    )
    if not building_active:
        raise _invalid()
    # Lock the row, then read the clock: ...
    await db.execute(select(Invitation.id).where(Invitation.id == invitation.id).with_for_update())
    now = clock.now()
    claimed = await db.scalar(
        update(Invitation)
        .where(
            Invitation.id == invitation.id,
            Invitation.token_hash == invitation.token_hash,
            status_clause(InvitationStatus.PENDING, now),
        )
        .values(accepted_at=now)
        .returning(Invitation.id)
    )
    if claimed is None:
        raise _invalid()
    # ...
    if new_account is not None:
        account_id = await db.scalar(
            pg_insert(User)
            .values(
                email=invitation.email,
                full_name=new_account[0],
                password_hash=password_hash,
                # The emailed token proves the address.
                email_verified_at=now,
            )
            # The account was created since the read (another building's invitation): it is an
            # existing account now, which needs a login.
            .on_conflict_do_nothing(index_elements=[func.lower(User.email)])
            .returning(User.id)
        )
        if account_id is None:
            raise _login_required()
```

- Ends the read before argon2, then re-checks the building, locks the invitation, reads the clock and claims.
- Why: D2. Without the row lock before the clock, a second accept that waited behind a first one (which then
  rolled back) would claim with a time from before the token expired
  (`test_expiry_is_checked_after_waiting_for_the_invitation_row`). Without `ON CONFLICT`, two buildings'
  invitations for one new email raced to a 500 (`test_racing_accepts_have_one_winner[two-buildings]`).

`backend/app/invitations/service.py::_activate_membership` — create or reactivate

```python
    inserted = await db.scalar(
        pg_insert(BuildingMembership)
        .values(building_id=invitation.building_id, user_id=user_id, **activated)
        .on_conflict_do_nothing(index_elements=["building_id", "user_id"])
        .returning(BuildingMembership.id)
    )
    reactivated = inserted is None
    if inserted is not None:
        membership_id: UUID = inserted
    else:
        # Conditional (CLAUDE.md rule 7): an active or suspended membership is left alone (D1).
        updated = await db.scalar(
            update(BuildingMembership)
            .where(
                BuildingMembership.building_id == invitation.building_id,
                BuildingMembership.user_id == user_id,
                BuildingMembership.status.in_(_REACTIVATABLE),
            )
            .values(**activated)
            .returning(BuildingMembership.id)
        )
        if updated is None:
            raise MembershipExists(
                detail="This account is already a member here; a manager changes its roles."
            )
        # ... delete the old roles, insert the invitation's ...
    if invitation.unit_id is not None:
        # ...
        await transfer_occupancy(
            db,
            building_id=invitation.building_id,
            membership_id=membership_id,
            new_unit_id=invitation.unit_id,
            relationship=invitation.relationship,
        )
    elif reactivated and Role.RESIDENT not in invitation.roles:
        # An occupancy belongs to a resident membership (ADR-0010).
        await end_occupancy(db, building_id=invitation.building_id, membership_id=membership_id)
```

- The insert handles a new membership; the conditional UPDATE is the only way an existing one becomes active.
  Making `_REACTIVATABLE` every status fails `test_active_or_suspended_membership_is_not_changed` (mutation probe).
- The occupancy branch keeps ADR-0010's rule that an occupancy belongs to a resident membership when a
  deactivated membership with a leftover occupancy comes back.

`backend/app/auth/service.py::apply_role_change` and `::touch_session` — option A
([permalink](https://github.com/JamesSoh2000/Condo-app-revised/blob/2d82eb7/backend/app/auth/service.py#L178-L281))

```python
async def lock_idle_deadlines(db: AsyncSession, user_id: UUID) -> None:
    # ... docstring ...
    await db.execute(select(User.id).where(User.id == user_id).with_for_update(key_share=True))


async def apply_role_change(
    db: AsyncSession, user_id: UUID, *, active_session_id: UUID | None
) -> None:
    # ... docstring ...
    await lock_idle_deadlines(db, user_id)
    now = clock.now()
    window = await idle_window(db, user_id)
    if active_session_id is not None:
        await db.execute(
            update(AuthSession)
            .where(AuthSession.id == active_session_id, _is_live(now))
            .values(last_seen_at=now, idle_expires_at=now + window)
        )
    await db.execute(
        update(AuthSession)
        .where(AuthSession.user_id == user_id, AuthSession.revoked_at.is_(None))
        .values(
            idle_expires_at=func.least(
                AuthSession.idle_expires_at, AuthSession.last_seen_at + window
            )
        )
    )

# ... in touch_session, after the 5-minute check:
    await lock_idle_deadlines(db, session.user_id)
    idle = await idle_window(db, session.user_id)
    # And the clock again: the session may have expired while this waited for the lock (review
    # round 4); `now` from before the wait would still call it live.
    now = clock.now()
    # ...
    await db.execute(
        update(AuthSession)
        .where(
            AuthSession.id == session.id,
            AuthSession.last_seen_at == session.last_seen_at,
            _is_live(now),
        )
        .values(last_seen_at=now, idle_expires_at=now + idle)
    )
```

- Every writer of idle deadlines locks first and reads roles and clock after the lock; `least` only shortens.
- Remove any of the three locks and `test_session_writes_and_a_staff_accept_take_turns` fails (probes: 1, 2 and 3
  of its 4 cases); remove the clock re-read and
  `backend/tests/auth/test_session_concurrency.py::test_refresh_waiting_on_a_role_change_cannot_revive_an_expired_session`
  fails (2 of 3); remove `_is_live(now)` from the refresh and `test_refresh_after_a_cap_cannot_revive_the_session`
  fails.

`backend/app/logging_config.py::loggable_path`

```python
_INVITATION_TOKEN = re.compile(r"^/api/invitations/[^/]*")


def loggable_path(path: str) -> str:
    """`path` as a log may record it: a token in it replaced by `{token}` (CLAUDE.md rule 10)."""
    return _INVITATION_TOKEN.sub("/api/invitations/{token}", path, count=1)
```

- Without it, `test_invitation_token_is_not_logged` fails (probe), and the stack journey found the raw token in
  `docker logs` on the CSRF rejection line before `backend/app/core/csrf.py` called it.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| A used, expired, revoked, resent, unknown, malformed or non-UTF-8 token, or an inactive building | one 404 body for GET and POST, nothing written | `test_invalid_tokens_answer_one_404_body` (9 cases × 2 routes), `test_expired_at_and_after_expiry_but_valid_just_before`, `test_accepted_token_cannot_be_used_twice` |
| The token expires, is revoked or resent, or the building or unit is deactivated while the password hashes | rechecked in the write transaction | `test_token_expiring_while_the_password_hashes_is_invalid`, `test_change_while_the_password_hashes_makes_the_token_invalid` ×3, `test_unit_deactivated_while_the_password_hashes_refuses_accept` |
| Two accepts of one token | one wins, the other 404 | `test_racing_accepts_have_one_winner[one-token]` |
| Expiry while waiting on another accept's row lock | 404 | `test_expiry_is_checked_after_waiting_for_the_invitation_row` |
| One new email, two buildings' invitations (sequential or racing) | the second 409 `login_required`, no 500 | `test_second_buildings_invitation_needs_login_once_the_first_created_the_account`, `test_racing_accepts_have_one_winner[two-buildings]` |
| Existing account without a session (none, revoked, idle-expired) | 409, its password untouched | `test_existing_account_without_session_gets_login_required`, `test_revoked_session_counts_as_no_session`, `test_idle_expired_session_counts_as_no_session` |
| Another user's session | 403, also for a new email; no cookie swap | `test_session_of_another_user_is_a_mismatch`, `…_when_no_account_has_the_email` |
| `roles` in the body | 422, nothing written | `test_roles_in_the_body_are_rejected` |
| Weak, long, padded password; bad full name | 422 with the policy's type and no echo; padding kept; name stripped | `test_weak_password_is_refused_without_echo`, `test_too_long_password_is_refused_without_echo`, `test_password_at_the_maximum_length_is_accepted`, `test_password_is_not_stripped`, `test_bad_full_name_is_refused`, `test_full_name_is_stripped` |
| Existing membership in each status | pending/denied/deactivated activated with exactly the invited roles; active/suspended 409 | `test_existing_membership_is_activated_with_exactly_the_invited_roles` ×3, `test_active_or_suspended_membership_is_not_changed` ×2 |
| Leftover occupancy on reactivation | ended (no resident role), moved (invited unit), kept (resident, no unit) | `test_reactivation_ends_…`, `test_reactivation_moves_…`, `test_reactivation_keeps_…` |
| Existing account's sessions after a staff accept | caller refreshed to 12 h; others capped; refused after 12 idle hours; a resident invitation changes nothing | `test_accept_is_activity_for_the_invitees_session`, `test_existing_session_gets_the_staff_idle_window_on_accept`, `test_accept_shortens_the_accounts_other_sessions_too`, `test_resident_invitation_keeps_the_resident_idle_window` |
| An expired staff session after a later role removal or suspension | stays expired | `test_expired_staff_session_stays_expired_after_a_role_change` ×2 |
| A refresh or login racing the accept, either order | the second waits; the written session ends after 12 idle hours | `test_session_writes_and_a_staff_accept_take_turns` ×4 |
| A refresh queued behind a role change past its deadline | no revival | `test_refresh_waiting_on_a_role_change_cannot_revive_an_expired_session` ×3 |
| Rate limit | 21st request 429; accepts and lookups share the counter; other IPs not affected; policy pinned at 20/600 | `test_lookup_is_rate_limited_per_ip`, `test_accept_counts_against_the_same_limit`, `test_accepts_consume_the_counter_the_lookup_then_hits`, `test_invitation_rate_policy_is_20_per_10_minutes` |
| Token in logs | redacted in the request log and the CSRF line | `backend/tests/test_request_logging.py::test_invitation_token_is_not_logged`, `::test_csrf_rejection_does_not_log_the_invitation_token` |
| Accept without CSRF headers | 403, nothing written | `test_accept_without_csrf_headers_is_refused` (also passes without the route; the stack journey's 403 is the real proof) |

Acceptance criteria → tests: 1 `test_new_person_accepts_and_is_logged_in_as_active_security`; 2 the invalid-token
rows; 3 the session rows and `test_invitee_logged_in_accepts_without_password_change`; 4
`test_roles_in_the_body_are_rejected`; 5 `test_invitation_with_unit_starts_occupancy`,
`test_deactivated_unit_refuses_accept`; 6 the rate-limit row; 7
`test_lookup_shows_building_masked_email_and_roles`, `test_one_character_local_part_is_masked_the_same_way`; 8 the
password/name row and `test_new_account_needs_full_name_and_password`; 9 the membership and occupancy rows and
`test_invitation_of_building_b_activates_only_in_b`; 10 the race rows; 11 the log row; 12
`backend/tests/test_architecture.py` (allowlist fitness) and the CSRF row.

## 6. Review log

Each round: a fresh Codex `gpt-6.1-sol` (high) with the security pass; no Claude reviewer (James's instruction
for this run). Rounds 1-3 reviewed commits from before the branch was rebased onto `main` (they stay in PR #87's
history). Rounds 4-5 were verification rounds James asked for.

| Round | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|
| 1 | `5aba160` | BLOCK | F1 High: existing sessions kept the resident window after a staff accept; F2 Medium: expiry checked with the read's clock; F3 Medium: building not rechecked; F4 Low: `string_too_long` | all fixed (`17f2714`, pre-rebase) |
| 2 | `17f2714` | BLOCK | R2-F1 High: a refresh or login racing the cap stored 7 days; R2-F2 Medium: clock read before the row-lock wait | fixed (`067fc72`, `24fc371`, pre-rebase) |
| 3 | `24fc371` | BLOCK | R3-F1 High: the read-time staff check made expiry reversible; R3-F2 Medium: accept not counted as activity | High open → blocked (stop rule 4, inbox B-6); James chose option A; fixed in `5d765f2` |
| 4 | `a3a5822` | BLOCK | R4-F1 High: `touch_session` read the clock before waiting on the new lock | James chose "fix + round 5"; fixed in `2d82eb7` |
| 5 | `2d82eb7` | MERGE | none; R4-F1, R3-F1, R3-F2, R2-F1 verified | — |

The failures behind the fixes, with the test that failed first:
- **F1:** an existing account accepts `security`; after 13 idle hours `/api/auth/me` still answered 200.
  `test_existing_session_gets_the_staff_idle_window_on_accept`.
- **F2/R2-F2:** a token 1 s from expiry was claimed after argon2 or after a lock wait.
  `test_token_expiring_while_the_password_hashes_is_invalid`, `test_expiry_is_checked_after_waiting_for_the_invitation_row`.
- **F3:** the building deactivated during hashing; an active membership was still created.
  `test_change_while_the_password_hashes_makes_the_token_invalid[building-deactivated]`.
- **R2-F1:** with the stored cap and no lock, a refresh paused after reading the resident window wrote 7 days after
  the accept's cap; the session lived through 13 idle hours. Now `test_session_writes_and_a_staff_accept_take_turns`.
- **R3-F1:** the round-2 read-time rule refused a staff session idle 13 h, then served it again once the staff role
  was deleted. `test_expired_staff_session_stays_expired_after_a_role_change`.
- **R3-F2:** a resident session idle 13 h accepted a staff role, then got 401 on the next request.
  `test_accept_is_activity_for_the_invitees_session`.
- **R4-F1:** a refresh starting 1 s before its deadline waited behind a role removal, then wrote 7 days with its
  stale clock. `test_refresh_waiting_on_a_role_change_cannot_revive_an_expired_session`.

Found by the implementer: the CSRF log line held the token (stack journey) → D5.

## 7. Not verified, accepted risks and follow-ups

- **Rounds 4-5 verified the fixes only** (James's instruction); the whole diff was last reviewed for new bugs in
  round 3, before option A. The option A code was reviewed only for whether the R2/R3/R4 findings hold.
- **Stale docstring:** `backend/app/invitations/service.py::accept_invitation` says the write transaction "starts
  by claiming the token"; it now starts with the building and invitation locks (§3). Comment only; tracked only
  here.
- The lock cost (D6) was not measured (no benchmark run).
- Not tested end to end on the stack: the existing-account path (logged-in invitee) and the reactivation paths;
  they are covered by tests against real Postgres only.
- `invalid_characters` from the password policy can't be reached over HTTP (a lone surrogate fails JSON parsing
  first); no test.
- Accepted: people behind one NAT share the 20-per-10-minutes counter (D4); an invitation can't change an active
  member's roles until P4-06 (D1); a user-row lock in each refresh and login (D6).
- Follow-ups: **P4-06 must call `apply_role_change`** after any role or status change (D6); **P4-07** should set
  `Referrer-Policy: no-referrer` on `/invite/{token}` so the token doesn't leave in a `Referer` header. Both are
  added to their tickets in the bookkeeping commit.

## 8. How to change this safely

- A new way to grant or remove roles: call `backend/app/auth/service.py::apply_role_change` in the same
  transaction, after the change. `backend/tests/auth/test_sessions.py` (the B-6 tests) show the expected effects;
  copy `test_session_writes_and_a_staff_accept_take_turns` for its races.
- A new writer of `sessions.idle_expires_at`: take `lock_idle_deadlines` first, then read the roles and the clock.
- A new public route with a secret in its path: extend `loggable_path`, add it to `AUTH_ALLOWLIST`, and extend
  `backend/tests/test_request_logging.py`.
- Changing the accept's order of locks: keep building → invitation (create and resend lock the building first);
  `test_racing_accepts_have_one_winner` and the "while the password hashes" tests will catch most regressions.

## 9. Must explain, then quiz

**1. Why one generic error for unknown, expired, used and revoked tokens?** Recorded (ticket and the code
comment on `_invalid`): the answer mustn't tell a guesser which tokens once existed. Inferred beyond that: a
different answer for "used" or "revoked" would confirm an address was invited and what became of it. `backend/app/invitations/service.py::_invalid` builds the
one body, and `_find_valid` and the claim both raise it; `test_invalid_tokens_answer_one_404_body` compares the
bodies (minus `request_id`) for nine kinds of bad token on both routes.

**2. Why must an existing account log in before accepting, rather than setting a password through the invite?**
The ticket states the rule ("never set a password on an existing account here") but not its reason. Inferred:
whoever holds the link would otherwise take over the account: the email link proves control of the mailbox at the
time it was read, not the right to replace the password of an account that may hold other buildings' memberships.
Logging in proves the account; resetting a password is P4-04's flow, with its own checks. The code never writes a
password for an existing account: `accept_invitation` builds `new_account` (and hashes) only when no account has
the email; `test_invitee_logged_in_accepts_without_password_change` posts a new password and checks the hash didn't
change, and `test_existing_account_without_session_gets_login_required` checks the 409 leaves it alone.

**3. Where do the roles come from at accept time, and why never from the request?** From the invitation row
(`_Pending.roles`, written by the manager in P4-02a), inserted by `_activate_membership`. The request schema has no
roles field and forbids extra fields, so `roles` in the body is a 422 (`test_roles_in_the_body_are_rejected`). The
ticket requires it ("the client cannot change roles"). Inferred why: the invitee is the person being granted
access; letting them choose their roles would let anyone with a resident invitation make themselves a manager.

Quiz:

1. Why does the accept end its read transaction before hashing the password, and what does it re-check afterwards?
2. Two accepts of the same token arrive together. Walk through what each transaction does and what each caller gets.
3. An account is logged in on a phone (idle 13 hours) and a laptop (active), and accepts a security invitation on
   the laptop. What happens to each session, and which lines decide it?
4. What would break if `touch_session` read the clock before `lock_idle_deadlines` instead of after?
5. How would you extend this so a manager's "remove staff role" action (P4-06) keeps the session rules correct?

<details><summary>Answers</summary>

1. argon2 is slow; holding a pooled connection and the invitation row lock through it would let a burst of accepts
   exhaust the pool and serialise behind one another. After hashing, the write transaction re-checks the building
   (`FOR SHARE`, `is_active`), locks the invitation, reads a fresh clock and claims with a conditional UPDATE, so a
   token that expired or was revoked or resent meanwhile, or a building deactivated meanwhile, is refused.
2. Both read the invitation as pending. The first locks the row and claims it; the second's `FOR UPDATE` waits.
   When the first commits, the second reads the row as accepted, so its claim matches zero rows → 404
   `invitation_invalid`. If the first rolls back instead, the second proceeds with a clock read after the wait.
   `test_racing_accepts_have_one_winner[one-token]`, `test_expiry_is_checked_after_waiting_for_the_invitation_row`.
3. `apply_role_change` (under the user lock) sets the laptop session's `last_seen_at` to now and its deadline to
   now + 12 h, then caps every session to `last_seen_at + 12 h`: the phone's `last_seen_at` is 13 hours old, so its
   deadline moves into the past and it is refused from then on, permanently (`least` never lengthens, and a refresh
   only writes while live). `test_role_change_records_activity_on_the_active_session`.
4. A refresh that resolved a session just before its deadline and then waited behind a role change would judge
   liveness with the old time and write a fresh deadline, reviving a session that expired while it waited (R4-F1);
   `test_refresh_waiting_on_a_role_change_cannot_revive_an_expired_session` fails (probe: 2 of 3 cases).
5. In the same transaction as the role or status change, call `apply_role_change(db, user_id,
   active_session_id=None)` (or the manager's own session id if the manager is changing their own roles). It takes
   the user lock, reads the new roles, and caps the stored deadlines; removing a staff role then leaves the window
   at most what the remaining roles allow, never longer than what was stored. Add a race test like
   `test_session_writes_and_a_staff_accept_take_turns`.

</details>
