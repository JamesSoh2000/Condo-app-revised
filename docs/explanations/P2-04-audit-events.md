# Explanation — P2-04 Audit events

> **PR:** #60 · **Source revision:** `7922d2d`. This is the pre-merge PR head this explanation was written from and checked against.
> **Reviewed:** the final review round (3) reviewed this commit.
> **Merge commit:** not known when this was written; after the merge, `gh pr view 60 --json mergeCommit` gives it.
>
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it before merge. This describes the PR's changes at the source revision. It does not describe commits after it (bookkeeping) or the squash merge, and a rebase after it gives the same changes new SHAs. It is a snapshot: before the merge it is edited to match the PR head; once merged, later changes get a new explanation and this one is not updated. Lasting decisions live in ADRs.
>
> **Reality check:** at `7922d2d` I re-read from disk:
> - `git diff origin/main...HEAD`
> - every file in the table in §4 in full: `backend/app/audit/{service,report,models,actions}.py`, `backend/app/cli.py`, `backend/app/auth/service.py`
> - the migration `91af698c06d2`
> - the assertions of every test named in §5
> - the PR #60 description, with the three review rounds
>
> Ran `uv run pytest tests/audit tests/test_architecture.py tests/auth tests/test_world.py tests/test_cli_seed.py` against `condo_test`: 275 passed. Captured the CLI query's SQL with the SQLAlchemy echo (§3). `make check` at this revision: 783 passed (PR, round 2).
>
> Differences from the plan: see §2, "Plan versus final code".
>
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)). Form: full. Tier: 1. Walkthrough variant: A (login request), plus C for the CLI.

## 1. What was built and why

The app can now answer "who did what, when". A new table, `audit_events`, gets one row per sensitive action. The helper `backend/app/audit/service.py::record_audit` adds the row to the *same database transaction* as the action. So the row exists exactly when the action was committed, and never otherwise.

Five auth actions record events: a login, a failed login, a logout, logging out everywhere, and revoking one session. Operators read the events with `python -m app.cli audit` (`make cli args="audit …"`), filtered by building, actor, entity, action prefix and age.

The two decisions that matter most:
- **A failed login commits its own event before raising.** Without that, the error path would discard it.
- **`record_audit` refuses metadata that could carry a secret.** That covers keys like `password` or `token` at any depth, oversized values, and values Postgres can't store.

A fitness test fails the build if any code updates or deletes an audit row.

## 2. Decisions

The D numbers match the PR's "Decisions and alternatives".

### D1. A failed login commits its `auth.login_failed` event, then raises

- **Problem or constraint:** `login` signals failure by raising `InvalidCredentials`, and only use-cases commit (CLAUDE.md rule 5). The router commits nothing. An event added and then raised past would be rolled back when the request's session closes, so criterion 2 could never hold.
- **Chosen:** on the failure path, `backend/app/auth/service.py::login` calls `record_audit`, then `db.commit()`, then raises. Each path still commits exactly once.
- **Alternatives rejected:**
  - Record from the router or an exception handler. That breaks the layering, and the handler has no session.
  - Return a result instead of raising. That changes the `InvalidCredentials` contract the router and tests rely on.
- **Tradeoffs and accepted limitations:** every failed login writes a row, so password guessing also fills `audit_events` until P2-05's rate limit lands. Unknown-email and known-user failures do the same work (one INSERT, one commit), so this adds no timing difference between them.
- **Basis:** ticket criterion 2. **Source:** recorded (PR D1).

### D2. What a failed login stores, and what it doesn't

- **Problem or constraint:** the ticket says never store the attempted email or password, and store `{user_id}` only when a user matched. P2-01b's carry adds: don't reveal in anything a client can read whether the email exists.
- **Chosen:**
  - `actor_user_id`, `entity_id` and `building_id` are null, and `entity_type` is `user`.
  - `metadata` is `{}` for an unknown email, and `{"user_id": "<id>"}` when the email matched a user whose password was wrong or who is inactive.
  - The reason for the failure is not stored.
- **Alternatives rejected:**
  - Also put the id in `entity_id`. That's redundant, and `--entity user:<id>` would then mix failed logins into the user's own history.
  - A hash of the attempted email, to spot credential stuffing. It's still personal data, and out of scope.
