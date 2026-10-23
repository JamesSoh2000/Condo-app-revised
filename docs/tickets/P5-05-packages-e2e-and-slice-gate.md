# P5-05 — Packages E2E and reference-slice gate

| Field | Value |
|---|---|
| Phase / lane | P5 / B |
| Risk tier | 1 |
| Depends on | P5-03c, P5-03d, P5-04, P4-09, P1-08 |
| Replaces old | M7-T06, M7-T10 (local part; the staging part is D-06) |
| Status | todo |

## Goal

The full onboarding-to-package journey passes in the browser, locally and in CI, including on the
production-like stack. The patterns are written up as a **slice recipe** that the next slices follow.

## Why

This is the **reference slice gate**. Passing it proves the architecture works end to end. After it, each
developer can build a slice independently, using the recipe.

## Scope

- In:
  - **E2E J4** (`e2e/tests/j4-packages.spec.ts`):
    - security logs a package with a photo for unit 101
    - the resident's badge and notification appear, and the deep link opens the package with the photo
    - the email for `package_arrived` is in Mailpit
    - security picks it up, and the resident sees it in history
    - **privacy assertions:** in a second context, `resident2` (same building) gets 404 for the package URL and
      the photo `download-url`; a building-B user gets 404 via the API
  - **Manual checks on the prod-like stack** (`make prodlike`; evidence in the PR):
    - the `package_arrived` email is in Mailpit with the right link
    - the photo loads through the presigned URL from the S3 emulator, and the URL in the page carries a
      60 s expiry
    - restarting the worker mid-queue recovers (P3-01 criterion repeated on the prod-like stack)
  - The staging smoke and the checks against real S3 and SES are in
    [D-06](./D-06-staging-verification-gate.md).
  - **`docs/SLICE_RECIPE.md`** (≤ 150 lines), the checklist for building a slice, using packages as the
    worked example:
    - schema with composite FKs
    - state module
    - `visible_*` query
    - service with a single commit
    - router on the building router with role and feature guards
    - notify, audit and email template
    - the 10-case tests
    - types regeneration
    - feature hooks and pages
    - removing legacy pages and the ratchet
    - E2E journey
    - explanation
  - The milestone recap for P5 (`/milestone-recap P5`).
- Out:
  - new features

## Interfaces

`e2e/tests/j4-packages.spec.ts`, `docs/SLICE_RECIPE.md`.

## First follow-ups (playbook step 8, from the P4 recap, PR #113)

- Pattern "recap facts not checked against their source" reached 2 (P3 recap PR #83, P4 recap PR #113: counts taken
  by regex, a demo written but not run, items listed as open that later tickets closed). Promote it before this
  phase's recap: add a step to `.claude/commands/milestone-recap.md` to run the demo script on the stack, and to take
  each count and status from its source (each PR's "Independent review", the log's "Caught by" column, the
  later tickets that close an explanation's §7 item), not a summary.

## Carried from P5-02b

From PR #115: `backend/tests/packages/test_api.py::_picked_up` (P5-02a) writes `picked_up_at` from the host
clock + 1 s while `received_at` is the database's `now()`. When the WSL2 host and the Docker VM drifted over
a second it failed `ck_packages_picked_up_after_received` (twice on 2026-10-22: the P5-02b local `make check`
and the Codex review run; both passed on rerun). Make it use the database clock (`func.clock_timestamp()`),
or `received_at` plus an interval, before the slice gate relies on a green suite.

## Acceptance criteria

1. **Given** `make e2e`, **then** J1–J4 and J7 pass locally and in CI.
2. **Given** `make prodlike` and `E2E_BASE_URL=http://localhost:8080`, **then** J4 passes against the
   production-like stack, and CI runs it the same way (P4-09).
3. **Given** the manual prod-like checks, **then** all three have evidence (screenshot, curl output, log
   excerpt).
4. **Given** `docs/SLICE_RECIPE.md`, **when** a fresh agent session reads only the recipe and the P6-03 stub,
   **then** it produces a plan for the maintenance backend that reuses the slice's helpers and test table
   without reading the packages code (the recipe's completeness test, noted in the recap).
5. **Given** the P5 recap, **then** its gate result, demo script, decisions and agent-performance sections
   are complete (James's own sections are optional).

## Test plan

Run the E2E suites against the dev and prod-like stacks. Do the manual checks. Run the recipe check (criterion 4)
in a fresh subagent.

## Likely files

`e2e/tests/j4-packages.spec.ts`, `docs/SLICE_RECIPE.md`, `docs/recaps/P5.md`.

## Must explain (learning checkpoint)

1. Explain the whole packages slice, from schema to UI, as you would on a whiteboard.
2. Which part of this slice would you change first if the building had 50 packages per minute? Why?
3. What would you add to the recipe after building the next slice?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
