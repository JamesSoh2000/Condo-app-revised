# P5-05 — Packages E2E and reference-slice gate

| Field | Value |
|---|---|
| Phase / lane | P5 / B |
| Risk tier | 1 |
| Depends on | P5-03c, P5-03d, P5-04, P4-09, P1-08 |
| Replaces old | M7-T06, M7-T10 (local part; the staging part is D-06) |
| Status | in progress |

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

## Carried from P5-03d

- **First follow-up (playbook step 8):** the pattern "overflow at 375 px with long text" reached 5 in the mistakes
  log (P5-03d R1 F2) after its `CLAUDE.md` lesson. Add a check that enforces it, for example an E2E step that fills
  every package field with the API's longest values and asserts `scrollWidth <= clientWidth` at 375 and 768 px on
  the desk page, both dialogs and the outcome message.
- Pickup and return E2E: two contexts race one package (the loser sees "Already picked up or returned by a
  colleague." and its list drops the row); the dialogs' focus on open, Shift+Tab inside a radio group, and
  Cancel after the row is gone (all checked in Chromium by hand in PR #119, not in CI).
- Not tested: a building switch while a **return** is out (the pickup case is; both use `usePackageSubmit`).
- The P3-05 fitness test (every component under `src/app` or `src/features` that reads
  `useBuilding({ passive: true })` also calls `useBuildingDenied()`), still open after P5-03b–d. As worded it
  fails on `app/AccountMenu.tsx::BuildingChoices`: change that component or exempt it with a reason.
- Accepted Low risk (P5-03d D2): the pickup dialog's occupants are inserted above "Someone else" when they load,
  so the list can shift under a click. Reserve the space or show the choices together if it matters.

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

Added in framing (the 10-case rows an E2E can reach, the carried follow-ups, and cases the scope missed):

6. **Given** J4, **then** it asserts each scope step from the browser: the desk logs the package with a photo
   through the Log package panel; the resident's "My packages" badge rises by one and the bell lists a
   notification naming this run's carrier; that notification's link opens `/packages/<id>` with the photo
   loaded (`naturalWidth > 0`) from a presigned URL whose query has `X-Amz-Expires=60`; Mailpit holds the
   `package_arrived` email to the resident naming this run's carrier, and its link is exactly
   `<origin>/packages/<id>`; the desk hands it out and the resident's badge falls back, the waiting list
   drops it and the package shows in History as picked up.
7. **Given** J4's privacy step, **then** (10-case rows 2–6): signed out, `GET …/packages/<id>` is 401; a
   resident of another Maple unit (`resident2`, unit 102) gets 404 for the package, 404 for the photo's
   `download-url`, and "Package not found" at `/packages/<id>` in the browser; the resident who may see it
   gets 403 for `POST …/pickup` (wrong role); a pending Maple membership (`pending@example.test`) gets 404;
   Birch's manager gets 404 for the package and the photo under Maple's path, and 404 for the same ids under
   Birch's own path.
8. **Given** the desk at 375 px and 768 px wide, **when** a waiting package has the API's longest values
   (carrier 50, description 200, tracking 4, a unit with a 20-character tower and label, a typed pickup name
   of 120 and a return reason of 300 characters, unbroken), **then** the page, the Hand out and Return
   dialogs and the outcome message each keep `scrollWidth <= clientWidth` (the P5-03d first follow-up).
9. **Given** two desk contexts with the Hand out dialog open on one package, **when** both confirm, **then**
   one hands it out and the other shows "Already picked up or returned by a colleague." and its list drops
   the row; its Cancel then closes the dialog with focus inside the page; each dialog moves focus into
   itself on open; Shift+Tab inside the pickup dialog's radio group stays in the dialog (P5-03d carry).
10. **Given** a building switch while a **return** is out, **then** the return dialog behaves as the pickup
    case does (frontend test, P5-03d carry).
11. **Given** every component under `src/app` and `src/features` that reads `useBuilding({ passive: true })`,
    **then** a parser-based fitness test fails unless the same function calls `useBuildingDenied()` (directly
    or through `useCanViewAs`), or it is listed as exempt with a reason (the P3-05 carry).
12. **Given** the packages API tests' `_picked_up` and `_returned` rows, **then** their timestamps come from
    the database clock, so host and database clock drift can't fail `ck_packages_*_after_received` (P5-02b
    carry).
13. **Given** `.claude/commands/milestone-recap.md`, **then** it says to run the demo script on the stack and
    to take each count and status from its source, not a summary (the P4 recap's first follow-up).

## Test plan

Run the E2E suites against the dev and prod-like stacks. Do the manual checks. Run the recipe check (criterion 4)
in a fresh subagent.

## Likely files

`e2e/tests/j4-packages.spec.ts`, `docs/SLICE_RECIPE.md`, `docs/recaps/P5.md`.

## Must explain (learning checkpoint)

1. Explain the whole packages slice, from schema to UI, as you would on a whiteboard.
2. Which part of this slice would you change first if the building had 50 packages per minute? Why?
3. What would you add to the recipe after building the next slice?

## Carried from P5-04

- **Step 8 promotion (next after P5-03d's overflow check, above):** the pattern "a list read before the change it is compared with" now
  appears twice (P5-04 R1 F1, R2 F1 in `docs/AGENT_MISTAKES_LOG.md`). Turn it into a fitness test or a `CLAUDE.md`
  lesson: when a view refreshes data on a signal (a polled count, a mutation), list the reads that can start before
  the signal's first value and those already in flight at a change, and cancel before invalidating.
- J4's resident half can use `/packages`, the "My packages, N waiting" nav name, and `/packages/<id>` from the
  `package.arrived` notification (criterion 2's bell link). The badge polls every 30 s, so a journey waiting for it
  needs up to ~30 s or a page reload.
- Coverage gaps from P5-04 review round 3 (no defect found): a pickup time's own conversion and a non-English building
  locale (P5-04 AC4); the lists' loading messages and Load more succeeding after a failure (AC8).
- Accepted in P5-04: a member who is a resident and also security or property management sees every package of the
  building on `/packages` and in its badge (`visible_packages` grants the union). Decide whether the slice gate
  accepts that, or whether the page should narrow to the caller's own packages (a server-side `mine` filter).
- The seed has no package photos, so P5-04's stack run showed "No photo" boxes only; a journey that logs a package
  with a photo would cover the resident's `PrivateImage` alt text in a browser.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
  - 1–2: "pass" means every spec (J1–J4, J7, `header-panels`, the new desk checks) in both projects
    (`chromium`, `mobile`), with `make e2e DB_PORT=55432` (dev stack) and `make e2e E2E_STACK=prodlike`
    locally, and the `E2E journeys` job green on the PR head.
  - 6–7: each J4 step as a browser or API assertion. Added cases: the photo really loads and its URL's
    expiry is asserted in CI, not only by hand; the email link is compared with the package id; the badge
    rises and falls; 10-case rows 2 (signed out), 4 (wrong role), 6 (pending membership) and Birch's own
    path (row 3 with a Maple id). Rows 7 and 9 are covered by the backend tests (P5-02a/b) and not repeated.
  - 8–10, 12–13: the carried follow-ups (P5-03d, P5-02b, the P4 recap), each made a criterion.
  - 11: the P3-05 fitness test, carried since P3-05.
  - 3: the worker restart is done on the prod-like stack with several `email.send` jobs queued (packages
    logged in a burst) and the restart issued before Mailpit has them all, both ways: a graceful stop
    (SIGTERM) and a crash (SIGKILL) with a job running. Evidence: every queued email arrives, the jobs all
    end `succeeded`, and the worker log. Corrected during verification: the first wording said "each email
    arrives once", which ADR-0006 does not promise ("delivery is at-least-once… never promise exactly-once
    email"): after a crash the job that was running may send twice. Once each is required of the graceful
    stop only. (Also in the inbox's "Decisions to audit".)
  - 3: the photo check also records that the presigned URL still answers after 60 s on the S3 emulator
    (LocalStack's default skips signature checks); the expiry itself is D-06's check against real S3.
  - 4: the check runs in a fresh subagent given only `docs/SLICE_RECIPE.md` and the P6-03 stub (in
    `P6-P7-backlog.md`; there is no P6-03 ticket file yet); its plan and the gaps it shows are in the PR.
  - 5: the recap is written in step 8 after this merges, as its own docs PR (as P4's was, PR #113): the
    gate needs every P5 ticket `done`, which happens only with this merge.
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - The two projects run J4 at once against one seeded building, so each takes its own unit and resident
    or their badges and notifications interleave: `chromium` uses unit 101 (`resident1`), as the ticket
    says; `mobile` uses unit 304 (`resident4`). The desk checks use only units they create, which no journey
    reads (the first wording also named unit 503, which they don't use; review round 2, L2). Basis: autonomous, following `e2e/README.md` ("a journey makes its own users… so the two
    projects can run in parallel").
  - The seeded desk and resident accounts log in once per run in `auth.setup.ts` (the login limits, README).
  - P5-03d D2 (pickup occupants inserted above "Someone else" when they load) stays an accepted Low risk:
    changing it is a feature change this ticket's scope excludes. It goes to the recap's open risks.
  - Reviewers (Tier 1): a fresh Claude reviewer with the security pass, plus Codex at `gpt-6-astra-medium`
    (the playbook's table; James's instruction for this run). No second Claude reviewer.
- Split: none. Non-test lines: `docs/SLICE_RECIPE.md` (≤ 150), the recap command (~5), `e2e/README.md`
  (~25): about 180. The specs, helpers and fitness test are tests.
