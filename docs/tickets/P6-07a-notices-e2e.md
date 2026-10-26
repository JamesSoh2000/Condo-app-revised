# P6-07a — Notices E2E (J5)

| Field | Value |
|---|---|
| Phase / lane | P6 / B |
| Risk tier | 2 |
| Depends on | P6-02a–f, P5-05 |
| Replaces old | M9-T05 (notices part) |
| Status | todo |

Drafted from the P6-07 stub in [P6-P7-backlog.md](./P6-P7-backlog.md) and split by journey, because each needs
a different slice merged first: this ticket (J5) can run now, the notices slice being done;
[P6-07b](./P6-07b-maintenance-e2e.md) (J6) waits for P6-04; [P6-07c](./P6-07c-dashboard-e2e-and-smoke-list.md)
(J8 and the D-06 smoke list) for P6-05. Each journey is one spec of P5-05's size (`j4-packages.spec.ts` 163 lines)
plus its rate-limit budget, five clean runs and a prod-like run; three in one PR would be one long review.

## Goal

Playwright journey J5 passes locally and in CI on both stacks: the manager publishes a normal and an urgent notice,
residents see the feed, the unread badge and the urgent banner, and marking a notice read clears the badge.

## Why

Journey 5 of `docs/PRODUCT_SCOPE.md`, the first proof that the notices API, the fan-out job, the polled badges and
the banner work together in a real browser. The unit tests stub the API; only the E2E shows the 30 s polling, the
worker and Mailpit agreeing.

## Scope

- In:
  - **`e2e/tests/j5-notices.spec.ts`**, as `docs/SLICE_RECIPE.md` step 11:
    - the manager writes and publishes a normal notice in the editor (P6-02d), then an urgent one, each titled with
      this run's id so parallel projects don't see each other's
    - a resident's "Notices" badge rises by two; the urgent banner shows the urgent notice and its link opens
      `/notices/<id>`; the bell lists both notifications; Mailpit holds the urgent one's email
      (`notice.published_urgent` emails, `notice.published` doesn't: `app/notifications/kinds.py`), its link
      `<origin>/notices/<id>`, and no email for the normal one
    - "Mark as read" on each clears the badge to its earlier count; the banner goes once the urgent one is read
    - **privacy** through the API: a draft is 404 for a resident; Birch's manager gets 404 for Maple's notice
      under Maple's path; signed out 401
  - a helper in `e2e/helpers/notices.ts` only if the spec needs one (as `helpers/packages.ts`)
  - the rate-limit budget table in `e2e/README.md` re-measured with J5's logins (shared personas from `.auth/`)
  - the journey's row in `e2e/README.md`'s table, and its **smoke steps** for D-06 in a new "Staging smoke steps"
    section (the stub's "list the smoke steps"), J5's lines only
- Out: J6, J8 (P6-07b, c); visual or layout checks beyond what the journey touches (P7-04)

## Interfaces

`e2e/tests/j5-notices.spec.ts`, `e2e/README.md`. No app change; a bug the journey finds is fixed in this PR only
if small and in scope, otherwise it blocks the ticket with a follow-up.

## Acceptance criteria

1. **Given** `make e2e`, **then** J5 passes in both projects (`chromium`, `mobile`) alongside the existing specs,
   and in CI.
2. **Given** `make e2e E2E_STACK=prodlike`, **then** J5 passes against the production-like stack, as CI runs it.
3. **Steps.** Each scope step is asserted from the browser: the badge's accessible name ("Notices, N unread")
   before and after, the banner's text and its link's target, the read clearing the badge without a reload (within
   the 30 s poll, waited for, never a fixed sleep).
4. **Privacy.** The API checks above, each asserted on status and problem `code`.
5. **Parallel projects.** Both projects run at once against one seeded building without moving each other's counts:
   each project uses its own resident (or asserts deltas on notices it created), as SLICE_RECIPE step 11 says.
6. **Budget.** The README's per-run table is re-measured and every limit stays under its allowance; the logins J5
   adds are counted.
7. **Stable.** `make e2e` passes five times in a row (e2e/README "Before merging a new journey"), output in the PR.
8. **The journey can fail.** One mutation probe (for example, the feed's mark-read not invalidating the summary)
   makes J5 fail, output in the PR (CLAUDE.md "prove a gate can fail").
9. **Smoke steps.** `e2e/README.md` lists J5's staging smoke steps (what D-06 runs against staging without Mailpit
   access, if staging has none), each a line D-06 can turn into a test.

## Test plan

- The spec itself; `make e2e DB_PORT=55432` ×5 and `make e2e E2E_STACK=prodlike DB_PORT=55432`, outputs in the PR;
  the mutation probe's output (criterion 8)

## Likely files

`e2e/tests/j5-notices.spec.ts`, `e2e/helpers/{notices,auth}.ts`, `e2e/README.md`. Copy from
`e2e/tests/j4-packages.spec.ts`, `e2e/helpers/mailpit.ts`.

Estimate: ~20 non-test lines (README); the spec and helpers are test code.

## Must explain (learning checkpoint)

1. How does the spec wait for the 30 s poll without a fixed sleep, and what would a sleep hide?
2. How do the two projects avoid moving each other's badge counts?
3. Which privacy checks go through the API rather than the browser, and why?

## Open decisions (resolve while framing)

Left open by the stub:
- whether the manager publishes through the editor (default: yes, the journey's UI) or the API (faster, but then
  the editor is not in a journey)
- each project's resident: two seeded residents (`resident4`, `resident6`) or one with deltas

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
