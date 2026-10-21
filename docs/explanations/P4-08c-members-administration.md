# Explanation — P4-08c Members list, suspend, reactivate, move out

> **PR:** #100 · **Source revision:** `a10f43b`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (1) reviewed `3db116f`; the commits after it are the round 1
> fixes (`c55f93f` tests, `53db4bb` F1 fix) and a comment-only change (`a10f43b`).
> **Merge commit:** not known when written; after the merge, `gh pr view 100 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `a10f43b` the diff (`git diff origin/main...HEAD`, every non-test path), `Members.tsx`,
> `MemberDialog.tsx`, `Modal.tsx`, `reason.tsx`, `api.ts`, `ResidentsPage.tsx`, the assertions of the tests cited in §5,
> the PR body (0 comments, 0 reviews on GitHub; the review is in the body). Ran `npx vitest run src/features/residents`:
> `Tests 122 passed (122)`; `pytest tests/memberships/test_members_concurrency.py -k stale_manager_cannot_move`:
> `6 passed`. The pass found `useMembers`'s comment still claiming distinct keys alone reset paging (false after F1);
> fixed in `a10f43b`. Differences from the plan: see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: B.

## 1. What was built and why

The "Members" tab of `/manage/residents` used to say "Member administration is coming". It now lists the building's
members (filter by role and status, search by name or email, "Show more" for further pages), and a property manager
can suspend, reactivate or move out a member through a confirmation dialog. Every refusal the three endpoints document
(`last_manager`, `cannot_target_self`, `invalid_transition`, `occupancy_changed`, `member_not_found`) gets its own
message. The roles editor and the unit transfer were split off to P4-08e while framing, to keep the PR near the size
limit (it still came in over: §2). The two decisions that matter most: the server's conditional update decides every
race (the dialog keeps the member it was opened with and the list is refetched after every outcome), and the modal
shell and reason rules are shared with P4-08b's decision dialog instead of copied.

## 2. Decisions

### D1. Split the roles editor and the transfer to P4-08e

- **Problem or constraint:** the playbook's ~400 non-test-line limit; P4-08b's dialog had come in ~40% over its
  estimate.
- **Chosen:** P4-08c keeps the list, filters, search and the three status actions (estimated ~385); P4-08e
  (`docs/tickets/P4-08e-member-roles-and-transfer.md`) gets the roles editor and the transfer (~200).
- **Alternatives rejected:** everything in one PR (~585, over the limit); the list alone (nothing in it exercises the
  ticket's error codes).
- **Tradeoffs and accepted limitations:** the ticket's original criterion 1 (last manager removing their own role)
  moved unchanged to P4-08e; here `last_manager` is only reachable from the suspend / move-out race.
- **Basis:** playbook step 1.4 (autonomous). **Source:** recorded (ticket Frame notes, PR D1).

### D2. One status dialog; the modal shell and the reason rules shared with `DecisionDialog`

- **Problem or constraint:** three new confirmations next to P4-08b's two, all modal with the same keyboard rules,
  and two of them taking the same `Reason` type (`backend/app/memberships/schemas.py` imports it from
  `backend/app/onboarding/schemas.py`).
- **Chosen:** `frontend/src/features/residents/Modal.tsx::Modal` (backdrop, `role="dialog"`, `aria-modal`, Escape
  unless busy, Tab kept inside) and `frontend/src/features/residents/reason.tsx::ReasonField` / `reasonError` /
  `REASON_MESSAGES`, both taken out of `DecisionDialog`; one `MemberDialog` with a `kind`.
- **Alternatives rejected:** copying `DecisionDialog` (P4-08b's round 1 Tab-trap fix would live in two places); a UI
  kit dialog (a new dependency for one pattern).
- **Tradeoffs and accepted limitations:** it touches P4-08b's dialog; P4-08b's 62 tests ran unchanged and passed after
  the refactor (PR "Deviations"; and in the suite of 122 now).
- **Basis:** convention (reuse, no UI kit), autonomous. **Source:** recorded (PR D2).

### D3. The search form wraps below the selects; the message wraps (found on the stack run)

- **Problem or constraint:** criterion 2 (375 px, a 176-character unbroken name, a 254-character email). The first
  Chromium run overflowed: `scrollWidth 470` (the search form, `flex-1 min-w-0`, shrank beside the selects; its
  button ended at x=470) and `scrollWidth 1467` after an action (the outcome message, which names the member, had no
  `overflow-wrap`).
- **Chosen:** the form gets `flex-[1_1_15rem] min-w-0` (a 15rem basis makes it wrap in the `flex-wrap` row); the
  message gets `[overflow-wrap:anywhere]` like the rows.
- **Alternatives rejected:** always stacking the filters (wastes desktop width).
- **Tradeoffs and accepted limitations:** jsdom has no layout, so the unit test checks only the class; the proof is
  the second stack run (every step `scrollWidth 375`). P4-08b's `PendingRequests` message has the same missing class
  (carried to P4-08d).
- **Basis:** experiment on the stack. **Source:** recorded (PR D3).

### D4. Going back to a filter combination starts from its first page (review round 1, F1)

- **Problem or constraint:** each filter combination is its own React Query entry
  (`frontend/src/features/residents/api.ts::membersListKey`). React Query refetches *every* loaded page of an infinite
  query when it is shown again, so returning to "All statuses" after "Show more" asked for two pages and showed both,
  against criterion 4.
- **Chosen:** `frontend/src/features/residents/Members.tsx::Members` routes every filter change through `applyFilters`,
  which removes the destination combination's cached entry (`removeQueries`, exact key) before switching to it, and
  does nothing when the combination is unchanged.
- **Alternatives rejected:** `gcTime: 0` on the list (would also drop the cache when the page is left, changing the
  abandoned-caller behaviour criterion 13 tests).
- **Tradeoffs and accepted limitations:** submitting the same search again does nothing (no refresh by re-submitting;
  window focus and "Try again" still refresh).
- **Basis:** review finding (round 1). **Source:** recorded (PR smaller decisions; Independent review F1).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Filters in component state | in the URL like the tab | more code; Back resets them as the panel is keyed by history entry | autonomous | PR |
| Search on submit | as you type with a debounce | a request per pause, a timer, answers to reconcile | autonomous | PR |
| Default "All" filters | active only | the API's default; a manager must find suspended and moved-out members | P4-06a list default | PR |
| Own row keeps its buttons | hide by `/me` user id | duplicates the server's `cannot_target_self`, which criterion 10 shows | autonomous | PR |
| Pending rows have no action | approve / deny here too | decided in "Pending requests" | ticket scope | PR |
| A list 422 is shown on the search field | a list error | the selects only send valid values, so only `search` can be refused | autonomous | PR |
| Cancel with the row gone focuses the tab's `sr-only` heading | the empty, `display: none` message | focus would drop to `<body>` | autonomous | PR |
| Every outcome invalidates the list from the mutation | from the dialog | the answer can come after the dialog or page is gone | convention (P4-08b D3) | PR |

**Framing changes:** criterion 2 sharpened (inputs, browser); 1 and 3–15 added (the `last_manager` path this ticket
can reach, list / filters / search / actions by status, each dialog, one request, every documented code, generic
failures, the two P4-08b list-refresh findings applied from the start, leaving and switching, a refetch under an open
dialog, the carried backend test). None loosened; the original criterion 1 moved unchanged to P4-08e.

**Plan versus final code:** (1) size: 638 added / 113 removed non-test lines against ~385 (`Members.tsx` 256 lines
against ~170), not split again (PR "Deviations"); (2) D3's wrapping classes, after the stack run; (3) D4's
`applyFilters` and the exported `membersListKey`, after review round 1; (4) four P4-08b tests now assert the Members
panel instead of the placeholder text (PR "Gate changes"). Otherwise the files, hooks, keys and error mapping are as
planned.

## 3. How it is implemented

### Overview

- `ResidentsPage` renders `Members` in the Members tab (panel keyed by building and history entry, from P4-08b).
- `Members` owns the filters, the outcome message and which dialog is open; `useMembers` fetches the list.
- `MemberDialog` confirms one action; `useMemberAction` sends it and invalidates `['b', id, 'members']` on any outcome.
- `Modal` and `ReasonField` are shared with `DecisionDialog`.

### Walkthrough (variant B: suspend a member)

1. **The action.** On `/manage/residents?tab=members`, `frontend/src/features/residents/Members.tsx::Members` renders
   each row's buttons from `ACTIONS[member.status]` (`active` → Suspend, Move out; `suspended` → Reactivate, Move out;
   others none). "Suspend Robin Park" stores `{ kind, member, opener }` in `open` and clears the old message.
2. **Form and validation.** `frontend/src/features/residents/MemberDialog.tsx::MemberDialog` focuses the reason field.
   On Confirm, `confirm` takes the `inFlight` ref first (a second click in the same tick returns), then
   `frontend/src/features/residents/reason.tsx::reasonError` checks what the server's `Reason` refuses: `Cc`/`Cf`/`Zl`/`Zp` characters, then 3–500
   code points after trimming. The reason is sent as typed; the server strips it.
3. **Hook.** `frontend/src/features/residents/api.ts::useMemberAction`, mutation key `['b', buildingId, 'members', 'action']`.
4. **API call.** `members_suspend` (`POST /api/buildings/{building_id}/members/{membership_id}/suspend`, body
   `{reason}`); `members_reactivate` has no body; `members_deactivate` takes `{reason}`.
5. **Response handling.** Success → `onClose("<name> was suspended.")`. A refusal from `frontend/src/features/residents/MemberDialog.tsx::refusal`
   (404 `member_not_found`; 409 `last_manager`, `cannot_target_self`, `invalid_transition`, `occupancy_changed`) closes
   the dialog with its message. A 422 on `reason` is placed on the field by its `type`. Anything else (429 with its
   wait, 500, network, an unknown 409, 403) stays open with "Could not suspend <name>. Try again." and the button works
   again. A `building_not_found` is recorded by the client's mutation cache (`buildingDenial.ts`), since the key starts
   `['b', id]`. If the dialog unmounted meanwhile (`mounted` ref), nothing is set.
6. **Cache.** `onSettled` invalidates `['b', buildingId, 'members']`: every filter combination, whatever the outcome,
   even after the component is gone. It isn't returned, so the dialog's answer doesn't wait for the refetch.
7. **States.** `frontend/src/features/residents/Members.tsx::close` puts focus on the message when there is one, else back on the opener, else on the
   tab's `sr-only` heading. The list shows loading, "Could not load the members." / "Could not refresh the members."
   with Try again (above the old rows), "No members match.", and "Show more" only when no fetch is out and the last
   refresh didn't fail. At 375 px everything wraps (D3).

### Data model changes

None (frontend only, plus one backend test case).

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `frontend/src/features/residents/Members.tsx` | new: the tab | +256 |
| `frontend/src/features/residents/MemberDialog.tsx` | new: the status dialog | +151 |
| `frontend/src/features/residents/api.ts` | `useMembers`, `useMemberAction`, types, keys | +69 |
| `frontend/src/features/residents/reason.tsx` | new: reason rules and field (from `DecisionDialog`) | +64 |
| `frontend/src/features/residents/Modal.tsx` | new: modal shell (from `DecisionDialog`) | +51 |
| `frontend/src/features/residents/DecisionDialog.tsx` | uses `Modal` and `ReasonField` | +46 / −108 |
| `frontend/src/features/residents/ResidentsPage.tsx` | Members panel renders `Members` | +2 / −5 |
| `frontend/src/features/residents/members.test.tsx` | new: 60 tests | +890 |
| `frontend/src/features/residents/residents.test.tsx` | placeholder assertions → Members panel | +11 / −5 |
| `backend/tests/memberships/test_members_concurrency.py` | `[noop]` case | +9 / −7 |
| `docs/tickets/…` | frame, P4-08e split, index | +173 / −22 |

`frontend/src/features/residents/Members.tsx::applyFilters`

```tsx
  // Each combination starts from its first page: the cached pages of an earlier visit would all be fetched again
  // (review round 1, Codex F1). The current combination is left alone, so the same search again changes nothing.
  const applyFilters = (change: Partial<MemberFilters>) => {
    const next = { ...filters, ...change };
    if (next.role === filters.role && next.status === filters.status && next.search === filters.search) return;
    queryClient.removeQueries({ queryKey: membersListKey(buildingId, next), exact: true });
    setFilters(next);
  };
