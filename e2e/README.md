# E2E journeys (Playwright)

Real browser journeys against the whole stack: the SPA, the API, the worker, Mailpit and Postgres
([P4-09](../docs/tickets/P4-09-playwright-harness-onboarding-e2e.md)). They are the only tests that prove those
pieces work together, so they cover a few critical journeys, not every screen. The backend and frontend suites
cover the rest.

| Spec | Journey |
|---|---|
| `tests/j1-bootstrap.spec.ts` | J1: `bootstrap-building` (CLI) → invitation email → the first manager sets a password → home; the link is single-use |
| `tests/j2-staff-invite.spec.ts` | J2: the manager invites security on the Invitations tab → email → accept → security's home; the account menu opens with Enter and Space |
| `tests/j3-onboarding.spec.ts` | J3: join link → signup → unit → pending → the manager approves → email, notification, home; Birch can't see the resident. Plus the deny path |
| `tests/j7-password-reset.spec.ts` | J7: forgot → email → reset → another device is signed out. Plus the `condo.auth` Web Lock across two pages (a seeded resident) |
| `tests/j4-packages.spec.ts` | J4: the desk logs a package with a photo → the resident's badge and bell → the notification's link opens it with the photo (a 60 s presigned URL) → the `package_arrived` email and its link → the desk hands it out → History. Then who else gets 401, 403 or 404 for the package and its photo: signed out, another Maple unit's resident, a pending member, Birch's manager. `chromium` uses unit 101, `mobile` unit 304, so the two runs don't move each other's badge (P5-05) |
| `tests/packages-desk.spec.ts` | Not a journey: the package desk at 375 and 768 px with the API's longest values (page, both dialogs, the outcome messages), two desks handing out one package, the dialogs' focus, Cancel after the row is gone (P5-05). Each test makes its own unit |
| `tests/header-panels.spec.ts` | Not a journey: the header's bell panel and account menu at 320–412 px stay inside the viewport and across the header, and from 640 px hang under their buttons; a tap below an open panel closes it (P4-08h). Maple's manager from `.auth/`, so no login of its own |

## Run

```bash
make e2e                       # the dev stack (make up) and the Vite dev server on :5173
make e2e E2E_STACK=prodlike    # the prod-like stack on :8080, as CI runs it (run `make down` first)
make e2e args="j3 --project=chromium"   # pass Playwright options
```

`make e2e` starts the stack, resets it (`make e2e-reset`), installs this package and Chromium, then runs the
`chromium` (Desktop Chrome) and `mobile` (Pixel 7) projects. With the dev stack, Playwright starts the Vite dev
server unless one already runs on :5173. If port 5432 is taken, add `DB_PORT=<free port>` as for every target.

`make e2e-reset` drops and recreates the stack's `public` schema, migrates and seeds. It refuses unless the
stack's API is running with `APP_ENV=dev`. It stops the API and worker while it works, because their pooled
connections cache the old schema's types.

Once the stack is up and reset, you can run the suite on its own from `e2e/`:

```bash
npx playwright test                          # the dev stack's defaults
# the prod-like stack: its compose file needs the image tag `make prodlike` started (this commit's SHA, plus
# "-dirty" if the tree had uncommitted changes then)
API_IMAGE_TAG=$(git rev-parse HEAD) E2E_BASE_URL=http://localhost:8080 E2E_COMPOSE_FILE=compose.prodlike.yml \
  E2E_API_SERVICE=api npx playwright test
```

| Variable | Default | What |
|---|---|---|
| `E2E_BASE_URL` | `http://localhost:5173` | The SPA's origin |
| `E2E_COMPOSE_FILE` | `docker-compose.yml` | The compose file `helpers/cli.ts` runs the CLI through (relative to the repo root) |
| `E2E_API_SERVICE` | `app` | Its API service: `app` on the dev stack, `api` on the prod-like one |
| `E2E_MAILPIT_URL` | `http://localhost:8025` | Mailpit's API (both stacks publish it there) |

