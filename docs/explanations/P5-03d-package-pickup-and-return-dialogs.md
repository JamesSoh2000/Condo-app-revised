# Explanation — P5-03d Package pickup and return dialogs

> **PR:** #119 · **Source revision:** `1cb53980cec314c91cc84a8ca6d8862c8317216c`, the pre-merge PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (3, Codex
> `gpt-6.1-sol` at high effort) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 119 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read `git diff origin/main...HEAD` at `1cb5398` (all 9 paths), the whole of
> `PackageDialog.tsx`, `PickupDialog.tsx`, `ReturnDialog.tsx`, the changed parts of `WaitingList.tsx`, `api.ts`,
> `frontend/src/features/residents/Modal.tsx`, `frontend/src/features/residents/reason.tsx`, the test names and assertions cited in §5, and the PR body; ran
> `npx vitest run src/features/packages src/features/residents`: 10 files, 420 passed. Differences from the plan:
> one, see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: B.

## 1. What was built and why

Each row of the package desk's "Waiting" list (`/security/packages`, P5-03b) now has two buttons:
**Hand out** opens a dialog to pick who collects the package, and **Return** asks for the reason it goes
back to the carrier. Two desks can reach for the same package. The one that loses gets a 409 from the
server; its dialog closes with "Already picked up or returned by a colleague.", and the list is asked for
again (criterion 1). No backend code changed: the dialogs call P5-02b's `packages_pickup` and
`packages_return` and P5-02a's `units_occupants`. The two decisions that matter most: one "ended" message
for both actions (D1), and which people the pickup dialog offers (D2).

## 2. Decisions

### D1. One "ended" message for both transitions

- **Problem or constraint:** a 409 `invalid_transition` only says the package is no longer `received`. It
  doesn't say whether a colleague picked it up or returned it. The ticket's wording was "Already picked up
  (by a colleague)".
- **Chosen:** "Already picked up or returned by a colleague." (`frontend/src/features/packages/PackageDialog.tsx::ENDED`) for a 409
  `invalid_transition` and a 404 `package_not_found` from either dialog. The dialog closes, and the page
  shows and focuses the message.
- **Alternatives rejected:** parsing the 409's `detail` ("A picked_up package can't become …"): it is human
  text, not a stable code (CLAUDE.md rule 8). A GET of the package after the 409: one more request and one
  more way to fail, for a single word. Adding the status to the problem body: an API change in a UI ticket.
