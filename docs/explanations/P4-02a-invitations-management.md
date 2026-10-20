# Explanation — P4-02a Invitations: table and manager endpoints

> **PR:** #86 · **Source revision:** `374f94e`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (3) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 86 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `374f94e` the diff (`git diff --stat origin/main...HEAD`, 24 paths), the whole
> of `backend/app/invitations/{models,schemas,service,router}.py`, the migration `87a5795f265e`, the three
> `invitation.*` templates, the small diffs in `backend/app/main.py`, `backend/app/audit/actions.py` and
> `backend/app/models/registry.py`, the
> assertions of every test cited below, PR #86's description and the three Codex review files. Ran
> `uv run pytest tests/invitations tests/test_world.py tests/files/test_migration_cleanup.py`: 84 passed
> (the last with the S3 test environment `make test` sets). Compiled the lock, pending-check and revoke
> statements with the Postgres dialect for §3. CI was green on `374f94e`. Differences from the plan: see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 1. Walkthrough variant: A.

## 1. What was built and why

A property manager can now invite someone by email into their building with preassigned roles (and,
for a pre-approved resident, a unit): `POST /api/buildings/{id}/invitations`. They can list invitations by
status, revoke one, and resend one with a fresh link. The invitee gets an email (through the worker) with
`${APP_BASE_URL}/invite/<token>`; the database keeps only the token's sha256. Accepting the link is the
next ticket, [P4-02b](../tickets/P4-02b-invitation-accept.md): P4-02 was split while framing.

The two decisions that matter most: **only a hash of the token is stored** (the raw token lives in the email,
and briefly in the queued job, which the worker scrubs), and **at most one pending invitation per email and
building**, enforced under a lock on the building row by both create and resend (the second after review
round 1).

## 2. Decisions

### D1. Split P4-02 into P4-02a (manage) and P4-02b (accept)

- **Problem or constraint:** the framing estimate for P4-02 was ~550 non-test lines, over the ~400 limit.
- **Chosen:** P4-02a = table, manager endpoints, email, audit; P4-02b = public lookup and accept, their rate
  limit and allowlist entries. P4-03 and P4-07 now depend on P4-02b in the index.
- **Alternatives rejected:** "table first, endpoints later": the table alone tests nothing a reviewer could
  judge.
