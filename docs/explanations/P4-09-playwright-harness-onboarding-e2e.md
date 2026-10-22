# Explanation — P4-09 Playwright harness and onboarding E2E

> **PR:** #102 · **Source revision:** `c3bcf8b`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (3, Codex `gpt-6.1-sol`, high) reviewed `8b4736f`; the two
> commits after it are its Low finding's README fix (`429fb3e`) and a comment fix in `j3-onboarding.spec.ts`
> (`c3bcf8b`), neither reviewed.
> **Merge commit:** not known when written; after the merge, `gh pr view 102 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `c3bcf8b` the diff (`git diff --stat origin/main...HEAD`, 22 paths), all of
> `e2e/helpers/{test,cli,mailpit,auth}.ts`, `e2e/playwright.config.ts`, `e2e/scripts/check-no-sleeps.sh`, the
> four specs' assertions, the Makefile and `.github/workflows/ci.yml` diffs, the ticket's criteria and Frame notes,
> and the PR body (rounds 1–3); ran `make e2e E2E_STACK=prodlike` on a clean tree: `14 passed (11.6s)`,
> `real 1m4.356s`. The re-read found `decide()`'s comment wrong ("returns the manager's page"); fixed in `c3bcf8b`.
> Differences from the plan: see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: C.

## 1. What was built and why

`e2e/` is a Playwright suite that drives a real browser through the whole stack (SPA, API, worker, Mailpit,
Postgres) in four journeys: J1 bootstrap (CLI → invitation email → first manager), J2 staff invite, J3 resident
onboarding (approve and deny), and J7 password reset, plus the `condo.auth` Web Lock case P2-06c left unproven.
`make e2e` starts a stack, resets its database and runs both projects (desktop Chromium and a Pixel 7 viewport);
the new CI job `E2E journeys` does the same on the prod-like stack and is now a required check on `main`. The
decisions that matter most: one suite for two stacks (D2), rate limits left at production values with a
per-run budget and a retry-time reset (D4, round 1), and J2 inviting through the API because no invite screen
exists (D1, the one loosened step).

## 2. Decisions

### D1. J2 creates the invitation through the API, not a screen

- **Problem or constraint:** the ticket's J2 begins "the manager invites security", but the frontend has only
  the accept page (`frontend/src/app/routes.tsx::AppRoutes` has `/invite/:token` and no invitations page), and no
  ticket in the index builds one.
- **Chosen:** the journey opens the manager's saved session (`newContext({ storageState })`) and calls
  `invitations_create` through that context's `request` with the SPA's CSRF headers
  (`e2e/helpers/auth.ts::apiPost`); email, accept and home are UI.
- **Alternatives rejected:** building the screen here (out of scope, over the line budget); dropping J2 (loses
  invite → email → accept).
- **Tradeoffs and accepted limitations:** the manager's invite form is not exercised end to end (§7).
- **Basis:** autonomous; loosening recorded in the ticket's Frame notes and the inbox. **Source:** recorded (PR D1).

### D2. One suite, two stacks, chosen by `E2E_STACK`

- **Problem or constraint:** CI must run against the prod-like stack (`:8080`, compose service `api`); the
  ticket's default base URL is the Vite dev server (`:5173`, service `app`); "locally, either stack works".
- **Chosen:** `Makefile::E2E_STACK` (default `dev`) sets `E2E_COMPOSE_FILE`, `E2E_API_SERVICE` and
  `E2E_BASE_URL`, which `make e2e` passes to Playwright; the helpers read them. On the dev stack
  `e2e/playwright.config.ts::webServer` starts `npm run dev` unless something already serves :5173.
- **Alternatives rejected:** a prod-like-only suite (every local change needs an image and SPA build); two
  targets with duplicated recipes.
- **Tradeoffs and accepted limitations:** the dev stack needs `frontend/node_modules` on the host (`make e2e`
  installs them if missing).
- **Basis:** ticket; names autonomous. **Source:** recorded (PR D2).

### D3. `e2e-reset` stops the API and worker, then drops the schema

- **Problem or constraint:** the ticket asks to drop and recreate the schema; running API and worker connections
  keep asyncpg's per-connection type cache, whose enum OIDs a recreated schema changes.
- **Chosen:** refuse unless the API container's settings say `APP_ENV=dev`; stop API and worker; `DROP SCHEMA
  public CASCADE; CREATE SCHEMA public` in the db container's own `$POSTGRES_DB`; migrate and seed with
  `compose run --rm`; start them again with `--wait`.
- **Alternatives rejected:** `seed --reset` (TRUNCATE keeps the schema the ticket says to recreate); dropping
  under a running API (stale type caches).
- **Tradeoffs and accepted limitations:** about 15–20 s per reset. Inferred: the stale-cache failure was
  reasoned about, not reproduced; no run dropped the schema under a live API.
- **Basis:** ticket; mechanism autonomous. **Source:** recorded (PR D3).

### D4. Rate limits keep production values; a run has a measured budget

- **Problem or constraint:** every request comes from one IP, and P2-05's limits (signups 10 per IP per hour,
  invitations 20 per IP per 10 minutes, logins 8 per email per 15 minutes…) would refuse a suite that repeats
  itself.
- **Chosen:** shared personas log in once per run (`e2e/tests/auth.setup.ts`, saved `storageState`); journeys
  make their own users; the reset empties the windows; the Web Lock test uses a seeded resident no other
  journey uses, so a run makes 6 signups, not 8. Review round 1 (F2) added `e2e/helpers/test.ts::test`'s
  `freshRateLimitsOnRetry`: before a retry it empties `rate_limits`, so a retried test gets its first attempt's
  budget. `e2e/README.md` holds the budget table, measured from `rate_limits` after one run.
- **Alternatives rejected:** raising `RATE_LIMIT_*` for the e2e environment (the prod-like stack stops being
  prod-like and the limits go unexercised).
- **Tradeoffs and accepted limitations:** repeating `npx playwright test` on one database without a reset
  exceeds the signup budget; the README says to use `make e2e`, which always resets.
- **Basis:** ticket (P2-05 carry offered both options); review round 1 F2. **Source:** recorded (PR D4, round 1).

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Mobile project = `devices['Pixel 7']` (Chromium), every journey | a subset on mobile | journeys are the critical paths; both fit the 5-minute budget | ticket, default | PR table |
| `@quarantine` → `grepInvert` | a non-blocking job | `continue-on-error` loosens a gate | ticket | PR table |
| No-sleep rule as a script (`npm run lint`) | `eslint-plugin-playwright` | a lint toolchain and two dependencies for one rule | autonomous | PR table |
| `trace: 'retain-on-failure'` everywhere | `on-first-retry` in CI | the first attempt's trace was lost when it and the retry failed differently | review round 1 F3 | PR round 1 |
| `newContext` fixture for every extra context | `browser.newContext` | its pages record no video | review round 2 R2-2 | PR round 2 |
| `E2E journeys` required before the merge, not with it | after the merge (P1-08's order) | the probe run (E2E red, the rest green) would have been mergeable | review rounds 1–2 (F1, R2-1) | PR rounds 1–2 |

**Framing changes:** criteria 1–5 sharpened (what "clean" includes, the job name and probe, the exact 404
request, what "redirected" means, the lint), 6–13 added (single-use invite link, P2-06c account-menu keys and
Web Lock journey, J3 notification and deny, links only from Mailpit, isolation and rate limits, artifacts, the
reset's guard); 12 tightened in round 1 to "every failed attempt". Loosened: J2's invite step (D1).

**Plan versus final code:** the Plan's file list holds, plus `e2e/helpers/test.ts` (rounds 1–2) and
`e2e/scripts/check-no-sleeps.sh`. Differences: CI traces are `retain-on-failure`, not trace-on-first-retry (F3);
the Plan's `auth.ts` "apiGet" doesn't exist (journeys call `request.get` directly, GET needs no CSRF headers);
the Web Lock test uses a seeded resident instead of a signup (D4); the required check was added before the
merge, not with it (R2-1).

## 3. How it is implemented

### Overview

- **`Makefile::e2e`** starts the chosen stack, runs **`Makefile::e2e-reset`**, installs `e2e/` and Chromium,
  and runs Playwright with the stack's variables.
- **`e2e/playwright.config.ts`**: projects `setup` → `chromium`, `mobile`; CI retries once; artifacts per
  failed attempt.
- **`e2e/helpers/test.ts::test`**: the `test` every spec imports, with the retry reset and the `newContext`
  fixture.
- **Helpers**: `mailpit.ts` (wait for and read the email), `cli.ts` (operator commands in the API container,
  and the rate-limit reset), `auth.ts` (CSRF headers, API login and signup, personas, unique emails).
- **CI**: `.github/workflows/ci.yml::e2e:` runs the typecheck and the no-sleep lint, then
  `make e2e E2E_STACK=prodlike`, and uploads the report and `test-results` on failure.

### Walkthrough (variant C: one `make e2e E2E_STACK=prodlike` run, as in CI)

1. **Trigger:** a push to a PR runs `E2E journeys`; locally, `make e2e E2E_STACK=prodlike`.
2. **Stack:** `make prodlike` builds `condo-api:<sha>` and the SPA, migrates, and starts api, worker, db,
   mailpit, s3 and caddy (`compose.prodlike.yml`).
3. **Reset (`Makefile::e2e-reset`):** checks `APP_ENV` inside `api`; stops `api` and `worker`; drops and
   recreates `public`; `alembic upgrade head` from base; `python -m app.cli seed`; `up -d --wait api worker`.
4. **Install:** `npm ci` in `e2e/`; `npx playwright install --with-deps chromium` when `CI` is set.
5. **Run:** `setup` logs Maple's and Birch's managers in through `/api/auth/login` and saves their cookies to
   `e2e/.auth/`. The 12 journey tests then run in parallel (2 workers in CI, 4 locally). Each journey makes
   its own data, waits for its own emails in Mailpit and follows their links.
6. **Retry:** in CI a failed test runs once more; `freshRateLimitsOnRetry` first runs `DELETE FROM rate_limits`
   in the db container.
7. **Result:** green, or a red job with `playwright-report` uploaded (HTML report, traces, videos, screenshots)
   and the stack's last 200 log lines in the job log. Re-run: push again, or `make e2e` locally; the reset makes
   every run start from the seed.

### Data model changes

None.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `e2e/helpers/test.ts` | the journeys' `test`: retry reset, `newContext` fixture | +49 |
| `e2e/helpers/cli.ts` | `runCli`, `resetRateLimits` | +41 |
| `e2e/helpers/mailpit.ts` | `waitForEmail`, `extractLink` | +55 |
| `e2e/helpers/auth.ts` | personas, `apiPost`, `apiLogin`, `apiSignup`, `buildingId`, `uniqueEmail` | +66 |
| `e2e/playwright.config.ts` | projects, retries, artifacts, `webServer` | +44 |
| `e2e/tests/*.ts` | setup and the four journeys | +312 |
| `e2e/scripts/check-no-sleeps.sh` | criterion 5 | +18 |
| `e2e/{package.json,package-lock.json,tsconfig.json}` | the suite's package | +127 |
| `e2e/README.md` | run, debug, budget, write a journey, flaky policy | +111 |
| `Makefile` | `E2E_STACK`, `e2e-reset`, `e2e` (replaces the stub) | +40 / −6 |
| `.github/workflows/ci.yml` | job `e2e:` (`E2E journeys`) | +50 |
| `.github/dependabot.yml`, `.gitignore`, `CLAUDE.md` | `/e2e` updates; ignore `.auth/` and outputs; command notes | +19 / −2 |
| `docs/tickets/…P4-09…md`, `docs/tickets/README.md` | frame; status | +74 / −12 |

**Key excerpts**

`Makefile::e2e-reset`

```make
# The API and worker are stopped first: their pooled connections cache the old schema's type OIDs.
e2e-reset: ## Drop and recreate the e2e stack's schema, migrate and seed; refused unless its API has APP_ENV=dev
	@$(E2E_COMPOSE) exec -T $(E2E_API_SERVICE) python -c \
	  "import sys; from app.core.config import settings; sys.exit(settings.app_env != 'dev')" || { \
	  echo "e2e-reset: refused: the $(E2E_STACK) stack's API must be running, with APP_ENV=dev"; exit 1; }
	$(E2E_COMPOSE) stop $(E2E_API_SERVICE) worker
	$(E2E_COMPOSE) exec -T db sh -c \
	  'psql -q -v ON_ERROR_STOP=1 -U postgres -d "$$POSTGRES_DB" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"'
	$(E2E_COMPOSE) run --rm --no-deps $(E2E_API_SERVICE) alembic upgrade head
	$(E2E_COMPOSE) run --rm --no-deps $(E2E_API_SERVICE) python -m app.cli seed
	$(E2E_COMPOSE) up -d --wait $(E2E_API_SERVICE) worker
```

- Asks the running API what environment it is, then rebuilds the database from nothing (D3).
- The guard reads the application's own settings, not a Makefile variable, so the refusal reflects the stack
  that would lose its data. `$$POSTGRES_DB` is each db container's own name (`condo_dev` or `condo`).
- Without the guard, a misconfigured stack's data would be dropped; without the `stop`, live connections
  would keep cached types of a schema that no longer exists (inferred, D3).

`e2e/helpers/test.ts::test`

```ts
export const test = base.extend<{
  freshRateLimitsOnRetry: void;
  newContext: NewContext;
}>({
  freshRateLimitsOnRetry: [
    async ({}, use, testInfo) => {
      if (testInfo.retry > 0) await resetRateLimits();
      await use();
    },
    { auto: true },
  ],
  newContext: async ({ browser }, use, testInfo) => {
    const contexts: BrowserContext[] = [];
    const pages: Page[] = [];
    await use(async (options = {}) => {
      const context = await browser.newContext({ ...options, recordVideo: { dir: testInfo.outputPath('videos') } });
      context.on('page', (page) => pages.push(page));
      contexts.push(context);
      return context;
    });
    // A video is complete once its context is closed; closing one twice is harmless.
    await Promise.all(contexts.map((context) => context.close()));
    const failed = testInfo.status !== testInfo.expectedStatus;
    for (const [index, page] of pages.entries()) {
      const video = page.video();
      if (!video) continue;
      if (failed) await testInfo.attach(`video-context-page-${index + 1}`, { path: await video.path(), contentType: 'video/webm' });
      else await video.delete();
    }
  },
});
```

- Every spec imports this `test`. The auto fixture runs for every test; it only acts on a retry (round 1 F2).
- `newContext` is how a journey opens a second user or device. Playwright's `browser.newContext` inherits the
  project's device settings but records no video, so this fixture records it and keeps it only on failure,
  matching `video: 'retain-on-failure'` (round 2 R2-2).
- Remove the auto fixture and a CI retry of J1 can be refused 429 on the invitation accept (the round-1 probe:
  the mobile retry failed at `toHaveURL`). Remove `recordVideo` and failures of J3's manager page, J7's other
  device and both Web Lock pages have no video.

`e2e/helpers/mailpit.ts::waitForEmail`

```ts
export async function waitForEmail(to: string, subjectIncludes: string, timeout = 30_000): Promise<Email> {
  const api = await request.newContext({ baseURL: MAILPIT_URL });
  try {
    let id: string | undefined;
    await expect
      .poll(
        async () => {
          const response = await api.get('/api/v1/search', { params: { query: `to:"${to}"` } });
          expect(response.ok()).toBe(true);
          const { messages } = (await response.json()) as SearchResult;
          // Newest first; `to:` matches substrings, so the address is compared exactly.
          id = messages.find(
            (m) => m.To.some((r) => r.Address.toLowerCase() === to.toLowerCase()) && m.Subject.includes(subjectIncludes),
          )?.ID;
          return id;
        },
        { message: `email to ${to} with subject "${subjectIncludes}"`, timeout },
      )
      .toBeTruthy();
    // ...
```

- Polls Mailpit's search API until the worker has delivered the email, then fetches its text part.
- `expect.poll` retries with growing intervals up to a deadline, so there is no fixed sleep (criterion 5).
  The exact address comparison matters because `to:` matches substrings and journeys run in parallel.
- `extractLink` then returns the first URL whose path starts with the given prefix, as path and query only.

`e2e/tests/j7-password-reset.spec.ts` (the Web Lock test, trimmed)

```ts
  await pageA.route('**/api/auth/logout', async (route) => {
    held();
    await released;
    await route.continue();
  });
  await pageA.getByRole('button', { name: /Account menu/ }).click();
  await pageA.getByRole('button', { name: 'Log out' }).click();
  await logoutHeld;

  await pageB.getByLabel('Email').fill(WEB_LOCK_USER);
  await pageB.getByLabel('Password').fill(SEED_PASSWORD);
  await pageB.getByRole('button', { name: 'Sign in' }).click();
  // B's login queues behind A's logout, which holds the lock.
  await expect
    .poll(() => pageB.evaluate(async () => (await navigator.locks.query()).pending?.map((lock) => lock.name)))
    .toContain('condo.auth');
  release();

  await expect(pageB.getByRole('heading', { name: 'Home' })).toBeVisible();
  // The login went out only after the logout answered, so the logout's cleared cookie can't undo it.
  expect(order).toEqual(['request /api/auth/logout', 'response /api/auth/logout', 'request /api/auth/login']);