```

- Every filter change (both selects and the search form) goes through it. Without the `removeQueries` line, going
  back to a combination refetches all its loaded pages (D4; the three `back to a combination after …` tests fail).
  Without the early return, re-submitting the current search would remove the query the list is watching.

`frontend/src/features/residents/MemberDialog.tsx::refusal`

```tsx
function refusal(error: unknown, kind: MemberActionKind, member: Member): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 404 && error.code === 'member_not_found') return 'This member is no longer in this building.';
  if (error.status !== 409) return null;
  switch (error.code) {
    case 'last_manager':
      return 'The building must keep at least one active property manager, so this wasn’t done.';
    case 'cannot_target_self':
      return kind === 'deactivate' ? 'You can’t move yourself out.' : 'You can’t suspend yourself.';
    case 'invalid_transition':
      return `${member.full_name}’s status changed in the meantime, so this wasn’t done. Check the list and try again.`;
    case 'occupancy_changed':
      return `${member.full_name}’s unit changed at the same time, so this wasn’t done. Check the list and try again.`;
  }
  return null;
}
```

- These are the answers that mean "the member can't be changed as you saw it", so the dialog closes and the
  refetched list shows the truth. An unknown 409 returns `null` and gets the generic retry message instead.

`frontend/src/features/residents/MemberDialog.tsx::confirm` (inside `MemberDialog`)

```tsx
  const confirm = async () => {
    if (inFlight.current) return;
    const invalid = withReason ? reasonError(reason) : null;
    setFieldError(invalid);
    if (invalid) return field.current?.focus();
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    // The button about to be disabled would drop focus to <body> in a browser.
    root.current?.focus();
    try {
      const id = member.membership_id;
      await act.mutateAsync(kind === 'reactivate' ? { kind, id } : { kind, id, reason });
    } catch (error) {
      inFlight.current = false;
      if (!mounted.current) return;
      setBusy(false);
      const ended = refusal(error, kind, member);
      if (ended) return onClose(ended);
      // ...422 on `reason` placed on the field; otherwise the 429 wait or "Could not <verb> <name>. Try again."
    }
    if (mounted.current) onClose(`${member.full_name} ${copy.done}`);
  };
