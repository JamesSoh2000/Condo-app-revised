# Explanation — P4-03 Bootstrap-building operator command

> **PR:** #89 · **Source revision:** `03f3b381f48402a46b271d25428e801a850b8d9d`, the pre-merge PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (2) reviewed this
> commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 89 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `03f3b38` the whole diff (`git diff origin/main...HEAD`, 14 files), the
> changed symbols in full, the migration, the assertions of every test in `backend/tests/cli/test_bootstrap.py`,
> `backend/tests/test_cli_seed.py::test_no_placeholder_commands_are_left`, and the PR description (no PR comments
> or reviews exist); ran `uv run pytest tests/cli tests/test_cli_seed.py tests/invitations tests/units`:
> 390 passed. Differences from the plan: two additions from review round 1 (see §2 "Plan versus final code").
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 1. Walkthrough variant: C (an operator command run).

## 1. What was built and why

`python -m app.cli bootstrap-building` creates a new building with its settings, features and units (from an
optional CSV), plus an invitation for its first property manager, whose email is queued. It does this in one
transaction with one audit event, `building.bootstrapped`, and prints the invitation's accept URL once, to
stdout. `--dry-run` checks everything, prints the plan and writes nothing. It solves the chicken-and-egg
problem: someone has to create the first building and manager, and ad hoc SQL is error-prone and unaudited
(ticket "Why").

Two decisions matter most:

- An invitation can now have no inviting user. `invitations.created_by_user_id` became nullable (D1).
- Nothing secret reaches a log or the terminal except that one URL line. That includes database errors,
  whose messages would otherwise print the email job's link (D4, from review round 1).

## 2. Decisions

### D1. An operator's invitation has no `created_by_user_id` (autonomous)

- **Problem or constraint:** `invitations.created_by_user_id` was NOT NULL (P4-02a), but the bootstrap has no
  user to invite from: the first manager is the invitation's target.
- **Chosen:** the expand migration `85cc5c7f420d` drops NOT NULL; NULL means an operator command created it.
  The accept copies the value into `building_memberships.status_changed_by_user_id`, which was already
  nullable, so a bootstrapped manager's membership records no approver.
- **Alternatives rejected:**
  - A "system" user row: a fake account that could be logged into or picked up by queries on users.
  - Creating the manager's account directly: the ticket asks for an invitation, and the password would have
    to travel some other way.
- **Tradeoffs and accepted limitations:** a NULL could also come from a bug that forgets the creator. The API
  path (`backend/app/invitations/service.py::create_invitation`) always passes `ctx.user_id`. The downgrade
  fails while an operator's invitation exists.
- **Basis:** autonomous (decision rule 3), expand-only (CLAUDE.md rule 11). Lasting (a table shape), so it is
  in the inbox's "Decisions to audit".