```

- Holds page A's logout at the network, makes B log in, waits until the browser itself reports B's request for
  `condo.auth` as pending, releases the logout, then checks the network order and that B stays signed in.
- This is what P2-06c could only test with a fake lock manager. The test controls timing by holding a request,
  not by sleeping.
- With `frontend/src/app/authQueue.ts::runAuthCall`'s lock removed, the poll fails (`Received array: []`). With
  the poll also removed, the order assertion fails (`request logout, request login, response logout`). Both
  mutation runs are in the PR.

`.github/workflows/ci.yml::e2e:` (trimmed)

```yaml
      - name: Suite typecheck and lint
        working-directory: e2e
        run: |
          npm ci --no-audit --no-fund
          npm run typecheck
          npm run lint

      - name: Build the prod-like stack and run the journeys
        run: make e2e E2E_STACK=prodlike

      - name: Upload Playwright report and traces
        if: failure()
        uses: actions/upload-artifact@v7
        with:
          name: playwright-report
          path: |
            e2e/playwright-report
            e2e/test-results
```

- The suite's types and the no-sleep rule fail fast; then the same `make e2e` as locally; artifacts only when
  something failed.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Another building's manager reads Maple's members | 404, not 403; Birch's list lacks the resident | `j3-onboarding.spec.ts` › `J3: a resident joins with the link…` |
| A used invitation link is opened again | invalid-link screen | `j1-bootstrap.spec.ts` › `J1: an operator bootstraps…` |
| A reset leaves another device signed in | the other device ends on `/login`, `/api/auth/me` 401 | `j7-password-reset.spec.ts` › `J7: a password reset by email…` (mutation without `revoke_all_sessions`: fails) |
| Logout in one page undoes a login in another | the lock orders them; the login wins | `J7 Web Lock: …` (two mutations, §4) |
| A retried test is rate-limited | `rate_limits` emptied before the retry | no permanent test; the round-1 probe (forced J1 first-attempt failures): `2 flaky, 12 passed`, and with the fixture disabled the mobile retry fails |
| A failure leaves no trace or video | every failed attempt keeps them, extra contexts too | no permanent test; CI probe run 39708997457 (traces for first attempt and retry) and the round-2 video probe |
| A hard sleep enters a journey | `npm run lint` fails, also spaced or across lines | no permanent test; probes in rounds 1–2 (`exit=1`) |
| The reset runs on a non-dev stack | refused before anything is stopped | no permanent test; manual: API stopped → refused; the predicate under `APP_ENV=test` → exit 1 |
| Parallel journeys pick each other's rows | rows found by the journey's own name or email | structural; five consecutive runs green |

Acceptance criteria → evidence: 1 `make e2e` from a clean `e2e/`: `14 passed`, 30 s (dev) / 1 m 13 s
(prod-like); 2 CI job, probe run 39708997457, branch protection (R2-1); 3–4, 6–9 the specs above; 5 the lint
and its probes; 10 every link via `extractLink(await waitForEmail(…))`; 11 unique data, `auth.setup.ts`, the
budget table, five runs; 12 config + probe artifacts; 13 manual refusals and runs on both stacks.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol` (high) | `5257915` | BLOCK | F1 High: E2E not required; F2 Medium: retries exceed the invitation limit; F3 Medium: first attempt's trace lost; F4 Low: `waitForTimeout (500)` passes the lint | F2–F4 fixed in `747f542`; F1 deferred to the merge, reopened in round 2 |
| 2 | Codex `gpt-6.1-sol` (high), new run | `34c471d` | BLOCK | R2-1 High: F1 still open; R2-2 Medium: extra contexts record no video; R2-3 Low: a sleep across lines passes the lint | R2-1 fixed in branch protection; R2-2 and R2-3 in `8b4736f` |
| 3 | Codex `gpt-6.1-sol` (high), new run | `8b4736f` | MERGE | R3-1 Low: the README's standalone prod-like command lacks `API_IMAGE_TAG` | fixed in `429fb3e` (not reviewed); the command was run on the prod-like stack: `14 passed` |

