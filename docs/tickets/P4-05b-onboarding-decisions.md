# P4-05b — Onboarding decisions: list, approve, deny (split from P4-05)

| Field | Value |
|---|---|
| Phase / lane | P4 / A |
| Risk tier | 1 |
| Depends on | P4-05a |
| Replaces old | part of [P4-05](./P4-05-resident-join-onboarding-approval.md) |
| Status | in progress |

## Goal

Property management sees the pending join requests from [P4-05a](./P4-05a-resident-signup-and-join.md) and
approves or denies each. The resident is notified in-app and by email; an approval starts their occupancy.

## Why

The second half of demo journey 3. Approval creates the occupancy data every later privacy rule depends on.

## Scope

- In (building router, `property_management`):
  - `GET /onboarding-requests?status=pending&cursor=`: requester name and email, unit and relationship,
    `submitted_at`.
  - **`POST /onboarding-requests/{id}/approve`:**
    - a conditional update on `status='pending'` (otherwise 409 `already_decided`)
    - the unit read `FOR KEY SHARE` and re-checked active before `start_occupancy` (the P4-01a carry)
    - membership becomes `active`, and `start_occupancy` with the request's relationship
    - `notify(membership.approved)` with in-app and email
    - audit `onboarding.approved` and `membership.activated`
  - **`POST /onboarding-requests/{id}/deny`** `{reason}` (required, 3–500 chars): membership becomes `denied`,
    `notify(membership.denied)`, audit.
  - **Email** for `membership.approved` and `membership.denied`. The ticket named templates
    `membership_approved` and `membership_denied`; P3-03 already maps both kinds to the generic
    `notification` template. Decide while framing (code is the truth for what exists).
  - **Pending count** for managers: `pending_onboarding_count` (extend P3-03's summary, or a separate
    `GET /onboarding-requests/summary`; choose one and document it).
- Out: document evidence uploads; unit-ownership verification beyond manager judgement.

## Interfaces

`onboarding_list`, `onboarding_approve`, `onboarding_deny`, and the pending count's.

## Acceptance criteria

(The original ticket's criteria 3, 4, 5, 7 and 9, sharpened while framing; 10–17 added. Paths are under
`/api/buildings/{building_id}`.)

