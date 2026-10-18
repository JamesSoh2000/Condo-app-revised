# Explanation — P2-gate-01 Reconcile the login rate-limit exit gate

> **PR:** not yet opened when written (see `gh pr list --head p2-gate-01-login-rate-limit-gate`). **Source
> revision:** the PR head after the bookkeeping commit; the changes are documentation only, on top of `main` at
> `5954517`. **Merge commit:** not known when written. Built and merged autonomously
> ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)) on a human decision recorded below. This is a
> snapshot: once merged, write a new explanation for later changes.
> **Reality check:** re-read the diff against `main` (roadmap, recap, inbox, ticket, tickets README) and
> `backend/tests/test_rate_limit.py`; ran it: 31 passed. `make check DB_PORT=55432`: exit 0, 840 backend and
> 260 Vitest tests. A live ten-attempt probe of the dev stack gave 401 ×8 then 429 ×2.
> Written by the implementing session ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: short. Tier: 3.

## 1. What changed and why

The P2 recap found one red exit-gate item: the roadmap said "the 6th failed login within the window gets 429",
but [P2-05](../tickets/P2-05-rate-limiting.md) specified, and the tests prove, 8 counted attempts per
normalized email per fixed 15-minute window, so the 9th gets 429. The agent could not choose between the two
gates, because loosening a criterion is not an autonomous call and lowering the quota is a policy change.

James chose, in session on 2026-10-17, to keep P2-05's behavior and to change the roadmap. This PR changes
only documents: the roadmap's P2 line, the recap (original report kept as history, with a dated resolution and
fresh verification), the inbox's Resolved table, the tickets index and this ticket.

## 2. Decision

| | |
|---|---|
| Chosen (James, human) | Keep 8 per email per 15 min; the roadmap now says the 9th attempt gets 429, even with the right password |
| Rejected (James) | `P2-fix-01`: lower the email quota to 5, which would also have changed P4-04's reset defaults |
| Basis | The specified, reviewed and tested policy already exists; the roadmap line disagreed with it since P0-01 |

The new line also states what the old one hid: successful logins count, and the 30-per-10-minute IP limit is
independent. Both are what the code does (`test_login_succeeds_under_the_limits` counts a success;
`test_thirty_first_login_from_one_ip_in_10_minutes_is_429` shows an IP-blocked attempt never reaches the email
counter). Windows are fixed and aligned to the epoch, so a block ends at the window boundary, not 15 minutes
after the last attempt (`test_login_is_allowed_again_when_the_window_passes`).

## 3. Not changed

Targeted lockout (8 attempts from any IPs lock one email for 15 minutes) and successful attempts consuming
quota remain accepted risks in recap §5. No code, configuration, test, CI or protection changed.

## 4. How to check

`cd backend && uv run pytest tests/test_rate_limit.py` (31 passed). Live: ten wrong-password logins for one
email on `make up`: 401 for 1–8, 429 with `Retry-After` for 9–10, unless the fixed window rolls over mid-run.