- **Tradeoffs and accepted limitations:** operators can't see which non-existent emails were tried, or why a known user's login failed. Audit rows have no HTTP read path, so the stored `user_id` reveals nothing to clients.
- **Basis:** ticket Scope and the P2-01b carry. **Source:** recorded (PR D2).

### D3. `request_id` is `String(128)` and nullable (the ticket said `String(64)`)

- **Problem or constraint:** `backend/app/middleware/request_logging.py::RequestLoggingMiddleware` keeps a client's `X-Request-ID` if it matches `[A-Za-z0-9._-]{1,128}`. Such an id would not fit a 64-character column, so the login would fail with a 500. CLI commands have no request at all.
- **Chosen:** 128 characters, nullable.
- **Alternatives rejected:** truncating to 64. The stored id would then no longer equal the response header (criterion 1).
- **Basis:** autonomous; the code is the truth. **Source:** recorded (PR D3, Frame notes).

### D4. Logout-all is `auth.logged_out_all`, recorded by the use-case

- **Problem or constraint:** the ticket's Scope said `auth.sessions_revoked_all`, while its P2-02 carry said `auth.logged_out_all`.
- **Chosen:** `auth.logged_out_all`, recorded in `backend/app/auth/service.py::logout_all` with `{"count": n}`. The helper `revoke_all_sessions` records nothing.
- **Alternatives rejected:** recording inside `revoke_all_sessions`. Password reset (P4-04) and deactivation will call that helper inside their own use-cases, and each should record its own action.
- **Tradeoffs and accepted limitations:** any future caller of `revoke_all_sessions` must record its own event.
- **Basis:** ticket carry; an autonomous choice between the two names. **Source:** recorded (PR D4). The Scope line was corrected in review round 1 (L2).

### D5. The metadata rules

- **Problem or constraint:** the ticket names forbidden key words and a 1 KiB value limit. It doesn't say anything about case, nesting, how size is measured, or values Postgres JSONB can't store.
- **Chosen:**
  - A key containing `password|token|secret|cookie|authorization` is refused, in any case, at any depth.
  - Each top-level value's JSON is limited to 1,024 UTF-8 bytes.
  - Values must be JSON; a UUID becomes a string.
  - Nesting is limited to 32 levels.
  - NUL is refused in keys and strings.
  - Metadata must be a dict.
  - What gets stored is the round-tripped JSON, so it is exactly what was checked.
- **Alternatives rejected:**
  - Silently drop offending keys. That hides caller bugs, and the ticket says raise.
  - Count characters, not bytes. Bytes are the stricter reading.
  - For depth: catch `RecursionError` only. An iterative walk handles cycles, depth and NUL in one place (review round 2).
- **Tradeoffs and accepted limitations:**
  - There is no total size bound.
  - A harmless-looking key can still hold personal data.
  - A legitimate key such as `token_count` is refused.
  - Review round 3 left three Low edges, listed in §7.
- **Basis:** ticket criterion 4 and review rounds 1–2. **Source:** recorded (PR D5, review log).

### D6. Append-only is a convention plus a grep

- **Problem or constraint:** the ticket asks for no update or delete paths, checked by grepping for `update(AuditEvent` and `delete(AuditEvent`. The same mutation can be written in other ways.
- **Chosen:** `backend/tests/test_architecture.py::files_that_mutate_audit_events` scans `app/` and `migrations/` and also catches:
  - `AuditEvent.__table__.update(` and `.delete(`
  - legacy `query(AuditEvent)….update(` and `….delete(`
  - raw `UPDATE audit_events`, `DELETE FROM audit_events` and `TRUNCATE … audit_events`, in any case

  A meta-test proves each pattern fires, and that inserts, selects and other models' updates don't.
- **Alternatives rejected:**
  - A trigger that rejects UPDATE and DELETE. The ticket says "by convention", and a trigger would block a future retention job.
  - Revoking privileges. There is one database role today.
- **Tradeoffs and accepted limitations:**
  - The grep can't tell `session.delete(event)` apart from other deletes, and an aliased import slips past.
  - `seed --reset` (dev only) truncates every table by names built at run time, so it erases the trail too.
- **Basis:** ticket criterion 6. **Source:** recorded (PR D6).

### D7. One PR at 507 non-test lines