James chose the reviewer for this run: Codex `gpt-6.1-sol` at high effort only, no Claude reviewer.

- **F2:** Codex failed each J1 first attempt after it passed, with `CI=1`. The mobile retry's
  `POST /api/invitations/…/accept` got 429 (14 invitation calls per run, 22 needed with both retries, limit 20).
  The fix is the retry reset (D4). Evidence: the same probe went from 1 failed to `2 flaky, 12 passed`, and
  failed again with the fixture disabled.
- **F3:** with `on-first-retry`, only the retry's trace (in its `-retry1` folder) existed. Evidence: CI probe run 39708997457 uploaded
  traces for `…-chromium/`, `…-chromium-retry1/`, `…-mobile/` and `…-mobile-retry1/`.
- **R2-1:** the selector probe run had E2E red and the other four green, which protection would have allowed.
  `E2E journeys` was added to `main`'s required checks (strict kept). Codex's proof then passed.
- **R2-2:** `page.video()` was `null` for `browser.newContext` pages. Fix: the `newContext` fixture.
  Evidence: a forced failure attached `video-context-page-1` and `-2`; a passing run left no `.webm`.

## 7. Not verified, accepted risks and follow-ups

- **J2's invite form is not under test** (D1). Follow-up: a manager invitation screen ticket, added to the
  index in this PR's bookkeeping; when it lands, J2's invite step moves to the UI.
