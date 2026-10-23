# Explanation — P5-05 Packages E2E and reference-slice gate

> **PR:** #121 · **Source revision:** `320ff23` (pre-merge PR head this explanation was written from and checked
> against). **Reviewed:** the final review round (3) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 121 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: once merged, write a new explanation for later changes and do not update this one.
> **Reality check:** re-read at `320ff23` the diff (`git diff origin/main...HEAD`, 13 paths), in full
> `e2e/tests/j4-packages.spec.ts`, `e2e/tests/packages-desk.spec.ts`, `e2e/helpers/packages.ts`, the
> `auth.ts`/`mailpit.ts` hunks, `frontend/src/test/buildingDenial.test.ts` (inspector and every test), the new
> `packageActions.test.tsx` case, both backend test hunks, `docs/SLICE_RECIPE.md`, the recap command hunk, and the
> PR body (plan, decisions, three review rounds). Ran: `make test DB_PORT=55432 PYTEST_ADDOPTS="-q tests/packages"`
> → `298 passed`; `vitest` on `buildingDenial.test.ts` + `packageActions.test.tsx` → `75 passed`; `j4` +
> `packages-desk` on the prod-like stack (image `8fdb1c2`; `git diff 8fdb1c2 320ff23` touches no app code) →
> `13 passed`. Full-suite numbers below come from the PR's runs, cited with their commits. Differences from the
> plan: see §2.
> **Updated** (pre-merge, bookkeeping commit): §2 and §7 add the ticket's "Carried from P5-04" section, which framing
> missed (no code changed; the rows below name where each item went).
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 1. Walkthrough variant: C (one J4 run through the stack).

## 1. What was built and why

The packages slice (P5-01 to P5-04) gets the browser journey that proves it end to end, J4: the desk logs a package
with a photo, the resident sees the badge, the bell and the email, opens the package from the link, the desk hands it
out, and everyone else who asks gets 401, 403 or 404 with the right problem code. A second spec checks in Chromium
what P5-03d checked only by hand: layout at 375 and 768 px with the API's longest values, two desks racing one
package, dialog focus. `docs/SLICE_RECIPE.md` writes the slice up as a checklist for P6, and a fresh agent planned P6-03
from it alone. The carried follow-ups land as tests: a parser-based fitness test that passive building readers read the
denial, the backend tests' timestamps from the database clock, a building switch during a return, and two new steps in
the recap command. No application code changed. The decision that shaped J4 most: each Playwright project uses its own
unit (D1), because both run at once against one seeded building.

## 2. Decisions

### D1. Each Playwright project runs J4 on its own unit and resident

- **Problem or constraint:** `chromium` and `mobile` run J4 at the same time on one seeded Maple. The resident's badge
  counts every waiting package they may see, so two runs on unit 101 would move each other's count, and both emails
  would go to one address with one subject.