- **Problem or constraint:** the limit is about 400 lines. The PR had 484 before review; review fixes added 23.
- **Chosen:** keep it whole. That count includes the 78-line migration and 6 Makefile lines.
- **Alternatives rejected:** splitting the CLI into P2-04b. The CLI is the only way to read what criteria 1–2 write, and a split means a second Tier 1 review cycle.
- **Basis:** autonomous, following P2-01b's D7. **Source:** recorded (PR D7). The round-2 reviewer accepted the reasoning.

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| `auth.session_revoked` puts the session id in `entity_id`, metadata `{}` | metadata `{"session_id"}` (P2-02 carry) | Same fact; `--entity session:<id>` finds it | autonomous | PR table, Frame notes |
| `logout` records whenever its UPDATE revoked a row, including an expired but unrevoked session | Only live sessions | The row changed; the revocation behaviour itself is unchanged from P2-01b | autonomous | PR table; criterion 7 |
| `created_at` comes from `app.core.clock.now()` (the server default stays) | DB `now()` only | `--since` uses the app clock; matches `start_session`; frozen-clock tests | convention | PR table |
| Order by `created_at DESC, id DESC` | `created_at` only | uuid7 ids keep insertion order when timestamps are equal | autonomous | PR table |
| `--action` uses `startswith(…, autoescape=True)` | Plain LIKE | `_` is in every action name and is a LIKE wildcard | autonomous | PR table |
| Unknown `--building`/`--actor` exits 1; malformed `--since`/`--entity` exits 2 before any session | Print nothing | A typo would look like "no events" | autonomous | PR table |
| FKs on `building_id` and `actor_user_id`, no cascade | No FK | Users and buildings are deactivated, never deleted | convention | PR table |
| `make cli args="…"` | `make cli audit …` | make reads extra words as targets | P1-06 carry | PR table |

**Framing changes:** criteria 1–6 were sharpened, and 7 (logout), 8 (logout-all and revoking one session) and 9 (long request ids) were added. None was loosened. Commit `997c1c4` holds these; a wording fix to criterion 7 came in `8eea5be`.

**Plan versus final code:** I compared the PR's Plan with the code at `7922d2d`.
- `start_session` keeps its signature and `login` uses a new private `_new_session`. This deviation was noted in the PR below the Plan; it keeps the dozen existing callers unchanged.
- The metadata checks grew in review rounds 1–2, from a recursive key check to `_check_structure`, adding the depth limit, NUL and non-dict checks.
- `_parse_since` gained an overflow guard (round 1).

Nothing else differs.

## 3. How it is implemented

### Overview

- `backend/app/audit/models.py::AuditEvent` is the table, with three indexes for the three lookups: by building, by entity, by actor.
- `backend/app/audit/service.py::record_audit` validates its input and adds a row to the caller's session. It never flushes or commits.
- `backend/app/auth/service.py` calls it in `login` (both paths), `logout`, `logout_all` and `revoke_session`, just before each one's single commit.
- `backend/app/audit/service.py::find_audit_events` and `backend/app/audit/report.py::render` back the CLI command `backend/app/cli.py::audit_command`.

### Walkthrough A: a failed login, then a successful one

1. `POST /api/auth/login` goes through `RequestLoggingMiddleware`. That middleware sets the `request_id_ctx` context variable to the client's valid `X-Request-ID`, or to a new uuid4. The same value is echoed in the `X-Request-ID` response header.
2. `backend/app/auth/router.py::login` calls `backend/app/auth/service.py::login`. The service looks the user up by `lower(email)`, ends that read, and runs one argon2 verification (P2-01b).
3. **On failure:** `record_audit(action="auth.login_failed", entity_type="user", metadata={"user_id": found.id} if found else None)`, then `await db.commit()`, then `raise InvalidCredentials`. The INSERT goes out at the commit's flush. The response is the usual 401 problem+json, and the row survives it.
4. **On success:** `_new_session` adds and flushes the `sessions` row and returns its id. `record_audit(action="auth.logged_in", entity_type="session", entity_id=session.id, actor_user_id=found.id)` adds the event, and the single `db.commit()` writes the session and the event together.
5. Inside `record_audit`:
   - The action is checked against `<domain>.<past_verb>`.
   - The metadata goes through `_sanitize` → `_check_structure` → a per-value size check → a JSON round-trip.
   - `request_id` is read from `request_id_ctx`, and `created_at` from `clock.now()`.