3. **Given** a manager approves a pending request (`POST /onboarding-requests/{id}/approve`), **then** 200
   with the request `approved` (`decided_at` set, `decided_by` the manager); the membership is `active`
   with exactly the role `resident` and `status_changed_by_user_id` = the manager; one current occupancy of
   the request's unit with the request's relationship exists; the resident has one `membership.approved`
   notification (`entity_type="onboarding_request"`, the request's id) and one `email.send` job to their
   address; audit has `onboarding.approved` (entity the request) and `membership.activated` (entity the
   membership), IDs only in metadata. The resident's next `GET /api/auth/me` lists the membership `active`,
   and `GET /api/buildings/{A}` is 200 for them.
4. **Given** a second approval or denial of a decided request (approved or denied), **then** 409
   `already_decided` and nothing changes. Two concurrent approvals (real connections) give exactly one 200
   and one 409 `already_decided`, and one occupancy; an approval racing a denial likewise gives one winner.
5. **Given** a deny (`POST /onboarding-requests/{id}/deny`) without `reason`, with a reason shorter than 3
   or longer than 500 characters after trimming, or with a control character anywhere (also at either end,
   before trimming), **then** 422 and nothing changes. With a valid reason: 200, the request `denied` with
   the trimmed reason, the membership `denied`, one `membership.denied` notification and email job, audit
   `onboarding.denied` (no reason text in metadata), no occupancy; the resident's `/onboarding/me` shows
   `denied` and the reason. Resubmitting creates a new pending request (and the membership is `pending`).
7. **Given** `a_security` (or a resident, or council without property_management), **when** listing,
   counting, approving or denying, **then** 403 `forbidden_role`. A building-B manager, a pending or
   suspended member and no session get 404 / 404 / 401 (tenant rows 2, 3, 6).
9. **Given** the approval transaction fails after the membership update (simulated), **then** the request
   and membership are still `pending`, and no occupancy, notification, email job or audit event persists.
10. **List.** `GET /onboarding-requests` (`status` = `pending` by default, or `approved`/`denied`; cursor
    pagination, newest first) returns the building's requests only: id, requester `full_name` and `email`,
    `unit_id`, `unit_label`, `tower`, `relationship`, `status`, `submitted_at`, `decided_at`,
    `decision_reason`. A pending request whose membership is no longer `pending` (see 13) is not listed.
11. **Count.** `GET /onboarding-requests/summary` returns `{"pending_onboarding_count": n}`, counting what
    the pending list shows.
12. **Tenancy of the id.** Approving or denying another building's request, or a random id, is 404
    `onboarding_request_not_found` with the same body (tenant rows 3/5).
13. **Membership changed meanwhile.** A request whose membership is no longer `pending` (an invitation
    accepted it, P4-02b) is refused on approve and deny with 409 `membership_not_pending`: no second
    occupancy, roles unchanged, request still pending.
14. **Unit deactivated meanwhile.** Approving a request whose unit is now inactive is 409 `unit_inactive`
    and writes nothing; the manager can still deny it. A deactivation committed while the approval waits on
    the unit's lock is seen (real connections); an approval committed first makes the deactivation 409
    `unit_has_occupants`.
15. **Resubmission limit.** `POST /api/join/{code}/requests` is limited per user (10 per hour,
    `join_request` bucket), counted in a route dependency after the session check; the 11th is 429
    `rate_limited` with `Retry-After`, and another user is unaffected.
16. **Promoted pattern (step 8 of P4-05a).** No input type checks control characters after the strip: a
    fitness test fails if any `InputModel` field uses `printable` as an after-validator; `Label`, `Tower`,
    the building `Name`/`LongText`/`Operator` and the deny reason refuse `"x\n"` and `"\tx"` (422 / error).
17. **Email.** Both decision emails use P3-03's generic `notification` template and carry the
    notification's title and body; a resident with an inactive user or unsendable address gets the in-app row
    only (P3-03 rule, not re-tested beyond one case).

## Test plan

- `tests/onboarding/test_decisions.py`, with separate sessions for the concurrency test.
- `tests/onboarding/test_decisions.py` (HTTP), `tests/onboarding/test_decisions_concurrency.py` (real
  connections: approve × approve, approve × deny, approve × unit deactivation both ways).
- `tests/test_architecture.py` (criterion 16 fitness), schema tests for `Label`/`Name`.
- Commands: `make check`, `make gen-api`.

## Must explain (learning checkpoint)

1. Why does approval need a conditional update? What happens with two managers clicking at once?
2. What happens when a unit is deactivated while its join request waits for a decision?

## Carried from P4-05 (do while framing)

- `notify` with an email kind in the same transaction as other deduplicated jobs: take every dedupe key in
  one stable order (P3-03 carry, Codex round 2 on P3-03).
- A denied applicant can't read in-app notifications (the notifications routes need an active membership);
  `/onboarding/me` is where they see the reason.

## Carried from P4-05a (do while framing)

From PR #91 and its review rounds; see [the explanation](../explanations/P4-05a-resident-signup-and-join.md) §7.
- **First, the promoted pattern (step 8):** "a control-character check after the strip" is now in the
  mistakes log twice (P3-04a, P4-05a round 1 F3). Add the fitness test or `CLAUDE.md` lesson in this PR. The
  round 2 reviewer noted the same order still in `app/units/schemas.py` (`Label`; check `SearchText` and `Tower` too) and the
  building schemas: fix them with it, or record why not.
- **Approval updates the membership only from `pending`.** An invitation accept (P4-02b, `_REACTIVATABLE`)
  can make a `pending`/`denied` membership `active` while its join request stays `pending`; approving that
  request must not start a second occupancy or overwrite the invited roles (round 2 residual). Expire or
  refuse such a request (409), with a test.
- **Rate-limit resubmissions** (round 1, Claude L3): once deny exists, a denied resident can resubmit
  repeatedly and every manager is notified each time. A per-user or per-membership limit, as a route
  dependency (as `signup_limit`).
- The approval reads the unit `FOR KEY SHARE` (`with_for_update(read=True, key_share=True)`) and re-checks
  `is_active`: a pending request's unit may have been deactivated since (P4-05a accepted this).
- Optional, any later ticket: `app/logging_config.py::loggable_path` redacts only invitation tokens; the join
  code appears verbatim in request logs (round 2, Claude L1, Low).

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: 3 (exact writes, audit, `/me` and tenant access after), 4 (both decided
  states, approve × deny race), 5 (reason bounds, control characters, what deny writes), 7 (every route, every
  wrong role, rows 2/3/6), 9 (what "nothing persists" covers); added 10 (list), 11 (count), 12 (id tenancy),
  13 (membership changed by an invitation), 14 (unit deactivated, both race orders), 15 (resubmission
  limit), 16 (promoted control-character pattern), 17 (email template).
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - **Email templates:** keep P3-03's generic `notification` template for both kinds (`app/notifications/kinds.py`
    already maps them; code is the truth for what exists, the ticket said to decide). No new templates.
    Autonomous, reversible.
  - **Pending count:** a separate `GET /onboarding-requests/summary` (`pending_onboarding_count`), role-gated
    like the list. Extending P3-03's `/notifications/summary` would give every member a manager-only field.
    Autonomous, reversible.
  - **`already_decided`, not `invalid_transition`:** the ticket names the code; CLAUDE.md rule 7's
    conditional `UPDATE … WHERE status = 'pending' RETURNING` is kept. Ticket.
  - **Membership no longer pending (carry):** refuse approve and deny with 409 `membership_not_pending`, and
    leave such requests out of the pending list and count, rather than adding a new request state
    (`superseded`) and a migration now. The request row stays `pending` in the table. Follow-up: P4-06 (or a
    later ticket) can close such requests when an invitation activates the membership. Autonomous,
    reversible.
  - **Unit inactive at approval:** 409 `unit_inactive` (the code P4-02b's accept uses); the request stays
    pending so the manager denies it with a reason. Autonomous.
  - **Deny reason:** 3–500 characters after trimming, no control characters (checked before the trim);
    stored on the request, shown by `/onboarding/me`, put in the notification and email body, never in
    audit metadata (CLAUDE.md rule 10). Ticket + autonomous.
  - **Resubmission limit:** per user, 10 per hour, `join_request` bucket, a route dependency after the session
    (an anonymous request is a 401 before it). Per user rather than per membership: the dependency needs no
    database read of its own. Autonomous.
  - **Sessions:** approval grants only `resident`, which is not a staff role, so `apply_role_change` (which
    only shortens idle windows for staff) is not called. Established by `app/auth/service.py::idle_window`.
  - **Dedupe-key order (P3-03 carry):** each decision makes one `notify` call for one recipient and queues no
    other deduplicated job, so there is one key per transaction; nothing to order. Established by the code.
  - **Lock order:** approve/deny lock the request (conditional UPDATE), then the membership, then (approve)
    the unit `FOR KEY SHARE`. Submit locks the membership but never the request row; invitation accept and
    `deactivate_unit` never lock requests, so no cycle.
  - The optional join-code log redaction stays a follow-up (not in scope).
- Split: part b of [P4-05](./P4-05-resident-join-onboarding-approval.md). Estimate ~330 non-test lines
  (service ~170, router ~70, schemas ~45, config/kinds/actions ~10, control-character fixes ~25): no split.