- **Emailed links' origin is not asserted.** `extractLink` keeps path and query, so a wrong `APP_BASE_URL` in
  the email would go unnoticed. Tracked only here.
- **Chromium only.** No Firefox or WebKit project; the mobile project is Chromium with a Pixel 7 viewport.
- **The retry reset, the artifact settings, the no-sleep lint and the reset guard have no permanent tests.**
  They were shown by probes recorded in the PR; a regression in them would show only as a missing artifact, a
  429 on a retry, or a sleep getting through.
- **`check-no-sleeps.sh` is a text scanner.** A sleep through a computed property (`page['waitForTimeout']`)
  passes it; `setTimeout(` in a comment fails it (stricter, accepted).
- **The stale type cache that D3 avoids was not reproduced.** The `stop` before the drop is reasoned, not
  proven necessary.
- **Local runs used Node 22** (CI uses the pinned 24.16.0; `npm` warns `EBADENGINE`).
- **The rate-limit budget** in `e2e/README.md` must be re-measured when a journey is added; nothing checks it.
- **Unreviewed commits:** `429fb3e` (README command) and `c3bcf8b` (a comment), both after round 3's MERGE.

## 8. How to change this safely

- **A new journey:** a spec in `e2e/tests/`, importing `test` and `expect` from `e2e/helpers/test.ts`. Make its
  own data with `uniqueEmail`, open second users with `newContext`, read links through `waitForEmail` and
  `extractLink`. Count its signups, logins and invitation calls against the README's budget table (re-measure
  with a query on `rate_limits` after a reset and one run). Run `make e2e` five times.