### Walkthrough C: `make cli args="audit --building maple --action auth.logged_"`

1. `make cli` runs `docker compose exec app python -m app.cli audit …`.
2. `audit_command` parses `--since` and `--entity` **before** opening a session. A bad value raises `typer.BadParameter`, which exits 2. It then builds an `AuditQuery`.
3. `run_in_session` opens a session and runs `find_audit_events`, which resolves the slug (or raises `UnknownFilterValue`, exit 1) and runs this query (captured with the SQLAlchemy echo at `7922d2d`):

```sql
SELECT buildings.id FROM buildings WHERE buildings.slug = $1::VARCHAR          -- ('maple',)
SELECT audit_events.id, audit_events.created_at, audit_events.action, audit_events.building_id,
       buildings.slug, audit_events.actor_user_id, users.email, audit_events.entity_type,
       audit_events.entity_id, audit_events.request_id, audit_events.metadata
FROM audit_events LEFT OUTER JOIN buildings ON buildings.id = audit_events.building_id
                  LEFT OUTER JOIN users ON users.id = audit_events.actor_user_id
WHERE audit_events.building_id = $1::UUID AND (audit_events.action LIKE $2::VARCHAR || '%' ESCAPE '/')
ORDER BY audit_events.created_at DESC, audit_events.id DESC LIMIT $3::INTEGER
-- (UUID('01a1459a-…'), 'auth.logged/_', 200)
```

   The prefix arrives as `auth.logged/_` with `ESCAPE '/'`: the `_` is literal.
4. `render` prints one line per event, or a JSON array with `--json`. The runner's commit is a no-op for a read.

### Data model changes

New table `audit_events` (migration `91af698c06d2`, purely additive):

