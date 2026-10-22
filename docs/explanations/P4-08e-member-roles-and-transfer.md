# Explanation — P4-08e Member roles editor and unit transfer

> **PR:** #107 · **Source revision:** `9b05314`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (2) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 107 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `9b05314` the diff (`git diff origin/main...HEAD`, every non-test path),
> `RolesDialog.tsx`, `TransferDialog.tsx`, `api.ts`, `Members.tsx`, `MemberDialog.tsx`, `Modal.tsx`, the
> `useDebounced` move, `BuildingProvider`'s roles effect, the assertions of the tests cited in §5, and the PR body
> (the review is in the body). Ran `npx vitest run src/features/residents src/features/onboarding src/app/building.test.tsx`:
> `Tests 279 passed (279)`; `make check DB_PORT=55432` at `9b05314`: exit 0. Differences from the plan: see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: B.

## 1. What was built and why

The "Members" tab (P4-08c) let a manager suspend, reactivate and move out members. It now also lets them change an
active member's roles ("Change roles") and move a resident to another unit ("Transfer unit"). Both call endpoints
that already existed (`members_roles_update`, `members_transfer`, P4-06a/b), so the PR is frontend only. Every
refusal those endpoints document reads as a message. A change to one's own membership asks for `/me` again, and the
nav and page guards follow from that. The two decisions that matter most: the roles change is sent as a diff from
the roles the dialog showed when it opened (D1), and the `/me` refresh runs from the mutation after every outcome (D2).

## 2. Decisions

### D1. Roles sent as `{add, remove}` computed from the dialog's snapshot

- **Problem or constraint:** the list can refetch while the dialog is open (window focus, another action), and
  the API takes a diff, not a full set (`backend/app/memberships/service.py::change_roles` ignores a role already
  held in `add` or not held in `remove`).
- **Chosen:** the checkboxes start from `member.roles` as the row was when opened, and Save sends `add` = ticked
  roles that row didn't list and `remove` = listed roles now unticked, both in `Role`'s declaration order
  (`frontend/src/features/residents/RolesDialog.tsx::RolesDialog`).
