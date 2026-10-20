# Explanation — P4-05b Onboarding decisions: list, approve, deny

> **PR:** #92 · **Source revision:** `f2c9518` (pre-merge PR head), the commit this explanation was written from and
> checked against. **Reviewed:** the final review round (2) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 92 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `f2c9518` the whole `git diff origin/main...HEAD` for `backend/app` (the
> onboarding service, router and schemas, the unit, building and auth schemas, config, actions, `main.py`), the
> tests cited below and their assertions, the PR description (rounds 1 and 2) and the round 2 Codex report; compiled
> the decision SQL with the Postgres dialect; ran `pytest tests/onboarding tests/test_architecture.py
> backend/tests/units/test_schemas.py backend/tests/cli/test_bootstrap.py`: 286 passed. `make check` at this head: exit 0
> (1,951 backend, 359 frontend tests). Differences from the plan: helper names only (see §2).
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 1. Walkthrough variant: A.

## 1. What was built and why

Property managers can now act on the join requests residents send through a building's join link
([P4-05a](./P4-05a-resident-signup-and-join.md)). Four routes under `/api/buildings/{building_id}/onboarding-requests`
let them list the requests, count the pending ones, approve one or deny one. An approval makes the membership
`active` and starts the resident's occupancy of the requested unit. Every later "residents see only their own
records" rule depends on that occupancy. A denial stores a reason that the resident sees. Both notify the resident
in-app and by email.

The two decisions that matter most:
- Both decisions are **conditional updates** (`… WHERE status = 'pending'`), so a second or concurrent decision
  finds nothing to update and gets 409 `already_decided`.
- A request whose membership is **no longer pending** (an invitation activated it meanwhile) is refused and left
  out of the list. Approving it would have added a second occupancy and overwritten the invited roles.

The PR also adds a per-user limit on join requests, and refuses control characters *before* trimming input. That
second change is a mistakes-log pattern promoted to a fitness test.

## 2. Decisions

### D1. A request whose membership is no longer pending is refused, and hidden from the list

- **Problem or constraint:** an invitation accept (P4-02b, `backend/app/invitations/service.py::_REACTIVATABLE`)
  can make a `pending` or `denied` membership `active` while its join request stays `pending`. Approving that
  request must not start a second occupancy or overwrite the invited roles (P4-05a round 2 residual, carried into
  this ticket).
- **Chosen:** the membership update in `backend/app/onboarding/service.py::_decide` matches only
  `status = 'pending'`. Zero rows raise 409 `membership_not_pending`, and raising rolls back the request's own update
  too. The pending list and count add `backend/app/onboarding/service.py::_membership_pending`, so managers aren't
  shown requests they can't decide.
- **Alternatives rejected:**
  - A new request state (`superseded`) set by the invitation accept. It needs an enum migration and a change to
    P4-02b's accept.
  - Approving such a request as a no-op. It would record an approval that granted nothing.