- **Source:** recorded (PR #89 D1, ticket Frame notes F1).

### D2. Exactly one audit event: `import_units(audit=False)`

- **Problem or constraint:** AC2 asks for exactly 1 audit event, but `import_units`, which the ticket says to
  reuse, records a `unit.created` event for every unit.
- **Chosen:** a keyword `audit: bool = True` on `backend/app/units/service.py::import_units`. Bootstrap passes
  False, and `building.bootstrapped` records the unit count in its metadata.
- **Alternatives rejected:**
  - Changing AC2 to "1 + one per unit": that loosens a criterion.
  - A separate unit insert in bootstrap: it duplicates the import, which the ticket forbids.
- **Tradeoffs and accepted limitations:** the bootstrapped units have no event of their own. The bootstrap
  event (same transaction, same building) is their record.
- **Basis:** ticket AC2 and "reused rather than duplicated".
- **Source:** recorded (PR #89 D2, Frame notes F3).

### D3. Any invalid CSV row refuses the whole run

- **Problem or constraint:** the import skips invalid rows (P4-01 D3); the P4-01b carry note left the choice
  to this ticket.
- **Chosen:** `bootstrap_building_command` exits 1 before any session if `parse_units_csv` reports an invalid
  row. It lists the line numbers and reasons, never the cell values.
- **Alternatives rejected:** importing the valid rows. AC4 says a malformed row exits non-zero before writing.
- **Tradeoffs and accepted limitations:** the operator fixes the file and runs again. `import-units` remains
  for partial updates later.
- **Basis:** ticket AC4. **Source:** recorded (PR #89 D3, Frame notes F2).

### D4. A database error prints only its SQLSTATE (review round 1, F1)

- **Problem or constraint:** a statement that fails after the token exists (the email job's INSERT, or the
  commit) raised a SQLAlchemy error. Its message and traceback print the statement's parameters, including
  the job payload's `/invite/<token>`. Codex showed this with a trigger that fails the jobs INSERT: the raw
  token was on stderr. Hiding traceback locals (`pretty_exceptions_show_locals=False`) didn't cover it.
- **Chosen:** the command catches `SQLAlchemyError` around `run_in_session` (the work and the commit). It
  prints `error: the database refused the bootstrap (SQLSTATE <code>); nothing was written` and raises
  `Exit(1) from None`, so there is no traceback and no chained exception.
- **Alternatives rejected:**
  - Printing the server's own message: a Postgres DETAIL can quote row values.
  - Catching every `Exception`: that would hide programming errors, and non-database errors here carry no
    parameters.
- **Tradeoffs and accepted limitations:** the operator sees less detail. The runbook says to look up the
  SQLSTATE or read the database log.
- **Basis:** review finding (round 1, F1). **Source:** recorded (PR #89 D4).

Smaller decisions, one row each:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| `join_code` = `XXXXX-XXXXX` from 31 characters without `0 O 1 I L` (`secrets.choice`, about 2^49) | the slug; a UUID | guessable; too long for the 16-character column | autonomous | PR #89 table, Frame notes F5 |
| `--features` defaults to `packages,notices,maintenance`; `""` means none; unknown or repeated names, or an empty item (`a,,b`), are refused | required option | the ticket's example is the demo set | ticket | PR #89, F6 |
| `--locale` defaults to `en` and must be in `SUPPORTED_LOCALES` (`en`, `fr`) | any string | the email would fall back to `en` silently | code | PR #89, F6 |
| `--manager-name` is optional and shown only in the plan and summary | store it | invitations have no name column; the accept form asks for the name (P4-02b) | code | PR #89, F7 |
| The operator is `$OPERATOR`, else `$USER`; neither set is refused; 1-64 printable characters | "unknown" | an audit row without an operator is not accountable | ticket | PR #89, F8 |
| `--reason`: 1-500 printable characters **and** at most 1,024 bytes as JSON | characters only | 400 × `界` passed the dry run and failed the real run after its writes (round 1, F2) | review round 1 | PR #89 table |
| Every CSV error names its option (`--units-csv`; `import-units` now says `--csv`) | unprefixed | AC4 says the error names the option (round 1, F3) | review round 1 | PR #89 table |
| Slug `^[a-z0-9-]{1,63}$`, the database's own rule | stricter | the CHECK constraint is the rule | code | PR #89 table |
| The building insert is `ON CONFLICT (slug) DO NOTHING` | catching `IntegrityError` | a failed statement aborts the transaction; the units import uses the same pattern | convention | PR #89 table |
| Audit metadata `{operator, reason, invitation_id, units}` | `{operator, reason}` | links the event to what it created | ticket + D2 | PR #89 table |
| Typer tracebacks never show locals (`pretty_exceptions_show_locals=False`) | rich's default (on) | the command holds the token in a local variable, which a pretty traceback prints | autonomous | PR #89 table |

**Framing changes:** all six criteria were made precise (exact tables, columns and output lines). Three were
added: AC7 (`APP_ENV=prod`), AC8 (one transaction; a late failure writes nothing) and AC9 (other buildings
untouched). Ten-case table rows 1-6 and 8-10 don't apply (no route, role or tenant context). None was
loosened. Ticket Frame notes, commit `952c1bf`.

**Plan versus final code:** compared with the PR's Plan, the final code adds two things, both from review
round 1: the `SQLAlchemyError` handler (D4) and the byte cap on `--reason`. `_read_units_csv` also takes the
option name (F3). Everything else matches, including the files, `add_invitation`'s shape, the migration and
the test map.

## 3. How it is implemented

### Overview

- `backend/app/cli.py::bootstrap_building_command` validates every input before any database session:
  options into `BootstrapInput`, the CSV through `_read_units_csv`, and the operator from the environment.
- `backend/app/buildings/service.py::bootstrap_building` does the writes. It only flushes;
  `backend/app/cli.py::run_in_session` commits once.
- It reuses `backend/app/units/service.py::import_units` (with `audit=False`) and
  `backend/app/invitations/service.py::add_invitation`, a helper extracted from `create_invitation`.
- `backend/app/buildings/service.py::render_bootstrap` prints the plan or summary. The command prints the
  URL itself, last.

### Walkthrough (variant C: one real run)

1. **Trigger:** `docker compose exec -e OPERATOR=james app python -m app.cli bootstrap-building --slug cedar
   … --units-csv /tmp/cedar-units.csv --reason "…"` (the runbook, `docs/runbooks/bootstrap-building.md`).
2. **Checks, no database:**
   - The operator comes from `OPERATOR` or `USER`; neither set → `error: set OPERATOR (or USER)…`, exit 1.
   - `BootstrapInput(...)` validates the slug pattern, the text lengths and printable characters, the IANA
     timezone, the locale, distinct known features, the email (lowered), and the reason's byte size. Each
     pydantic error prints as `error: --<option>: <message>`, never with the value.
   - `_read_units_csv` reads at most 1 MiB + 1 byte, decodes UTF-8 and calls `parse_units_csv`. Any invalid
     row refuses the run (D3).
3. **The transaction:** `run_in_session` opens a session and calls `work`, which calls `bootstrap_building`.
   - Dry run: one `SELECT id FROM buildings WHERE slug = …`. A hit raises `SlugExists`; otherwise it returns
     a result with no IDs and no token.
   - Real run, in order:
     1. `INSERT INTO buildings … ON CONFLICT (slug) DO NOTHING RETURNING id`; no row → `SlugExists`.
     2. One multi-row `INSERT` of `building_features`.
     3. `import_units(..., audit=False)`: one upsert per row in a fixed order.
     4. `add_invitation`: an invitation with a fresh token whose sha256 is stored, a 7-day expiry, roles
        `[property_management]` and `created_by_user_id` NULL, then `queue_email` (an `email.send` job whose
        payload `context.link` is `/invite/<token>`).
     5. `record_audit(building.bootstrapped, actor_user_id=None, …)`, then a flush.
4. **End state:** `run_in_session` commits (a dry run rolls back). The command prints the summary (slug,
   name, timezone, locale, features, units, invitation, manager name, building id, join code). Then it
   prints `deliver this link…` and `accept URL: <APP_BASE_URL>/invite/<token>` as the last line. The worker
   later sends the email and drops `context` from the job.
5. **Failures:**
   - `SlugExists` → `error: slug already exists: <slug>`, exit 1, nothing committed.
   - A database error → `error: the database refused the bootstrap (SQLSTATE …); nothing was written`
     (D4).
   - Any exception inside `work` skips the commit, so nothing is written (AC8).
6. **Recovery:** fix the input and run again. If the slug already exists, the building is there: check with
   `make cli args="audit --building <slug> --action building."`. A lost or expired link has no operator
   command yet (§7).

### Data model changes

`invitations.created_by_user_id` is now nullable (migration `85cc5c7f420d`, D1). There are no new tables or
constraints. `join_code` (unique, String(16)) already existed. Bootstrap is the first code that fills it.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/buildings/service.py` | `bootstrap_building`, `render_bootstrap`, `BootstrapResult`, `SlugExists`, join codes | +130/−4 |
| `backend/app/buildings/schemas.py` | `BootstrapInput` and its validators | +69/−1 |
| `backend/app/cli.py` | the command (replacing the placeholder), `_read_units_csv` shared with `import-units`, no traceback locals | +116/−23 |
| `backend/app/invitations/service.py` | `add_invitation` extracted from `create_invitation`; `_Pending.created_by_user_id` optional | +42/−12 |
| `backend/app/invitations/models.py` | `created_by_user_id` nullable | +4/−1 |
| `backend/app/units/service.py` | `import_units(..., audit=True)` | +9/−4 |
| `backend/app/audit/actions.py` | `BUILDING_BOOTSTRAPPED` | +2 |
| `backend/migrations/versions/85cc5c7f420d_…` | DROP NOT NULL | +31 |
| `backend/tests/cli/test_bootstrap.py` | the criteria, round-1 regressions and the CLI wiring | +739 |
| `backend/tests/test_cli_seed.py` | the placeholder test replaced (§7, gate note) | +6/−11 |
| `docs/runbooks/bootstrap-building.md`, `docs/ARCHITECTURE.md`, the ticket | runbook, CLI list, Frame notes | docs |

**Key excerpts**

`backend/app/buildings/service.py::bootstrap_building`

```python
    unit_count = 0 if units is None else len(units.rows)
    if dry_run:
        if await db.scalar(select(Building.id).where(Building.slug == data.slug)) is not None:
            raise _slug_exists(data.slug)
        return BootstrapResult(None, None, unit_count, None, None)
    join_code = _join_code()
    # ON CONFLICT: a concurrent bootstrap of the slug makes this wait, then return nothing,
    # instead of an IntegrityError.
    building_id = await db.scalar(
        pg_insert(Building)
        .values(
            # ...
            join_code=join_code,
        )
        .on_conflict_do_nothing(index_elements=["slug"])
        .returning(Building.id)
    )
    if building_id is None:
        raise _slug_exists(data.slug)
    # ... features
    if units is not None:
        report = await import_units(db, building_id, units, dry_run=False, audit=False)
        unit_count = report.created
    building = await db.get_one(Building, building_id)
    invitation, token = await add_invitation(
        db,
        building,
        email=data.manager_email,
        roles=[Role.PROPERTY_MANAGEMENT],
        created_by_user_id=None,
        now=clock.now(),
    )
    await record_audit(
        # ...
        metadata={
            "operator": data.operator,
            "reason": data.reason,
            "invitation_id": invitation.id,
            "units": unit_count,
        },
    )
    await db.flush()
    return BootstrapResult(building_id, join_code, unit_count, invitation.id, token)
```

- It does every write and never commits, so the caller's one commit makes the run atomic (AC8).
- `ON CONFLICT` turns a duplicate slug into `SlugExists`, not an aborted transaction. Without it,
  `test_same_slug_again_is_refused_and_writes_nothing[real]` and `test_existing_world_slug_is_refused` fail
  (mutation probe in the PR: 2 failed).
- With `audit=True`, the 40 imported units add 40 `unit.created` events, so
  `test_real_run_creates_exactly_the_bootstrap_rows` fails (probe: 1 failed).
- `BootstrapResult.token` is declared `field(repr=False)`, so printing the result never shows the token.

`backend/app/cli.py::bootstrap_building_command` (the end)

```python
    async def work(db: AsyncSession) -> None:
        result = await bootstrap_building(db, data, units, dry_run=dry_run)
        output.append(render_bootstrap(data, result, dry_run=dry_run))
        if result.token is not None:
            # stdout only, once: never logged (ticket). The link the email carries.
            output.append(
                "deliver this link to the manager only if the email does not arrive:\n"
                f"accept URL: {settings.app_base_url}/invite/{result.token}"
            )

    try:
        run_in_session(work, commit=not dry_run)
    except SlugExists as exc:
        typer.echo(f"error: {exc}", err=True)
        raise typer.Exit(1) from exc
    except SQLAlchemyError as exc:
        # Never the message or the traceback: they carry the statements' parameters, and the
        # email job's hold the accept link (review round 1, F1). The SQLSTATE says what failed.
        state = getattr(getattr(exc, "orig", None), "sqlstate", None) or type(exc).__name__
        typer.echo(
            f"error: the database refused the bootstrap (SQLSTATE {state}); nothing was written",
            err=True,
        )
        raise typer.Exit(1) from None
    typer.echo("\n".join(output))
```

- Output is collected and printed only after the commit, so a failed commit prints no URL for a link that
  doesn't exist.
- `typer.echo` writes to stdout and never goes through `logging` (AC6).
- Remove the `SQLAlchemyError` clause and three tests fail (probe "catch nothing": 3 failed), including the
  subprocess test against a real database.

`backend/app/buildings/schemas.py::_fits_audit_value`

```python
def _fits_audit_value(value: str) -> str:
    # `record_audit` measures a metadata value as JSON (ensure_ascii=False) in UTF-8 bytes: a
    # reason it would refuse must fail here, before any write, not after (review round 1, F2).
    if len(json.dumps(value, ensure_ascii=False).encode()) > MAX_VALUE_BYTES:
        raise PydanticCustomError(
            "too_long", "must be at most {limit} bytes", {"limit": MAX_VALUE_BYTES}
        )
    return value
```

- It mirrors `backend/app/audit/service.py::_to_json`'s measurement, so the dry run refuses what the real
  run's `record_audit` would refuse.
- Without it, `test_reason_over_the_audit_value_limit_is_refused` fails (probe: 1 failed).

`backend/app/invitations/service.py::add_invitation`

```python
    token = generate_token()
    invitation = Invitation(
        building_id=building.id,
        email=email,
        roles=[role.value for role in roles],
        unit_id=unit_id,
        relationship=relationship,
        token_hash=hash_token(token),
        expires_at=now + INVITATION_TTL,
        created_by_user_id=created_by_user_id,
    )
    db.add(invitation)
    await db.flush()
    await db.refresh(invitation, ["created_at"])
    await _queue_invitation_email(db, building, invitation, token)
    return invitation, token
```

- This is `create_invitation`'s former body, with no checks, audit or commit. `create_invitation` still does
  its locking, pending check and `invitation.created` audit around it, and the P4-02 tests still pass. The
  token, hashing, expiry and email are therefore identical for both paths.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| A dry run writes something | only a slug SELECT | `test_dry_run_writes_nothing_and_prints_the_plan` (six table counts equal) |
| The slug exists (also in a dry run) | `SlugExists`, exit 1 | `test_same_slug_again_is_refused_and_writes_nothing[real,dry-run]`, `test_cli_same_slug_exits_1_without_committing` |
| Two bootstraps of one slug at once | `ON CONFLICT` makes the second return nothing → `SlugExists` | No test in the repo; Codex round 2 ran two scratch proofs on separate connections (2 passed, not committed) |
| A late failure (the email can't be queued) | nothing committed | `test_late_failure_writes_nothing` (savepoint rollback, counts equal), `test_bootstrap_flushes_but_never_commits` |
| A database error prints the link | SQLSTATE only, no traceback | `test_cli_database_error_prints_no_sql_parameters`, `test_cli_commit_failure_prints_no_sql_parameters`, `test_real_database_failure_prints_no_token` |
| A traceback prints locals (the token) | locals hidden | `test_cli_tracebacks_never_show_locals` (asserts the setting only) |
| Logs or audit hold the token or URL | the URL is echoed, never logged | `test_logs_and_audit_hold_no_token_or_url` (app loggers, DEBUG) |
| Bad timezone, slug, email, locale, features, reason, name, address | refused before a session, naming the option | `test_bad_input_is_refused` (20 cases), `test_cli_refuses_bad_input_before_any_session` (8) |
| A multibyte reason passes the dry run and fails later | refused by bytes | `test_reason_over_the_audit_value_limit_is_refused`, `test_a_reason_the_input_accepts_is_recorded` |
| A bad CSV (row, header, UTF-8, syntax, size, missing) | exit 1 before a session, `error: --units-csv:` | `test_cli_bad_csv_exits_1_before_any_session` (5), `test_cli_oversized_csv_names_the_option`, `test_cli_missing_csv_exits_1`, `test_cli_invalid_rows_are_listed_by_line_without_values` |
| No operator | refused | `test_cli_refuses_without_an_operator`, `test_cli_user_is_the_operator_when_operator_is_unset` |
| Other buildings changed | untouched | `test_other_buildings_are_untouched` (full rows of the world's buildings, units, invitations, features) |
| Join codes collide or are ambiguous | random, 11 characters, unambiguous alphabet | `test_join_codes_are_generated_and_differ` (a collision itself would surface as a database error; no test) |

Acceptance criteria → tests:

1. `test_dry_run_writes_nothing_and_prints_the_plan`, `test_cli_dry_run_rolls_back_and_prints_no_url`.
2. `test_real_run_creates_exactly_the_bootstrap_rows`, `test_cli_real_run_commits_and_prints_the_url_last`.
3. `test_same_slug_again_is_refused_and_writes_nothing`, `test_cli_same_slug_exits_1_without_committing`.
4. `test_bad_input_is_refused`, `test_cli_refuses_bad_input_before_any_session`,
   `test_cli_bad_csv_exits_1_before_any_session` and the other CLI refusal tests above.
5. `test_manager_accepts_and_can_invite_staff`: the accept returns 200 with roles `["property_management"]`,
   and the membership is active; then `POST …/invitations` returns 201.
6. `test_logs_and_audit_hold_no_token_or_url`, plus the three database-error tests.
7. `test_cli_runs_with_app_env_prod`. It patches `settings.app_env` and the command doesn't read it, so it
   proves "no prod refusal was added", not a production configuration (§7).
8. `test_late_failure_writes_nothing`, `test_bootstrap_flushes_but_never_commits`.
9. `test_other_buildings_are_untouched`.

Stack evidence (PR #89): the prod-like run at `231a205` covered the dry run, the real run (3 | 40 | 1 NULL |
the audit row), the repeated slug, `Mars/Base`, no `OPERATOR`, the email in Mailpit, accept 200, `/me`
active `property_management`, the staff invite 201, and 0 token hits in the api, worker and caddy logs.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings (severity: one line) | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6-astra`, medium (fresh process; no Claude reviewer, as James instructed for this run) | `231a205` | BLOCK | F1 Medium: a database error printed the token; F2 Medium: a multibyte reason passed the dry run but failed the real run; F3 Low: CSV errors didn't name the option | all fixed in `64ddda4` (tests `cbb7622`) |
| 2 | Codex `gpt-6-astra`, medium (new process) | `03f3b38` | MERGE | none | — |

- **F1.** A trigger made the jobs INSERT fail. The real CLI, in a subprocess, printed SQLAlchemy's error with
  its `[parameters: …]`, which hold `/invite/<43-character token>`. Codex's proof is kept as
  `test_real_database_failure_prints_no_token`. It failed before `64ddda4` and passes after. That fix
  produced D4.
- **F2.** `reason="界" * 400` is 400 characters (≤ 500) but 1,202 bytes as JSON. The dry run passed; the real
  run raised `ValueError` in `record_audit` after the inserts, and the transaction rolled back. Fixed by the
  byte cap. `test_reason_over_the_audit_value_limit_is_refused` failed before the fix and passes after.
- **F3.** `wrong,header`, non-UTF-8, broken CSV, missing and oversized files printed `error: <message>`
  without `--units-csv`. Fixed by passing the option name to `_read_units_csv`. The prefix assertions in the
  CSV tests failed before the fix and pass after.
- Round 2 also checked the fixes' neighbours listed in the PR: the commit-time failure, the exact byte
  boundary, every reader error path, and `import-units`.

## 7. Not verified, accepted risks and follow-ups

- **Concurrent same-slug bootstraps:** no committed test. The `ON CONFLICT` behaviour rests on the code and on
  Codex's round-2 scratch proofs, which weren't kept.
- **AC7:** proven only with a patched setting. The prod-like stack runs `APP_ENV=dev`; a real production
  configuration is milestone D (D-06 adds the SSM run to the runbook).
- **The stack journey ran at `231a205`, before the round-1 fixes.** The fixes changed only error paths
  (database errors, the reason's byte cap, CSV error prefixes), which unit and subprocess tests cover. The
  successful path wasn't re-run on the stack.
- **`test_cli_tracebacks_never_show_locals`** asserts the setting, not a rendered traceback.
- **A join-code collision** (about 2^49 codes) would fail the run with a database error (SQLSTATE 23505).
  There is no retry and no test. Accepted as negligible (inferred; not recorded in the PR).
- **No operator command recovers a lost or expired first-manager link:** revoke and resend need a manager in
  the building. PR follow-up; added to the inbox in the bookkeeping commit.
- **The downgrade of `85cc5c7f420d` fails** while an operator's invitation exists (stated in the migration).
- **The raw link sits in the queued `email.send` payload** until the worker sends it and drops `context`.
  This is P4-02a's accepted risk, unchanged.
- **`--manager-name` is not stored,** so the accept form can't prefill it. Follow-up for P4-07 if wanted.
- **The URL on stdout is a credential** by design (ticket). The runbook tells the operator to clear the
  scrollback and not paste it anywhere.
- Gate note: `test_cli_placeholders_exit_nonzero_naming_their_ticket` lost its last row (this command), as
  each earlier ticket removed its own row (P3-02, #73). It was replaced by
  `test_no_placeholder_commands_are_left`.

## 8. How to change this safely

- **A new option** (say `--join-code-disabled`): add the field to `BootstrapInput`, pass it in
  `bootstrap_building_command`, and use it in `bootstrap_building`. A value that reaches `record_audit` must
  also fit `MAX_VALUE_BYTES` before any session (F2's lesson). Add a row to `test_bad_input_is_refused`.
- **Anything else that writes a secret in the transaction:** the `SQLAlchemyError` handler already hides
  parameters. Don't add `logging` of the result, and keep `BootstrapResult.token` out of `repr`.
  `test_logs_and_audit_hold_no_token_or_url` and `test_real_database_failure_prints_no_token` will tell you.
- **Changing invitations:** `add_invitation` is shared with `create_invitation`. The P4-02 tests in
  `backend/tests/invitations/` cover the API path, and AC5's test covers the bootstrap path.
- **Changing the import:** keep `audit=False` working; `test_real_run_creates_exactly_the_bootstrap_rows`
  counts audit events.

## 9. Must explain, then quiz

**1. Why an audited CLI instead of an admin web page for this?** The first building has no manager, so no
web user exists who is allowed to create it. A web route would need a new platform-admin role, its login
and its rate limits: new attack surface for a rare action (Inferred; the ticket keeps the platform-admin UI
out of scope). A CLI runs only where you already have shell access to the app container. That access is
the authority, and the command records who used it and why
(`backend/app/buildings/service.py::bootstrap_building`'s `building.bootstrapped` event with `operator` and
`reason`). It is also scriptable for the E2E journey (P4-09) and for staging through SSM (D-06).

**2. Why print the URL to stdout but never log it?** The URL contains the token, and the token is the only
credential an accept needs. Logs are shipped, kept and read by more people and systems than the operator's
terminal. The database stores only the token's sha256 (`add_invitation`'s `token_hash`), so stdout is the
one place the operator can still recover it if the email fails (ticket). The command writes it with
`typer.echo`, never `logging`. It hides traceback locals and database-error parameters (D4), and
`test_logs_and_audit_hold_no_token_or_url` checks the app's loggers.

**3. What would go wrong if bootstrap were not a single transaction?** A failure halfway (say the email job
couldn't be queued) would leave a building with no manager invitation, or with units but no audit event.
Running it again would then fail with `slug already exists`, so the operator would need SQL to clean up:
exactly what the command replaces. `bootstrap_building` only flushes and `run_in_session` commits once, so
`test_late_failure_writes_nothing` sees every count unchanged after such a failure.

Quiz:

1. The dry run checks the slug but writes nothing. Name a failure the dry run could miss before round 1, and
   what now catches it before a session.
2. Why does the building insert use `ON CONFLICT (slug) DO NOTHING` instead of catching `IntegrityError`?
3. Why is `created_by_user_id` NULL on this invitation, and where does that NULL end up when the manager
   accepts?
4. What would break if `except SQLAlchemyError` were removed from `bootstrap_building_command`?
5. How would you add an operator command to resend a bootstrapped building's lost manager invitation?

<details><summary>Answers</summary>

1. A reason under 500 characters but over 1,024 bytes as JSON (for example 400 × `界`). The dry run passed,
   and the real run failed in `record_audit` after its inserts. `_fits_audit_value` in `BootstrapInput` now
   refuses it with the other input checks.
2. In Postgres, a failed statement aborts the whole transaction, so after an `IntegrityError` nothing else
   could run. `ON CONFLICT … RETURNING id` returns no row instead: the code raises a clean `SlugExists`, and
   a concurrent insert of the same slug waits and then sees the conflict.
3. No user invited the manager: an operator ran a command (D1). On accept,
   `_activate_membership` copies it into `building_memberships.status_changed_by_user_id`, so that is NULL
   too (`test_manager_accepts_and_can_invite_staff` asserts it).
4. A database error after the token exists, at the email job's INSERT or at the commit, would surface as an
   uncaught SQLAlchemy exception. Its message prints the statement's parameters, including
   `/invite/<token>`, onto stderr. `test_real_database_failure_prints_no_token` and the two CLI
   database-error tests would fail.
5. Inside one session: find the building by slug and its open invitation for `property_management` with a
   NULL creator, then do what `resend_invitation` does without a `TenantContext`: a conditional UPDATE with a
   new token hash and expiry, then queue the email. Record an audit event with the operator and reason,
   print the URL once, and apply the same SQLSTATE-only error handling. Reuse `add_invitation`'s email path
   rather than copying it.

</details>