- **Alternatives rejected:** a diff against the latest list row (the manager would save a change they never saw);
  sending every role as add/remove (it would undo a change made elsewhere to a role this manager didn't touch).
- **Tradeoffs and accepted limitations:** if someone else changed the same role meanwhile, this manager's choice
  wins for it.
- **Basis:** ticket scope (`{add, remove}`); P4-08c convention (the dialog keeps the member it was opened with).
- **Source:** recorded (PR #107 D1).

### D2. `/me` refreshed from the mutation, after every outcome, when the member is the caller

- **Problem or constraint:** the nav and the role guards read the caller's roles from the building query, not
  `/me`. `frontend/src/app/BuildingProvider.tsx::BuildingProvider` asks for the building again when `/me` shows
  different roles. A change to oneself may answer after the page is gone, or fail on the network after it
  committed.
- **Chosen:** the dialog passes `self` (the row's `user_id` is `/me`'s user) in the mutation's variables;
  `frontend/src/features/residents/api.ts::useMemberChange`'s `onSettled` invalidates `['me']` when it is true,
  for success and failure alike.
- **Alternatives rejected:** invalidating in the dialog (lost when it unmounts); also invalidating the building
  query directly (BuildingProvider already does it from `/me`, so there's one path to keep).
- **Tradeoffs and accepted limitations:** the nav follows after two requests (`/me`, then the building).
- **Basis:** ticket ("A change to the manager's own roles refreshes `/me`"); P4-08c criterion 13's pattern.
- **Source:** recorded (PR #107 D2).

### D3. The unit list is stale at once (`staleTime: 0`)

- **Problem or constraint:** review round 1 F2: the client's default 30 s `staleTime` served a reopened dialog
  the units from before, so a unit deactivated meanwhile stayed selectable.
- **Chosen:** `frontend/src/features/residents/api.ts::useUnitOptions` sets `staleTime: 0`, as the members list.
- **Alternatives rejected:** `refetchOnMount: 'always'`: covers a reopened dialog but not going back to an earlier
  search inside the open one.
- **Tradeoffs and accepted limitations:** one more request per reopen or revisited search.
- **Basis:** review finding (round 1, Codex F2); the `CLAUDE.md` lesson this PR adds.
- **Source:** recorded (PR #107 "Independent review", round 1).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Two new dialogs beside `MemberDialog` | one dialog for all kinds | different fields; `MemberDialog` stays as tested | autonomous | PR table |
| "No change" / "no roles" checked before sending | let the server answer | a 422 `no_change` has no field to place; the 409 is still mapped for a race | autonomous | PR table |
| "Transfer unit" only on rows listing Resident | every active row | ticket scope | ticket | PR table |
| Debounced search, first page only | submit to search; "Show more" | the join form's convention (P4-08a); a prefix narrows | convention | PR table |
| `unit_not_found` / `unit_inactive` keep the dialog open | close with a message | another unit can be picked, as the join form | convention | PR table |
| Removing own Property manager ends on `/403` | a redirect elsewhere | ticket: "the guards follow" | ticket | PR table |
| Lessons in `CLAUDE.md` | a fitness test | not detectable statically without false positives | autonomous | PR table |
| Control characters checked on the raw text | after `trim()` | trimming hid a tab (round 1 F3) | review | PR review log |

**Framing changes:** criteria 1–2 sharpened (the message, what stays unchanged, the transfer's `last_manager`;
375 px with named inputs in Chromium); 3–15 added (buttons by row, each dialog and every documented code, `/me`
after a self change with P4-08d's badge follow-up, the unit search states, double-click/Cancel/Escape, generic
failures, leaving and switching, a refetch under an open dialog, the two lessons). None loosened. Criterion 5's
`resident_has_unit` message was reworded after framing (commit `57ae97a`, Frame notes): "transfer them" was wrong
advice, because a transfer keeps a unit.

**Plan versus final code** (also in the PR's "Deviations from the plan"):
- Size: 496 non-test lines added against a ~325 estimate (`TransferDialog` 209, `RolesDialog` 129). Not split, as
  P4-08b and P4-08c.
- Typing in the unit search clears the pick, as the join form does.
- `frontend/src/features/residents/MemberDialog.tsx::memberRefusal` (the plan's "shared closing messages") also maps `membership_not_active` for
  the status actions, whose routes never return it.
- After review round 1: the units refresh error, `staleTime: 0` and the raw-text control check (D3, §6).

## 3. How it is implemented

### Overview

- `frontend/src/features/residents/Members.tsx::kinds`: which buttons a row gets.
  `frontend/src/features/residents/Members.tsx::dialog` picks the dialog and passes `self`.
- `RolesDialog` and `TransferDialog`: own state, one request per confirm, refusals mapped to messages.
- `api.ts`: `useRolesChange` and `useTransfer` (both built by `useMemberChange`) and `useUnitOptions`.
- Shared: `Modal` (Tab trap now includes inputs), `memberRefusal`, `useDebounced` (moved from the join form).

### Walkthrough (variant B): a manager removes their own Property manager role

1. **Control.** On `/manage/residents?tab=members`, the manager's own active row has "Change roles"
   (`frontend/src/features/residents/Members.tsx::kinds`). Clicking it stores `{kind: 'roles', member, opener}`, and `frontend/src/features/residents/Members.tsx::dialog` renders
   `RolesDialog` with `self = member.user_id === useMe().data?.user.id`.
2. **Validation.** The four boxes start from the row's roles. On Save, nothing ticked shows "A member must keep at
   least one role." and nothing changed shows "Change at least one role."; neither sends a request.
3. **Hook.** `useRolesChange` → `useMemberChange` with mutation key `['b', buildingId, 'members', 'roles']`. Keyed
   by building, so a `building_not_found` marks the building denied (`frontend/src/app/buildingDenial.ts::recordBuildingDenial`).
4. **API call.** `POST /api/buildings/{building_id}/members/{membership_id}/roles` with `{add: [], remove:
   ['property_management']}`.
5. **Response.** 200: the dialog closes with "<name>'s roles were updated.", and focus goes to the message. 409
   `last_manager` (the only manager): it closes with the last-manager message. Other mapped codes close with their
   message; anything else (429, 500, network, an unknown 409) keeps the dialog open with an alert.
6. **Cache.** `onSettled` invalidates `['b', buildingId, 'members']` and, as `self` is true, `['me']`. The new
   `/me` has different roles for this building, so `BuildingProvider` invalidates `['b', buildingId,
   'building']`. With `my_roles` no longer holding `property_management`, `frontend/src/app/guards.tsx::RequireRole`
   redirects to `/403`, and the nav drops "Residents" with
   `frontend/src/features/residents/PendingBadge.tsx::ResidentsNavLabel`, so the badge's summary polling stops.
7. **States.** While the request is out, the checkboxes and buttons are disabled, focus sits on the dialog, and
   Escape does nothing.

The transfer works the same way, except that the unit list is a query: `useDebounced(search, 300)`, then
`useUnitOptions(buildingId, term, enabled)` with key `['b', buildingId, 'units', {active: true, search}]`. Results
show as radios, and the relationship radios start on the current relationship.

### Data model changes

None.

## 4. The code

| File | Change | Lines (+/−) |
|---|---|---|
| `frontend/src/features/residents/TransferDialog.tsx` | new: transfer dialog | +214 |
| `frontend/src/features/residents/RolesDialog.tsx` | new: roles dialog | +129 |
| `frontend/src/features/residents/api.ts` | hooks, `ROLE_LABELS` | +80 / −1 |
| `frontend/src/features/residents/Members.tsx` | buttons, dialog choice, `self` | +41 / −16 |
| `frontend/src/features/residents/MemberDialog.tsx` | `memberRefusal` exported | +18 / −4 |
| `frontend/src/features/residents/Modal.tsx` | Tab trap includes inputs | +2 / −2 |
| `frontend/src/features/onboarding/api.ts`, `JoinRequestForm.tsx` | `useDebounced` moved | +13, +1 / −12 |
| `CLAUDE.md` | two lessons, same 150 lines | +6 / −6 |
| `frontend/src/features/residents/roles.test.tsx` | new: 49 tests | +752 |
| `frontend/src/features/residents/members.test.tsx` | active row's four buttons | +1 / −1 |

`frontend/src/features/residents/api.ts::useMemberChange`

```ts
function useMemberChange<T extends { self: boolean }>(buildingId: string, kind: string, mutationFn: (variables: T) => Promise<Member>) {
  const queryClient = useQueryClient();
  return useMutation({
    // Keyed by building, so a `building_not_found` here marks the building denied (app/buildingDenial.ts).
    mutationKey: [...membersKey(buildingId), kind],
    mutationFn,
    onSettled: (_data, _error, variables) => {
      void queryClient.invalidateQueries({ queryKey: membersKey(buildingId) });
      if (variables.self) void queryClient.invalidateQueries({ queryKey: ['me'], exact: true });
    },
  });
}
```

- What it does: builds both mutations. After any outcome it asks for the members again, and for `/me` when the
  member is the caller.
- Why: D2. `self` rides in the variables, so `onSettled` still knows it after the dialog has unmounted.
- Without the `self` line, removing one's own Property manager would leave the nav and guards on the old roles
  until something else refreshed `/me` (test "removing one’s own Property manager: …" fails).

`frontend/src/features/residents/RolesDialog.tsx::RolesDialog` (the save)

```tsx
  const save = async () => {
    if (inFlight.current) return;
    const add = ROLES.filter((role) => checked.has(role) && !member.roles.includes(role));
    const remove = ROLES.filter((role) => !checked.has(role) && member.roles.includes(role));
    if (checked.size === 0) return setFailure({ message: 'A member must keep at least one role.' });
    if (add.length === 0 && remove.length === 0) return setFailure({ message: 'Change at least one role.' });
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    // The button about to be disabled would drop focus to <body> in a browser.
    root.current?.focus();
    try {
      await change.mutateAsync({ id: member.membership_id, add, remove, self });
    } catch (error) {
      inFlight.current = false;
      if (!mounted.current) return;
      setBusy(false);
      const ended = refusal(error, member);
      if (ended) return onClose(ended);
      return setFailure({ message: rateLimitMessage(error) ?? `Could not change ${member.full_name}’s roles. Try again.` });
    }
    if (mounted.current) onClose(`${member.full_name}’s roles were updated.`);
  };
```

- `member` is the prop captured when the dialog opened, never the refetched row (D1).
- `inFlight` is a ref, checked before React has re-rendered the button disabled, so a double-click sends one
  request.
- `mounted` stops a late answer from calling `onClose` on a page that has gone (criterion 12).

`frontend/src/features/residents/TransferDialog.tsx::TransferDialog` (search and pick)

```tsx
  const [search, setSearch] = useState('');
  // Checked before trimming, which would drop a leading or trailing tab (review round 1, Codex F3).
  const invalidSearch = CONTROL.test(search);
  const typed = useDebounced(search, DEBOUNCE_MS);
  const term = typed.trim();
  const units = useUnitOptions(buildingId, term, !invalidSearch && !CONTROL.test(typed));
  // ...
  const options = units.data?.items ?? [];
  // Only a unit the list shows counts: one picked in an earlier list may not be in this one (criterion 8).
  const chosen = options.some((unit) => unit.id === unitId) ? unitId : null;
```

- The query is off while either the current text or the debounced text has a control character, so no request
  with a trimmed-away tab goes out.
- `chosen` is derived on every render, so Transfer can't send a unit the list no longer shows. Typing also clears
  `unitId` (the input's `onChange`).

`frontend/src/features/residents/TransferDialog.tsx::unitGone` and the catch branch

```tsx
      if (unitGone(error)) {
        setUnitId(null);
        void units.refetch();
        return setFailure({ message: UNIT_GONE });
      }
```

- A unit deactivated, or not this building's, keeps the dialog: the pick is cleared and the units are asked for
  again. The stack run showed the deactivated unit leaving the list (PR evidence).

`frontend/src/features/residents/api.ts::useUnitOptions`

```ts
    queryKey: ['b', buildingId, 'units', { active: true, search }],
    // Stale at once, as the members list: a reopened dialog or an earlier search asks again, so a unit deactivated or
    // added meanwhile isn't served from the 30 s cache (review round 1, Codex F2; the CLAUDE.md lesson).
    staleTime: 0,
    enabled,
```

## 5. Edge cases and tests

All tests are in `frontend/src/features/residents/roles.test.tsx` unless named otherwise. I opened each and
confirmed its assertions.

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Only manager removes own role | 409 `last_manager` → message; row and nav unchanged | "the only manager removing their own role: last_manager, the row and the nav unchanged (criterion 1)" |
| Self change leaves nav stale | `/me` → building → `/403`, no Residents, no more summary polls | "removing one’s own Property manager: /me asked again, the nav loses Residents and its badge, the page goes to /403" |
| `/me` asked for others' changes | only when `self` | "a change to another member doesn’t ask for /me" |
| Network failure after commit | `/me` asked anyway | "a failed change to oneself still asks /me again (it may have been written)" |
| Self transfer | `/me` asked (occupancy) | "transferring oneself asks /me again (its occupancy)" |
| Empty or unchanged roles | message, no request | "with nothing changed says so and sends nothing; with nothing ticked says a role must stay" |
| Refetch changes the row under the dialog | snapshot diff only | "the roles dialog keeps the roles it opened with, and sends only what was changed in it" |
| Row dropped under the transfer dialog | server answers `member_not_found` | "a dropped row keeps the transfer dialog, and the server decides" |
| Stale pick after a new search | pick cleared | "a pick the new search doesn’t show is no longer picked" |
| Unit gone at confirm | dialog stays, pick cleared, units refetched | "%i %s keeps the dialog open, the unit no longer picked, …" (404, 409) |
| Units refresh fails with data | alert above kept units, Try again | "F1: %s on a refetch shows with Try again above the cached units" |
| Reopened dialog serves cached units | refetched | "F2: reopening the dialog asks for the units again, …" |
| Tab trimmed out of search | not sent | "F3: %s says so and sends nothing, though trimming would remove it" |
| Double-click | one request | "%s: a double-click sends one request; nothing closes the dialog until the answer" |
| Answer after leaving | nothing shown; list and `/me` invalidated | "an answer after leaving the page shows nothing on the new one; …" |
| `building_not_found` | building marked denied | "building_not_found on %s marks the building denied" |
| 375 px with a long name and email | fits | stack transcript in the PR (Chromium); no automated test |

Acceptance criteria → tests: 1 the last-manager tests above; 2 the stack transcript; 3 "active rows have Change
roles, …" and `members.test.tsx` "actions by status"; 4 the three "roles dialog" tests; 5 "roles refusals that end
the dialog"; 6 the four "own roles follow" tests; 7 the three "transfer dialog" tests; 8 "unit search states" plus
F1–F3; 9 "transfer refusals"; 10 "one request, Cancel and Escape"; 11 "failures that keep the dialog"; 12 "leaving
and switching"; 13 "a refetch under an open dialog"; 14–15 the `CLAUDE.md` diff (150 lines before and after).

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol` (high), the only reviewer (James's instruction for this run) | `57ae97a` | MERGE | F1 Medium: refresh error hidden; F2 Medium: reopened dialog reuses units; F3 Low: tab trimmed past the check | all fixed in `9b05314`, tests red first in `b29a3a7` |
| 2 | Codex `gpt-6.1-sol` (high), new invocation, whole diff | `9b05314` | MERGE | none | — |

- **F1.** A 429 on a units refetch after a first success left the cached list with no message and no retry.
  The error now shows above the kept units. F1's two cases failed before the fix and pass now.
- **F2.** Open, close, deactivate a unit elsewhere, reopen within 30 s: no request, and the unit was still
  selectable. Fixed by `staleTime: 0` (D3). F2 failed before (one request, not two) and passes now.
- **F3.** `12\t` showed the warning but sent `search=12`. The raw text is now checked. The trailing and leading
  tab cases failed before; the inner NUL case passed before and after.

## 7. Not verified, accepted risks and follow-ups

- Criterion 2 (375 px) is shown only by the Chromium stack run in the PR, not by an automated test. The run used
  seeded data with one resident given a 120-character name and 254-character email.
- The Chromium accessible names were checked through Playwright's role queries in that run, not with an
  accessibility-tree dump.
- The debounce's exact 300 ms is not asserted; the tests wait past it (round 1 noted this).
- Round 2's extra proofs (late answers across a building switch, failed self-transfer, overlapping `/me`
  refreshes) were scratch and deleted. They are not in the suite.
- Accepted: the unit search shows only the first page (tracked only here and in PR #107's follow-ups).
- Accepted: the nav follows a self change after two requests (D2; tracked only here).
- Accepted: 496 non-test lines, over the ~400 guideline (PR deviations).

## 8. How to change this safely

- **A new member action:** add a `Kind` to `frontend/src/features/residents/Members.tsx::LABELS` and `BUTTON_STYLES`, a branch in
  `frontend/src/features/residents/Members.tsx::dialog`, and build its mutation with `useMemberChange`, so it keeps the invalidation, the `/me`
  refresh and building denial. Add its refusals to the dialog's own `refusal`, or to `memberRefusal` if every
  dialog can get them.
- **A new refusal code:** map it in the dialog's `refusal` and add a row to that dialog's refusal table test.
- **Changing the unit query:** keep the `['b', buildingId, …]` key (rule 12, building switch) and `staleTime: 0`
  (F2 test).

## 9. Must explain, then quiz

**1. Why is the roles change sent as `{add, remove}` from the dialog's snapshot, not the full role set?**
The API takes a diff and ignores entries that change nothing
(`backend/app/memberships/service.py::change_roles`). Computing it from what the dialog showed when it opened
(`frontend/src/features/residents/RolesDialog.tsx::RolesDialog`) sends only the roles this manager actually touched. A role another manager
changed meanwhile is left alone, while sending the full set would revert it. The test "the roles dialog keeps the
roles it opened with, and sends only what was changed in it" shows a refetch adding Security under the open
dialog: ticking Council sends `{add: ['council'], remove: []}`, not a removal of Security (D1).

**2. Why does a change to one's own membership refresh `/me`, and how do the nav and guards follow?**
The nav (`MainNav`) and `RequireRole` read `my_roles` from the building query. `BuildingProvider` invalidates that
query when `/me` reports different roles for the selected building. So `useMemberChange` invalidates `['me']` when
`self` is true. The new `/me` triggers the building refetch, and `RequireRole` and the nav re-render with the new
roles: `/403` and no "Residents" after losing Property manager. It runs from `onSettled`, so it also happens when
the dialog or page is gone, and after a failure that may have committed (D2).

**Quiz**

1. A manager opens "Change roles" on Robin (Resident). Meanwhile another manager adds Security. The first
   manager ticks Council and saves. What does Robin end up with, and why?
2. Why is `self` passed in the mutation's variables instead of being read in `onSettled` from the component?
3. What would break if `useUnitOptions` lost `staleTime: 0`?
4. What would break if `TransferDialog` checked control characters on `term` (the trimmed text) only?
5. How would you extend the transfer dialog to page through more than the first page of units?

<details><summary>Answers</summary>

1. Resident, Security and Council. The request is `{add: ['council'], remove: []}`: the diff from the snapshot
   doesn't mention Security, so the server keeps it.
2. `onSettled` belongs to the mutation and can run after the dialog has unmounted. The variables travel with the
   mutation, so the value is known whenever the answer comes.
3. A dialog reopened within 30 s (or a search revisited) would serve the cached units: a unit deactivated
   meanwhile would stay selectable (test F2 fails), and the user would only learn of it from `unit_inactive`.
4. A leading or trailing tab would be trimmed away and sent as a valid search, while the field still showed the
   control-character warning (tests F3).
5. Make `useUnitOptions` an infinite query (as `useMembers`) on `next_cursor`, add a "Show more" under the
   radios with the members list's guards (not while fetching, not after a failed refresh), and keep `chosen`
   derived from all loaded pages.

</details>
