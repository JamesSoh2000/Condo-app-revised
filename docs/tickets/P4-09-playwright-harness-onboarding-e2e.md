# P4-09 — Playwright harness and onboarding E2E

| Field | Value |
|---|---|
| Phase / lane | P4 / B |
| Risk tier | 2 |
| Depends on | P4-07b, P4-08c, P4-03, P1-08 (the split parts of P4-07 and P4-08, as in the index) |
| Replaces old | M15-T02 (partial), M7-T06 (onboarding part) |
| Status | done |

## Goal

Playwright runs real browser journeys against the full compose stack, reads emails via the Mailpit API, and
gates merges in CI. Journeys 1, 2, 3 and 7 pass.

## Why

E2E tests are the only proof that frontend, backend, worker, email and database work together. They are the
phase gates in [ROADMAP.md](../ROADMAP.md).

## Scope

- In:
  - **`e2e/` at the repo root**: its own `package.json`, `playwright.config.ts` (Chromium, plus a mobile
    viewport project), `baseURL` from `E2E_BASE_URL` (default `http://localhost:5173`).
  - **`make e2e-reset`:** drop and recreate the schema, migrate, and seed (dev only). **`make e2e`** brings
    the stack up (api, worker, db, mailpit, s3, plus the Vite dev server or a `vite preview` build), resets,
    and runs Playwright.
  - **Helpers:**
    - `mailpit.ts`: `waitForEmail(to, subjectIncludes)` polls the Mailpit API, `extractLink(email, pathPrefix)`
    - `cli.ts`: runs `docker compose exec api python -m app.cli …` (for bootstrap)
    - `auth.ts`: API login, then `storageState` reuse for speed where the UI login isn't under test
  - **Journeys:**
    - **J1 bootstrap:** CLI `bootstrap-building`, then the invitation email, then the manager sets a
      password, then the manager home.
    - **J2 staff invite:** the manager invites security, then the email, then accept, then the security home.
    - **J3 resident onboarding:** join link, signup, pick unit, pending; the manager approves; the resident
      gets the notification and the home. Plus a deny-path variant.
    - **J7 password reset:** forgot, email, reset; a second browser context's session is logged out.
  - **CI job `e2e`:**
    - runs against the production-like stack from P1-08 (`E2E_BASE_URL=http://localhost:8080`), so the merge
      gate exercises the built image and SPA behind Caddy. Locally, either stack works. The compose file
      the helpers use comes from an env var.
    - traces, video and screenshots uploaded on failure
    - `retries: 1` in CI only
    - required status check
  - **Flaky-test policy:** a test that is flaky twice gets the `@quarantine` tag and a ticket within 48 h.
    Never silently retry forever.
  - **`e2e/README.md`:** how to run, debug (`--ui`, trace viewer) and write a journey.
- Out:
  - running E2E against staging. That is a smoke suite without email reading, in milestone D. See D-06.

## Interfaces

`make e2e`, `make e2e-reset`, CI job `e2e`, env `E2E_BASE_URL`.

## Acceptance criteria

(1–5 are the original criteria, sharpened while framing; 6–13 were added while framing. See the Frame notes.)

1. **Given** a clean machine with Docker, **when** `make e2e` runs, **then** J1, J2, J3 and J7 pass locally
   in under 5 minutes. "Clean" means `make e2e` itself installs the suite's packages (`npm ci` in `e2e/`)
   and Chromium; it brings the stack up, resets it (`make e2e-reset`) and runs both projects (desktop
   Chromium and the mobile viewport). The wall-clock time of the Playwright run is pasted in the PR.
2. **Given** a PR, **then** the `e2e` job (`E2E journeys`) runs on the prod-like stack and is required on
   `main`. A deliberately broken button selector fails it, and the failed run uploads a trace artifact
   (shown with a probe commit on the PR, reverted before review).
3. **Given** J3, **then** it verifies a building-B user cannot open the approved resident's data: Birch's
   manager asking for Maple's member list (`members_list`, searching for the resident) gets 404, not 403,
   through Playwright's `request` context; and Birch's own member list does not include the resident.
4. **Given** J7, **then** a second logged-in context is redirected to login after the reset: its next
   navigation to `/` ends on `/login`, and `GET /api/auth/me` with its cookies is 401.
5. **Given** the tests, **then** none use hard `waitForTimeout` sleeps: `npm run lint` in `e2e/` fails on any
   `waitForTimeout(` or `page.waitFor(` under `tests/` or `helpers/`, runs in CI before the journeys, and is
   shown failing once on purpose.
6. **J1:** after the manager sets a password from the emailed link, the shell shows the new building's home
   (its name) and the manager's navigation ("Residents"); opening the same link again shows the invitation's
   invalid-link screen (the token is single-use end to end).
7. **J2:** the invited security user lands on the building's home with security's navigation (no
   "Residents"); the account menu opens with **Enter** and, after closing, with **Space** (carried from
   P2-06c).
8. **J3:** the resident's pending screen shows before the decision; after approval the resident gets the
   "Your join request was approved" email and the in-app notification, and the home loads. In the deny
   variant, the resident gets the "Your join request was declined" email and the denied screen shows the
   reason.
9. **J7 Web Lock (carried from P2-06c):** in two pages of one context, a logout in page A held at the
   network and a login in page B: B's login request is sent only after A's logout answered, and B stays
   signed in (`/api/auth/me` 200 after a reload).
10. **Mail:** every link a journey follows is read from Mailpit (`helpers/mailpit.ts`), addressed to that
    journey's own recipient; none is read from the database or the CLI's output.
