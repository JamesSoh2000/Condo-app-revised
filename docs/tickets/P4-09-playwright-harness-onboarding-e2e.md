# P4-09 — Playwright harness and onboarding E2E

| Field | Value |
|---|---|
| Phase / lane | P4 / B |
| Risk tier | 2 |
| Depends on | P4-07, P4-08, P4-03, P1-08 |
| Replaces old | M15-T02 (partial), M7-T06 (onboarding part) |
| Status | todo |

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

1. **Given** a clean machine with Docker, **when** `make e2e` runs, **then** J1, J2, J3 and J7 pass locally
   in under 5 minutes.
2. **Given** a PR, **then** the `e2e` job runs and is required. A deliberately broken button selector fails
   it, with a trace artifact.
3. **Given** J3, **then** it verifies a building-B user cannot open the approved resident's data (one API
   assertion via `request` context).
4. **Given** J7, **then** a second logged-in context is redirected to login after the reset.
5. **Given** the tests, **then** none use hard `waitForTimeout` sleeps (lint rule or review).

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

## Frame notes (filled by the human in step 1)

- Design prediction:
- Extra cases added:
