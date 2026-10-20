# P4-05b — Onboarding decisions: list, approve, deny (split from P4-05)

| Field | Value |
|---|---|
| Phase / lane | P4 / A |
| Risk tier | 1 |
| Depends on | P4-05a |
| Replaces old | part of [P4-05](./P4-05-resident-join-onboarding-approval.md) |
| Status | todo |

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

(The original ticket's criteria 3, 4, 5, 7 and 9, unchanged; sharpen them while framing this part.)

3. **Given** a manager approves, **then** the membership is `active` with role `resident`, a current
   occupancy exists with the chosen relationship, and the resident has an in-app notification and an email
   job. The resident's next `/me` shows `active`.
4. **Given** a second approval or denial of the same request, **then** 409 `already_decided`. Two concurrent
   approvals result in exactly one success.
5. **Given** a deny without a reason, **then** 422. With a reason, the resident's `/onboarding/me` shows it.
   Resubmitting creates a new pending request.
7. **Given** `a_security`, **when** approving, **then** 403. A building-B manager gets 404.
9. **Given** the approval transaction fails after the membership update (simulated), **then** no occupancy,
   notification or email job persists.

## Test plan

- `tests/onboarding/test_decisions.py`, with separate sessions for the concurrency test.
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

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split: part b of [P4-05](./P4-05-resident-join-onboarding-approval.md).
