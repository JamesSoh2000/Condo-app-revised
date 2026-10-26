# P6-07c — Dashboard E2E (J8) and the staging smoke list

| Field | Value |
|---|---|
| Phase / lane | P6 / B |
| Risk tier | 2 |
| Depends on | P6-05b, P6-07b |
| Replaces old | M9-T05 (dashboard part) |
| Status | todo |

Split from the P6-07 stub ([P6-P7-backlog.md](./P6-P7-backlog.md)); after [P6-07b](./P6-07b-maintenance-e2e.md).
[D-06](./D-06-staging-verification-gate.md) depends on this ticket for the smoke list.

## Goal

Playwright journey J8 passes locally and in CI on both stacks: each role's landing page shows the right counts
(pending approvals, packages waiting, open maintenance, unread notices), and the counts move when the data does.
The staging smoke steps for J5, J6 and J8 are complete for D-06.

## Why

Journey 8 of `docs/PRODUCT_SCOPE.md`, and the last of P6's journeys: after it, every demo journey 1–8 has an E2E, and
D-06 has one list of what to smoke on staging.

## Scope

- In:
  - **`e2e/tests/j8-dashboard.spec.ts`**:
    - each Maple role (resident, security, property management, council) opens `/` and sees its cards, with counts
      equal to the API's `GET …/dashboard` for the same session and to the nav badges
    - a change moves a count: the desk logs a package for the resident (waiting +1 on the resident's and the desk's
      page), the resident reads a notice (unread −1), a join request is filed (manager's pending +1, if the
      signup budget allows, else through a seeded pending request), a maintenance request is submitted (open +1 for
      the manager)
    - a feature off: in a building without `maintenance` (see "Open decisions"), no maintenance card shows
    - Birch's manager sees only Birch's counts
  - the README row, the budget re-measured, J8's smoke steps, and the "Staging smoke steps" section checked as
    complete for J5, J6 and J8 (the stub's "so D-06 can add them to the staging smoke")
- Out: the staging smoke spec itself (D-06); performance (P7-03)

## Interfaces

`e2e/tests/j8-dashboard.spec.ts`, `e2e/README.md`. No app change beyond small in-scope fixes.

## Acceptance criteria

1. **Given** `make e2e`, **then** J8 passes in both projects and in CI; **given** `E2E_STACK=prodlike`, it passes
   there too.
2. **Counts per role.** For each role, every card's number equals the dashboard API's answer and the matching nav
   badge in the same session; a council member sees the cards P6-05b settled.
3. **Counts move.** Each change in scope moves exactly its card by the expected delta for the expected roles, waited
   for through the 30 s poll or a return to `/`, never a fixed sleep; the deltas are taken against the count before
   the change, so the other project's run doesn't break them.
4. **Feature off.** In a building without `maintenance`, the maintenance card is absent and no maintenance URL is
   asked; Maple's other specs, running at once, are unaffected (the step never changes Maple's features).
5. **Other building.** Birch's manager's counts are Birch's only.
6. **Budget and stability.** The README's budget table re-measured within its allowances (J8 adds logins and maybe
   a signup); five consecutive `make e2e` passes, output in the PR.
7. **The journey can fail.** A mutation probe (for example, `maintenance_summary` counting `resolved`) makes J8
   fail, output in the PR.
8. **Smoke list complete.** `e2e/README.md`'s "Staging smoke steps" lists J5, J6 and J8's steps, each runnable
   against staging (no CLI, no database access; Mailpit steps marked as replaced by the SES check D-06 names), and
   D-06's ticket links to the section.

## Test plan

- The spec; `make e2e DB_PORT=55432` ×5 and `make e2e E2E_STACK=prodlike DB_PORT=55432`; the mutation probe,
  outputs in the PR

## Likely files

`e2e/tests/j8-dashboard.spec.ts`, `e2e/helpers/*.ts`, `e2e/README.md`, `docs/tickets/D-06-staging-verification-gate.md`
(the link only).

Estimate: ~30 non-test lines (README, D-06 link); the spec and helpers are test code.

## Must explain (learning checkpoint)

1. How does the spec take deltas so a parallel run can't break them?
2. How is a feature switched off for the journey without affecting the other specs?
3. Which smoke steps can't run on staging as written, and what replaces them?

## Open decisions (resolve while framing)

Left open by the stub:
- how the feature-off step gets a building without `maintenance`: `bootstrap-building --features` (the CLI takes
  the list, as J1 runs it; no CLI toggles a feature on an existing building), a seeded third building with
  `maintenance` off (changes `app/seed.py`), or a new operator command (more scope)
- whether the join-request step uses a signup (the signup budget is 6 of 10 per hour today) or a seeded pending
  request

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