- **A new rate limit:** check the budget the same way.
- **Another stack:** add an `E2E_STACK` branch to the Makefile with its compose file, API service and base URL.
- `npm run lint`, `npm run typecheck` and CI's `E2E journeys` will catch sleeps, type errors and broken journeys.

## 9. Must explain, then quiz

**1. Why read the invitation link from Mailpit rather than from the database?** The email is what the user
actually gets. Reading it proves the whole path: the request queued a job, the worker rendered the template and
sent it over SMTP, and the link carries the right path and a working token. The database can't give that
proof, and for password resets it doesn't even hold the token: the `password_reset_tokens` migration stores only
its sha256. `e2e/helpers/mailpit.ts::waitForEmail` is the only source of links in the suite (criterion 10).

**2. What makes an E2E test flaky, and which Playwright features prevent it?** Timing (asserting before the page
or the worker caught up), shared state (two tests touching one row or account), and order dependence. Here:
locators by role and label (`getByRole`, `getByLabel`) that re-resolve on every attempt; actions that
auto-wait for the element to be visible and enabled; web-first assertions (`await expect(locator).toBeVisible()`)
that retry until a timeout; `expect.poll` for things outside the page (Mailpit, the browser's lock queue); and
`page.route` to hold a request instead of guessing a delay (the Web Lock test). Per-test data and the retry
reset remove the shared-state causes; the no-sleep lint keeps fixed delays out.

**3. Why keep E2E to a few critical journeys instead of testing everything this way?** Each journey costs
seconds and a whole stack (about 2 minutes of CI time for 14 tests), can fail for reasons far from the code
under test, and shares one IP's rate limits. The backend (2,123 tests) and frontend (713) suites cover rules and
components faster and point at the broken line. E2E covers what only the full stack can show: the pieces working
together on the paths that, if broken, stop a building from onboarding at all.

**Quiz**

1. Why does the Web Lock test open page B on `/login` before the session exists?
2. J3 runs on two projects at once, and both requests appear in Maple's pending list. How does each journey
   approve its own?
3. A CI retry of J3 starts after its first attempt made a signup. Which code keeps it from being refused?
4. What would break if `Makefile::e2e-reset` no longer stopped the API before dropping the schema?
5. How would you extend the suite to Firefox?

<details><summary>Answers</summary>

1. A signed-in visit to `/login` redirects away (`LoginPage` navigates to `next` when a session exists), so
   B would never show the form.
2. `decide()` clicks the button whose accessible name is `Approve <fullName>`, and each journey's name has a
   random suffix (`newName`).
3. `e2e/helpers/test.ts::test`'s `freshRateLimitsOnRetry`: on `testInfo.retry > 0` it runs `resetRateLimits()`,
   which empties `rate_limits` before the test body.
4. The API and worker would keep pooled connections with asyncpg type caches for enum OIDs that no longer
   exist. Inferred (D3): requests or job claims would fail after the reset until the connections were replaced.
   Not reproduced.
5. Add a project with `devices['Desktop Firefox']`, install it in `Makefile::e2e` (`playwright install
   firefox`), and re-measure the rate-limit budget: a third project adds a third of a run's signups (6 → 9 of
   10), so the signup budget would need the Web Lock trick for J3 or J7 too, or per-project resets.

</details>