- **Chosen:** `chromium` uses unit 101 / `resident1` (the ticket's unit), `mobile` unit 304 / `resident4`
  (`e2e/tests/j4-packages.spec.ts::UNITS`). The badge is read from the API before logging and must read exactly one
  more, then fall back. Emails are found by this run's unique carrier (`e2e/helpers/packages.ts::uniqueCarrier`,
  `e2e/helpers/mailpit.ts::waitForEmail`'s `textIncludes`). The desk checks create their own units.
- **Alternatives rejected:** a fresh building per run through `bootstrap-building` (J1's way) — needs units, a desk
  account and an onboarded resident, spending invitation and signup budget near its limit; a fresh resident onboarded
  into 101 — still sees the other project's unit-101 package; asserting only "a badge shows" — seeded packages already
  show one.
- **Tradeoffs and accepted limitations:** `mobile` exercises unit 304, not 101; a third run on the same database at
  once can still move the counts.
- **Basis:** autonomous, following `e2e/README.md` (journeys isolate themselves so projects can run in parallel).
- **Source:** recorded (PR decision D1; ticket Frame notes).

### D2. The denial fitness test reads source with the TypeScript parser and follows hooks to a fixed point

- **Problem or constraint:** the P3-05 follow-up (carried since P3-05): a component that reads the building passively
  shows cached data after a refetch fails, so once the building is denied it must read `useBuildingDenied()`. As first
  worded the rule failed on `frontend/src/app/AccountMenu.tsx::BuildingChoices`.
- **Chosen:** `frontend/src/test/buildingDenial.test.ts::inspect` lists, per function, the hooks it calls, each
  resolved to `<module>::<name>` through the file's imports; `::unguarded` marks as "aware" every hook that calls the
  denial or an aware hook, until nothing changes, then reports passive readers that call no aware hook. So
  `BuildingChoices` passes through `frontend/src/app/MainNav.tsx::useCanViewAs`, with no exemption. Two components are exempt in
  `::EXEMPT`, with reasons: they render only under `frontend/src/app/guards.tsx::BuildingLoaded`, which shows the
  denial screen instead of its children.
- **Alternatives rejected:** a regex (the CLAUDE.md lesson: aliases and multi-line calls escape it); exempting
  `BuildingChoices` (the hook already reads the denial, so an exemption would hide nothing).
- **Tradeoffs and accepted limitations:** it proves the denial is *read* in the function, not that it gates the render
  (probe: removing `BuildingNav`'s direct read stayed green, since it also reads it through `useCanViewAs`). Names are
  not resolved by lexical scope (the open round-3 finding, §7).
- **Basis:** ticket criterion 11; existing convention `frontend/src/test/queryFreshness.test.ts`; review rounds 1–2.
- **Source:** recorded (PR evidence row 11, review log).

### D3. Criterion 3's worker restart follows ADR-0006: every email arrives, not each exactly once

- **Problem or constraint:** the Frame notes first said "each email arrives once". The crash run showed one email sent
  twice: the job running at SIGKILL kept its 60 s lease (`backend/app/jobs/worker.py::LEASE`), was reclaimed, and
  ran again.
- **Chosen:** the criterion requires every queued email to arrive and every job to end `succeeded`, for both a crash
  and a graceful stop; "once each" for the graceful stop only.
- **Alternatives rejected:** none considered: [ADR-0006](../adr/0006-postgres-job-queue.md) says "Delivery is
  at-least-once… Docs never promise exactly-once email", so the first wording contradicted an accepted ADR.
- **Basis:** ADR-0006; the stack transcript.
- **Source:** recorded (ticket Frame notes, commit `54e94dc`; PR criterion 3 evidence). Also an inbox line.

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Seeded desk and resident accounts log in once in `e2e/tests/auth.setup.ts` | log in per test | the per-IP and per-email login limits; the run now uses 15 of 30 per IP | convention | PR, README |
| The recap is its own docs PR in step 8 | include it here | the gate needs every P5 ticket `done`, true only after this merge; P4's was PR #113 | playbook | PR, Frame notes |
| P5-03d D2 (occupants load above "Someone else") stays an accepted Low | reserve the space | a UI change; the ticket says no new features | ticket | PR |
| The photo is a base64 constant (`e2e/helpers/packages.ts::PHOTO_PNG`) | a binary fixture file | no binary in the repo | autonomous | PR deviations |
| Privacy checks assert the problem `code`, not only the status (`::expectProblem`) | status only | an unknown route also answers 404 (`not_found`), and CSRF 403s (`csrf_failed`) | review round 1, L1 | PR review log |
| The slice gate accepts the multi-role union on `/packages` (the P5-04 carry): a resident who is also desk staff sees the building's packages there | narrow it with a `mine` filter | a product change outside the ticket; `visible_packages` documents the union | autonomous | inbox, ticket |
| The emulator's lax expiry is recorded, not fixed | turn on LocalStack signature checks | a compose change outside the ticket; D-06 checks real S3 | autonomous | PR follow-ups |

**Framing changes:** criteria 6–13 added (each J4 step as an assertion; 10-case rows 2–6 through the browser and
API; the four carried follow-ups; the recap command). Criteria 1–5 sharpened (both stacks, both projects; criterion 3
with a crash and a graceful stop; criterion 4 in a fresh subagent; criterion 5 deferred to step 8). Nothing loosened;
criterion 3's own added wording was corrected to the ADR (D3).

**Plan versus final code:** deliberate deviations, listed in the PR below the Plan: no PNG fixture file (D table);
`apiPost` takes extra headers (the API requires `Idempotency-Key`, found when the first desk-check run got 400);
`waitForEmail`'s third argument is an options object; the desk checks use only their own units (the Frame notes first
named 503 too, fixed in round 2); the recipe got a second commit after the criterion-4 check. Review rounds added the
problem-code assertions and rebuilt the fitness test's resolver (§6).

## 3. How it is implemented

### Overview

- `e2e/tests/j4-packages.spec.ts`: the journey, two browser contexts (desk, resident) plus API-only contexts for the
  privacy rows.
- `e2e/tests/packages-desk.spec.ts`: short-lived API contexts (the manager creates a unit, the desk logs packages with
  the longest values), then one or two desk pages (security, and the manager as the second desk) measured and driven
  in the browser.
- `e2e/helpers/packages.ts`, `auth.ts`, `mailpit.ts`: API helpers, the personas, a body-text match for Mailpit.
- `frontend/src/test/buildingDenial.test.ts`: a vitest fitness test over every non-test file in `src/app` and
  `src/features`.
- Docs: `docs/SLICE_RECIPE.md`, `.claude/commands/milestone-recap.md`, `e2e/README.md`.

### Walkthrough (variant C): one J4 run, `make e2e E2E_STACK=prodlike`

1. **Trigger.** `make e2e` builds the image and SPA, starts the prod-like stack behind Caddy on :8080, resets and
   seeds it (`make e2e-reset`), then runs Playwright. CI's `E2E journeys` job runs the same target.
2. **Setup.** `auth.setup.ts` logs each `PERSONAS` entry in once and saves its cookies under `e2e/.auth/`
   (gitignored). J4 opens the resident's context from that file and reads `GET …/packages/summary` for the count.
3. **The desk logs it.** In the desk's page, J4 picks the unit in the Log package panel, types an `E2E <8 hex>` carrier
   under "Other", and uploads `PHOTO_PNG` through the real file chooser: the SPA asks the files API for a presigned POST
   and sends the bytes to the S3 emulator. J4 waits for "Remove photo" (upload done), then captures the `POST
   …/packages` response to learn the id and `photo_file_id`.
4. **What the API wrote** (P5-02a, unchanged): the package, the claimed file, a `notifications` row and an `email.send`
   job per recipient, one commit. The worker later renders `package_arrived` and sends it to Mailpit.
5. **The resident.** After a reload the nav link's accessible name reads `My packages, <n+1> waiting`, the card is in
   "Waiting for you", and the bell lists `<carrier> delivered a package for unit 101.`. Clicking it navigates to
   `/packages/<id>`; the dialog's `<img>` must load (`naturalWidth` 16) from a URL whose `X-Amz-Expires` is 60
   (`backend/app/files/service.py::DOWNLOAD_EXPIRES`).
6. **The email.** `waitForEmail` polls Mailpit's search for `to:"resident1@…" "<carrier>"` and asserts the text holds
   `<origin>/packages/<id>`; J4 then opens that link.
7. **Pickup and history.** The desk hands it to the resident in the dialog; the desk message names them, the row goes;
   the resident's badge falls back, the card leaves "Waiting for you" and appears in "Package history" as picked up.
8. **Privacy.** `privacy()` asks as signed out, as `resident2` (unit 102), as the pending member and as Birch's manager,
   by API, plus `resident2`'s browser at `/packages/<id>` ("Package not found", no image).
9. **Where it fails.** Each `expect` names its step; a failure keeps a trace, video and screenshot under
   `e2e/test-results/` (CI uploads `playwright-report`). A 429 at setup means the rate-limit windows are spent: run
   `make e2e` again (it resets).

### Data model changes

None.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `e2e/tests/j4-packages.spec.ts` | new: J4 | +163 |
| `e2e/tests/packages-desk.spec.ts` | new: layout, race, focus checks | +184 |
| `e2e/helpers/packages.ts` | new: photo, carrier, unit/package/summary API helpers | +56 |
| `e2e/helpers/auth.ts` | five personas; `apiPost` extra headers | +15 −3 |
| `e2e/helpers/mailpit.ts` | `textIncludes` option | +11 −3 |
| `frontend/src/test/buildingDenial.test.ts` | new: fitness test | +369 |
| `frontend/src/features/packages/packageActions.test.tsx` | the return building-switch test | +31 |
| `backend/tests/packages/test_api.py` | `_AFTER_RECEIVED` from the database clock | +16 −5 |
| `backend/tests/packages/test_desk_fields.py` | `returned_at=func.now()` | +3 −3 |
| `docs/SLICE_RECIPE.md` | new: the recipe | +144 |
| `.claude/commands/milestone-recap.md` | run the demo; facts from their source | +10 −5 |
| `e2e/README.md` | specs, personas, re-measured budget | +10 −6 |
| `docs/tickets/P5-05-packages-e2e-and-slice-gate.md` | frame, criteria 6–13 | +70 −3 |

(13 paths, 1082 insertions and 28 deletions; from `git diff --numstat origin/main...HEAD`.)

**Key excerpts**

`e2e/tests/j4-packages.spec.ts::privacy` (trimmed)

```ts
async function privacy(newContext: NewContext, maple: string, pkg: PackageOut) {
  const photoUrl = `/api/buildings/${maple}/files/${pkg.photo_file_id}/download-url`;

  const anonymous = await newContext();
  await expectProblem(await anonymous.request.get(packagesPath(maple, `/${pkg.id}`)), 401, 'not_authenticated');

  // resident2 lives in unit 102: same building, someone else's package.
  const neighbour = await newContext({ storageState: storageStatePath('resident102') });
  await expectProblem(await neighbour.request.get(packagesPath(maple, `/${pkg.id}`)), 404, 'package_not_found');
  await expectProblem(await neighbour.request.get(photoUrl), 404, 'file_not_found');
  // ...
  const birch = await newContext({ storageState: storageStatePath('birchManager') });
  const birchId = await buildingId(birch.request, 'birch');
  await expectProblem(await birch.request.get(packagesPath(maple, `/${pkg.id}`)), 404, 'building_not_found');
  // ...
  // Maple's ids under Birch's own path are no better.
  await expectProblem(await birch.request.get(packagesPath(birchId, `/${pkg.id}`)), 404, 'package_not_found');
  // ...
}
```

- Asks for the package and its photo as each identity that must not see them. The codes tell which guard answered:
  `building_not_found` is the tenant context (non-member or pending), `package_not_found`/`file_not_found` the
  visibility query and the photo hook.
- Without the codes, a mistyped path passes (probe: `/download-urls` → `Received: "not_found"`), and the row-4 403
  passes on a CSRF failure (probe → `Received: "csrf_failed"`).
- Removing `visible_packages`'s resident filter fails it (probe → `Expected: 404 Received: 200`).

`e2e/tests/packages-desk.spec.ts::expectFits`

```ts
async function expectFits(page: Page, target: Locator, what: string) {
  await expect(target).toBeVisible();
  const box = await target.evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
    left: el.getBoundingClientRect().left,
    right: el.getBoundingClientRect().right,
    viewport: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
  }));
  const width = page.viewportSize()!.width;
  expect(box.scroll, `${what} at ${width} px: its scrollWidth`).toBeLessThanOrEqual(box.client);
  expect(box.left, `${what} at ${width} px: its left edge`).toBeGreaterThanOrEqual(0);
  expect(box.right, `${what} at ${width} px: its right edge`).toBeLessThanOrEqual(box.viewport);
  expect(box.page, `the page at ${width} px with ${what}: its scrollWidth`).toBeLessThanOrEqual(box.viewport);
}
```

- Called on the waiting list, both dialogs and both outcome messages, at 375 and 768 px, with a 20+20-character unit,
  a 50-character carrier, a 200-character description, a 120-character name and a 300-character reason, all unbroken.
- Four checks, because overflow shows up in different places: inside the element (`scrollWidth`), off its edge, or as
  page-wide scroll.
- Probes: removing `[overflow-wrap:anywhere]` from the message, the Modal or the row each failed it
  (`Received: 1101`, `1843`, `1938` against `343`).

`frontend/src/test/buildingDenial.test.ts::unguarded`

```ts
export function unguarded(fns: Fn[]): string[] {
  const aware = new Set([DENIAL]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const fn of fns) {
      if (/^use[A-Z]/.test(fn.name) && !aware.has(fn.key) && [...fn.calls].some((hook) => aware.has(hook))) {
        aware.add(fn.key);
        grew = true;
      }
    }
  }
  return fns.filter((fn) => fn.passive && ![...fn.calls].some((hook) => aware.has(hook))).map((fn) => fn.id);
}
```

- `DENIAL` is the key of `frontend/src/app/BuildingProvider.tsx::useBuildingDenied` (written `app/BuildingProvider` plus `::useBuildingDenied` in the test). A hook joins `aware` when it calls something already in it;
  the loop stops when a pass adds nothing. Each `fn.key` is `<module>::<name>` for a module-level function and
  `…@<position>` for a nested one, so a nested hook can't vouch for a module-level one with its name (round 2, F2).
- `inspect` builds `calls` with `hookOf` (identifiers through imports, namespace members, element access, local
  aliases from `bind`) and `passive` with `isPassive` (`{ passive: true }`, or any member it can't read, the last
  `passive` winning).
- Without the fixed point, `BuildingChoices` (denial read through `useCanViewAs`) would need an exemption, and a new
  wrapper hook would too.

`backend/tests/packages/test_api.py::_AFTER_RECEIVED`

```python
# A second after `received_at`, by the database's clock as `received_at` is (its default `now()`):
# the host's clock can be more than a second off the database's, which failed the table's
# `*_after_received` checks (WSL2 and the Docker VM, twice on 2026-10-22; the P5-02b carry).
_AFTER_RECEIVED = func.now() + timedelta(seconds=1)
```

- `now()` is the transaction's start time, the same value `received_at`'s default takes, so `picked_up_at` and
  `returned_at` are exactly one second later whatever the host clock says. `_picked_up`/`_returned` then
  `db.refresh` the row to read the computed value.
- Probe: `now() - 1 s` → 4 tests fail on `ck_packages_picked_up_after_received` (`PROBE OK`).

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Another Maple resident opens the package or its photo | 404 `package_not_found` / `file_not_found`; "Package not found" in the browser | J4 (`privacy`) |
| A pending member, or Birch, asks under Maple's path | 404 `building_not_found` | J4 (`privacy`) |
| Birch asks with Maple's ids under its own path | 404 `package_not_found` / `file_not_found` | J4 (`privacy`) |
| A resident tries a desk action | 403 `forbidden_role` | J4 |
| Signed out | 401 `not_authenticated` | J4 |
| The photo URL expiry changes | J4 fails on `X-Amz-Expires` | J4 (probe 61 s) |
| Two desks hand out one package | the loser sees "Already picked up or returned by a colleague.", focus on it, row gone | `packages-desk.spec.ts` "two desks…" (in turn; the simultaneous case is `backend/tests/packages/test_concurrency.py`) |
| The row leaves under an open dialog, then Cancel | dialog closes, focus on "Waiting", no message | same test |
| Shift+Tab from the pickup radios | focus stays in the dialog | same test (no mutation probe) |
| Longest values at 375/768 px | nothing overflows | `packages-desk.spec.ts` "the desk page, both dialogs…" |
| A building switch with a return out | dialog gone, no message in the next building | `packageActions.test.tsx` "a building switch with a return out…" (pins the outcome, not the `mounted` guard: §7) |
| A new passive reader without the denial | the fitness test lists it | `buildingDenial.test.ts` (probes: stale exemption; `useCanViewAs` without the read) |
| Host clock behind the database's | test rows still satisfy `*_after_received` | `test_api.py`, `test_desk_fields.py` (probes) |

Acceptance criteria → tests: 1–2 the full suite on both stacks (`39 passed` dev at `82fc86c`, prod-like at `f5599d3`
and `8fdb1c2`; CI `E2E journeys` green on every head); 3 the PR's prod-like transcripts; 4 the PR's recipe-check
record; 5 step 8; 6–7 J4; 8–9 `packages-desk.spec.ts`; 10 `packageActions.test.tsx`; 11 `buildingDenial.test.ts`; 12
`test_api.py`/`test_desk_fields.py` with probes; 13 the command file.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6-astra-medium` | `54e94dc` | MERGE | Medium: fitness test missed namespace calls and a spread after `passive: false`; criteria: AC6 waiting list unasserted | fixed `5f060be`, `eb1f1ab` |
| 1 | Claude + security | `54e94dc` (+ `eb1f1ab`) | MERGE | Medium M1: wrapped/anonymous functions shared `<module>`, hooks matched by name across files; Low L1: row 4 any 403; Low L2: race in turn | M1 `d462786`; L1 `8fdb1c2` + neighbours `0e42690`; L2 dismissed (backend proves the simultaneous race) |
| 2 | Codex | `0e42690` | MERGE | Medium F1: element access; Medium F2: nested hook vouched for a module-level one | fixed `7bc2a0b` |
| 2 | Claude + security | `0e42690` → `7bc2a0b` | MERGE | Medium M1: `test_desk_fields.py` host clock; Low L1: local aliases; Low L2: "unit 503" wording | `406a0a6`, `d30be2d`, `320ff23` |
| 3 | Codex | `320ff23` | MERGE | Medium: names not resolved by lexical scope | **open**, follow-up (§7) |
| 3 | Claude + security | `320ff23` | MERGE | Low: the same scope gap, plus `!`, parenthesised and `.call` callees | **open**, follow-up (§7) |

The failures behind the fixes:
- **Fitness test (R1 F1, R1 M1, R2 F1/F2, R2 L1):** each was a source shape that let a component read the building
  passively without reading the denial and still pass: `Building.useBuilding(…)`, `{ passive: false, ...o }`,
  `memo(() => …)` beside a guarded neighbour, a same-named hook in another file, `Building['useBuilding'](…)`, a nested
  `useCan` that reads the denial, `const read = useBuilding`. Each became an `R1-…`/`R2-…` test that failed first and
  passes now, and each reviewer's proof file passed after its fix.
- **J4 problem codes (R1 L1 and neighbours):** a status-only 403/404 passed a CSRF refusal and a mistyped route; the
  probes above show both now fail.
- **`test_desk_fields.py` (R2 M1):** `returned_at=datetime.now(UTC)` with no margin beside a database `now()`; a
  simulated 2 s host lag hits `ck_packages_returned_after_received` (`PROBE OK`). The `grep` for the same pattern
  found only `backend/tests/jobs/test_cli_jobs.py`, where no check constrains the column.

## 7. Not verified, accepted risks and follow-ups

- **Open Medium (round 3):** the fitness test resolves names without lexical scope. A function-local alias
  (`const read = useBuildingDenied` in one function) or a declaration that shadows a module-level hook can make it
  pass a reader that reads no denial; `useBuilding!(…)`, `(useBuilding)(…)` and `useBuilding.call(…)` aren't read.
  No code in `src/app` or `src/features` has these shapes (the inventory test reads it all). Fix: resolve callees with
  the TypeScript checker's symbols. Tracked: the PR's follow-ups; will be added to P6-02 (the next lane-B ticket) in
  the bookkeeping commit.
- The fitness test proves the denial is read, not that it gates rendering.
- The building-switch tests (pickup from P5-03d, return here) pin the outcome, not `usePackageSubmit`'s `mounted`
  guard: removing the guard stays green, since React drops a late state update on an unmounted component.
- **The S3 emulator serves a presigned GET after its expiry** (LocalStack 4.14 defaults; a curl 61 s later got 200).
  J4 proves the URL is signed for 60 s; only D-06 proves real S3 refuses it later. Possible follow-up: turn on the
  emulator's signature validation. Tracked: inbox, in the bookkeeping commit.
- The two desks confirm in turn in the browser; the simultaneous race is the backend's.
- Shift+Tab inside the radio group has no mutation probe.
- `mobile` runs J4 on unit 304, not 101 (D1); a third run on the same database at once can move the badge counts.
- At-least-once email: a worker crash can send the in-flight email twice (D3, ADR-0006).
- P5-03d D2 stays an accepted Low (occupants load above "Someone else"). Tracked: the P5 recap's open risks.
- The recipe check's domain gaps for P6-03 (common areas, what reopen leads to, comment recipients, several photos):
  will be added to the P6-03 stub in the bookkeeping commit.
- Criterion 5 (the recap) is not on this branch: it is step 8's PR.
- **Missed in framing:** the ticket's "Carried from P5-04" section (it was read from a main checkout behind
  `origin/main`). Its step-8 promotion (a `CLAUDE.md` lesson for "a list read before the change it is compared with")
  is not in this PR: a `CLAUDE.md` change after review round 3 would need a fourth round, so it goes in the P5 recap
  PR. Its P5-04 R3 coverage gaps (a pickup time's own conversion, a non-English locale, the lists' loading messages,
  Load more after a failure) stay untested and go to the recap's open risks. Tracked: the ticket's note, the inbox,
  the mistakes log.

## 8. How to change this safely

- **A new journey on seeded accounts:** add personas to `e2e/helpers/auth.ts::PERSONAS` (they log in in setup), give
  each project its own unit or account (D1), match emails with `textIncludes`, assert problem codes with a helper like
  `expectProblem`, and re-count the README's rate-limit budget from `rate_limits` after one run.
- **A new desk control or message:** add an `expectFits` call for it in `packages-desk.spec.ts` with the API's longest
  values; prove it fails once by removing the element's wrap class.
- **A new passive building reader:** read `useBuildingDenied()` (or a hook that does), or add an `EXEMPT` entry with
  the reason; the exemption test fails when an entry goes stale. Changing the inspector: add a case to "the inspector"
  block first.
- **Never run `npm run build` in `frontend/` while the prod-like stack runs:** Caddy's bind mount then serves a deleted
  `dist/assets` (round 1's reviewers both hit it); re-run `make prodlike`.

## 9. Must explain, then quiz

**1. The whole packages slice, schema to UI.** The table (`backend/app/packages/models.py::Package`) carries
`building_id` and composite FKs to the unit and the recipient membership, so a package can't point into another
building; check constraints tie timestamps to the status. `backend/app/packages/state.py::ALLOWED` says `received` may
become `picked_up` or `returned`. `backend/app/packages/queries.py::visible_packages` is the one rule for who sees what:
desk roles everything in the building, a resident their own and their unit's packages from their occupancy window.
`backend/app/packages/service.py::create_package` checks the idempotency key, claims the photo, writes the row,
notifies (rows plus `email.send` jobs) and audits, then commits once; pickup and return are conditional UPDATEs, so of
two at once one wins and the other gets 409 `invalid_transition`. The router mounts it on the building router with the
feature guard and desk roles on writes. On the client, `frontend/src/features/packages/api.ts` keys everything under
`['b', buildingId, 'packages']`; the desk page logs and hands out, the resident page lists and opens one at
`/packages/<id>`. The worker sends `package_arrived`; the photo is fetched through a 60 s presigned URL that
`backend/app/packages/photos.py::can_view_package_photo` authorizes through `visible_packages`. J4 drives all of it.

**2. 50 packages a minute: what to change first?** Inferred (no record): the email path. Each logging queues one
`email.send` job per recipient, and a worker claims and runs one job at a time
(`backend/app/jobs/worker.py::Worker`), so mail falls behind first; more worker processes (its `SKIP LOCKED` claim
gives concurrent workers disjoint jobs) would come before anything in the request path. Second, the desk's list doesn't poll (ADR-0012) and each logging refetches
it, so at that rate the desk would want a list that updates itself. The database side is indexed for both lists
(`(building_id, status, received_at DESC)`).

**3. What to add to the recipe after the next slice.** Already added from the criterion-4 check: child rows whose
visibility comes from the parent and also governs notifications and files; actor and time-window checks inside the
conditional UPDATE. After P6-03 I would add (inferred) a worked example of a child table and its 10-case rows, a
pattern for "who may act" beyond roles, and whatever the first slice built from the recipe had to ask for.

Quiz:

1. Why does J4 read the badge count from the API before logging, instead of expecting a fixed number?
2. A pending member and Birch's manager both get 404 for the package. Why is their code `building_not_found` while
   `resident2`'s is `package_not_found`?
3. What would break if `_AFTER_RECEIVED` were `datetime.now(UTC) + timedelta(seconds=1)` again?
4. What would break if `unguarded` added only hooks that call `useBuildingDenied` directly (no fixed point)?
5. How would you extend J4's checks to the maintenance slice's photos (P6-03/P6-04)?

<details><summary>Answers</summary>

1. The seeded resident already has waiting packages, and earlier runs may have left more; only the change (+1, then
   back) belongs to this run. D1 keeps the other project off the same unit.
2. The tenant context (`get_tenant_context`) answers first: neither has an active Maple membership, so the building
   itself is "not found". `resident2` is an active member, so the request reaches `visible_packages`, which hides the
   package.
3. Nothing while the host and database clocks agree; when the host lags by more than a second (WSL2 and Docker,
   2026-10-22), `picked_up_at` lands before the database's `received_at` and the insert fails
   `ck_packages_picked_up_after_received`.
4. `frontend/src/app/AccountMenu.tsx::BuildingChoices` would be reported (it reads the denial only through `useCanViewAs`), and so
   would any component using a wrapper hook; the fix would be exemptions that hide nothing.
5. The same shape: the resident's own request shows the photo, `naturalWidth` > 0 and `X-Amz-Expires=60`; another
   resident, a pending member and the other building get the photo's `download-url` 404 with their codes; internal
   comments' attachments must 404 for the resident too (the recipe's child-row rule).

</details>