```

- The ref guard comes first because a second click in the same tick still sees the button enabled (React hasn't
  re-rendered `disabled` yet). `member` is the object captured when the dialog opened, so a refetch that changes or
  drops the row doesn't change what is sent (criterion 14).

`frontend/src/features/residents/api.ts::useMemberAction`

```ts
  return useMutation({
    // Keyed by building, so a `building_not_found` here marks the building denied (app/buildingDenial.ts).
    mutationKey: [...membersKey(buildingId), 'action'],
    mutationFn: (action: MemberAction) => {
      // ...reactivate (no body), suspend or deactivate ({ reason })
    },
    // Not returned, so `mutateAsync` doesn't wait for the refetch (P4-08b round 1, Codex F1).
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: membersKey(buildingId) });
    },
  });
```

- The invalidation lives in the hook's options, which outlive the component: an answer that arrives after the page
  was left still marks the list stale (criterion 13).

`frontend/src/features/residents/Members.tsx::Members` ("Show more")

```tsx
      {members.hasNextPage && !members.isRefetchError && (
        // Not while any fetch is out, nor after a failed refresh: a next page would cancel the refresh, or clear its
        // error without repairing the first page (P4-08b review rounds 2 and 3).
        <button
          type="button"
          disabled={members.isFetching}
          onClick={() => void members.fetchNextPage({ cancelRefetch: false })}
```

## 5. Edge cases and tests

Tests are in `frontend/src/features/residents/members.test.tsx` unless noted; all ran (122 passed in the residents
folder).

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Double-click sends two actions | `inFlight` ref, then `disabled` | `%s: a double-click sends one request, the button disabled until the answer` (3 kinds) |
| A colleague changed or removed the member while the dialog was open | dialog keeps its member; server's 409/404 closes it with a message | `keeps the dialog on its member when a refetch changes the row / drops the row, and the server decides` |
| Two managers suspend each other | `last_manager` message, list refetched | `suspend / deactivate answered 409 last_manager: …` |
| Answer arrives after leaving the page | nothing shown; list still invalidated | `an answer after leaving the page changes nothing on the new one…`, `Back to the Pending tab while an action is in flight…` |
| Building switch mid-action | Birch shows nothing; Maple's list not recreated | `a building switch while an action is in flight…` |
| Refresh fails after an action | warning above old rows; no "Show more" until Try again works | `a failed refresh after an action warns above the old rows…` |
| "Show more" during a refetch | disabled | `Show more is disabled during any refetch (a focus refetch too)` |
| Back to an earlier filter combination | starts from page one | `back to a combination after the status filter / the role filter / the search…` |
| Search with a control character | refused client-side; a server 422 shown on the field | `refuses a search with a control character and sends nothing`, `shows the same message for a 422 on the search` |
| Reason invalid | field message, nothing sent | `%s: %s refuses the reason and sends nothing`, `places a 422 on the reason by its type…` |
| Focus after close | message, opener, or heading | criterion 9 and 10 tests assert `document.activeElement`; stack run checked Chromium |
| Long name / email at 375 px | wraps | stack run (D3); `wraps the outcome message…` (class only) |
| Stale manager's no-op transfer (backend) | 403 / 404, nothing written | `backend/tests/memberships/test_members_concurrency.py::test_stale_manager_cannot_move_a_member` `[*-noop]`; mutation probe `2 failed, 4 passed` |

Acceptance criteria → tests:
1. `last_manager` rows of `%s answered %i %s: closes, says so…`.
2. Stack run at 375 px (PR transcript); `wraps a long name and a 254-character email…`, `wraps the outcome message…`.
3. `lists the members newest first with status, roles, unit, relationship and reason`, `says when no member matches`,
   `offers Try again when the list fails…`, `shows more with next_cursor…`.
4. `sends the role and status filters, combined with the search…`, `offers all roles and all statuses`, `searches on
   Enter, and leaves an empty (or blank) search out`, `can't take more than 100 characters`, the two search-refusal
   tests, the F1 tests.
5. `offers Suspend and Move out on active rows…`.
6. `suspends with the reason as typed…` and the reason tests. 7. `reactivates after confirming, with no body`.
8. `moves out with a reason, saying the occupancy ends`, `names no unit for a member without one`.
9. double-click table, `Cancel and Escape send nothing and return focus…`, `keeps Tab inside the dialog`.
10. `%s answered %i %s: closes, says so and asks for the list again` (11 rows). 11. `move out: %s keeps the dialog
    open…`, `%s: a 500 says what failed`. 12. the two refresh / Show more tests. 13. the four leaving / switching
    tests and `building_not_found on an action marks the building denied…`. 14. the refetch table. 15. the `[noop]`
    backend cases.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol` (high), the only required reviewer at James's instruction for this run | `3db116f` | `MERGE` | F1 Medium: a return to a filter combination reloads all its pages; F2 Low: the server-422 test never reached the server; AC13 gap: no in-flight test with Back / building switch | F1 fixed `53db4bb` (tests `c55f93f`); F2 test rewritten `c55f93f`; AC13 tests added `c55f93f` (passed first time) |

- **F1.** Inputs: load two pages, set Status to Suspended, set it back to All. Wrong outcome: requests `['',
  '?cursor=page-2']` and two rows. Evidence: the three `back to a combination after …` tests failed (`3 failed | 57
  passed`) and pass after `53db4bb`. Produced D4.
- **F2.** The 422 test typed `Rob\u0085in`, which `onSearch` refuses before any request. Now it types `Robin`, the stub
  answers 422, and the test asserts `refused === 1`.

## 7. Not verified, accepted risks and follow-ups

- **No review of the fix commits.** Round 1 reviewed `3db116f`; `c55f93f`, `53db4bb` and `a10f43b` were not
  re-reviewed (the round already said `MERGE`; the fixes are a Medium and a Low with failing-then-passing tests).
- **Layout only in one browser run.** Wrapping (criterion 2) was checked in Chromium 1200 on the dev stack, not in
  Safari or Firefox, and jsdom tests check classes only.
- **Focus in a real browser** was checked on the stack for suspend, reactivate, Escape, the colleague refusal and move
  out; the Cancel-with-row-gone fallback to the heading is tested only in jsdom (and only indirectly).
- **Same search again** doesn't refresh (D4).
- **Size over the limit** (638 / 113 against ~400): tracked in `docs/AGENT_MISTAKES_LOG.md` in the bookkeeping commit.
- **P4-08b's `PendingRequests` message** lacks `overflow-wrap` (D3): carried to P4-08d in the bookkeeping commit.
- **Roles editor, transfer, original criterion 1:** P4-08e (`docs/tickets/P4-08e-member-roles-and-transfer.md`).

## 8. How to change this safely

- **Add an action** (P4-08e's roles or transfer): add its kind to `frontend/src/features/residents/api.ts::MemberAction` and `useMemberAction`, its
  copy to `frontend/src/features/residents/MemberDialog.tsx::COPY` (or a separate dialog using `Modal`), its codes to `refusal`, and the status that
  allows it to `frontend/src/features/residents/Members.tsx::ACTIONS`. The criterion 9–14 tests are tables over the kinds: add rows.
- **Add a filter:** add it to `MemberFilters` (the query key changes with it), `useMembers`' query, and route its control
  through `applyFilters`; the F1 tests show the pattern.
- **Touch `Modal` or `reason.tsx`:** both dialogs depend on them; run both test files (`residents.test.tsx`,
  `members.test.tsx`).

## 9. Must explain, then quiz

**1. Why does every outcome (success or refusal) ask for the list again, from the mutation and not the dialog?**
Success changes the row's status; a refusal (`invalid_transition`, `member_not_found`, `last_manager`) means the list
the manager saw is out of date. Either way the server's list is the truth. The invalidation is in
`frontend/src/features/residents/api.ts::useMemberAction`'s `onSettled`, which runs even when the dialog or the whole page has unmounted (the
component's `mounted` ref only stops it from setting state). If the dialog did it, an answer arriving after Back or a
building switch would leave a stale list cached (criterion 13).

**2. Why may "Show more" not run while the list's refresh is out or has failed?** A next-page fetch while a refresh is
out would either cancel it or append to the old pages, leaving a changed member shown as before (P4-08b round 2). After
a failed refresh, a successful next page clears the query's error without repairing the first page, so the warning
disappears while the stale rows stay (P4-08b round 3). `frontend/src/features/residents/Members.tsx::Members` hides the button while `isRefetchError`
and disables it while `isFetching`.

Quiz:

1. Two managers have the same member's dialog open; both press Suspend. What does each see, and why?
2. Why is the in-flight guard a ref and not just the button's `disabled`?
3. A manager loads two pages, filters by Council, then sets the role back to All roles. How many list requests follow
   the last change, and which line makes that so?
4. What would break if `useMemberAction` returned the `invalidateQueries` promise from `onSettled`?
5. How would you add the transfer action (P4-08e) to this screen?

<details><summary>Answers</summary>

1. One request wins the server's conditional `UPDATE … WHERE status = 'active'`: that manager sees "<name> was
   suspended."; the other gets 409 `invalid_transition`, so `refusal` closes the dialog with "…status changed in the
   meantime…", and both lists refetch.
2. Two clicks in the same tick run before React re-renders the button disabled; the ref is set synchronously at the
   top of `confirm`, so the second call returns.
3. One, for the first page: `applyFilters`' `removeQueries` drops the cached "All roles" combination, so it starts
   fresh instead of refetching both pages.
4. `mutateAsync` would wait for the list refetch before resolving, so a slow list would hold the dialog open after the
   server had answered (P4-08b round 1, F1).
5. A `transfer` kind in `MemberAction` / `useMemberAction` (`members_transfer` with `{unit_id, relationship}`), a dialog
   with a unit search over `GET /units?active=true` and a relationship select (using `Modal`), its codes
   (`not_a_resident`, `unit_inactive`, `unit_not_found`, `membership_not_active`, `occupancy_changed`) in its refusal
   mapping, and "Transfer unit" in `ACTIONS.active` for members holding `resident`; then add rows to the criterion 9–14
   test tables.

</details>
