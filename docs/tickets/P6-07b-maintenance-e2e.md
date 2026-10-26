# P6-07b — Maintenance E2E (J6) with the internal-note privacy check

| Field | Value |
|---|---|
| Phase / lane | P6 / B |
| Risk tier | 2 |
| Depends on | P6-04a–d, P6-07a |
| Replaces old | M9-T05 (maintenance part) |
| Status | todo |

Split from the P6-07 stub ([P6-P7-backlog.md](./P6-P7-backlog.md)); after [P6-07a](./P6-07a-notices-e2e.md),
whose README sections it extends.

## Goal

Playwright journey J6 passes locally and in CI on both stacks: a resident submits a request with a photo, the
manager moves it through the states adding a public comment and an internal note, and the resident sees the
status changes and the public comment, never the internal note.

## Why

Journey 6 of `docs/PRODUCT_SCOPE.md`, and the stub's "internal-note privacy check": the one place the app promises
a resident won't see staff text, proven through the real stack (the list, the view, the notification, the email).

## Scope

- In:
  - **`e2e/tests/j6-maintenance.spec.ts`**:
    - a resident submits a request for their unit with a photo (P6-04b), description tagged with this run's id
    - the manager sees it in the staff list (P6-04d), opens it, starts it, adds a public comment, adds an internal
      note (P6-04c's toggle), puts it on hold, resumes and resolves it
    - the resident's view shows each status change and the public comment; the bell lists the status and comment
      notifications (P6-03c/d), whose links open `/maintenance/<id>` (or P6-04a's path); Mailpit holds the emails
      the kinds send, and none of them contains the internal note's text
    - **internal-note privacy**: the internal note's text appears nowhere on the resident's page (the DOM text of
      the view, the list and the bell panel), in no resident notification, email or `GET …/comments` answer
    - **privacy** through the API: another resident (`resident2`, unit 102) gets 404 for the request, its photo's
      `download-url` and its comments; Birch's manager 404 under Maple's path; signed out 401; the resident gets
      403 for `POST …/start`
  - the README row, the budget re-measured, and J6's smoke steps added to P6-07a's "Staging smoke steps"
- Out: J8 (P6-07c); the 14-day reopen window (backend tests cover it); layout checks (P7-04)

## Interfaces

`e2e/tests/j6-maintenance.spec.ts`, `e2e/helpers/maintenance.ts` (if needed), `e2e/README.md`. No app change beyond
small in-scope fixes.

## Acceptance criteria

1. **Given** `make e2e`, **then** J6 passes in both projects and in CI; **given** `E2E_STACK=prodlike`, it passes
   there too.
2. **Steps.** Each scope step is asserted from the browser, including the photo loaded in the manager's view
   (`naturalWidth > 0`) from a presigned URL, and each status as text on the resident's view.
3. **Internal-note privacy.** The internal note's unique text is absent from the resident's rendered page at every
   step after it is written, from every resident notification and Mailpit message, and from the resident's
   `GET …/comments`; the manager's view shows it labelled "Internal".
4. **Privacy.** The API checks above, each asserted on status and problem `code`.
5. **Parallel projects.** Each project files for its own resident's unit (or tags and filters by run id), so the
   two runs don't see each other's requests or counts.
6. **Budget and stability.** The README's budget table re-measured within its allowances; five consecutive `make e2e`
   passes, output in the PR.
7. **The privacy check can fail.** A mutation probe that drops the `is_internal = false` narrowing from
   `visible_maintenance_comments` for residents makes criterion 3 fail, output in the PR.
8. **Smoke steps.** J6's staging smoke steps are listed in `e2e/README.md`.

## Test plan

- The spec; `make e2e DB_PORT=55432` ×5 and `make e2e E2E_STACK=prodlike DB_PORT=55432`; the mutation probe
  (`scripts/mutation-probe.sh`, committed tree), outputs in the PR

## Likely files

`e2e/tests/j6-maintenance.spec.ts`, `e2e/helpers/{maintenance,mailpit}.ts`, `e2e/README.md`. Copy from
`e2e/tests/j4-packages.spec.ts` (photo, presigned URL, privacy step).

Estimate: ~20 non-test lines (README); the spec and helpers are test code.

## Must explain (learning checkpoint)

1. List every path by which the internal note could reach the resident, and which assertion covers each.
2. Why does the probe mutate the backend query rather than the frontend?
3. How do the two projects keep their requests apart?

## Open decisions (resolve while framing)

Left open by the stub:
- each project's resident and unit (default: two seeded residents of different units, as J4's personas)
- whether the hold/resume steps stay in the journey (default: yes, they are "the states"; they cost two dialogs)

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