A journey makes its own users and building, with random emails and slugs, so the two projects can run in
parallel and a retry needs no reset; one that uses seeded accounts gives each project its own (J4's units). The
shared seeded accounts (`PERSONAS` in `helpers/auth.ts`: Maple's and Birch's managers, Maple's security, the
residents of units 101, 102 and 304, and a pending member) log in once per run, in `tests/auth.setup.ts`, and their
cookies are reused from `.auth/`.

The rate limits keep their production values, and every request comes from one IP, so a run has a budget. The
reset empties the windows, which is why `make e2e` resets every time; before a retry, `helpers/test.ts` empties
them too, so a retried test gets the budget its first attempt had. Every spec imports `test` from there. Measured
in `rate_limits` after one run of both projects (re-measured in P5-05: J4 and the desk checks add only the five
new personas' logins; the desk's unit search has no limit):

| Limit | Per run | Allowed |
|---|---|---|
| Invitation lookups and accepts per IP | 14 (J1, J2) | 20 per 10 minutes |
| Signups per IP | 6 (J3 ×2, J7 reset ×1, per project) | 10 per hour |
| Logins per IP | 15 | 30 per 10 minutes |
| Logins per email | 4 for `resident5@example.test` (J7 Web Lock); 1 for each persona; 2 for each J7 reset account | 8 per 15 minutes |
| Join lookups, unit searches, join requests | 4 each | 20, 120 per 10 minutes; 10 per user per hour |
| Password-reset requests and confirms | 2 each | 30 per IP, 8 per email |

So run `make e2e` again rather than repeating `npx playwright test` on the same database, log a shared persona in
with `storageState`, not in each test, and count a new journey's signups and logins against this table.

## Debug

- `npx playwright test --ui`: watch mode, with each step's DOM, network and console.
- `npx playwright test --debug j1`: step through with the inspector.
- A failed test leaves a trace, a video and a screenshot in `test-results/`. Open the trace with
  `npx playwright show-trace test-results/<test>/trace.zip`, or the whole run with `npx playwright show-report`.
- In CI, a failed `E2E journeys` job uploads `playwright-report` (the HTML report, traces from the first
  retry, videos and screenshots). Download it from the run's summary and open it with `npx playwright show-report <dir>`.
- Mail the journeys read: http://localhost:8025. The stack's logs: `docker compose logs` (add
  `-f compose.prodlike.yml` for that stack).

## Write a journey

- Use locators by role, label or test id (`getByRole`, `getByLabel`, `getByTestId`) and web-first assertions
  (`await expect(locator).toBeVisible()`). They retry until the page catches up.
- Never sleep. `npm run lint` fails on `waitForTimeout(`, `setTimeout(` and `waitFor(<ms>)` under `tests/` and
  `helpers/`. To wait for something outside the page, use `expect.poll` (as `helpers/mailpit.ts` does). To
  control timing, hold a request with `page.route` until the test releases it (as the J7 Web Lock test does).
- Read links from the email (`waitForEmail(to, subject)`, then `extractLink(email, '/invite/')`), never from the
  database or the CLI's output. The email is what the user gets.
- Make the journey's own data (`uniqueEmail('label')`, a random slug). Find rows by that data, never by
  position: other journeys run at the same time.
- Import `test` and `expect` from `helpers/test.ts`, not `@playwright/test`. Open a second user's or device's
  context with its `newContext` fixture, not `browser.newContext`: that keeps the context's video when the test
  fails, as the `page` fixture's is kept, and closes it at the end.
- An API call made "as the SPA" goes through `apiPost` (the CSRF headers) on a context's `request`, which
  shares the context's cookies.
- Operator commands go through `runCli([...])` (`docker compose exec <api> python -m app.cli …`).

## Flaky tests

CI retries a failed test once (`retries: 1`); locally there are no retries. A test that passed only on its
retry is flaky: the run shows it as "flaky", not "passed".

- A test that is flaky **twice** gets the `@quarantine` tag in its title and a ticket to fix it within 48
  hours. `grepInvert` in `playwright.config.ts` keeps quarantined tests out of the required run. Nothing is
  quarantined today.
- Never raise the retries, add a sleep or widen a timeout to hide flakiness. Find the race: usually an
  assertion that doesn't wait, a shared row, or a request the test doesn't wait for.
- Before merging a new journey, run `make e2e` five times in a row (each run resets, so the rate-limit budget
  above holds; `--repeat-each` on one database would exceed it).