11. **Isolation:** each journey uses its own emails and building slug, so the two projects and a CI retry can
    run without a reset in between and without colliding; manager and Birch personas log in once per run
    (`storageState`), so a run stays under the login rate limits (carried from P2-05), which keep their
    production values.
12. **Failure artifacts:** in CI, `retries: 1`; a trace, video and screenshot for every failed attempt (the
    first attempt's too, when its retry fails differently or passes: review round 1, F3), uploaded as an artifact
    with the HTML report whenever the job fails. Locally, `retries: 0`. A retry starts with empty rate-limit
    windows (review round 1, F2).
13. **`make e2e-reset`** refuses unless the stack's API reports `APP_ENV=dev`; otherwise it stops the API and
    worker, drops and recreates the `public` schema, migrates, seeds and restarts them. It works with either
    stack (`E2E_STACK=dev|prodlike`).

## Test plan

The journeys above. Run 5 times locally in a row to check flakiness before merging.

## Likely files

`e2e/{package.json,playwright.config.ts,README.md}`, `e2e/helpers/{mailpit,cli,auth}.ts`,
`e2e/tests/{j1-bootstrap,j2-staff-invite,j3-onboarding,j7-password-reset}.spec.ts`, `Makefile`,
`.github/workflows/<ci>.yml`.

## Must explain (learning checkpoint)

1. Why read the invitation link from Mailpit rather than from the database?
2. What makes an E2E test flaky, and which Playwright features prevent it (auto-waiting, locators,
   web-first assertions)?
3. Why keep E2E to a few critical journeys instead of testing everything this way?

## Carried from P1-06 (do while framing)

- The compose service is `app`, not `api`: use `docker compose exec app python -m app.cli …` (as `make seed`
  does).

## Carried from P2-05 (do while framing)

- Login is rate-limited: 30 attempts per 10 minutes per IP, 8 per 15 minutes per email, counting successes.
  A suite that logs in repeatedly as one seeded user from one IP will get 429s. Set `RATE_LIMIT_LOGIN_IP` and
  `RATE_LIMIT_LOGIN_EMAIL` (JSON `{"limit", "window_seconds"}`) for the e2e environment, or log in once per
  persona and reuse the storage state (PR #61 review round 1, L2).

## Carried from P2-06c (do while framing)

- The `condo.auth` Web Lock (`frontend/src/app/authQueue.ts::runAuthCall`) is proven only with a fake lock
  manager. With two browser contexts sharing storage, or two pages of one context, add a journey: a slow logout
  in page A, a login in page B, B stays signed in (PR #65 D4).
- The account menu opens with Enter (checked in P2-06c's stack run) and Space (native `<button>`, never
  checked). Add both to a journey.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: 1–5 made checkable (what "clean" includes, the job name, the probe for 2,
  the exact 404 request for 3, what "redirected" means for 4, the lint for 5). Added 6 (J1, including the
  reused invite link: the case the ticket missed), 7 (J2 and the P2-06c account-menu keys), 8 (J3's
  notification and deny variant), 9 (the P2-06c Web Lock journey), 10 (links only from Mailpit), 11
  (isolation and the P2-05 rate limits), 12 (artifacts), 13 (the reset's guard). Tenant table: case 3
  (another building's member → 404) is criterion 3; cases 1 and 6 are the journeys themselves (the pending
  resident sees the pending screen); the other cases are the backend suites' job, not E2E's.
- Criteria loosened (with reason; also listed in the inbox):
  - **J2's invite step goes through the API, not a screen.** No manager screen creates invitations yet (the
    frontend has only the accept page, and no ticket in the index builds one). The journey signs in as the
    manager, creates the invitation with `invitations_create` through the browser context's `request`
    (same cookies and CSRF headers as the SPA), then reads the email and accepts it in the UI as written.
    A follow-up ticket for the invite screen, which then moves this step to the UI, will be added to the
    index in step 6.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - **Two stacks, one suite** (ticket: "either stack works"): `make e2e` defaults to `E2E_STACK=dev` (`make up`
    plus the Vite dev server, which Playwright starts on :5173 unless one runs); `E2E_STACK=prodlike` runs
    `make prodlike` and uses :8080. The Makefile passes the compose file (`E2E_COMPOSE_FILE`), the API's
    service name (`E2E_API_SERVICE`: `app` or `api`) and `E2E_BASE_URL` to the helpers. CI runs
    `make e2e E2E_STACK=prodlike`. Basis: ticket, autonomous for the variable names.
  - **Reset by stopping the API and worker** before dropping the schema: their pooled connections cache
    type OIDs (asyncpg) that a recreated schema changes. Basis: autonomous.
  - **Rate limits keep their values** (P2-05 carry: the ticket offers both options): personas log in once per
    run; journeys create their own users; the reset empties the windows. Basis: autonomous; keeps the
    prod-like stack prod-like.
  - **Mobile project:** Playwright's `Pixel 7` (Chromium), running every journey. Basis: ticket, default.
  - **Quarantine:** `@quarantine` tests are left out of the required run (`grepInvert`) and must have a ticket;
    none are quarantined now. Basis: ticket.
  - **`@playwright/test` 1.64.1**, its own `e2e/package-lock.json`, and a Dependabot entry for `/e2e`.
- Split: none. Estimate: ~270 non-test lines (Makefile ~35, CI job ~60, config and package files ~70, README
  ~100, Dependabot ~6); helpers and specs are test code.