- **Tradeoffs and accepted limitations:** the desk isn't told which of the two happened.
- **Basis:** autonomous; `backend/app/packages/state.py::assert_transition`.
- **Source:** recorded (PR #119 D1).

### D2. Who the pickup dialog offers

- **Problem or constraint:** the server accepts the named recipient (any active membership, even after
  they moved out) or an active current occupant of the unit (`backend/app/packages/service.py::_check_pickup_member`).
  `units_occupants` lists only the occupants.
- **Chosen:** one radio group. The recipient comes first, from the package itself
  (`recipient_membership_id`, `recipient_name`, labelled "(recipient)"), then the occupants without
  repeating the recipient, then "Someone else", which shows a name field. Nothing is preselected. A member
  the server refuses with 422 `invalid_pickup_member` is hidden for the rest of the dialog.
- **Alternatives rejected:** occupants only: a recipient who moved out would have to be typed as a name,
  losing the link to the membership. Preselecting the recipient: one wrong Enter hands the package to the
  wrong person.
- **Tradeoffs and accepted limitations:** a recipient whose membership is no longer active is offered until
  the server refuses it once. The recipient shows at once and the occupants are inserted above "Someone
  else" when they load, so the list can move under a click (§7).
- **Basis:** autonomous.
- **Source:** recorded (PR #119 D2; the moving list in its Follow-ups).

### D3. The radio-group fix lives in the shared residents `Modal`

- **Problem or constraint:** the modal's Tab trap treated every radio as a tab stop, but the browser
  tabs a radio group as one stop. With the second occupant checked, Shift+Tab left the dialog (review
  round 2, F1).
- **Chosen:** in `frontend/src/features/residents/Modal.tsx::Modal`, a group's stop is its checked radio,
  or its first if none is checked. The focused element is mapped to its group's stop before the
  first/last check.
- **Alternatives rejected:** a per-dialog `tabStops` prop: every caller would have to remember it, and
  the residents' `TransferDialog` already has a radio group (its `UnitPicker`) inside the same trap.
- **Tradeoffs and accepted limitations:** the change reaches every residents dialog; the residents suite
  ran green with it (420 passed together with packages).
- **Basis:** review finding (round 2).
- **Source:** recorded (PR #119 "Independent review", round 2 decision).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Reuse the residents `Modal` and `ReasonField` | `frontend/src/components/ui/dialog.jsx` | legacy JSX, not extended (CLAUDE.md rule 12) | convention (P4-08b–e) | PR table |
| Length counted in code points; `maxLength` set to 2× the limit | `maxLength={120}` | the browser counts UTF-16 units, so an emoji name would stop early; Pydantic counts code points | as `frontend/src/features/residents/reason.tsx::ReasonField` | PR table |
| Invalidate in `onSettled`, cancelling first | `onSuccess` only | a lost answer may still have been applied | as `useLogPackage` | PR table |
| The pickup dialog focuses the dialog element on open | focus the first choice | the choices load later, and nothing should be chosen for the desk | review round 1 F1 | PR round 1 table |
| The dialogs are rendered by `WaitingList`, not by `Row` | one dialog inside each row | a refresh that drops the row would unmount it (criterion 8) | criterion 8 | Inferred: from the criterion and the PendingRequests pattern |

**Framing changes:** criterion 1 sharpened: which codes, the exact message, focus, cancel then invalidate,
no retry. Criteria 2–9 added: choices, return reason, the refusals that keep the dialog open, success,
invalidation, one request, keeping the package, layout. None loosened.

**Plan versus final code:** the plan named a small `outcome.ts` for the "ended" refusal. The code has
`PackageDialog.tsx` instead, which also holds the shared shell, the submit hook with the in-flight guard,
and the text validator both dialogs use. This is recorded in the PR below the Plan. Review rounds added
focus-on-open, the heading as a focus fallback, the radio tab stop in `Modal`, and the 44 px "Try again"
(§6). Everything else matches the plan.

## 3. How it is implemented

### Overview

- `frontend/src/features/packages/api.ts::usePackageAction`: one React Query mutation for both actions, keyed `['b', id, 'packages', 'action']`.
- `frontend/src/features/packages/PackageDialog.tsx::usePackageSubmit`: the in-flight guard, the "ended" handling and the failure message;
  `frontend/src/features/packages/PackageDialog.tsx::PackageDialog` is the shell (heading, package line, alert, Cancel and confirm).
- `frontend/src/features/packages/PickupDialog.tsx::PickupDialog` and `frontend/src/features/packages/ReturnDialog.tsx::ReturnDialog`: each dialog's own fields, its checks
  and its 422 placement.
- `frontend/src/features/packages/WaitingList.tsx::WaitingList`: the row buttons, the open dialog, the outcome message and where focus goes
  afterwards.

### Walkthrough (variant B: a desk hands a package out)

1. **Action.** On the "Waiting" list, `frontend/src/features/packages/WaitingList.tsx::Row` renders "Hand out", named for screen readers
   "Hand out the UPS package for unit A-101". Clicking it stores `{kind, item, opener}`, and
   `WaitingList` renders `PickupDialog` with that package. The package is a copy, so a refresh doesn't change it.
2. **Dialog.** On open, `PickupDialog` focuses the dialog element and asks `useUnitOccupants` for the unit.
   The recipient choice shows at once, and the occupants follow (a "Loading…" line, or an error with
   "Try again").
3. **Checks before sending.** Nothing chosen gives "Choose who is collecting it.". For "Someone else",
   `frontend/src/features/packages/PackageDialog.tsx::textError` refuses a control character or lone surrogate ("Use visible characters
   only."), a blank name ("Type their name.") and more than 120 code points after the trim. These mirror
   `PickupName` in `backend/app/packages/schemas.py`.
4. **Request.** `usePackageSubmit` takes the guard, disables the dialog and moves focus to the dialog element.
   `usePackageAction` then POSTs `…/packages/{id}/pickup` with exactly one of `picked_up_by_membership_id`
   and `picked_up_by_name` (trimmed).
5. **Answer.** 200: `onClose("Unit A-101’s package was handed to NAME.")`. 409 `invalid_transition` or 404
   `package_not_found`: `onClose(ENDED)`. 422 `invalid_pickup_member`: the person is hidden, the
   occupants are asked again, and a message appears under the group. 422 on `picked_up_by_name`: a message
   under the field. 429: the rate-limit message. Anything else: "Could not record the pickup. Try again.".
   On every refusal the dialog stays open with what was typed.
6. **Cache.** `onSettled` cancels every query under `['b', id, 'packages']`, then invalidates them, whatever
   the outcome. The waiting list fetches again, and the row disappears if the package is no longer `received`.
7. **Focus and states.** `WaitingList`'s `close` focuses the status message after an outcome. On Cancel or
   Escape it goes back to the row button, or to the "Waiting" heading if a refresh has removed that row.
   At 375 px the dialog fills the width minus 16 px and scrolls vertically; long names wrap (§5).

Return follows the same path, through `ReturnDialog` (reason 1–300 code points, field focused on open) and
`…/return`.

### Data model changes

None.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `frontend/src/features/packages/PackageDialog.tsx` | new: submit hook, shell, validator | +120 |
| `frontend/src/features/packages/PickupDialog.tsx` | new | +144 |
| `frontend/src/features/packages/ReturnDialog.tsx` | new | +63 |
| `frontend/src/features/packages/WaitingList.tsx` | row buttons, dialog host, message, focus | +67 −5 |
| `frontend/src/features/packages/api.ts` | `usePackageAction` | +26 |
| `frontend/src/features/residents/Modal.tsx` | radio group = one tab stop | +10 −2 |
| `frontend/src/features/residents/reason.tsx` | optional `maxLength` | +4 −2 |
| `frontend/src/features/packages/packageActions.test.tsx` | new: 56 tests | +683 |
| `docs/tickets/P5-03d-package-pickup-and-return-dialogs.md` | framing | +50 −4 |

`frontend/src/features/packages/PackageDialog.tsx::usePackageSubmit`

```tsx
  const submit = async (sent: PackageAction, done: string, onFailure: (error: unknown) => boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    // The button about to be disabled would drop focus to <body> in a browser.
    root.current?.focus();
    try {
      await action.mutateAsync(sent);
    } catch (error) {
      inFlight.current = false;
      if (!mounted.current) return;
      setBusy(false);
      const ended =
        error instanceof ApiError &&
        ((error.status === 409 && error.code === 'invalid_transition') || (error.status === 404 && error.code === 'package_not_found'));
      if (ended) return onClose(ENDED);
      if (!onFailure(error)) setFailure(rateLimitMessage(error) ?? failed);
      return;
    }
    if (mounted.current) onClose(done);
  };
```

- The guard is a ref, so a second click in the same tick, before React disables the button, sends nothing.
  Without it two POSTs go out (the mutation probe in the PR: "expected 2 to be 1").
- `mounted` stops a late answer from calling `onClose` after a building switch has unmounted the dialog.
- `ended` is D1. Without the 404 half, a deleted package would show "Could not record …" (probe: 2 tests
  fail).

`frontend/src/features/packages/PickupDialog.tsx::PickupDialog` (choices and refusal)

```tsx
  const choices: Choice[] = [];
  // Staff always get the recipient's name (P5-03a); the fallback only keeps the type honest.
  if (item.recipient_membership_id) choices.push({ membershipId: item.recipient_membership_id, name: item.recipient_name ?? 'The recipient', recipient: true });
  for (const occupant of occupants.data ?? []) {
    if (occupant.membership_id !== item.recipient_membership_id) choices.push({ membershipId: occupant.membership_id, name: occupant.full_name });
  }
  const offered = choices.filter((c) => !refused.includes(c.membershipId));
  // A choice counts only while it is still offered.
  const chosen = choice === SOMEONE_ELSE || offered.some((c) => c.membershipId === choice) ? choice : null;

  const failed = (err: unknown) => {
    if (err instanceof ApiError && err.code === 'invalid_pickup_member' && chosen !== SOMEONE_ELSE && chosen !== null) {
      setRefused((ids) => [...ids, chosen]);
      setChoice(null);
      void occupants.refetch();
      setError({ field: 'choice', message: REFUSED });
      return true;
    }
    // ...
  };
```

- D2 in code. `chosen` is derived from `choice` on each render, so a person removed by a refetch (or by
  `refused`) can't be sent.
- `refused` outlives the refetch: if the occupants come back with the same person, they stay hidden
  (`invalid_pickup_member removes that person…`; probe: 1 test fails without `setRefused`).

`frontend/src/features/packages/WaitingList.tsx::WaitingList` (closing)

```tsx
  const close = (outcome: string | null) => {
    if (outcome) setMessage(outcome);
    const back = open?.opener.isConnected ? open.opener : headingRef.current;
    setFocusTo({ target: outcome || !back ? 'message' : back });
    setOpen(null);
  };
```

- After an outcome the row is leaving, so focus goes to the message. Without one it goes back to the opener,
  or to the heading when the opener's row has gone. Round 2 F2: the empty message is `empty:hidden` and
  can't take focus, so focus used to fall to `<body>`.
- `focusTo` is state, not a ref, so the effect runs after the commit that shows the message (the
  PendingRequests lesson, cited in the comment).

`frontend/src/features/residents/Modal.tsx::Modal` (tab stops)

```tsx
    const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('input:not(:disabled), textarea, button:not(:disabled)') ?? []);
    // A radio group is one tab stop, as the browser tabs: its checked radio, else its first (P5-03d R2 F1).
    const stop = (element: HTMLElement): HTMLElement => {
      if (!(element instanceof HTMLInputElement) || element.type !== 'radio' || !element.name) return element;
      const group = controls.filter((other): other is HTMLInputElement => other instanceof HTMLInputElement && other.type === 'radio' && other.name === element.name);
      return group.find((radio) => radio.checked) ?? group[0];
    };
    const focusable = controls.filter((element) => stop(element) === element);
    // ...
    const active = document.activeElement;
    const index = active instanceof HTMLElement && controls.includes(active) ? focusable.indexOf(stop(active)) : -1;
```

- D3. Before this, Shift+Tab from the second, checked radio had index 1, so the trap didn't wrap, and
  Chromium moved focus to a row's "Return" button behind the modal (round 2 transcript in the PR).

`frontend/src/features/packages/api.ts::usePackageAction` (`onSettled`)

```ts
    onSettled: () => {
      const filters = { queryKey: packagesKey(buildingId) };
      void queryClient.cancelQueries(filters).then(() => queryClient.invalidateQueries(filters));
    },
```

- Cancelling first stops a fetch already in flight from answering with the list as it was before the action.
  The prefix covers the waiting list and any summary query. With `onSuccess` instead, a refusal or network
  error leaves the list stale (probe: 4 tests fail).

## 5. Edge cases and tests

All in `frontend/src/features/packages/packageActions.test.tsx` unless noted. Run at the source revision.

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Second desk confirms after the first | dialog closes, `ENDED` shown and focused, one POST | `a %s answered %i %s closes the dialog, says so and asks for the list again` (pickup/return × 409/404); `the list is asked again after the 409` |
| Recipient moved out but may collect | offered first as "(recipient)" | `offers a recipient who moved out but may still collect, before the occupants` |
| Recipient listed twice | not repeated among occupants | `offers the recipient, the other occupants once each and someone else, with nothing chosen` |
| Both fields sent | exactly one | `sends the chosen member only`, `sends a typed name only, trimmed` |
| Nothing chosen, blank, control, 121 code points | refused, nothing sent | `refuses %s in the dialog and sends nothing`; `takes 120 code points` |
| Reason blank, newline, 301 code points | refused, nothing sent | `refuses %s and sends nothing`; `takes 300 code points`; `sends the trimmed reason` |
| Occupants fail to load | error + Try again; "Someone else" still works; Try again disabled while out | `shows the occupants loading, then their failure with Try again…`; `the occupants Try again is disabled while the pickup is out (R1 F3)` |
| Server refuses the member | hidden, refetched, message, focus kept in the dialog | `invalid_pickup_member removes that person…`; `focus stays inside the dialog after invalid_pickup_member…` |
| 422 on name/reason, 500, 429 | message under the field / alert; input kept | `a 422 on the %s %s (%s) shows under the field`; `a %s answered %i keeps the dialog and what was typed` |
| Answer lost (network error) | packages queries still cancelled and invalidated | `the packages queries are asked again after %s` (success, refusal, 500, network) |
| Double click in one tick | one POST; buttons disabled; Escape ignored | `%s: a double click sends one request…` (both clicks inside one `act`) |
| Focus on open, Escape from it | inside the dialog; Escape closes; back to the row button | `%s puts focus inside the dialog on open, and Escape from there closes it (R1 F1)`; `%s, then %s, sends nothing and puts focus back on the row button` |
| Radio group and Tab | one stop: the checked radio, else the first | `Shift+Tab from a checked radio that is not the first…`; `Tab from the last button goes to the group’s checked radio…`; `with nothing chosen, Tab from the dialog goes to the first radio…` (passes on the old trap too: a guard) |
| Refresh drops the row under the dialog | dialog unchanged; the server's 409 then speaks; Cancel/Escape → heading | `a list refresh that drops the row leaves the dialog as it was`; `%s after a refresh dropped the row puts focus on the Waiting heading (R2 F2)` |
| Building switch with a pickup out | dialog gone; late answer shows nothing | `a building switch with a pickup out unmounts the dialog…` (pickup only; see §7) |
| `building_not_found` | building marked denied | `building_not_found on %s marks the building denied` |
| Residents dialogs after the `Modal` change | unchanged behaviour | `src/features/residents` suite, green (420 with packages) |
| 120-char name, 300-char reason, 200-char names at 375/768 px | no horizontal overflow, controls ≥ 44 px | No Vitest test (jsdom has no layout): Chromium stack runs in the PR |

Acceptance criteria → tests: 1 → "a colleague got there first" + the two-desk stack run. 2 → "the pickup
choices and what is sent". 3 → "the return reason". 4 → "refusals that keep the dialog open". 5 →
"success". 6 → "invalidation". 7 → "one request per confirmation, and focus". 8 → "the dialog keeps its
package". 9 → Chromium transcripts in PR #119.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol` (high) | `f2bca26` | MERGE | F1 M: pickup opened with focus behind the modal; F2 M: success message didn't wrap; F3 L: Try again enabled while busy; F4 L: Try again 20 px | all fixed in `02d917d` |
| 2 | Codex `gpt-6.1-sol` (high), fresh | `02d917d` | MERGE | F1 M: Shift+Tab out of a radio group; F2 L: focus to `<body>` after the row was dropped | both fixed in `278dafc` (+ guard test `1cb5398`) |
| 3 | Codex `gpt-6.1-sol` (high), fresh | `1cb5398` | MERGE | none | — |

James asked that this run use Codex `gpt-6.1-sol` at high effort as the only reviewer, fresh each round,
with no Claude reviewer.

- **R1 F1.** Opening "Hand out" left focus on the row button, so Escape and Tab acted on the page behind the
  modal. The earlier tests sent Escape straight to the dialog element. Fix: focus the dialog on open. Test
  `… puts focus inside the dialog on open, and Escape from there closes it (R1 F1)` failed, now passes.
  Chromium: "focus on open inside dialog: false" → true.
- **R1 F2.** A 120-character unbroken name in the success message widened the page to 1277 px at 375 px
  (1557 at 768; 2787 for a 200-character member name). Fix: `[overflow-wrap:anywhere]` on the message.
  Chromium after: 375/375 and 768/768. My first layout pass had measured the dialogs, not the message.
- **R1 F3, F4.** Occupants "Try again" was enabled during the request and 20 px tall. Fixed with
  `disabled={busy}` and `min-h-11`. A test for F3 failed, now passes; Chromium for F4: 20 px → 44 px.
- **R2 F1.** See D3. Two tests failed, now pass; Chromium: before, Shift+Tab landed on "Return the Amazon
  package for unit 101"; after, the cycle stays inside the dialog.
- **R2 F2.** Cancel after another desk took the package and a refresh removed the row: focus went to
  `<body>`. It now goes to the "Waiting" heading. Tests (Cancel and Escape) failed, now pass; Chromium:
  `BODY` → `H2 "Waiting"`.

## 7. Not verified, accepted risks and follow-ups

- **Not run locally:** backend pytest and `alembic check`. Docker Desktop's engine wasn't running, so
  `make up`/`make check` couldn't run. No backend file changed; CI's "Backend tests" passed on the PR. The
  stack runs used Postgres 16.2 from `pgserver`, uvicorn and Vite's dev server, not `make up` or
  `make prodlike`. CI tests Postgres 18, and the prod-like build's CSP wasn't exercised with the dialogs open.
- **Layout (criterion 9)** is proven only by the Chromium runs recorded in the PR, not by a test that runs
  in CI. The P5-05 E2E can carry it.
- **Building switch with a return out**: only the pickup case has a test (Codex round 3). Both share
  `usePackageSubmit`, so the guard is the same code. Inferred: the return case behaves the same.
- **Accepted risk (Low):** the occupants are inserted above "Someone else" when they load, so a click
  aimed there can land on an occupant. The checked radio stays visible, and the success message names the
  person. Tracked in the PR's follow-ups and in this file.
- **Accepted:** a recipient whose membership is inactive is offered until the server refuses it once (D2).
- **Over size:** 417 non-test lines against the ~400 guide (PR follow-ups).
- **Carried, not done:** the P3-05 fitness test (`useBuilding({ passive: true })` ⇒ `useBuildingDenied()`),
  carried from P5-03c. It goes to P5-05 in the bookkeeping commit.
- Who collected a package and the return reason are still not shown (ticket "Out").

## 8. How to change this safely

- **Another package action** (for example "undo"): add a variant to `frontend/src/features/packages/api.ts::PackageAction` and its POST in
  `usePackageAction`; build the dialog on `PackageDialog` and `usePackageSubmit` to get the guard, ENDED and
  invalidation; add a kind to `WaitingList`'s `Open`. The "invalidation" and "double click" tests show the
  pattern to copy.
- **Changing the name or reason limits** means changing `MAX` in the dialog and the backend's
  `PickupName`/`ReturnReason` together; the `takes 120/300 code points` tests pin them.
- **`frontend/src/features/residents/Modal.tsx`** is shared: run `src/features/residents` too, and check Tab in Chromium (jsdom
  doesn't move focus on Tab; the tests call the handler).

## 9. Must explain, then quiz

The ticket has no "Must explain" section. Its one original criterion is answered in §3 step 5 and by D1.

1. Why does the pickup dialog keep a copy of the package instead of reading the row from the list?
2. What does the `inFlight` ref catch that the button's `disabled` doesn't?
3. Why invalidate in `onSettled` and not `onSuccess`?
4. What would break if `refused` were removed from `PickupDialog`?
5. How would you show which of the two transitions a colleague made?

<details><summary>Answers</summary>

1. A refresh (on focus, Refresh, or after another action) can drop the row. The dialog is rendered by
   `WaitingList` with the `item` stored when it opened, so it stays as it was and the server's 409 tells
   the desk what happened (criterion 8; `a list refresh that drops the row leaves the dialog as it was`).
2. Two clicks in the same tick, before React re-renders the disabled button. The test makes both clicks
   inside one `act`. Without the ref, two POSTs go out.
3. A failure in the browser (network error, timeout) may still have been applied on the server, and a 409
   means another desk changed the list. Only refreshing on every outcome keeps the list true.
4. After 422 `invalid_pickup_member`, the occupants refetch could bring the same person back. The desk
   could choose them again and get the same refusal (the probe failed exactly that test).
5. Add the current status, or a separate code, to the 409 problem body in `assert_transition`, regenerate
   the types, and branch on it in `usePackageSubmit`. That's an API change, rejected for this ticket (D1).

</details>