- **Tradeoffs and accepted limitations:** until P4-02b merges, an invitation can be sent but not accepted.
- **Basis:** playbook step 1.4; the P4-01 precedent. **Source:** recorded (PR #86 D1, ticket Frame notes).

### D2. One pending invitation per (building, email), under a building-row lock

- **Problem or constraint:** two pending invitations for one person would be two live links, possibly with
  different roles. A partial unique index can't say "not expired": `now()` may not appear in an index
  predicate.
- **Chosen:** `backend/app/invitations/service.py::_lock_building` takes `FOR NO KEY UPDATE` on the
  building row; then `backend/app/invitations/service.py::_refuse_another_pending` looks for a pending
  invitation for the email and raises 409 `invitation_pending`. Create and resend both do this. NO KEY UPDATE
  doesn't conflict with the `FOR KEY SHARE` locks that foreign-key checks from other tables take.
- **Alternatives rejected:** a partial unique index on `(building_id, email) WHERE accepted_at IS NULL AND
  revoked_at IS NULL` (an expired, never-closed invitation would block a new one forever, or create would
  have to close it); allowing duplicates (two live links).
- **Tradeoffs and accepted limitations:** invitation writes in one building serialise for one short
  transaction each.
- **Basis:** autonomous; resend's part from review round 1 (R1-F1). **Source:** recorded (PR #86 D2, review log).

### D3. Email validation without `email-validator`

- **Problem or constraint:** the P1-02 carry: the first schema that *writes* an email must refuse non-ASCII,
  empty and padded values and check length after lowering. The address must also be one `queue_email`
  accepts, or create would raise `ValueError` mid-request (a 500).
- **Chosen:** `backend/app/invitations/schemas.py::_email` reuses P3-02's
  `backend/app/core/config.py::is_email_address` (ASCII, one bare address, ≤ 254 octets, local part ≤ 64),
  on a field declared with `strip_whitespace=False`, then lowers it.
- **Alternatives rejected:** `EmailStr`: a new dependency, and it accepts addresses `queue_email` refuses.
- **Tradeoffs and accepted limitations:** internationalised addresses are refused.
- **Basis:** P1-02 carry; existing convention. **Source:** recorded (PR #86 D3).

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Package `app/invitations/` | `app/memberships/` (ARCHITECTURE.md tree) | package by feature, as the ticket's "Likely files" | ticket | recorded (PR table) |
| `roles` as `varchar(32)[]` with CHECKs | a Postgres enum array | enums are non-native (`database_enum`): there is no type to make an array of | convention | recorded |
| `unit_id` needs `resident` and an active unit of the building | allow any | ADR-0010: occupancies belong to residents; P4-01a refuses to deactivate an occupied unit | ADR-0010, P4-01a | recorded |
| Resend and revoke allowed on an *expired* invitation | 409 | resend exists to revive expired ones; revoke closes them | autonomous | recorded |
| Email locale = the building's (`en` fallback) | always `en` | the invitee may have no account | autonomous | recorded |
| Status derived from timestamps | a `status` column | the timestamps already say it; a column would need a sweeper for expiry | autonomous | recorded |
| No dedupe key on the email job | `invitation:<id>` | resend must queue a second email | autonomous | recorded |
| Duplicate roles collapsed and sorted | 422 | harmless input; a set is meant | autonomous | recorded |
| Resend checks its own state before the pending check | pending check first | criterion 9 requires `invalid_transition` for a closed invitation | review round 2 | recorded |

**Framing changes:** P4-02 split (D1). P4-02a's criteria 1 and 6 sharpened from P4-02's (the job payload is
scrubbed; the full tenant table); criteria 2–5 and 7–10 added (email rules, role and unit validation, tenant
rows 7–10, list filters). Nothing loosened: P4-02's criteria 2, 3, 4, 5, 7, 8 moved to P4-02b unchanged.

**Plan versus final code:** compared with the PR's Plan. Differences, all recorded below the Plan or in the
review log: the size (614 non-test lines at the source revision, 502 hand-written plus a 112-line migration, over
~400; 575 when the PR was opened, before the two review fixes; a further
split would separate token rotation from the create that issues the token); resend also takes the building
lock and the pending check (review round 1); resend checks its own state first (review round 2); an added
real-connection concurrency test; three existing tests updated (§5); the email `link` is a path the template
prefixes with `app_base_url`.

## 3. How it is implemented

### Overview

- `backend/app/invitations/router.py::router`: four routes on the building router, each behind
  `require_roles(Role.PROPERTY_MANAGEMENT)`.
- `backend/app/invitations/service.py`: the use-cases, each committing once (CLAUDE.md rule 5); the status
  logic (`status_of` in Python, `status_clause` in SQL, the same precedence: accepted > revoked > expired >
  pending).
- `backend/app/invitations/models.py::Invitation`: the table, with its CHECKs and composite unit FK.
- The `invitation` email template, queued with `queue_email` in the same transaction; the worker's
  `email.send` handler sends it and drops `context` (which holds the link) from the stored payload.

### Walkthrough: `POST /api/buildings/{building_id}/invitations`

1. **HTTP** → `backend/app/invitations/router.py::create`. CSRF middleware first (unsafe method).
2. **Dependencies:** `get_current_session` (401 `not_authenticated`), `get_tenant_context` (404
   `building_not_found` unless an active member of an active building), `require_roles` (403
   `forbidden_role` unless property_management).
3. **Body:** `backend/app/invitations/schemas.py::InvitationCreate` (`extra="forbid"`): email validated and
   lowered; roles non-empty, deduplicated, sorted; `unit_id` and `relationship` both or neither; a unit needs
   `resident`. Any failure is 422 `validation_error`, with no echo of values.
4. **Service** `backend/app/invitations/service.py::create_invitation`:
   - lock the building:
     ```sql
     SELECT buildings.id, … FROM buildings WHERE buildings.id = $1 FOR NO KEY UPDATE
     ```
   - if `unit_id`: load it with `building_id = ctx.building_id` (404 `unit_not_found` for a missing or
     other building's unit; 409 `unit_inactive`);
   - the pending check (`_refuse_another_pending`):
     ```sql
     SELECT invitations.id FROM invitations
     WHERE building_id = $1 AND email = $2
       AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > $3   -- pending
     LIMIT 1
     ```
   - `generate_token()` (32 random bytes, URL-safe base64), insert the row with `hash_token(token)` and
     `expires_at = clock.now() + 7 days`.
5. **Side effects, same transaction:** `queue_email(... template="invitation", context={building_name, roles,
   link: "/invite/<token>", expires_at})` inserts an `email.send` job; `record_audit("invitation.created")`
   with no metadata. Then the one `commit()`.
6. **Response:** 201 `InvitationOut` (`id, email, roles, unit_id, relationship, status, expires_at,
   created_at`): no token, no hash.
7. **Later, in the worker:** `email.send` renders the template and sends it; on success the job's payload
   is rewritten without `context` (the handler's `sensitive_keys`), so the raw link is gone from the database.

**Revoke and resend** go through `backend/app/invitations/service.py::_transition`, one conditional
statement (CLAUDE.md rule 7):

```sql
UPDATE invitations SET revoked_at = $1, updated_at = now()
WHERE id = $2 AND building_id = $3 AND accepted_at IS NULL AND revoked_at IS NULL
RETURNING …
```

Zero rows: a second `SELECT` by id and building tells 404 `invitation_not_found` (not this building's, the
same body as a random id) from 409 `invalid_transition`. Resend first locks the building, reads its target
(404, or 409 `invalid_transition` if closed), refuses if *another* invitation for the email is pending, then
sets a new `token_hash` and `expires_at` in that UPDATE and queues the email again.

### Data model changes

Table `invitations` (migration `87a5795f265e`, additive):

| Column / constraint | Why it exists |
|---|---|
| `email varchar(254)`, CHECK `email = lower(email)` | lookups compare the lowered form; a row written around the schema can't hold mixed case |
| `roles varchar(32)[]`, CHECK `cardinality(roles) > 0`, CHECK `roles <@ ARRAY['resident','security','property_management','council']` | an invitation that grants nothing, or an unknown role, can't be stored |
| `unit_id`, `relationship`, CHECK both-or-neither; FK `(building_id, unit_id)` → `units` | a resident's unit is in the invitation's building (ADR-0005); a relationship never stands alone |
| `token_hash varchar(64)` UNIQUE | lookup by hash in P4-02b; the raw token is never stored |
| `expires_at`, `accepted_at`, `accepted_user_id`, `revoked_at`, `created_by_user_id` | the status is read from these; FKs RESTRICT, as elsewhere |
| index `(building_id, email)` | the pending check |

The migration was autogenerated, then hand-edited: autogenerate rendered the `relationship` CHECK twice,
fixed as in `8887ac143e98`.

## 4. The code

**Files changed** (non-test)

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/invitations/service.py` | use-cases, status logic, email | +279 |
| `backend/app/invitations/schemas.py` | `InvitationCreate`, `InvitationOut`, `InvitationStatus` | +72 |
| `backend/app/invitations/models.py` | `Invitation` | +68 |
| `backend/app/invitations/router.py` | four routes | +61 |
| `backend/migrations/versions/87a5795f265e_invitations_p4_02a.py` | the table | +112 |
| `backend/app/email/templates/en/invitation.{subject.txt,txt,html}` | the email | +15 |
| `backend/app/audit/actions.py`, `backend/app/main.py`, `backend/app/models/registry.py` | wiring | +7 |
| `frontend/src/api/schema.d.ts` | generated | +393 |

Tests: `backend/tests/invitations/{test_invitations,test_concurrency,conftest}.py` (new), and three existing
tests updated (§5).

`backend/app/invitations/service.py::resend_invitation`

```python
    building = await _lock_building(db, ctx)
    now = clock.now()
    target = (
        await db.execute(
            select(Invitation.email, Invitation.accepted_at, Invitation.revoked_at).where(
                Invitation.id == invitation_id, Invitation.building_id == ctx.building_id
            )
        )
    ).one_or_none()
    if target is None:
        raise _not_found()
    # Its own state first: an accepted or revoked one is `invalid_transition` whatever else is
    # pending (review round 2). `_transition` checks it again, in the statement that writes.
    if target.accepted_at is not None or target.revoked_at is not None:
        raise _invalid_transition()
    await _refuse_another_pending(db, ctx, target.email, now, besides=invitation_id)
    token = generate_token()
    invitation = await _transition(
        db, ctx, invitation_id, token_hash=hash_token(token), expires_at=now + INVITATION_TTL
    )
    await _queue_invitation_email(db, building, invitation, token)
    await _audit(db, ctx, actions.INVITATION_RESENT, invitation_id)
```

- Rotates the token: the old hash is overwritten in the conditional UPDATE, so the old link matches no row
  from the moment this commits.
- The lock and `besides=invitation_id` (D2, R1-F1): without them an expired invitation could be revived next
  to its replacement. The state check before them (R2-F1) keeps criterion 9's error code.
- Remove `_transition`'s `_open()` and a revoked or accepted invitation gets a new live token (mutation M4
  in the PR kills five tests).

`backend/app/invitations/service.py::_lock_building` and `_refuse_another_pending`

```python
async def _lock_building(db: AsyncSession, ctx: TenantContext) -> Building:
    # ...
    building = await db.scalar(
        select(Building).where(Building.id == ctx.building_id).with_for_update(key_share=True)
    )
    assert building is not None  # noqa: S101 (get_tenant_context found it active)
    return building


async def _refuse_another_pending(
    db: AsyncSession,
    ctx: TenantContext,
    email: str,
    now: datetime,
    *,
    besides: UUID | None = None,
) -> None:
    """At most one pending invitation per email and building. Call after `_lock_building`."""
    stmt = select(Invitation.id).where(
        Invitation.building_id == ctx.building_id,
        Invitation.email == email,
        status_clause(InvitationStatus.PENDING, now),
    )
    if besides is not None:
        stmt = stmt.where(Invitation.id != besides)
    if await db.scalar(stmt.limit(1)) is not None:
        raise InvitationPending(
            detail="This email already has a pending invitation; resend or revoke it."
        )
```

- Read-then-insert is safe only because of the lock: under READ COMMITTED, the second transaction waits on
  the building row, and its pending check (a new statement) sees the first's committed row.
- Without `with_for_update`, two concurrent creates both pass the check. Mutation M6 showed it on the
  first version of the concurrency test (`test_concurrent_creates_for_one_email_make_one_invitation`, since
  folded into the parametrized test as `[create-create]`): the second create returned `created` without
  waiting. M6 was not re-run on the parametrized version; M7 (no lock in resend) was, and fails
  `[create-resend]` and `[resend-create]`.

`backend/app/invitations/schemas.py::InvitationCreate`

```python
InvitationEmail = Annotated[
    str,
    StringConstraints(strip_whitespace=False, min_length=1, max_length=MAX_EMAIL_ADDRESS_LENGTH),
    AfterValidator(_email),
]
# ...
class InvitationCreate(InputModel):
    email: InvitationEmail
    roles: Annotated[list[Role], Field(min_length=1, max_length=8), AfterValidator(_distinct_roles)]
    # A pre-approved resident's unit and how they relate to it: both or neither.
    unit_id: UUID | None = None
    relationship: OccupancyRelationship | None = None
```

- `strip_whitespace=False` overrides `InputModel`'s model-wide stripping, so `" guard@example.test"` is a
  422 instead of being silently changed (D3).
- `extra="forbid"` (from `InputModel`) makes a client-chosen `token` a 422.

`backend/app/invitations/service.py::_queue_invitation_email`

```python
    await queue_email(
        db,
        # The stored, validated address (the P1-02 carry: mail goes only to the stored address).
        to=invitation.email,
        template="invitation",
        context={
            "building_name": building.name,
            "roles": list(invitation.roles),
            # A path: the template puts APP_BASE_URL in front. In `context`, the payload key the
            # worker drops once the email is sent.
            "link": f"/invite/{token}",
            "expires_at": invitation.expires_at.isoformat(),
        },
        locale=building.locale if building.locale in SUPPORTED_LOCALES else DEFAULT_LOCALE,
    )
```

- The token is placed under `context` on purpose: `email.send` is registered with
  `sensitive_keys=("context",)` (P3-02), so the worker removes it from the stored payload on success and
  `jobs.cleanup` scrubs it from dead jobs.

## 5. Edge cases and tests

All in `backend/tests/invitations/test_invitations.py` unless named otherwise.

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Token stored or returned | only `hash_token(token)` stored; `InvitationOut` has no token field; payload scrubbed after send | `test_manager_invites_and_the_email_carries_the_only_copy_of_the_token` |
| Mixed-case or invalid email | lowered; 422 for empty, padded, non-ASCII, malformed, list, display name, CRLF, NUL, over-long | `test_email_is_stored_lowercased`, `test_invalid_emails_are_422_and_write_nothing`, `test_lone_surrogate_in_the_email_is_422` |
| Empty/unknown roles, unit without relationship, unit without resident, client `token` | 422, no row | `test_invalid_roles_or_unit_pairing_is_422_and_writes_nothing` |
| Another building's unit, unknown unit | 404 `unit_not_found`, no row, no job (tenant row 7) | `test_unit_of_another_building_or_unknown_is_404_and_writes_nothing` |
| Deactivated unit | 409 `unit_inactive` | `test_inactive_unit_is_409_and_writes_nothing` |
| Second pending invitation (row 9) | 409 `invitation_pending` | `test_second_pending_invitation_for_the_email_is_409` |
| Concurrent create/create, create/resend, resend/create (row 10) | the second waits on the lock, then 409 | `backend/tests/invitations/test_concurrency.py::test_concurrent_writes_for_one_email_leave_one_pending_invitation` |
| Resend reviving an expired one beside a replacement | 409 `invitation_pending`, nothing changed | `test_resend_of_an_expired_invitation_beside_a_pending_replacement_is_409` |
| Resend of a closed one beside a replacement | 409 `invalid_transition` | `test_resend_of_a_closed_invitation_beside_a_pending_replacement_is_invalid_transition` |
| Wrong role (row 4) | 403 on all four routes for security, resident, council | `test_non_managers_get_403_on_every_route` |
| Other building's manager (row 3) | 404, same body as a random id, row unchanged | `test_other_buildings_manager_gets_404_for_an_a_invitation` |
| No session, pending, suspended (rows 2, 6) | 401; 404 `building_not_found` | `test_tenant_guards_on_invitation_routes` |
| Revoke/resend of a closed invitation (row 8) | 409 `invalid_transition` | `test_revoke_of_a_closed_invitation_is_409`, `test_resend_of_a_closed_invitation_is_409_and_queues_nothing` |
| Clock-based expiry | status `expired` once `expires_at <= now` | `test_list_filters_by_status_within_the_building` (expired by moving `expires_at`, not the clock: a 7-day jump would also end the manager's 12-hour session) |
| Row 5 (another resident's record) | n/a: only managers reach these routes | — |

Existing tests updated, assertions kept: the GET-path list in `frontend/src/api/client.test.ts`;
`EXPECTED_ROW_COUNTS` in `backend/tests/test_world.py` (`invitations: 0`); the P3-04c migration test now
downgrades to `05c58ec89743` by name, because `-1` would now undo this migration instead.

**Acceptance criteria → tests**
1. `test_manager_invites_and_the_email_carries_the_only_copy_of_the_token`; stack transcript in PR #86.
2. `test_email_is_stored_lowercased`, `test_invalid_emails_are_422_and_write_nothing`, `test_lone_surrogate_in_the_email_is_422`.
3. `test_invalid_roles_or_unit_pairing_is_422_and_writes_nothing`, `test_duplicate_roles_are_stored_once`.
4. `test_unit_of_another_building_or_unknown_is_404_and_writes_nothing`, `test_inactive_unit_is_409_and_writes_nothing`, `test_invitation_with_unit_and_relationship`.
5. `test_second_pending_invitation_for_the_email_is_409`, `test_closed_invitations_do_not_block_a_new_one`, `test_same_email_in_another_building_is_independent`, the concurrency test.
6. `test_non_managers_get_403_on_every_route`, `test_other_buildings_manager_gets_404_for_an_a_invitation`, `test_tenant_guards_on_invitation_routes`.
7. `test_list_filters_by_status_within_the_building`, `test_list_paginates_newest_first`.
8. `test_revoke_sets_revoked_at_and_audits`, `test_revoke_of_an_expired_invitation_closes_it`, `test_revoke_of_a_closed_invitation_is_409`.
9. `test_resend_rotates_token_and_expiry_and_requeues`, `test_resend_of_a_closed_invitation_is_409_and_queues_nothing`, and the two round 1–2 resend tests.
10. `test_revoke_after_resend_revokes_and_resend_after_revoke_is_409`.

## 6. Review log

Tier 1. By James's instruction for this run, the reviewer was one fresh Codex `gpt-6.1-sol` session at high
effort per round, with the security pass, and no Claude reviewer (instead of the playbook's Claude + Codex
pair).

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol` high | `17f87b1` | BLOCK | R1-F1 High: resend bypassed one-pending-per-email | fixed in `c31428c` |
| 2 | Codex `gpt-6.1-sol` high (new session) | `c31428c` | MERGE | R2-F1 Low: closed + replacement answered `invitation_pending` | fixed in `374f94e` |
| 3 | Codex `gpt-6.1-sol` high (new session) | `374f94e` | MERGE | none | — |

**R1-F1.** Create a `property_management` invitation, let it expire, create a replacement as `security`,
resend the expired one: 200, and two pending invitations with different live tokens and conflicting roles.
Codex's proof failed `assert 2 == 1`. Fix: resend takes `_lock_building` and
`_refuse_another_pending(besides=…)`. Evidence:
`test_resend_of_an_expired_invitation_beside_a_pending_replacement_is_409` failed before and passes after;
mutations M7 (no lock in resend) and M8 (no check in resend) each fail the concurrency or API tests. Neighbour
tests added: the replacement closed again, the same email in another building, three concurrent orders.

**R2-F1.** After R1-F1's fix, revoking (or accepting) an invitation, creating a replacement and resending the
original answered `invitation_pending`, against criterion 9's `invalid_transition`. Nothing was written. Fix:
read the target's state first. Evidence:
`test_resend_of_a_closed_invitation_beside_a_pending_replacement_is_invalid_transition` (2 cases) failed
before, passes after. Fixed although Low and after a MERGE, so round 3 reviewed the result.

## 7. Not verified, accepted risks and follow-ups

- **Accepting the invitation is not built** (P4-02b). Nothing yet consumes `token_hash`, and the email's
  "the link works once" is true only once P4-02b enforces it.
- **A stale comment:** `backend/app/invitations/models.py::Invitation` says the `(building_id, email)` index
  serves "the one-pending-per-email check in `create_invitation`"; since round 1 resend uses it too. Left
  as is rather than change code after the final review; tracked only here.
- **The raw token sits in `jobs.payload`** from create until the worker sends the email (normally seconds)
  or, for a dead job, until `jobs.cleanup` scrubs it. Accepted: the worker needs it (ADR-0006).
- **No rate limit on create or resend.** Only managers can call them, and each is audited. Accepted in
  PR #86; tracked only here and in the PR.
- **Writes in one building serialise** on the building row (D2).
- **The `fr` template** falls back to `en` (P3-02's placeholder).
- **Real SMTP** was verified with Mailpit on `make up` (PR #86 transcript), not with SES.
- **Concurrent revoke and resend** at the same instant is covered only by the single conditional UPDATE
  (each statement is atomic), not by a two-connection test.

## 8. How to change this safely

- **Another way to make an invitation pending** (for example "reopen"): take `_lock_building` and call
  `_refuse_another_pending` before writing; `backend/tests/invitations/test_concurrency.py` shows how to prove it.
- **A new status:** change `status_of` and `status_clause` together (same precedence); the list test checks
  each filter.
- **A new field in the email:** add it to the `context` in `_queue_invitation_email` and to all three
  templates; `queue_email` renders at queue time, so a missing variable fails the create, not the worker.
- **P4-02b** looks the invitation up by `hash_token(token)`, must treat expired, revoked and accepted alike,
  and closes it with a conditional UPDATE on `_open()` plus `expires_at > now`.

## 9. Must explain, then quiz

**1. Why store only a hash of the invitation token, and where else could the raw token live?** A database
reader (a backup, a leaked dump, a support query) must not be able to accept someone's invitation. The token
is 32 random bytes, so a plain sha256 can't be brute-forced, unlike a password, which is why it isn't argon2
(`backend/app/core/security.py::hash_token`). The raw token exists in the email and, until it is sent, in the
`email.send` job's `context`, which the worker drops on success. It is never in a response, a log line or
audit metadata (`test_manager_invites_and_the_email_carries_the_only_copy_of_the_token` asserts the response,
row, job and audit event).

**2. Why does resend issue a new token instead of re-sending the old one?** The old token can't be
re-sent: only its hash is stored. A new token also means a leaked or forwarded old email stops working,
and the new expiry starts from the resend (`backend/app/invitations/service.py::resend_invitation`;
`test_resend_rotates_token_and_expiry_and_requeues` checks that the old hash matches no row).

**3. Why are revoke and resend single conditional updates instead of read-then-write?** A read-then-write
lets two requests both see "open" and both write: a resend could give a revoked invitation a fresh live token.
`UPDATE … WHERE accepted_at IS NULL AND revoked_at IS NULL RETURNING` decides and writes in one atomic
statement; zero rows means it was closed (CLAUDE.md rule 7, `_transition`).

**Quiz**

1. A manager invites `Ann@Example.test`, then invites `ann@example.test` with another role. What happens, and
   which line decides it?
2. Why is the lock `FOR NO KEY UPDATE` and not `FOR UPDATE`?
3. Why can't the one-pending rule be a partial unique index?
4. What breaks if `_refuse_another_pending` is removed from `resend_invitation`?
5. How would you add a per-manager rate limit on create and resend?

<details><summary>Answers</summary>

1. The second is 409 `invitation_pending`: the schema lowers both (`backend/app/invitations/schemas.py::_email`), and
   `_refuse_another_pending` finds the first, still pending.
2. `FOR UPDATE` conflicts with the `FOR KEY SHARE` lock every foreign-key check on `buildings` takes, so
   inserting units, memberships or jobs that reference the building would wait for the invitation
   transaction. NO KEY UPDATE serialises the invitation writers only.
3. "Pending" includes `expires_at > now()`, and an index predicate must be immutable. An index on "not
   accepted, not revoked" would let an expired invitation block a new one.
4. An expired invitation could be resent next to its pending replacement: two live links, possibly with
   different roles (R1-F1). `test_resend_of_an_expired_invitation_beside_a_pending_replacement_is_409` and
   the `create-resend` concurrency case fail.
5. Add a `RatePolicy` setting and call `limiter.enforce` with a key built from `ctx.user_id` (as login
   does with `ip_key`) at the start of both routes, through the `get_rate_limiter` dependency so tests can
   override it; test the 429 with `frozen_clock`.

</details>