- **Tradeoffs and accepted limitations:** such rows stay `pending` in the table, invisible to the list (§7).
- **Basis:** ticket carry; autonomous, reversible.
- **Source:** recorded (PR #92 D1, ticket Frame notes).

### D2. The pending count is its own route

- **Problem or constraint:** managers need a badge count. The ticket allowed either P3-03's
  `/notifications/summary` or a separate route ("choose one and document it").
- **Chosen:** `GET …/onboarding-requests/summary` returns `{"pending_onboarding_count": n}`, for property management
  only. It counts with the same filter the pending list uses (`backend/app/onboarding/service.py::_listed`).
- **Alternatives rejected:** a field on `/notifications/summary`. Every member calls that route, so it would need a
  role-dependent field, and the count is not a notification.
- **Tradeoffs and accepted limitations:** the SPA makes one more request for managers.
- **Basis:** ticket; autonomous.
- **Source:** recorded (PR #92 D2).

### D3. Join resubmissions are limited per user

- **Problem or constraint:** once deny exists, a denied resident can resubmit, and each new request notifies every
  manager (P4-05a round 1, Claude L3).
- **Chosen:** `backend/app/onboarding/router.py::join_request_limit` counts every
  `POST /api/join/{code}/requests` per user: 10 per hour, key `join_request:user:<id>`
  (`rate_limit_join_request_user` in `backend/app/core/config.py::Settings`). It is a route dependency that runs
  after the session check, so an anonymous request is a 401 before anything is counted.
- **Alternatives rejected:** a per-membership limit. The dependency would need its own database read to find the
  membership.
- **Tradeoffs and accepted limitations:**
  - Idempotent retries count too. 10 per hour leaves room for them.
  - Requests that later fail with 404 or 422 count too (round 1 L4, dismissed: counting first can't be avoided by
    failing).
- **Basis:** ticket carry ("a per-user or per-membership limit, as a route dependency").
- **Source:** recorded (PR #92 D3; review round 1 L4).

### D4. Control characters are refused before the strip, enforced by a fitness test

- **Problem or constraint:** "a control-character check after the strip" was logged twice in
  `docs/AGENT_MISTAKES_LOG.md` (P3-04a, P4-05a). `APIModel` strips whitespace, so `"Rosa\n"` was stored as `"Rosa"`
  instead of being refused. The ticket asked for a fitness test or a `CLAUDE.md` lesson, plus fixes for `Label`,
  `Tower` and the building schemas.
- **Chosen:**
  - One shared `BeforeValidator`, `backend/app/units/schemas.py::printable_before_strip`, is used by `Label`, the
    building `Name`, `LongText` and `Operator`, `FullName`, and the deny reason.
  - `_blank_to_none` (the tower) checks first, so `"\t"` is refused, not read as blank.
  - Fitness test 6, `backend/tests/test_architecture.py::printable_after_strip`, fails if any `InputModel` field
    uses `printable` as an `AfterValidator`. It walks nested `Annotated` and union types.
- **Alternatives rejected:** a `CLAUDE.md` lesson instead of a test. The playbook prefers tests ("tests enforce").
  No other alternative was recorded.
- **Tradeoffs and accepted limitations:**
  - Inputs that used to be silently trimmed now get a 422, such as a CSV unit label `"101\t"` or a bootstrap name
    ending in `"\n"`.
  - The check only recognises `printable` itself. A hand-written validator elsewhere is not detected.
- **Basis:** ticket (P4-05a carry, step 8); playbook "promote".
- **Source:** recorded (ticket criterion 16, PR "Gate changes").

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Both emails use P3-03's generic `notification` template | `membership_approved` / `membership_denied` templates | `backend/app/notifications/kinds.py::KINDS` already maps both kinds; the email repeats the in-app text | code is the truth; ticket said "decide" | recorded (Frame notes) |
| 409 `already_decided` | 409 `invalid_transition` (CLAUDE.md rule 7's default) | the ticket names the code; the conditional update of rule 7 is kept | ticket | recorded |
| 409 `unit_inactive` at approval; the request stays pending | 404 `unit_not_found` | the unit exists and is the request's; the manager needs to know why, then denies | autonomous; P4-02b uses the same code | recorded |
| Reason 3–500 characters after the trim, no control characters | allow newlines | simplest; matches `LongText`; reversible when P4-08 needs a textarea | autonomous | recorded |
| Reason also refuses Unicode `Cf`, `Zl`, `Zp` (422 `invisible_characters`) | strip them; refuse only `Cf` | stripping silently changes what the manager wrote; `Zl`/`Zp` break the reason across lines as a newline would | review round 1, Claude L1 | recorded |
| Fixed notification titles ("Your join request was approved") | the building's name in the title | `notify` caps `title` at 200 characters and a building's name alone can be 200 | code (`backend/app/notifications/service.py::_MAX_LENGTHS`) | established by code |
| `BeforeValidator` placed *after* `StringConstraints` in `Annotated` | before them (as `FullName` has it) | placed first, it turned the constraints into generic ones and changed the CSV import's messages; placed last, it still runs first | test result (`backend/tests/units/test_import.py` failed, then passed) | recorded |
| No `apply_role_change` on approval | call it | `resident` isn't a staff role; that function only shortens staff idle windows | `backend/app/auth/service.py::apply_role_change` | recorded |
| One dedupe key per decision, so nothing to order (P3-03 carry) | — | each decision makes one `notify` call for one recipient and queues no other deduplicated job | code | recorded (Frame notes) |

**Framing changes:**
- Sharpened: criteria 3, 4, 5, 7 and 9 now state the exact writes, both decided states, the reason bounds, every
  route and wrong role, and what "nothing persists" covers.
- Added: criteria 10–17 (list, count, the id's building, membership changed meanwhile, unit deactivated meanwhile
  in both race orders, the resubmission limit, the promoted control-character pattern, the email template).
- Loosened: none.

**Plan versus final code:**
- The plan named helpers `_claim` and an activate/deny membership update. The final code has a single
  `backend/app/onboarding/service.py::_decide`, which does both conditional updates for either decision.
- The plan's test table named three tests that were written under other names. The PR notes this below the Plan
  (round 1 L2), and §5 uses the real names.
- Nothing else differs.

## 3. How it is implemented

### Overview

- `backend/app/onboarding/router.py::router` is a `building_router`, so every route depends on
  `get_tenant_context`; the `Manager` dependency adds `require_roles(PROPERTY_MANAGEMENT)`.
- `backend/app/onboarding/service.py::list_requests` and `::pending_summary` only read. `::approve_request` and
  `::deny_request` each run one transaction and commit once.
- `::_decide` holds the state machine: one conditional `UPDATE` on the request, then one on the membership.
- The approval reads the unit `FOR KEY SHARE`, then calls `backend/app/memberships/occupancy.py::start_occupancy`.
- The side effects are `notify` (an in-app row and an `email.send` job) and `record_audit`, written in the same
  transaction.

### Walkthrough (variant A): `POST /api/buildings/{b}/onboarding-requests/{id}/approve`

1. **HTTP.** `backend/app/onboarding/router.py::approve` takes `request_id: UUID`; a non-UUID is a 422 before
   anything runs. The CSRF middleware has already refused an unsafe request without the SPA's headers.
2. **Dependencies.**
   - `get_current_user` returns a 401 without a session.
   - `get_tenant_context` requires an active membership in an active building `b`, else 404 `building_not_found`.
     This covers another building's manager and pending or suspended members.
   - `require_roles(PROPERTY_MANAGEMENT)` returns 403 `forbidden_role` to security, residents and council.
3. **Service.** `backend/app/onboarding/service.py::approve_request`:
   1. `_decide` claims the request. This is the actual SQL, compiled with the Postgres dialect:
      ```sql
      UPDATE onboarding_requests SET status=%(status)s, decided_by_user_id=%(decided_by_user_id)s::UUID,
        decided_at=now(), decision_reason=%(decision_reason)s::VARCHAR, updated_at=now()
      WHERE onboarding_requests.id = %(id_1)s::UUID AND onboarding_requests.building_id = %(building_id_1)s::UUID
        AND onboarding_requests.status = %(status_1)s RETURNING onboarding_requests.id
      ```
      (In the code it is `.returning(OnboardingRequest)`, the whole row.) No row means one of two things. If no
      request with that id exists in `b`, it is 404 `onboarding_request_not_found`, the same body as a random id.
      Otherwise it is 409 `already_decided`.
   2. `_decide` then moves the membership:
      ```sql
      UPDATE building_memberships SET status=%(status)s, status_changed_at=now(),
        status_changed_by_user_id=%(status_changed_by_user_id)s::UUID, updated_at=now()
      WHERE building_memberships.id = %(id_1)s::UUID AND building_memberships.building_id = %(building_id_1)s::UUID
        AND building_memberships.status = %(status_1)s RETURNING building_memberships.user_id
      ```
      No row raises 409 `membership_not_pending` (D1), and the transaction rolls back, including step 1.
   3. The service reads the unit: `SELECT units.is_active FROM units WHERE … FOR KEY SHARE`. If the unit is inactive,
      it raises 409 `unit_inactive`.
   4. `start_occupancy` (ADR-0010) locks the membership, checks the history doesn't overlap, and inserts the current
      occupancy with the request's relationship.
4. **Side effects, same transaction.**
   - `notify(kind="membership.approved")` writes one in-app row for the resident. Because the kind has an email
     template, it also queues one `email.send` job with dedupe key `membership.approved:<request>:<user>`.
     `notify` skips the email for an inactive user or an unsendable address.
   - Audit `onboarding.approved` (metadata `membership_id`, `unit_id`) and `membership.activated` (metadata
     `onboarding_request_id`): IDs only.
   - Then `db.commit()`, once.
5. **Response.** 200 with `backend/app/onboarding/schemas.py::OnboardingRequestManagerOut`: the request plus the
   requester's name and email and the unit's label and tower.

**Deny** (`::deny_request`):
- `OnboardingDecisionIn` validates the body first: 422 on a missing, short, long, control-character or
  invisible-character reason.
- It then runs the same `_decide` with `denied` and the trimmed reason, which sets the membership to `denied`.
- No unit lock and no occupancy.
- `notify(kind="membership.denied")` with the reason in the body.
- Audit `onboarding.denied` with IDs only, never the reason.

The resident reads the reason through P4-05a's `/onboarding/me` (`backend/app/onboarding/service.py::my_status`
returns the latest request's `decision_reason`). Their next submission reopens the membership
(`::_reopen_or_refuse`, `denied` → `pending`) and creates a new request.

**List and count:**
- `::list_requests` paginates `select(OnboardingRequest)` filtered by `_listed`: the building, the status and, for
  `pending`, `_membership_pending`. It pages with the shared keyset helper (`id DESC`, uuid7 = newest first).
- It then loads names, emails and unit labels for that page in one joined query (`::_details`). The joins use the
  composite `(building_id, id)` keys.
- `::pending_summary` is `count(*)` with the same filter.

### Data model changes

None. P4-05a already created `onboarding_requests` with the decision columns, the constraints
`decided_when_not_pending` and `reason_only_when_denied`, and the list index
`ix_onboarding_requests_building_id_status_id`. This ticket's writes satisfy those constraints: `decided_at` is set
together with the status, and the reason only on deny.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/onboarding/service.py` | list, summary, `_decide`, approve, deny, error classes; module docstring | +292 / −5 |
| `backend/app/onboarding/router.py` | managers' `router`; `join_request_limit` on the join request route | +69 / −3 |
| `backend/app/onboarding/schemas.py` | `OnboardingDecisionIn` (with `_visible`), `OnboardingRequestManagerOut`, `OnboardingSummary` | +57 |
| `backend/app/units/schemas.py` | `printable_before_strip`; `Label` and the tower's blank check | +14 / −2 |
| `backend/app/buildings/schemas.py`, `backend/app/auth/schemas.py` | the shared before-strip check | +8 / −6, +3 / −9 |
| `backend/app/core/config.py`, `backend/.env.example` | `rate_limit_join_request_user` | +2, +1 |
| `backend/app/audit/actions.py`, `backend/app/main.py` | two actions; include the router | +2, +1 |
| `backend/tests/onboarding/test_decisions.py` | HTTP tests for criteria 3–5, 7, 9–14, 17 | +703 |
| `backend/tests/onboarding/test_decisions_concurrency.py` | real-connection races | +207 |
| `backend/tests/onboarding/test_join.py`, `backend/tests/onboarding/conftest.py` | resubmission limit with a committing limiter | +35, +3 |
| `backend/tests/test_architecture.py` | fitness test 6 + meta and non-vacuity tests | +74 / −2 |
| `backend/tests/units/test_schemas.py`, `backend/tests/cli/test_bootstrap.py` | control characters at the ends | +36, +5 |
| `frontend/src/api/schema.d.ts`, `frontend/src/api/client.test.ts` | regenerated types; two GET paths in the type test | +419, +2 |
| `docs/tickets/P4-05b-onboarding-decisions.md`, `docs/tickets/README.md` | the frame; status | +90 / −16, ±1 |

Non-test application code: +449 / −25 at this revision (+432 / −25 at round 1; the L1 fix added 17).

**Key excerpts**

`backend/app/onboarding/service.py::_decide`

```python
    request = await db.scalar(
        update(OnboardingRequest)
        .where(
            OnboardingRequest.id == request_id,
            OnboardingRequest.building_id == ctx.building_id,
            OnboardingRequest.status == OnboardingStatus.PENDING,
        )
        .values(
            status=decision,
            decided_at=func.now(),
            decided_by_user_id=ctx.user_id,
            decision_reason=reason,
        )
        .returning(OnboardingRequest)
    )
    if request is None:
        found = await db.scalar(
            select(OnboardingRequest.id).where(
                OnboardingRequest.id == request_id,
                OnboardingRequest.building_id == ctx.building_id,
            )
        )
        if found is None:
            # The same answer for another building's request and none at all (ADR-0004).
            raise OnboardingRequestNotFound(detail="Join request not found.")
        raise AlreadyDecided(detail="This join request has already been decided.")
    user_id = await db.scalar(
        update(BuildingMembership)
        .where(
            BuildingMembership.id == request.membership_id,
            BuildingMembership.building_id == ctx.building_id,
            BuildingMembership.status == MembershipStatus.PENDING,
        )
        # ...
        .returning(BuildingMembership.user_id)
    )
    if user_id is None:
        raise MembershipNotPending(
            detail="This person's membership changed since they asked to join; reload the list."
        )
    return request, user_id
```

- **What it does:** decides the request and moves the membership out of `pending`, both only from `pending`.
- **Why this way (D1; CLAUDE.md rule 7):**
  - The `WHERE status = 'pending'` *is* the check. Under READ COMMITTED, a second `UPDATE` of the same row waits
    for the first transaction. It then re-evaluates the `WHERE` on the committed row, finds `approved` or
    `denied`, and matches nothing.
  - The `building_id` filter is what makes another building's request a 404 rather than a decision.
- **What breaks without each part:**
  - Without the status condition, two managers clicking at once both "win": two occupancy inserts (the second
    fails on the one-current-occupancy index, a 500), two emails.
  - Without the membership's status condition, an invitation-activated member is approved again (D1).
  - Without `building_id`, a manager of A can decide B's requests by id.

`backend/app/onboarding/service.py::approve_request` (the part after `_decide`)

```python
    unit_active = await db.scalar(
        select(Unit.is_active)
        .where(Unit.building_id == ctx.building_id, Unit.id == request.unit_id)
        .with_for_update(read=True, key_share=True)
    )
    if not unit_active:
        raise UnitInactive(detail="This unit is deactivated: deny the request instead.")
    await start_occupancy(
        db,
        building_id=ctx.building_id,
        membership_id=request.membership_id,
        unit_id=request.unit_id,
        relationship=request.relationship,
    )
    out, details, building_name = await _decided_out(db, ctx, request)
    await notify(
        db,
        building_id=ctx.building_id,
        recipient_user_ids=[user_id],
        kind="membership.approved",
        # Fixed: `title` is at most 200 characters, a building's name alone can be.
        title="Your join request was approved",
        # ...
        entity_type="onboarding_request",
        entity_id=request.id,
    )
    # ... record_audit(ONBOARDING_APPROVED), record_audit(MEMBERSHIP_ACTIVATED)
    await db.commit()
    return out
```

- **What it does:** re-checks that the unit is active under a lock, starts the occupancy, notifies, audits and
  commits once.
- **Why `FOR KEY SHARE`:** `backend/app/units/service.py::deactivate_unit` takes the unit `FOR UPDATE`, which
  conflicts with `KEY SHARE`, so the two serialise in either order:
  - If the deactivation runs first, this read waits for it and then sees `is_active = false`.
  - If the approval runs first, the deactivation waits, then its occupancy check sees the new occupancy and refuses
    (`unit_has_occupants`).

  `KEY SHARE` is the weakest lock that conflicts with `FOR UPDATE`, so approvals for the same unit don't wait for
  each other.
- **What breaks without the re-check:** an occupancy of a deactivated unit (the P4-01a carry).

`backend/app/onboarding/schemas.py::OnboardingDecisionIn`

```python
_INVISIBLE = frozenset({"Cf", "Zl", "Zp"})


def _visible(value: Any) -> Any:
    if isinstance(value, str) and any(unicodedata.category(c) in _INVISIBLE for c in value):
        raise PydanticCustomError(
            "invisible_characters", "must not contain invisible or formatting characters"
        )
    return value


class OnboardingDecisionIn(InputModel):
    # ...
    reason: Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=3, max_length=500),
        BeforeValidator(_visible),
        BeforeValidator(printable_before_strip),
    ]
```

- **What it does:**
  - Refuses control characters, then invisible and formatting characters, in the raw value.
  - Only then trims, and requires 3–500 characters.
- **Why:** pydantic runs `BeforeValidator`s from the last one declared to the first, and all of them before the
  string schema that strips. So `"Not on the lease\n"` is refused rather than stored trimmed (D4), and three
  zero-width spaces can't pass as a "reason" (round 1 L1).
- **What breaks without it:** a blank-looking or bidi-reordered reason reaches the resident's screen and email.

`backend/tests/test_architecture.py::printable_after_strip` (fitness test 6)

```python
def printable_after_strip(models: Iterable[type[BaseModel]]) -> list[str]:
    """Fields of the given models whose `printable` check is an `AfterValidator`."""
    return sorted(
        f"{model.__name__}.{name}"
        for model in models
        for name, field in model.model_fields.items()
        if any(
            isinstance(v, AfterValidator) and v.func is printable
            for v in _validators(field.annotation, field.metadata)
        )
    )
```

- **What it does:** walks every `InputModel` subclass's fields, including nested `Annotated` and union members, and
  lists any that run `printable` after the strip.
- **How it is proved:**
  - `test_meta_printable_after_the_strip_is_reported` proves it can fail. It uses a plain `BaseModel` with two
    offending fields, one of them nested.
  - `test_the_check_sees_the_fields_checked_before_the_strip` proves it isn't vacuous: it finds the
    before-strip check on `UnitCreate.label`, `UnitCreate.tower`, `SignupIn.full_name`, `BootstrapInput.name` and
    `OnboardingDecisionIn.reason`.

`backend/tests/onboarding/test_decisions_concurrency.py::test_unit_deactivation_waits_for_an_approval` (trimmed)

```python
            async def held_commit() -> None:
                await release.wait()
                if not approval_commits:
                    raise RuntimeError("simulated failure at commit")
                await real_commit()

            approving.commit = held_commit  # type: ignore[method-assign]
            approval = asyncio.create_task(
                service.approve_request(approving, _ctx(world), request_id)
            )
            await asyncio.sleep(0.5)
            deactivation = asyncio.create_task(_deactivate(sessions, world, unit_id))
            await asyncio.sleep(1.0)
            assert not deactivation.done(), "the deactivation did not wait for the approval"
            release.set()
            # ...
        assert outcome == ("unit_has_occupants" if approval_commits else "deactivated")
```

- **What it does:** on real connections, holds a real approval at its commit, with its locks and uncommitted
  occupancy in place. It shows that `deactivate_unit` waits, then answers from what the approval did: commit gives
  409, rollback lets the deactivation proceed. Added in round 1, when this order had only a sequential test.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Two managers decide at once | one wins, the other gets 409 `already_decided`; one occupancy at most | `backend/tests/onboarding/test_decisions_concurrency.py::test_concurrent_decisions_give_one_winner` (`[approve]`, `[deny]`) |
| A decided request is decided again | 409, no writes | `backend/tests/onboarding/test_decisions.py::test_a_decided_request_is_409_already_decided` (4 combinations) |
| An invitation activated the membership meanwhile | 409 `membership_not_pending`, roles and state kept, request hidden from the list and count | `::test_a_request_whose_membership_was_activated_meanwhile_is_409[approve]`, `[deny]` |
| Unit deactivated before the approval | 409 `unit_inactive`, nothing written; deny still works | `::test_approving_a_request_for_an_inactive_unit_is_409_and_deny_still_works` |
| Deactivation commits while the approval waits | approval sees it: `unit_inactive`; after its rollback, approval succeeds | `backend/tests/onboarding/test_decisions_concurrency.py::test_approval_waits_for_a_unit_deactivation` (`[commits]`, `[rolls-back]`) |
| Approval in flight while a deactivation starts | deactivation waits, then 409 `unit_has_occupants`; after the approval's rollback, it deactivates | `::test_unit_deactivation_waits_for_an_approval[commits]`, `[rolls-back]`; sequentially `backend/tests/onboarding/test_decisions.py::test_a_unit_with_an_approved_resident_cannot_be_deactivated` |
| Failure after the membership update | everything rolls back: request and membership pending, no occupancy, notification, job or audit | `backend/tests/onboarding/test_decisions.py::test_a_failed_approval_leaves_nothing` (fails the last audit write) |
| Another building's request id | 404 with the same body as a random id; non-UUID is 422 | `::test_another_buildings_request_is_404_like_a_random_id` |
| Wrong role, other building, pending, suspended, no session | 403 / 404 / 404 / 404 / 401 on all four routes | `::test_wrong_role_is_403_on_every_route`, `::test_other_building_pending_and_suspended_members_get_404`, `::test_every_route_needs_a_session` |
| Bad reason (missing, null, short, long, control or invisible characters, extra field) | 422, nothing written | `::test_deny_refuses_a_bad_reason` (13 bodies); `::test_deny_accepts_500_characters` |
| Inactive resident user | in-app row only, no email job | `::test_an_inactive_resident_gets_no_email` |
| Resubmission spam | 11th request per user per hour is 429; other users unaffected | `backend/tests/onboarding/test_join.py::test_the_11th_join_request_from_one_user_in_an_hour_is_429`, `::test_join_request_rate_policy_is_10_per_hour` |
| Control character at either end of a label, tower, building field | refused, not trimmed | `backend/tests/units/test_schemas.py::test_control_characters_are_refused_even_at_the_ends`, `backend/tests/cli/test_bootstrap.py::test_bad_input_is_refused` |
| A pending membership that already has a current occupancy | `start_occupancy` raises `IntegrityError` (500) | **No test** (no current path creates it; §7) |

Acceptance criteria → tests:
- **3:** `test_manager_approves_a_request` checks the exact writes, the notification and job, both audits,
  `/api/auth/me` (`active`, `["resident"]`, the occupancy) and a 200 on `GET /api/buildings/{A}`. Also
  `test_approval_keeps_the_requested_relationship`.
- **4:** `test_a_decided_request_is_409_already_decided`, `test_concurrent_decisions_give_one_winner`.
- **5:** `test_deny_refuses_a_bad_reason`, `test_deny_accepts_500_characters`,
  `test_manager_denies_a_request_and_the_resident_resubmits`. The last one checks `/onboarding/me`, the resubmission
  (201, a new id) and the list.
- **7:** the three role and tenancy tests above.
- **9:** `test_a_failed_approval_leaves_nothing`.
- **10, 11:** `test_list_shows_the_buildings_pending_requests_newest_first`, `test_list_filters_by_status_and_paginates`.
- **12:** `test_another_buildings_request_is_404_like_a_random_id`.
- **13:** `test_a_request_whose_membership_was_activated_meanwhile_is_409`.
- **14:** the inactive-unit tests and both race tests.
- **15:** the two `test_join.py` tests.
- **16:** fitness test 6, its meta and non-vacuity tests, `backend/tests/units/test_schemas.py` and the bootstrap cases.
- **17:** the job payload (`template == "notification"`, title and body) asserted in the criteria 3 and 5 tests, and
  `test_an_inactive_resident_gets_no_email`.

Stack evidence: the curl journey on `make up` in PR #92 covers signup, two requests, security's 403, the summary
and list, approve, approve again (409), deny without a reason (422), deny, `/auth/me`, `/onboarding/me`, the
resubmission and both emails in Mailpit.

Tests-first evidence: on the old `backend/app`, the new test files gave 45 failed (plus two collection errors). No
mutation probe was run beyond that.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings (severity: one line) | Outcome |
|---|---|---|---|---|---|
| 1 | Claude (Sonnet 5.5, high effort; security pass) | `2c4894a` | MERGE | L1: invisible characters pass the reason check | fixed: tests `1450fa2`, then `_visible` in `f2c9518` |
| | | | | L2: plan names three tests that don't exist under those names | fixed in the PR (deviation note) |
| | | | | L3: PR size +432/−25 | accepted (PR D4) |
| | | | | L4: the limit counts requests that later fail | dismissed: counting first can't be bypassed; documented in D3 |
| | | | | Not proven: criterion 14's other race order (sequential only) | fixed: `test_unit_deactivation_waits_for_an_approval` (`1450fa2`) |
| 1 | Codex (`gpt-6.1-sol`, high effort) | `2c4894a` | MERGE | none; its scratch race tests passed and were deleted | — |
| 2 | Codex (`gpt-6-astra`, medium effort), the only round 2 reviewer on James's instruction | `f2c9518` | MERGE | none; confirmed both round 1 fixes | — |

**Round 1 L1:**
- **Failure:** `{"reason": "​​​"}` (three zero-width spaces) passed the 3-character minimum and was
  stored as a blank-looking reason. `U+202E` (bidi override) and `U+2028`/`U+2029` (line and paragraph separators)
  reached the resident's `/onboarding/me`, notification and email.
- **Evidence:** four new cases of `test_deny_refuses_a_bad_reason` got 200 instead of 422 before the fix and pass
  after it.
- **Decision:** the "refuses `Cf`, `Zl`, `Zp`" row in §2.

**Round 1, criterion 14:**
- The new race test failed on its first run in the rolls-back case. The test used unit 102, which has residents in
  the test world, so the deactivation was refused anyway.
- It now uses an empty unit and passes both ways.

## 7. Not verified, accepted risks and follow-ups

**Not verified:**
- **A pending membership with a current occupancy.** Approval would get `IntegrityError` from `start_occupancy`, a
  500. No current path creates that state; no test.
- **Invitation accept racing a decision** on real connections. The reasoning is in D1 and was checked by both
  round 1 reviewers, but only the sequential test exists (`test_a_request_whose_membership_was_activated_meanwhile_is_409`).
- **Real email delivery.** The jobs and their payloads are asserted; Mailpit showed both emails on the dev stack.
  No real SMTP or SES was used.
- **The race tests synchronise with `sleep`** (0.5–1 s). They may be slow or flaky on a loaded machine (round 2
  residual).

**Accepted risks and follow-ups:**
- **Requests hidden by D1** stay `pending` in the table. A later ticket can close them when an invitation activates
  the membership. Will be added to P4-06's ticket in the bookkeeping commit.
- **`Cf`/`Zl`/`Zp` are refused only in the deny reason.** Unit labels, building names and full names refuse only
  `Cc`. Tracked in the PR follow-ups; will be noted in P4-06's ticket.
- **Pydantic's generic message for an empty full name.** `FullName` keeps its `BeforeValidator` before the
  constraints, so an empty name gets "Value should have at least 1 item after validation, not 0". Cosmetic, from
  P4-05a. Tracked only here and in the PR.
- **The join code appears verbatim in request logs** (P4-05a round 2, Low). Optional; not in a ticket.
- **Resubmission limits are per user only.** Someone with many accounts is bounded by the signup limit
  (10 per hour per IP).
- **Approving a requester whose user account is inactive** activates the membership. They can't log in anyway.

## 8. How to change this safely

- **Another decision (for example "request more information").** Add a status to `OnboardingStatus` (a migration
  that adds an enum value) and a branch in `_decide`. Keep both conditional updates.
  `test_a_decided_request_is_409_already_decided` and `test_concurrent_decisions_give_one_winner` show whether the
  state machine still holds.
- **More fields in the list.** Extend `_details`, which runs one joined query per page. Never filter the list by a
  joined table without keeping `OnboardingRequest.building_id == ctx.building_id`.
- **A link in the notifications (P4-08).** Pass `link="/…"`. `notify` refuses anything that isn't an app path.
- **A new stripped input string that must refuse control characters.** Use
  `BeforeValidator(printable_before_strip)` after its `StringConstraints`. Fitness test 6 fails on
  `AfterValidator(printable)`.
- **Changing the lock on the unit read.** `test_approval_waits_for_a_unit_deactivation` and
  `test_unit_deactivation_waits_for_an_approval` break if the approval stops serialising with `deactivate_unit`.
  As in P4-05a, no test tells `FOR KEY SHARE` apart from a stronger lock.

## 9. Must explain, then quiz

**1. Why does approval need a conditional update? What happens with two managers clicking at once?**

The conditional update is what makes the state change safe under concurrency. Reading the status and then writing
it would not be enough: both managers could read `pending` before either writes.
`backend/app/onboarding/service.py::_decide` instead writes `UPDATE onboarding_requests … WHERE id = … AND
building_id = … AND status = 'pending' RETURNING …`. Postgres runs these two `UPDATE`s one after the other:
- **The first** updates the row, locks it, then also updates the membership, starts the occupancy, notifies,
  audits and commits.
- **The second** waits on that row lock. When the first commits, Postgres (READ COMMITTED) re-checks the `WHERE` on
  the new row version. The status is now `approved`, so no row matches.
- `_decide` then finds that the request exists in the building and raises 409 `already_decided`. Nothing the
  second transaction did persists, so there is one occupancy and one email.

If the first transaction rolls back instead, the second's `UPDATE` finds the row still `pending` and goes ahead.
`test_concurrent_decisions_give_one_winner` runs this on real connections, for approve × approve and approve × deny.

**2. What happens when a unit is deactivated while its join request waits for a decision?**

The request stays `pending`; P4-05a doesn't touch requests when a unit is deactivated. At approval,
`approve_request` re-reads the unit `FOR KEY SHARE` and refuses an inactive one with 409 `unit_inactive`, rolling
back the request and membership updates. The manager then denies the request with a reason. The resident sees the
reason in `/onboarding/me` and can submit again for another unit.

If the deactivation and the approval overlap, the locks order them:
- **Deactivation first:** its `FOR UPDATE` blocks the approval's `KEY SHARE` read until it commits. The approval
  then reads `is_active = false` (`test_approval_waits_for_a_unit_deactivation`).
- **Approval first:** the deactivation waits for the approval's commit, then sees its occupancy and answers
  `unit_has_occupants` (`test_unit_deactivation_waits_for_an_approval`).

**Quiz**

1. A manager approves a request whose user already accepted a security-staff invitation in the same building. What
   does the manager see, and what is left in the database?
2. Why is the list's pending filter `status = 'pending' AND <membership is pending>`, while the approved and denied
   lists filter on status alone?
3. What would break if `OnboardingRequest.building_id == ctx.building_id` were removed from the first `UPDATE` in
   `_decide`? Which test fails?
4. What would break if `_blank_to_none` in `backend/app/units/schemas.py` didn't call `printable_before_strip`
   first?
5. How would you extend this so a manager can undo a denial within an hour?

<details><summary>Answers</summary>

1. **409 `membership_not_pending`.** The request `UPDATE` succeeded, but the membership `UPDATE` matched no row
   (the membership is `active`), and raising rolled back the whole transaction. The request stays `pending`, the
   membership keeps its `security` role, and no occupancy is added. The request also disappears from the pending
   list and count, because of `_membership_pending`.
2. **Only pending requests are acted on.** A pending request whose membership moved on can't be decided (D1), so
   showing it would offer a button that always fails. Approved and denied requests are history. Their membership
   may have changed later (suspended, say), and they should still be listed.
3. **Cross-building decisions.** A manager of building A could approve or deny building B's request by its id:
   the `UPDATE` would match B's row. The membership `UPDATE` would then fail to match, because its `building_id`
   filter is A, so the result would be 409 `membership_not_pending` instead of 404, revealing that the id exists.
   `test_another_buildings_request_is_404_like_a_random_id` fails, since it expects the same 404 body as a random id.
4. **A tower of `"\t"` (or `"\n\n"`) would be silently accepted as no tower.** It is all whitespace, so the strip
   makes it blank and it becomes `None`, the silent-trim pattern D4 removes.
   `backend/tests/units/test_schemas.py::test_control_characters_are_refused_even_at_the_ends` fails, for the `\t` and
   `\n\n` tower cases.
5. **A `POST …/{id}/undo-denial` action endpoint.** It would run a conditional `UPDATE onboarding_requests SET
   status='pending', decided_at=NULL, decided_by_user_id=NULL, decision_reason=NULL WHERE id … AND building_id …
   AND status='denied' AND decided_at > now() - interval '1 hour'`, and the membership `UPDATE … WHERE
   status='denied'` back to `pending`, in one transaction with an audit event.
   - It must also check that the membership has no newer pending request (the resident may have resubmitted). The
     partial unique index `uq_onboarding_requests_pending_membership` would otherwise reject the second pending row
     with an `IntegrityError`.
   - It needs a decision about whether to notify the resident.

</details>
