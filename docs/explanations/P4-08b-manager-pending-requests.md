# Explanation — P4-08b Manager pending requests

> **PR:** #99 · **Source revision:** `b92b8c5de804d7c70407ba62480f9db5598882c4`, the pre-merge PR head this explanation
> was written from and checked against. **Reviewed:** the final review round (3) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 99 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read `git diff origin/main...HEAD` (15 paths), `api.ts`, `DecisionDialog.tsx`,
> `PendingRequests.tsx`, `ResidentsPage.tsx`, the `pages.ts` / `routes.tsx` / `routeScope.ts` / `MainNav.tsx` patches,
> `backend/app/onboarding/service.py::_decide`, the PR body (three review rounds) and the assertions of the tests
> cited below at `b92b8c5`; ran `npx vitest run src/features/residents src/app/nav.test.tsx`: 100 passed (2 files).
> No mutation probe was run; the evidence that the tests can fail is that they were red before the code (49 failed
> on the test commit; each round's tests failed before its fix, PR "Independent review"). Differences from the plan:
> see §2 "Plan versus final code".
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: B (UI interaction).

## 1. What was built and why

Property managers get `/manage/residents` in the typed frontend: a "Pending requests" tab that lists the building's
join requests and approves or denies each one in a modal dialog, and a "Members" tab that says its content is coming
(P4-08c). The legacy `Residents` placeholder route and legacy page (frontend/src/pages/Residents.jsx) are gone, so the Base44 ratchet drops
from 316 to 299. The nav item keeps its label and place, and links to the new path.

The decisions that matter most: one request per confirmation (a client guard), with the server's conditional update
as the real judge between two managers (§9, must-explain 1); and the list refresh belongs to the mutation, not to the
component, and must never hold back or be cancelled by anything else (D3, review rounds 1 and 2).

The ticket was split while framing: the nav pending badge and the follow-ups carried from P4-08a went to P4-08d (D1).

## 2. Decisions

### D1. Split the nav badge and carried fixes into P4-08d

- **Problem or constraint:** the PR must fit about 400 non-test lines, and the last two estimates (P4-01, P4-08a)
  came in about 40% low because the error and race criteria were not costed.
- **Chosen:** cost those criteria (about 400 for the page, list and dialog) and move the badge (about 45) and the
  carried P4-08a/P4-07b fixes (about 25) to [P4-08d](../tickets/P4-08d-pending-badge-and-onboarding-follow-ups.md).
- **Alternatives rejected:** keeping everything (about 470 by an estimate that had run low twice); splitting approve
  from deny (they share the dialog, the error mapping and the refresh).
- **Tradeoffs and accepted limitations:** until P4-08d merges, a manager sees the queue only on the page. The
  estimate was still low: 482 added non-test lines, mostly in `DecisionDialog.tsx` (§7).
- **Basis:** playbook step 1.4; autonomous. **Source:** recorded (ticket Frame notes, PR D1).

### D2. One hand-written dialog component for both decisions

- **Problem or constraint:** the ticket asks for confirmation dialogs and a reason dialog; `src/features/` uses no
  UI kit.
- **Chosen:** `frontend/src/features/residents/DecisionDialog.tsx::DecisionDialog`, with an `approve | deny` mode:
  `role="dialog"`, `aria-modal`, initial focus, a Tab trap, Escape, and focus returned by the caller.
- **Alternatives rejected:** native `<dialog>` with `showModal()` (jsdom 27.4, the test environment, doesn't
  implement it); the legacy shadcn `frontend/src/components/ui/dialog.jsx` (new typed code would depend on the shrinking legacy
  folder); a new dependency (not needed for one modal).
- **Tradeoffs and accepted limitations:** the page behind is not `inert`; screen readers rely on `aria-modal`.
- **Basis:** autonomous; `CLAUDE.md` rule 12. **Source:** recorded (PR D2).

### D3. The refresh belongs to the mutation, not the component, and never blocks the answer

- **Problem or constraint:** after any outcome (including 409s, which mean a colleague changed the list) the list must
  be asked for again, even if the dialog or the page is gone by the time the answer comes (criterion 11).
- **Chosen:** `frontend/src/features/residents/api.ts::useDecide` invalidates `['b', id, 'onboarding-requests']` in
  its hook-level `onSettled`, which TanStack Query runs whether or not a component still watches the mutation, and
  does not return that promise (review round 1, F1: returned, it made `mutateAsync` wait for the refetch).
- **Alternatives rejected:** invalidating in the component after `await` (lost once it unmounts); removing the row
  from the cache by hand (the server's list also shows colleagues' decisions; notifications already invalidate
  instead, `frontend/src/features/notifications/api.ts::useInvalidateNotifications`).
- **Tradeoffs and accepted limitations:** a generic failure also refetches (harmless). Until the refetch lands, the
  decided row is still listed; clicking it again gets 409 `already_decided`.
- **Basis:** existing convention, ADR-0012, review round 1. **Source:** recorded (PR D3).

### D4. The client mirrors the server's reason rules

- **Problem or constraint:** `OnboardingDecisionIn.reason` (`backend/app/onboarding/schemas.py::Reason`) refuses
  control characters (a line break), format characters and line/paragraph separators before stripping, then needs
  3–500 code points. A textarea invites Enter.
- **Chosen:** `frontend/src/features/residents/DecisionDialog.tsx::reasonError` checks `[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]` on the raw value, then the
  trimmed length in code points (`codePoints`); a 422 on `reason` is still placed by its error `type`
  (`REASON_MESSAGES`).
- **Alternatives rejected:** a single-line input (cramped for 500 characters on a phone; a pasted tab still passes);
  only placing the 422 (a round trip for the most likely mistake).
- **Tradeoffs and accepted limitations:** the browser's Unicode tables may differ from Python's; the 422 mapping
  covers that.
- **Basis:** `CLAUDE.md` lesson "validate by what the server accepts". **Source:** recorded (PR D4, criterion 8).

### D5. Focus after a decision is driven by state

- **Problem or constraint:** after a decision the row leaves the list, so focus must go to the outcome message. The
  first version used a ref read by an effect that ran on every render; in Chromium the list refetch's pending effect
  took the ref while the message `<p>` was still empty and `display: none` (`empty:hidden`), so focus fell to
  `<body>`. jsdom loads no CSS, so the tests passed.
- **Chosen:** `frontend/src/features/residents/PendingRequests.tsx::PendingRequests` keeps `focusTo` in state; an effect on `[focusTo]` focuses the
  message (or the opener after Cancel/Escape or `unit_inactive`) after the commit that renders it.
- **Alternatives rejected:** dropping `empty:hidden` (focus would still depend on effect timing).
- **Tradeoffs and accepted limitations:** no jsdom test can fail on the original bug; the evidence is the Chromium
  transcript in the PR (`focus after approve: p[role=status]`).
- **Basis:** experiment on the stack. **Source:** recorded (PR D5).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Nav item keeps "Residents" in its place | rename it | existing nav tests and users keep working | default | PR table |
| `/Residents` is "Page not found" | redirect | ADR-0011: routes outside the allowlist are 404; P4-08a did the same | ADR-0011 | PR table |
| Tab in `?tab=members` | component state | Back/Forward and links reach a tab | autonomous | PR table |
| Panel keyed by `location.key` and building; tablist not keyed | key the whole page | a remounted tablist would drop keyboard focus on every tab change | `CLAUDE.md` lesson | PR table |
| Dates in the building's time zone and locale | browser time zone | the building's day is what the manager reasons in | autonomous | PR table |
| The reason is sent as typed | send it trimmed | the server strips and counts itself | `CLAUDE.md` lesson | PR table |
| "Show more" disabled during any fetch, `cancelRefetch: false` | leave it enabled | it cancelled a refresh and kept a decided row (round 2) | review finding | PR round 2 |

**Framing changes:** criteria 1–3 sharpened (how one request is guaranteed; what "usable at 375 px" means, with a
254-character email; the exact ratchet drop, corrected from 18 to 17 during implementation, and the 404); 4–13 added
(route, nav and page; tabs; list states; each dialog; the other error codes; generic failures; leaving and Back;
buildings; a refetch under an open dialog). Criterion 8 was sharpened again in a later commit to mirror the reason's
character rules (D4). Nothing loosened.

**Plan versus final code:** (1) 482 added non-test lines, not about 400 (D1). (2) The client checks the reason's
characters (D4), and focus is state-driven (D5), both after the plan. (3) `useDecide`'s `onSettled` no longer returns
the invalidation (round 1) and "Show more" waits for any fetch (round 2): neither was in the plan. (4) Several test
names differ from the Plan's table (PR deviation note); this text cites the real names. (5) A building switch
navigates home (`frontend/src/app/BuildingProvider.tsx::BuildingProvider`), so the switch tests reopen the page.

## 3. How it is implemented

### Overview

- `frontend/src/features/residents/api.ts`: `usePendingRequests` (infinite query over `onboarding_list`) and
  `useDecide` (one mutation for approve and deny).
- `frontend/src/features/residents/ResidentsPage.tsx::ResidentsPage`: heading, the tablist (URL-driven), the panel keyed per history entry and building.
- `frontend/src/features/residents/PendingRequests.tsx::PendingRequests`: list states, rows, the outcome message, "Show more", and which dialog is open.
- `frontend/src/features/residents/DecisionDialog.tsx::DecisionDialog`: the modal, the guard, validation, the call and the error mapping.
- `frontend/src/app/pages.ts::pagePath`, `frontend/src/app/routes.tsx::AppRoutes`, `MainNav.tsx`: the route and nav link.

### Walkthrough (variant B): a manager approves Sam's request

1. **Route and guard.** `/manage/residents` is a child of `RequireActiveMembership` in `frontend/src/app/routes.tsx::AppRoutes`,
   wrapped in `RequirePageAccess access={PAGE_ACCESS.Residents}` (`roles: ['property_management']`). Anyone else is
   redirected to `/403` before `ResidentsPage` mounts, so no list request is sent.
2. **List.** `usePendingRequests(buildingId)` asks `GET /api/buildings/{id}/onboarding-requests` (pending by default)
   under `['b', id, 'onboarding-requests', 'pending']`, `staleTime: 0`, so focus refetches it. Each row shows name,
   email, unit (`unitName`), relationship label and the date in the building's zone.
3. **Open.** "Approve" (`aria-label="Approve Sam Lee"`) stores `{ kind, request, opener }`. The dialog keeps that
   request snapshot, so a refetch that drops the row doesn't change it (criterion 13).
4. **Confirm.** `confirm` returns at once if `inFlight.current` is set; otherwise it sets it, disables the buttons,
   moves focus to the dialog root, and calls `decide.mutateAsync({ kind: 'approve', id })`.
5. **API call.** `POST /api/buildings/{id}/onboarding-requests/{request_id}/approve` (`onboarding_approve`). The server
   runs a conditional `UPDATE … WHERE status = 'pending'` (`backend/app/onboarding/service.py::_decide`).
6. **Response.** 200 → `onClose({ message: 'Sam Lee was approved.', decided: true })`. A 409/404 that ends the dialog
   → `refusal` gives the message. A 422 on the reason → field error. Anything else → an alert in the dialog, with the
   429's wait when there is one; the buttons work again.
7. **Cache.** Whatever the outcome, `onSettled` starts the invalidation of `['b', id, 'onboarding-requests']`; the
   infinite query refetches its loaded pages, and the row disappears when the server's list arrives.
8. **Focus and states.** `close` sets the message and `focusTo`; the effect focuses the message (decided) or the opener
   (Cancel, Escape, `unit_inactive`). While any fetch is out, "Show more" is disabled. At 375 px rows and dialogs wrap
   (`[overflow-wrap:anywhere]`); the Chromium run measured `scrollWidth 375` with a 254-character email.

### Data model changes

None. No API change.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `frontend/src/features/residents/DecisionDialog.tsx` | new: the modal, guard, validation, errors | +216 |
| `frontend/src/features/residents/PendingRequests.tsx` | new: the pending tab | +120 |
| `frontend/src/features/residents/ResidentsPage.tsx` | new: page and tabs | +72 |
| `frontend/src/features/residents/api.ts` | new: list query, decision mutation | +54 |
| `frontend/src/features/residents/residents.test.tsx` | new: 62 tests | +928 |
| `frontend/src/app/pages.ts`, `routes.tsx`, `routeScope.ts`, `MainNav.tsx` | route, `path`, `pagePath`, allowlist | +27 −7 |
| frontend/src/pages/Residents.jsx (deleted), `frontend/base44-baseline.txt` | legacy page deleted; 316 → 299 | −745 |
| `CLAUDE.md` | the size-estimate lesson, in rule 4 of "How to work a ticket" | +2 −2 |
| `docs/tickets/…` | frame, split, P4-08d | docs |

`frontend/src/features/residents/api.ts::useDecide`

```ts
  return useMutation({
    // Keyed by building, so a `building_not_found` here marks the building denied (app/buildingDenial.ts).
    mutationKey: [...requestsKey(buildingId), 'decide'],
    mutationFn: (decision: Decision) => {
      // ...
    },
    // Not returned: `mutateAsync` would wait for the refetch, and a slow list would hold back the dialog's answer
    // (review round 1, Codex F1).
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: requestsKey(buildingId) });
    },
  });
```

- Every outcome refreshes the list, including after the dialog or page unmounted (D3).
- Without the `mutationKey`, a `building_not_found` would not mark the building denied (`buildingDenial.ts`).
- Returning the promise again would bring back round 1 F1: a slow list keeps the dialog disabled.

`frontend/src/features/residents/DecisionDialog.tsx::DecisionDialog` (the handler)

```tsx
  const confirm = async () => {
    if (inFlight.current) return;
    const invalid = deny ? reasonError(reason) : null;
    setFieldError(invalid);
    if (invalid) return field.current?.focus();
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    // The button about to be disabled would drop focus to <body> in a browser.
    root.current?.focus();
    try {
      await decide.mutateAsync(deny ? { kind, id: request.id, reason } : { kind, id: request.id });
    } catch (error) {
      inFlight.current = false;
      if (!mounted.current) return;
      setBusy(false);
      const ended = refusal(error, request);
      if (ended) return onClose(ended);
      const placed = deny ? serverFieldErrors(error, ['reason'], { reason: REASON_MESSAGES }) : null;
      if (placed) {
        setFieldError(placed[0].message);
        return field.current?.focus();
      }
      return setFailure(rateLimitMessage(error) ?? `Could not ${kind} the request. Try again.`);
    }
    if (!mounted.current) return;
    const message = deny ? `${request.full_name}’s request was denied.` : `${request.full_name} was approved.`;
    onClose({ message, decided: true });
  };
```

- The ref is checked first: two clicks in one tick both run before React re-renders the disabled button, and only
  the first passes. Without it, `sends one approve on a double-click…` sends two POSTs (inferred from the test's
  setup; no mutation probe was run on this line).
- `mounted` stops an answer from closing a dialog that's already gone (criterion 11); the refresh still happens in
  `useDecide`.

`frontend/src/features/residents/DecisionDialog.tsx::refusal`

```tsx
  if (error.status === 409 && error.code === 'already_decided') {
    return { message: 'Already decided by someone else.', decided: true };
  }
  // ... membership_not_pending (decided: true), onboarding_request_not_found (decided: true)
  if (error.status === 409 && error.code === 'unit_inactive') {
    const unit = unitName(request.tower, request.unit_label);
    return { message: `Unit ${unit} is no longer active, so this request can’t be approved. Deny it instead.`, decided: false };
  }
```

- `decided` tells the caller where focus goes: the row stays for `unit_inactive` (the manager should deny it), so
  focus returns to its button.

`frontend/src/features/residents/PendingRequests.tsx::PendingRequests` (focus and paging)

```tsx
  const [focusTo, setFocusTo] = useState<{ target: HTMLElement | 'message' } | null>(null);
  useEffect(() => {
    if (focusTo) (focusTo.target === 'message' ? messageRef.current : focusTo.target)?.focus();
  }, [focusTo]);

  const close = (outcome: Outcome | null) => {
    if (outcome) setMessage(outcome.message);
    const back = !outcome?.decided && open?.opener.isConnected ? open.opener : null;
    setFocusTo({ target: back ?? 'message' });
    setOpen(null);
  };
  // ...
        <button
          type="button"
          disabled={requests.isFetching}
          onClick={() => void requests.fetchNextPage({ cancelRefetch: false })}
```

- D5 for the focus; round 2 F1 for "Show more": `fetchNextPage()`'s default `cancelRefetch: true` aborted the
  decision's refresh and appended to the stale pages.

`frontend/src/features/residents/ResidentsPage.tsx::ResidentsPage` (the keyed panel)

```tsx
      <div key={`${buildingId}:${key}`} role="tabpanel" id="residents-panel" aria-labelledby={`residents-tab-${tab}`} className="mt-4">
        {tab === 'pending' ? (
          <PendingRequests />
        ) : (
          <p className="text-slate-600">Member administration is coming in a later update.</p>
        )}
      </div>
```

- A new history entry (a tab change, Back) or building remounts the panel, so an open dialog or a message never
  follows the user; the tablist sits outside the key and keeps focus.

## 5. Edge cases and tests

All tests are in `frontend/src/features/residents/residents.test.tsx` unless named otherwise.

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Double-click sends two decisions | ref guard + disabled buttons | `sends one approve on a double-click, with the button disabled until the answer`; `sends one deny on a double-click` |
| A colleague decided first | 409 → closes, "Already decided by someone else.", refetch | `%s answered %i %s: closes, says so and asks for the list again` (already_decided rows) |
| Membership changed / unit inactive / request gone | own messages; unit_inactive keeps the row and focuses its button | same table (membership_not_pending, unit_inactive, onboarding_request_not_found rows); `names a towered unit in the unit_inactive message` |
| 429, 500, network, unknown 409 | dialog stays, alert, button works again | `approve: %s keeps the dialog open with a message, and the button works again`; `deny: a 500 keeps the reason…` |
| Reason too short, too long (code points), line break, ZWSP, U+2028 | refused before sending; edit clears the error | `refuses a reason that is %s and sends nothing`; `accepts exactly 500 code points…` |
| Server 422 on the reason | placed by type, text kept | `places a 422 %s on the reason and keeps the text` |
| Slow list refresh after a decision | answer shown at once | `%s: closes and says so while the refresh is still out`; `a 500 re-enables the dialog while the refresh is still out` |
| Tab escapes the modal | wraps from any focus inside | `keeps Tab inside the dialog`; `%s from the alert a failure focused goes to the %s button`; `%s from the dialog itself while a denial is sent…` |
| Leaving or Back during a decision | nothing shows on the new screen; refresh still happens | `an answer after leaving the page changes nothing…`; `Back to the Members tab while a decision is in flight…`; `Back to the previous tab while a dialog is open closes it…`; `a message from one history entry doesn't show on another` |
| Building switch | home, then the other building's list; Maple's queries removed | `a building switch shows the other building's list and closes the dialog`; `a building switch while a decision is in flight…` |
| Building denied on a decision | `building_not_found` marks it denied | `building_not_found on a decision marks the building denied…` |
| Refetch drops the open dialog's row | dialog unchanged, server's 409 decides | `keeps the dialog on its request when a refetch drops the row…` |
| "Show more" cancels a refresh | disabled during any fetch | `after a decision, Show more waits for the refresh…`; `Show more is disabled during any refetch…`; `a decision while Show more is loading…` |
| Non-manager opens the page | `/403`, no list request | `sends a %s to /403 without asking for the list` |
| Focus after a decision in a real browser | message focused | No automated test (jsdom); Chromium transcript in the PR |
| Paging after a **failed** refresh | hides the error, keeps the decided row | No test; open finding (round 3 F1, §7) |

**Acceptance criteria → tests:**
1. double-click tests; the 409 `already_decided` rows. 2. Chromium transcript (375 px, `scrollWidth 375` for list and
both dialogs). 3. `shows Page not found at the legacy /Residents path`; ratchet output `299 (baseline: 299)`.
4. `lists the pending requests for a manager…`, `links the nav's Residents item…`, `marks the Residents item current…`,
`sends a %s to /403…`. 5. the three tab tests. 6. the three list-state tests. 7. `approves after confirming…`,
`Cancel and Escape send nothing…`, `keeps Tab inside the dialog`. 8. the deny tests above. 9. the refusal table.
10. the failure tests. 11. the leaving/Back tests. 12. the building tests. 13. the refetch test.

## 6. Review log

Reviewer for every round: Codex `gpt-6.1-sol`, effort high, the only reviewer at James's instruction in the session.

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex gpt-6.1-sol | `72a8947` | MERGE | F1 Medium: list refresh blocks the dialog's answer; F2 Medium: Shift+Tab escapes from the alert or dialog root | both fixed in `c82728b` |
| 2 | Codex gpt-6.1-sol | `c82728b` | MERGE | F1 Medium: "Show more" cancels the decision's refresh, decided row stays | fixed in `b92b8c5` |
| 3 | Codex gpt-6.1-sol | `b92b8c5` | MERGE | F1 Medium: paging after a failed refresh hides the error, decided row stays | open at merge, carried to P4-08d |

- **R1 F1.** POST answered 200 or 500 while the list GET stalled → the dialog stayed disabled with no message.
  Codex's proof failed on `72a8947`; the four "review round 1 … (F1)" tests failed before and pass after D3's
  change.
- **R1 F2.** After a 500 focuses the alert, or while sending focuses the dialog root, Shift+Tab reached a row
  button (also seen in Chromium by Codex). The four "(F2)" tests failed before and pass after; `onKeyDown` now wraps
  whenever focus is not on a tabbable control.
- **R2 F1.** Decision → refresh out → "Show more" → `fetchNextPage()` aborted the refresh and appended a page: the
  approved request stayed listed. Two "review round 2" tests failed before and pass after; the reverse order
  passed already.
- Before review, the stack run found D5 (focus to `<body>`) and a stale reason error after editing; both fixed.

## 7. Not verified, accepted risks and follow-ups

- **Open finding (round 3 F1, Medium):** after a decision whose refresh fails, "Show more" loads an older page, the
  error and "Try again" disappear, and the decided request stays listed until the next refetch. The server still
  refuses a second decision (409). Proposed fix: no "Show more" while `isRefetchError`. Tracked in P4-08d (added in
  the bookkeeping commit).
- **Layout and real-browser focus** (criterion 2, D5) are proved only by the Chromium runs recorded in the PR, not by
  an automated test. The second run (after round 1) repeated the whole journey; the resident `/403` check ran as a
  separate script both times because resident1 has two buildings in that dev database.
- **No mutation probe** was run; the tests' power rests on having failed before each change.
- The modal doesn't make the page behind `inert` (D2).
- **Size:** 482 added non-test lines against a ~400 estimate (pattern "size estimate too low", third time; logged in
  `docs/AGENT_MISTAKES_LOG.md` in the bookkeeping commit).
- Follow-ups in P4-08d: the nav badge, the carried P4-08a round 3 items, the `AcceptInvitePage` race, the four
  `AccountMenu` Lows, and round 3 F1 above.

## 8. How to change this safely

- **Another tab's content (P4-08c):** replace the Members placeholder in `frontend/src/features/residents/ResidentsPage.tsx::ResidentsPage`; keep it
  inside the keyed panel. The tab tests check the placeholder text and will need updating.
- **Another decision or error code:** add it to `refusal` (ends the dialog) or let it fall to the generic alert; add a
  row to the refusal or failure `it.each` tables.
- **Another migrated page:** give its `PAGE_ACCESS` row a `path`, add the route next to `/manage/residents` in
  `frontend/src/app/routes.tsx::AppRoutes`, and remove its name from `DEMO_PAGES`; `nav.test.tsx` checks order and labels.
- **Anything that refetches or pages the list:** keep `useDecide`'s invalidation un-awaited and keep "Show more" off
  while a fetch is out; the round 1 and round 2 tests fail otherwise.

## 9. Must explain, then quiz

**1. Why disable the button *and* rely on the server's conditional update?**
They guard different things. The client guard (`frontend/src/features/residents/DecisionDialog.tsx::DecisionDialog`'s `inFlight` ref, then `disabled`)
stops one manager's double-click from sending two POSTs; the ref matters because two clicks in one tick both run
before React re-renders the disabled button. But the client can't see another manager's browser: two managers can
each send one approval. Only the database can order those. `backend/app/onboarding/service.py::_decide` updates the
request `WHERE status = 'pending'`; the second transaction waits on the row lock, then matches nothing and gets 409
`already_decided`, which the dialog turns into "Already decided by someone else." and a refresh. So the button is UX
(no duplicate work, clear feedback), and the conditional update is correctness.

**Quiz**

1. Why does the list refresh live in `useDecide`'s `onSettled` rather than in `DecisionDialog`'s `confirm`?
2. A manager opens Approve on Robin; meanwhile a focus refetch removes Robin's row. What does the dialog show, and what
   happens on Confirm?
3. Why is the tab panel keyed by `location.key` while the tablist is not?
4. What would break if `useDecide`'s `onSettled` returned `queryClient.invalidateQueries(...)` again?
5. How would you extend the deny dialog to let managers pick from preset reasons?

<details><summary>Answers</summary>

1. Hook-level mutation callbacks run even after the component unmounts, so leaving the page mid-decision still
   refreshes the list (criterion 11); a 409 also needs the refresh, because the list changed under the manager.
2. The dialog still shows Robin (it keeps the request it was opened with). Confirm sends the POST; the server answers
   409 `already_decided`, the dialog closes, "Already decided by someone else." shows and is focused.
3. A new history entry must not keep an open dialog or an old message, so the panel remounts; the tablist must keep
   the focused tab element across the URL change, so it isn't remounted.
4. `mutateAsync` would wait for the refetch, so a slow or stalled list would keep the dialog disabled with no success
   or error message (round 1 F1); the round 1 F1 tests would time out.
5. Add the presets in `DecisionDialog` (buttons or a select that fills `reason`), keep `reasonError` as the single
   check, and add rows to the deny tests; the API needs no change since `reason` stays free text.

</details>