| Column | Type | Why |
|---|---|---|
| `id` | uuid7 PK | Time-ordered; the tie-breaker for equal `created_at` |
| `building_id` | FK `buildings`, null | Null for identity events; an FK keeps ids real (no cascade: buildings aren't deleted) |
| `actor_user_id` | FK `users`, null | Null for a login that matched no one, the system, or an operator |
| `action` | `varchar(64)` | `<domain>.<past_verb>` |
| `entity_type`, `entity_id` | `varchar(40)`, uuid null | What the action was on; no FK, since it can point at any table |
| `request_id` | `varchar(128)` null | D3 |
| `metadata` | `jsonb`, default `'{}'` | D5 |
| `created_at` | `timestamptz`, default `now()` | Set by `record_audit` from the app clock |

Indexes: `(building_id, created_at DESC)`, `(entity_type, entity_id)` and `(actor_user_id, created_at DESC)`, one per CLI filter.

## 4. The code

**Files changed** (non-test)

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/audit/service.py` | `record_audit`, the metadata checks, `find_audit_events` | +188 |
| `backend/app/audit/models.py` | `AuditEvent` | +37 |
| `backend/app/audit/report.py` | Text and JSON rendering | +41 |
| `backend/app/audit/actions.py` | Five `auth.*` constants | +7 |
| `backend/app/auth/service.py` | Events in five use-cases; `_new_session` | +77 −22 |
| `backend/app/cli.py` | The `audit` command | +73 −1 |
| `backend/app/models/registry.py` | Register the model | +1 |
| `backend/migrations/versions/91af698c06d2_audit_events.py` | The table | +78 |
| `Makefile` | `cli` target | +5 −1 |

Tests: `backend/tests/audit/test_audit.py`, `backend/tests/audit/test_cli_audit.py` and fitness test 5 in `backend/tests/test_architecture.py`; one line each in `test_world.py` and `test_cli_seed.py`.

`backend/app/auth/service.py::login` (the failure path)

```python
    if found is None or usable is None or not matches or not found.is_active:
        # Never the attempted email or password; the user's id only when the email matched one.
        await record_audit(
            db,
            action=actions.AUTH_LOGIN_FAILED,
            entity_type="user",
            metadata={"user_id": found.id} if found is not None else None,
        )
        # Committed although the login fails: the router commits nothing on an error.
        await db.commit()
        raise InvalidCredentials(detail="The email or password is incorrect.")
```

- It records the failure and commits before raising (D1, D2). `found.id` is a UUID; `record_audit` stores it as a string.
- Remove the `commit()` and the event silently disappears. Mutation M6 in the PR made three failed-login tests fail.

`backend/app/audit/service.py::record_audit`

```python
    if not _ACTION.fullmatch(action) or len(action) > _ACTION_MAX:
        raise ValueError(f"audit action must be '<domain>.<past_verb>', got {action!r}")
    if not entity_type or len(entity_type) > _ENTITY_TYPE_MAX:
        raise ValueError(f"audit entity_type must be 1-{_ENTITY_TYPE_MAX} characters")
    clean = _sanitize(metadata or {})
    db.add(
        AuditEvent(
            # ...
            request_id=request_id_ctx.get(),
            metadata_=clean,
            created_at=clock.now(),
        )
    )
```

- Everything is validated before `db.add`, so a refusal leaves nothing in the session (`assert not db.new` in the tests).
- There is no flush and no commit (CLAUDE.md rule 5): the caller's commit writes the row or discards it.
- `metadata or {}` is where review round 3's L2 lives: a falsy non-dict such as `[]` becomes `{}` (§7).

`backend/app/audit/service.py::_check_structure`

```python
    pending: list[tuple[object, int]] = [(metadata, 1)]
    while pending:
        value, depth = pending.pop()
        if depth > MAX_DEPTH:
            raise ValueError(f"audit metadata is nested deeper than {MAX_DEPTH}")
        if isinstance(value, dict):
            for key, inner in value.items():
                if not isinstance(key, str) or _SECRET_KEY.search(key) or "\x00" in key:
                    raise ValueError(f"audit metadata key {key!r} is not allowed")
                pending.append((inner, depth + 1))
        elif isinstance(value, list | tuple):
            pending.extend((inner, depth + 1) for inner in value)
        elif isinstance(value, str) and "\x00" in value:
            raise ValueError("audit metadata strings must not contain NUL")
```

- It walks the whole structure with an explicit stack, not recursion, so a deep or self-referencing structure stops at the depth limit with a `ValueError`. A self-referencing structure has unbounded depth along its loop.
- It runs **before** `json.dumps`, which recurses. Rounds 1 and 2 each found a case where a recursive walk raised `RecursionError` instead (§6).

`backend/app/auth/service.py::logout`

```python
    revoked = (
        await db.execute(
            update(AuthSession)
            .where(AuthSession.token_hash == hash_token(token), AuthSession.revoked_at.is_(None))
            .values(revoked_at=clock.now())
            .returning(AuthSession.id, AuthSession.user_id)
        )
    ).one_or_none()
    if revoked is not None:
        await record_audit(
            db, action=actions.AUTH_LOGGED_OUT, entity_type="session",
            entity_id=revoked.id, actor_user_id=revoked.user_id,
        )
    await db.commit()
```

- A conditional `UPDATE … RETURNING` means only the request that actually revoked the row records an event. A repeated or concurrent logout writes nothing.
- The function's docstring still says "if it is live". The condition is "not yet revoked", so an expired session is revoked and recorded too, as criterion 7 says. That is a stale docstring from before this ticket.

`backend/tests/test_architecture.py::_AUDIT_MUTATION`

```python
_AUDIT_MUTATION = re.compile(
    r"\b(?:update|delete)\(\s*AuditEvent\b"
    r"|\bAuditEvent\.__table__\.(?:update|delete)\("
    r"|\bquery\(\s*AuditEvent\b.*\.(?:update|delete)\("
    r"|(?i:\bupdate\s+\"?audit_events\b|\bdelete\s+from\s+\"?audit_events\b)"
    r"|(?i:\btruncate\b.*\baudit_events\b)"
)
```

- Fitness test 5 (D6). Mutation M1 added `update(AuditEvent)` under `app/` and made `test_no_code_updates_or_deletes_audit_events` fail.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| The attempted email or password ends up in the row | Only `{user_id}`, and only when matched | `test_unknown_email_records_login_failed_without_the_email_or_password` (serializes every column and searches it); `test_known_user_failure_records_only_the_user_id[wrong_password,inactive_user]` |
| Failure kinds are distinguishable from the response | Identical 401 bodies apart from `request_id` | `test_known_user_failure_records_only_the_user_id` |
| The use-case raises after recording | The row goes with the rollback | `test_audit_row_is_discarded_when_the_use_case_raises_before_commit` (500, then 0 rows) |
| `record_audit` commits | It doesn't | `test_record_audit_never_commits` (mutation M2) |
| A secret key, oversized or non-JSON value | `ValueError`, nothing added | `test_record_audit_refuses_secret_keys_large_and_non_json_values` (12 cases); boundary `test_value_of_exactly_one_kib_and_uuids_are_accepted` |
| Cycles, deep nesting, NUL, non-dict | `ValueError` | `test_record_audit_refuses_self_referencing_metadata`, `test_record_audit_refuses_deep_nesting_and_nul_characters`, `test_record_audit_refuses_metadata_that_is_not_a_dict`; `test_moderately_nested_metadata_is_accepted` |
| A malformed action name | `ValueError` | `test_record_audit_refuses_a_malformed_action` |
| A 128-character client request id | Stored whole | `test_client_request_id_of_128_characters_is_stored_whole` |
| No request (CLI) | `request_id` null | `test_request_id_is_null_outside_a_request` |
| Logout no-ops write an event | No row revoked, so no event | `test_logout_without_a_live_session_records_nothing`, the second half of `test_logout_records_logged_out_for_the_revoked_session` |
| Revoking someone else's, an unknown, a revoked or an expired session | 404, no event | `test_revoking_a_session_that_is_not_ones_own_live_one_records_nothing` (4 cases) |
| `_` in `--action` acts as a wildcard | Escaped | `test_action_prefix_is_literal_not_a_like_pattern` |
| Another building's or identity events in `--building` | Filtered out | `test_building_filter_prints_only_that_buildings_events` |
| Equal timestamps | Ordered by uuid7 id | `test_same_instant_events_keep_insertion_order_newest_first` (frozen clock) |
| `--since 999999d` overflows | Usage error, exit 2 | `test_cli_malformed_option_is_a_usage_error_without_a_session[args4]` |
| Surrogate key, falsy non-dict, shared sub-objects | **Not handled** (round 3 Lows) | No test (§7) |

Acceptance criteria → tests:
1. `test_login_records_one_logged_in_event_with_the_response_request_id`
2. `test_unknown_email_records_login_failed_without_the_email_or_password`, `test_known_user_failure_records_only_the_user_id`
3. `test_audit_row_is_discarded_when_the_use_case_raises_before_commit`
4. The sanitizer tests above, plus `test_record_audit_never_commits`
5. `backend/tests/audit/test_cli_audit.py` (19 tests), plus the stack transcript in the PR
6. `test_no_code_updates_or_deletes_audit_events`, `test_meta_audit_event_update_or_delete_is_reported`
7. The logout tests, including `test_logout_of_an_expired_session_revokes_and_records_it`
8. `test_logout_all_records_one_event_with_the_count`, `test_revoking_one_session_records_session_revoked`, the 404 test
9. The two `request_id` tests

## 6. Review log

| Round | Reviewer | Commit | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Claude (Sonnet 5.5, high, security pass) | `8eea5be` | MERGE | M1 `--since` overflow; L2 Scope name; L3 cyclic metadata, no total bound; L4 line count; L5 `_as_dict` matched any `*id` | M1, L2, L3-cyclic and L5 fixed in `77be3ec`; L3 total bound accepted; L4 dismissed (the count was right then) |
| 1 | Codex (`gpt-6-astra`, medium) | `8eea5be` | MERGE | L1 cyclic metadata → `RecursionError`; gaps: expired logout, 404 kinds | Fixed and covered in `77be3ec` |
| 2 | Claude (new, Sonnet 5.5, high) | `77be3ec` | MERGE | M1 stale line count; L2 deep acyclic nesting → `RecursionError`; L3 NUL accepted then fails at flush; L4 non-dict → `AttributeError`; L5 bounds | L2–L4 fixed in `9c92927`; count corrected; L5 accepted |
| 2 | Codex | `77be3ec` | MERGE | L1 deep nesting (the same as Claude L2); gap: ordering test didn't freeze the clock | Fixed in `9c92927` |
| 3 | Claude (new, Sonnet 5.5, high) | `7922d2d` | MERGE | L1 surrogate key; L2 falsy non-dict; L3 exponential walk of shared sub-objects | Accepted as follow-ups (last round) |
| 3 | Codex | `7922d2d` | MERGE | L1 surrogate key; L2 falsy non-dict | Accepted as follow-ups |

The failures behind each fix:
- **`--since 999999d`** passed the `\d{1,6}` pattern, then `clock.now() - timedelta(days=999999)` raised `OverflowError` (exit 1 with a traceback). `_parse_since` now tries the subtraction and turns the overflow into `BadParameter`. `[args4]` failed before the fix and passes after; the neighbour `test_cli_largest_since_in_range_still_works` (`999999h`) still passes.
- **A cyclic dict or list** made the old recursive `_check_keys` raise `RecursionError`. Round 1 serialized first, so json would refuse the cycle. Round 2 then found that a deep *acyclic* list beats that too, because json accepts it and the recursive walk then overflows: the round-1 fix had not been tested on its neighbour (see the CLAUDE.md lesson). The final fix is the iterative `_check_structure` with a depth limit. Both cyclic tests and the two deep cases failed before their fix and pass now.
- **NUL in a string** passed the sanitizer, and Postgres then rejected the JSONB at flush, giving a 500 and rolling back the whole use-case, the action included. The four NUL cases (key or value, top level or nested) failed and now pass.
- **Non-dict metadata** such as `["user_id"]` raised `AttributeError`; the three cases now raise `ValueError`.

Also: commit `9c92927` was pushed with an E501 lint failure in a docstring, before I read `make check`'s exit code. `7922d2d` wrapped the line, and `make check` then passed (PR, round 2 note).

## 7. Not verified, accepted risks and follow-ups

Not verified:
- **Round 3 Lows, unfixed.** Each is reachable only from trusted server code; no client input reaches metadata in this ticket.
  - A lone-surrogate key (`{"\ud800": "x"}`) passes `_check_structure`, and the flush then fails with a 500 instead of `record_audit` raising `ValueError`.
  - Falsy non-dict metadata (`False`, `0`, `""`, `[]`) becomes `{}` and writes a row.
  - Shared sub-objects (`x = [x, x]` repeated) are walked once per path, which is exponential: depth 20 takes about 1 s.

  Tracked: the PR follow-ups; carried to P4-01 in the bookkeeping commit.
- **Real commits outside the test harness.** In tests, `commit()` only releases a savepoint. The real commit of a failed login was checked by the PR's stack run (4 rows, none containing the attempted email or password) and by the round-3 reviewer against a real session. No automated test covers it.
- **`make cli` and the subprocess CLI path.** They have no automated test; the evidence is the PR's stack transcript. The CLI tests run the Typer app in-process with a fake session and query.
- **The migration's downgrade.** The round-2 reviewer ran `downgrade -1` then `upgrade head`; CI doesn't.
- **Concurrent revocations.** They are not tested directly. The conditional UPDATE is the argument, not a test.

Accepted risks and follow-ups:
- **Failed-login volume.** Every failed login writes a row; P2-05's rate limiting bounds it (D1). Tracked: P2-05 exists.
- **Append-only by convention only.** `session.delete(event)`, aliased imports, run-time SQL and dev `seed --reset` are not caught, and there is no trigger or hash chain (D6). Tracked: the inbox (added in bookkeeping).
- **The commit fitness test allows every `**/service.py`.** So only `test_record_audit_never_commits` guards `record_audit` against committing (mutation M2). Tracked: carried to P2-07.
- **No total metadata bound** and no key-length bound. Tracked: only here and in the PR.
- **Stale docstring.** `backend/app/auth/service.py::logout`'s docstring says "if it is live". Tracked: only here.

## 8. How to change this safely

- **Audit a new action:**
  1. Add a constant to `backend/app/audit/actions.py` (`<domain>.<past_verb>`).
  2. Call `record_audit` inside the use-case, **before** its single `commit()`, with `building_id=ctx.building_id` for building data.
  3. Put only ids and field names in `metadata`.
  4. Test it like `test_logout_records_logged_out_for_the_revoked_session`: the request, then exactly one event with its fields.
- **Record in a new path that raises** (like a failed login): commit before raising, or the event is lost (D1).
- **Never update or delete an `AuditEvent`.** Fitness test 5 fails on the common spellings. A retention job would need its own ticket and a deliberate change to that test.
- **Add a CLI filter:** add a field to `AuditQuery`, a clause in `find_audit_events`, and an option in `audit_command`; extend `test_cli_passes_every_filter`. A new filter that is slow on large tables needs an index in a new migration.

## 9. Must explain, then quiz

**1. Why must the audit row be written in the same transaction as the action?**
So the audit trail and the data can't disagree. If the event were committed separately and the action then failed, the trail would claim something that never happened. If the action committed and the event write then failed, something would have happened with no record. With one transaction, Postgres guarantees both or neither. In the code:
- `record_audit` only calls `db.add`.
- Each use-case (`backend/app/auth/service.py::logout_all`, for instance) commits once, after it.
- `test_audit_row_is_discarded_when_the_use_case_raises_before_commit` shows the "neither" half.

**2. Why does `auth.login_failed` not store the attempted email? What is the trade-off?**
An attempted email is personal data. Often it is a real person's address typed by someone else, a typo of the user's own, or a list being tested by an attacker. Storing it would build a list of other people's addresses, and audit metadata holds ids only (CLAUDE.md rule 10).

The trade-off is investigative power: operators can see *that* unknown-email failures happened and when (with `request_id` to find the log line), but not *which* addresses were tried, so they can't spot one address being sprayed. For known users, the `user_id` in metadata keeps the useful signal ("someone is guessing this account's password") without the email (D2).

**3. What makes a log "append-only" in practice, and how could it be made tamper-evident?**
Here it is a convention enforced by tooling: no code path updates or deletes an `AuditEvent`, and `backend/tests/test_architecture.py::files_that_mutate_audit_events` fails the build if one appears. That stops accidents, not a malicious operator with database access. Stronger options:
- Database privileges: the app role gets INSERT and SELECT only on `audit_events`.
- A trigger that rejects UPDATE and DELETE.
- Tamper-*evidence*: each row stores a hash of its contents plus the previous row's hash. Editing or removing a row breaks the chain, and a verifier detects it.
- Shipping events to write-once storage, such as S3 Object Lock.

None is built yet (D6).

**Quiz**

1. A login fails for an inactive user. What exactly is in the `audit_events` row, and what is in the 401 body?
2. `record_audit` is called with `metadata={"changes": {"reset_token_sent": True}}`. What happens, and why?
3. What would break if `logout` dropped `.returning(…)` and recorded `auth.logged_out` unconditionally?
4. What would break if `find_audit_events` used `AuditEvent.action.like(prefix + "%")`?
5. How would you extend this so that `membership.approved` (P4-06) is audited and visible with `--building maple`?

<details><summary>Answers</summary>

1. The row: `action` `auth.login_failed`, `entity_type` `user`, `actor_user_id`, `entity_id` and `building_id` null, `metadata` `{"user_id": "<id>"}`, plus `request_id` and `created_at`. The 401 is `invalid_credentials`, identical (apart from `request_id`) to an unknown email's (`test_known_user_failure_records_only_the_user_id[inactive_user]`).
2. `ValueError`, and nothing is added: the nested key contains `token`, and `_check_structure` checks keys at every depth, in any case. The use-case should name the field differently (`reset_email_sent`) or not record it.
3. Logging out with an unknown, already-revoked or missing token would write an event claiming a logout that changed nothing, and two concurrent logouts would write two. `test_logout_records_logged_out_for_the_revoked_session` (second half) and `test_logout_without_a_live_session_records_nothing` would fail.
4. `_` would become a wildcard: `--action auth.logged_` would match `auth.loggedxin`, and `--action %` would match everything (`test_action_prefix_is_literal_not_a_like_pattern`).
5. Add `MEMBERSHIP_APPROVED = "membership.approved"` to `backend/app/audit/actions.py`. In the approval use-case, call `record_audit(db, action=..., entity_type="membership", entity_id=membership.id, building_id=ctx.building_id, actor_user_id=ctx.user_id, metadata={"roles": [...]})` before its commit. `--building maple` then finds it through `ix_audit_events_building_id_created_at`. Add a test asserting exactly one event with those fields, and none for a refused approval.

</details>
