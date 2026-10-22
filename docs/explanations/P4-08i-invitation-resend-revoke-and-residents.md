# Explanation — P4-08i Invitation resend, revoke and pre-approved residents

> **PR:** #112 · **Source revision:** `7e8dcb0dffe332b74b8f37f4fac44c3a97499563`, the pre-merge PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (2) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 112 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `7e8dcb0` the diff (`git diff origin/main...HEAD`, 13 paths), the whole of
> `Invitations.tsx`, `UnitPicker.tsx`'s hook and both groups, `InvitationDialog.tsx`'s `refusal` and `confirm`, the
> `api.ts` and `InviteForm.tsx` patches, the `TransferDialog.tsx` additions, and the PR description (both review
> rounds, no PR comments or reviews). Ran `npx vitest run src/features/residents src/test/queryFreshness.test.ts`:
> `Test Files 8 passed (8) / Tests 313 passed (313)`. Differences from the plan: see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: B.

## 1. What was built and why

The "Invitations" tab of `/manage/residents` (P4-08g) could only send staff invitations and list pending ones. Now
each listed invitation has **Resend** (a new link, expiring in 7 days; the old link dies) and **Revoke** (the link
dies), each behind a confirmation dialog; a **Show** select lists Pending or Expired invitations, since resend is
what an expired invitation needs; and the invite form has **Resident**, which asks for a unit and a relationship.
No server code changed: the endpoints are P4-02a's.

Two decisions matter most. Every residents mutation now refreshes its lists through one helper,
`frontend/src/features/residents/api.ts::refresh`, which cancels before it invalidates, and a parser-based test
keeps it that way. This closes the "list refresh defeated by another fetch" pattern, which had reached 5 occurrences
(D3). And the unit search moved out of the transfer dialog into a shared `UnitPicker.tsx`, so the invite form
doesn't copy it.

## 2. Decisions

### D1. Expired invitations listed behind a "Show" select

- **Problem or constraint:** the ticket left open whether expired invitations are listed. Resend works on them: the
  server's `_open()` condition is "not accepted, not revoked" (`backend/app/invitations/service.py::_transition`).
- **Chosen:** one list with a "Show" select (Pending, Expired) that sets the request's `status=`. Each change of the
  select removes the other status's cached pages first, so it starts from the first page, as `Members`' filters do.
- **Alternatives rejected:** pending only, which leaves the most common resend case (a missed 7-day window) with no
  button; two lists on one tab, which doubles the list states, errors and "Show more" guards; all statuses, though
  accepted and revoked ones allow no action.
- **Tradeoffs and accepted limitations:** the select isn't in the URL, so Back after a switch doesn't restore it.
- **Basis:** ticket ("decide while framing"); autonomous, the simplest option. **Source:** recorded (ticket Frame
  notes, PR D1).

### D2. With Resident ticked, a unit and a relationship are required

- **Problem or constraint:** `InvitationCreate` takes `unit_id` and `relationship` together or not at all, and allows
  a resident with neither.
- **Chosen:** ticking Resident shows the unit search and the relationship group, and both become required. Unticking
  hides them and they aren't sent.
- **Alternatives rejected:** an optional unit, which adds a third state with no way back once a relationship radio is
  chosen, unless another control is added; a separate "pre-approve for a unit" checkbox, one more control for a case
  the members' transfer covers.
- **Tradeoffs and accepted limitations:** a resident without a unit can't be invited from the UI.
- **Basis:** ticket ("both or neither"); autonomous. **Source:** recorded (PR D2, Frame notes).

### D3. One refresh helper for every residents mutation, kept by a parser test

- **Problem or constraint:** the pattern "list refresh defeated by another fetch" reached 5 occurrences (PR #110 R1
  F1), after its `CLAUDE.md` lesson. The mechanism: when a query's first load is still running, it has no data yet,
  so `invalidateQueries` doesn't restart it. It waits for that fetch, and the fetch read the list from before the
  mutation.
- **Chosen:** `frontend/src/features/residents/api.ts::refresh` cancels the key's queries, then invalidates them, and isn't returned, so
  `mutateAsync` doesn't wait for the refetch. Every `onSettled` in `api.ts` calls it. The fitness test
  `frontend/src/features/residents/refresh.test.ts::problems` parses `api.ts` with TypeScript's parser and reports
  any `invalidateQueries`, `cancelQueries`, `refetchQueries` or `resetQueries` found outside `refresh`, as an
  identifier or as a string, and any `useMutation` whose `onSettled` doesn't call `refresh`.
- **Alternatives rejected:** a fitness test alone, requiring a cancel before each invalidate. That leaves five copies
  to get right, where the helper is right by construction.
- **Tradeoffs and accepted limitations:** the test reads `frontend/src/features/residents/api.ts` only. `useDecide` now cancels
  the whole requests key, not only the summary (the pending list's own first load too).
- **Basis:** the ticket's first follow-up; the `CLAUDE.md` lesson "parser, not a regex". **Source:** recorded (PR D3).

### D4. No row dialog while a create is out (review round 1, F1)

- **Problem or constraint:** a create's answer moves focus: to the status message on success, to the form's alert
  on a refusal, to the email field on a server-placed error. If that answer arrived while a resend or revoke dialog
  was open, focus left the modal.
- **Chosen:** the rows' buttons are disabled while a create of this building is out:
  `frontend/src/features/residents/api.ts::useInviting` is `useIsMutating` on the create's mutation key.
- **Alternatives rejected:** deferring the tab's focus move while a dialog is open, which covers the success message
  only, while the form's alert and email focus would need the same in `InviteForm`; queueing focus until the dialog
  closes, which has the same three paths plus a stale target.
- **Tradeoffs and accepted limitations:** for the length of one create request, the row buttons can't be used.
- **Basis:** review round 1 (Codex gpt-6-astra) F1. **Source:** recorded (PR D4).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| The unit search and relationship group moved into `UnitPicker.tsx`, shared with `TransferDialog` | copy them into the form | ~70 duplicated lines to keep in step | ticket ("searched as `TransferDialog` does") | recorded (PR) |
| Refusals that retrying can't fix (404, `invalid_transition`, `invitation_pending`, `forbidden_role`) end the dialog | keep it open | `MemberDialog`'s convention; Confirm again would get the same answer | convention | recorded (PR, Frame notes) |
| Revoke offered on expired rows too | resend only | the API allows it, and it ends the link explicitly | API | recorded (PR) |
| Reviewer: one Codex gpt-6-astra (medium) per round, no Claude reviewer | the Tier 2 fresh Claude reviewer | James's instruction for this run | session instruction | recorded (PR "Independent review") |

**Framing changes:** the stub had no criteria; 1–13 were written while framing, and none was loosened. The P4-08g
test "offers the three staff roles, no Resident" now expects Resident first, because its criterion said "no
Resident: P4-08i", which this ticket replaces (criterion 10). It still asserts the three staff roles.

**Plan versus final code:** compared with the PR's Plan, there are three differences:
- `useInviting` and the disabled row buttons were added by review round 1 (D4), and `aria-invalid` on both groups
  by round 1 F2.
- The building-switch test asserts that Maple's query is gone, not invalidated: a switch removes the old
  building's queries (`frontend/src/app/BuildingProvider.tsx::BuildingProvider`). This is noted below the Plan.
- Criteria 7 and 9's "asked for again" after the page is left holds as invalidation, which means a refetch when the
  list is next shown, as in P4-08g's test. This is noted below the Plan after round 2.

The non-test size at the source revision is 485 lines added and 170 removed. About 110 of the added lines are moved
from `TransferDialog`, for a net of +315. This is recorded in the PR header instead of a split.

## 3. How it is implemented

### Overview

- `api.ts`: `refresh`; `useInvitations(buildingId, status)` keyed `['b', id, 'invitations', status]`;
  `useInvitationAction` (resend or revoke); `useInviting`; `InvitationCreate` gains an optional unit and
  relationship.
- `frontend/src/features/residents/Invitations.tsx::Invitations`: the select, the rows' buttons, the open dialog, and where focus goes after it.
- `frontend/src/features/residents/InvitationDialog.tsx::InvitationDialog`: the confirmation, with one request per confirm, the refusals that end
  it and the failures that keep it open.
- `UnitPicker.tsx`: `useUnitPicker` (state and query), `UnitPicker` (the search field and units), and
  `RelationshipField`; used by `InviteForm` and `TransferDialog`.

### Walkthrough (variant B): a manager resends an expired invitation

1. **Show Expired.** The "Show" select calls `frontend/src/features/residents/Invitations.tsx::Invitations`' `show`. It removes the cached
   `['b', id, 'invitations', 'expired']` query (exact), then sets `status`, so `useInvitations` asks for
   `GET …/invitations?status=expired` from the first page. The list is named "Expired invitations", and each row
   says "Expired <date>" in the building's locale and time zone.
2. **Open.** The row's button, named "Resend the invitation to <email>", clears the tab's message and stores
   `{kind, invitation, opener}`. It is disabled while `useInviting` is true (D4). `InvitationDialog` mounts on the
   residents `Modal` and focuses Cancel.
3. **Confirm.** `confirm` takes the `inFlight` guard before anything else, so a double click sends one request. It
   sets `busy` (the buttons are disabled and `Modal` ignores Escape) and moves focus to the dialog element, since a
   disabled button would drop it to `<body>`. It then calls `useInvitationAction`'s
   `POST …/invitations/{id}/resend`.
4. **Answer.**
   - **200:** `onClose("A new invitation was sent to <email>. It expires <date>.")`, using the response's email and
     `expires_at`.
   - **404 `invitation_not_found`, 409 `invalid_transition`, 409 `invitation_pending` or 403 `forbidden_role`:**
     `onClose(<its message>)`.
   - **Anything else** (a 429 with its wait, a 500, a network error): an alert inside the dialog takes focus and
     the buttons work again.
   - If the dialog is gone by then (`mounted` is false), nothing is shown.
5. **Focus.** `Invitations`' `close` sets the message, and `focusTo` moves focus after the commit that shows it.
   With no message (Cancel, Escape), focus goes back to the opener, or to the list's heading if the row went.
6. **Cache.** Whatever the outcome, `onSettled` calls `refresh` on `['b', id, 'invitations']`. Both lists are
   cancelled and invalidated, so the resent invitation leaves Expired. If the page is gone, the lists are invalid
   and asked for when next shown.

A resident invite takes the same path through `InviteForm`'s `submit`. The checks run in order: email, roles, then
with Resident ticked the unit (focus to the unit search) and the relationship (focus to its first radio). The body
is `{email, roles, unit_id, relationship}`. A 404 `unit_not_found` or 409 `unit_inactive` calls
`picker.unitGone()`, which clears the choice and refetches the units, and shows "That unit is no longer available.
Choose another."; everything else typed is kept.

### Data model changes

None.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `frontend/src/features/residents/api.ts` | `refresh`, status-keyed list, `useInvitationAction`, `useInviting` | +58/−32 |
| `frontend/src/features/residents/Invitations.tsx` | select, row actions, dialog and focus | +82/−19 |
| `frontend/src/features/residents/InvitationDialog.tsx` | new: the confirmation | +132 |
| `frontend/src/features/residents/InviteForm.tsx` | Resident, unit, relationship | +30/−9 |
| `frontend/src/features/residents/UnitPicker.tsx` | new: shared unit search and relationship group | +171 |
| `frontend/src/features/residents/TransferDialog.tsx` | uses `UnitPicker` | +12/−110 |
| `frontend/src/features/residents/invitationActions.test.tsx` | new: criteria 2–12, round 1 | +718 |
| `frontend/src/features/residents/refresh.test.ts` | new fitness test (criterion 1) | +78 |
| `frontend/src/features/residents/members.test.tsx`, `roles.test.tsx`, `invitations.test.tsx` | neighbour tests; the superseded assertion | +39, +22, +3/−1 |
| `docs/tickets/…P4-08i…md`, `docs/tickets/README.md` | frame, status | |

`frontend/src/features/residents/api.ts::refresh`

```ts
function refresh(queryClient: QueryClient, filters: { queryKey: QueryKey; exact?: boolean }): void {
  void queryClient.cancelQueries(filters).then(() => queryClient.invalidateQueries(filters));
}
// ...
export const useInviting = (buildingId: string) => useIsMutating({ mutationKey: inviteKey(buildingId) }) > 0;
```

- Cancel first: a cancelled first load is reverted, so the invalidation that follows starts a new fetch instead of
  waiting for the old one. Without the cancel, the members neighbour test and two earlier F1 tests fail (mutation
  M2 in the PR).
- `void` with no `return`: the mutation's promise settles without waiting for the refetch (P4-08b R1).
- `useInviting` matches by key prefix. The create's key ends in `'create'` and the action's in `'action'`, so only a
  create disables the rows.

`frontend/src/features/residents/refresh.test.ts::problems`

```ts
  const visit = (node: ts.Node) => {
    // An identifier (`client.invalidateQueries`, `{ cancelQueries: c } = client`) or a string (`client['…']`).
    const name = ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : null;
    if (name && METHODS.has(name) && !inHelper(node)) found.push(`line ${line(node)}: ${name} outside ${HELPER}`);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useMutation') {
      // ... finds the options' `onSettled` property or method
      if (!settled || !callsHelper(settled)) found.push(`line ${line(node)}: a mutation whose onSettled doesn't call ${HELPER}`);
    }
    ts.forEachChild(node, visit);
  };
```

- It walks the syntax tree, so a destructured method, an element access or a multi-line call is still found. The
  test's `it.each` shows six forms it must flag, including a `const refresh = …` arrow: only a *function
  declaration* named `refresh` counts as the helper.
- Without it, a new mutation written with a bare `invalidateQueries` would pass review again (mutation M1 in the PR
  fails this test).

`frontend/src/features/residents/InvitationDialog.tsx::refusal`

```tsx
function refusal(error: unknown, kind: Kind, invitation: Invitation): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 404 && error.code === 'invitation_not_found') return 'This invitation no longer exists.';
  if (error.status === 403 && error.code === 'forbidden_role') return 'You can no longer manage invitations in this building.';
  if (error.status !== 409) return null;
  if (error.code === 'invalid_transition') return 'This invitation was already accepted or revoked.';
  if (kind === 'resend' && error.code === 'invitation_pending') {
    return `${invitation.email} already has another pending invitation. Revoke one of them first.`;
  }
  return null;
}
```

- A non-null result ends the dialog with that message (`confirm`'s `onClose(ended)`); null keeps it open with "Could
  not <kind> the invitation. Try again." or the 429's wait.
- `invitation_pending` is only a resend's: the server refuses a resend while another pending invitation exists for
  the email (`backend/app/invitations/service.py::resend_invitation`).

`frontend/src/features/residents/UnitPicker.tsx::useUnitPicker` (the choice rule)

```tsx
    // Only a unit the list shows counts: one picked in an earlier list may not be in this one (P4-08e criterion 8).
    chosen: options.some((unit) => unit.id === unitId) ? unitId : null,
    // ...
    unitGone: () => {
      setUnitId(null);
      void units.refetch();
    },
```

- The rule moved from `TransferDialog` unchanged. `useUnitPicker(buildingId, enabled)` lets the invite form leave the
  units unasked until Resident is ticked (asserted: no units request before the tick).

## 5. Edge cases and tests

All in `invitationActions.test.tsx` unless named.

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Switching Pending → Expired → Pending refetches every cached page | removes the target status's query first | "each change starts from the first page: going back to Pending after Show more asks one page again" |
| A double click on Revoke sends two | `inFlight` guard; buttons disabled; Escape ignored | "a double click sends one request; …" |
| The invitee accepts while the dialog is open | 409 `invalid_transition` ends the dialog | "%s → %i %s ends the dialog …" (both verbs); Chromium transcript (a colleague's revoke) |
| A colleague invited the email while an expired one is resent | 409 `invitation_pending` ends it with "Revoke one of them first." | same `it.each` row |
| A 500, network error or unknown 409 | the dialog stays, a focused alert, buttons enabled | "%s → %s keeps the dialog open …" |
| The answer comes after leaving the page | nothing shown; the list is invalidated | "an answer after leaving the page shows nothing …" |
| Building switch mid-revoke | nothing shown in Birch; Maple's queries removed | "a building switch while a revoke is out …" |
| A unit deactivated between search and Send | the alert, choice cleared, units refetched, the rest kept | "unit refusals keep the form open" (404, 409) |
| A create answers under an open dialog | rows disabled while a create is out | "F1: the row buttons are disabled …" (succeeds, refused, fails), "F1 neighbour: a server-placed email error …" |
| Another building's create disables these rows | the key is per building | "F1 neighbour: another building's create doesn't disable …" |
| A members first load reused after an action | `refresh` cancels it | `members.test.tsx` "P4-08i: a members first load still out …" |
| A missing choice not exposed to assistive tech | `aria-invalid` on both groups | "both groups are aria-invalid after Send …"; `roles.test.tsx` "P4-08i review round 1: the transfer marks a missing choice invalid" |

Acceptance criteria → tests:
1. Covered by `refresh.test.ts` (three tests) and the `members.test.tsx` neighbour; probes M1 and M2 are in the PR.
2. "shown: pending or expired" (four tests); `queryFreshness.test.ts` passes without an exemption.
3. "row actions" (five tests).
4. "resend" (two tests).
5. "revoke".
6. "refusals" (seven ending, three keeping, the 429, `building_not_found`).
7. The list being asked for again is asserted inside the resend, revoke, refusals and leaving tests.
8. "one request".
9. "leaving and switching".
10. "resident in the invite form" (six tests).
11. "unit refusals keep the form open".
12. "labels" and the F2 tests; Chromium transcript in the PR.
13. Chromium transcript in the PR (`scrollWidth` 375 at 375 px).

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex gpt-6-astra (medium) | `31fd18a` | MERGE | F1 Medium: a create's answer steals focus from an open dialog; F2 Low: missing unit/relationship groups not `aria-invalid` | both fixed in `7e8dcb0` |
| 2 | Codex gpt-6-astra (medium), new session | `7e8dcb0` | MERGE | none | — |

- **F1.** Failure: start a slow create, open a row's Revoke. When the create succeeded, focus moved to the status
  message behind the modal, and the modal's Tab trap no longer had focus. Evidence: with the fix reverted, the four
  F1 tests failed (`× … once it succeeds / is refused / fails`, `× … server-placed email error`); with it, they pass.
  Codex's proof failed with `expected false to be true`. Produced D4.
- **F2.** Failure: with Resident ticked, Send without choices showed both messages but neither group had
  `aria-invalid` (criterion 12). Evidence: both F2 tests failed without the fix and pass with it.
- **Round 2 observation, not a finding:** criteria 12–13 rest on the Chromium transcript, and "asked for again" is
  proven as invalidation. Both are recorded in §2 and §7.

## 7. Not verified, accepted risks and follow-ups

- Focus in Chromium and the 375 px layout were checked once by a scratch Playwright spec on the dev stack, which was
  deleted afterwards (transcript in the PR). No committed browser test covers them, and the reviewers didn't rerun
  them.
- After the page is left, the lists are invalidated but not refetched until shown again (criteria 7 and 9's reading,
  §2).
- The "Show" select isn't kept in the URL (D1). A unit-less resident can't be invited from the UI (D2).
- `refresh.test.ts` covers `frontend/src/features/residents/api.ts` only. Invalidations in `app/` and `features/notifications/`
  are not checked.
- Seen once: `roles.test.tsx` "building_not_found on transfer marks the building denied" failed in one full local
  run and passed in every rerun. It is tracked only in the PR, and is added to the inbox in the bookkeeping commit.
- No backend change. P4-02a's tests carry the tenant rows (another building's invitation or unit → 404).

## 8. How to change this safely

- **A new residents mutation:** give it `onSettled: () => refresh(queryClient, { queryKey: <its domain key> })`.
  `refresh.test.ts` fails on anything else in `api.ts`.
- **A new listed status:** add it to `frontend/src/features/residents/api.ts::ListedStatus` and `Invitations.tsx`'s `SHOWN`. The query key follows,
  and "shown: pending or expired" shows the pattern to test.
- **The unit search:** change it in `UnitPicker.tsx`. Both `roles.test.tsx` (transfer) and
  `invitationActions.test.tsx` (invite) exercise it.
- **Another action that moves focus on its answer:** check it against open dialogs, as D4 does for the create.

## 9. Must explain, then quiz

**1. Why does the refresh helper cancel before it invalidates, and why is it not awaited?**
React Query's `invalidateQueries` refetches an active query, but a query whose *first* load is still out has no
data, so it doesn't start a new fetch: it returns the one already running. That fetch read the server before the
mutation, so its answer would show the old list as if refreshed. Cancelling first reverts that fetch, and the
invalidation then starts a new one (`frontend/src/features/residents/api.ts::refresh`; the members neighbour test and mutation M2). It isn't awaited
or returned because `onSettled`'s promise is part of `mutateAsync`'s: the dialog would wait for the list's refetch
before showing its answer (P4-08b R1, recorded in the helper's comment).

**2. Why can an expired invitation be resent, and when does the server refuse it?**
Expiry isn't a stored state. `status` is read from the timestamps, and the transition's condition is "not accepted
and not revoked", so an expired invitation is still open (`backend/app/invitations/service.py::_transition`).
`resend_invitation` refuses it with 404 if it isn't this building's, 409 `invalid_transition` if it was accepted or
revoked, and 409 `invitation_pending` if another invitation for the same email is pending: otherwise resending
would bring back a second live offer beside its replacement. The UI shows each as a message and closes the dialog
(`frontend/src/features/residents/InvitationDialog.tsx::refusal`).

Quiz:

1. A manager opens Expired, resends one, and the request fails with a 500. What do they see, and is the list asked
   for again?
2. Why does `useInviting` not also disable the rows while a resend is out?
3. What breaks if `Invitations.tsx`'s `show` stops calling `removeQueries`?
4. What would break if `UnitPicker`'s `chosen` returned `unitId` directly?
5. How would you extend the tab to let a manager resend all expired invitations at once?

<details><summary>Answers</summary>

1. The dialog stays open with a focused alert, "Could not resend the invitation. Try again.", and the buttons
   enabled. Yes: `onSettled` runs `refresh` on every outcome ("%s → %s keeps the dialog open …" asserts two list
   requests).
2. A resend runs inside the modal dialog that started it, so nothing else can be clicked. The create is the only
   mutation that can still be out when a row's dialog opens (PR's round 1 neighbour table).
3. Going back to a status shown earlier would refetch every page it had loaded, through React Query's infinite
   refetch, not just the first. "each change starts from the first page …" fails.
4. A unit picked under one search could stay chosen after a new search no longer lists it, and be sent unseen
   (P4-08e criterion 8). "typing a new search clears the unit choice …" and the transfer's tests catch it.
5. A bulk endpoint, or a loop of `useInvitationAction` calls under one confirmation, with one `refresh` at the end and
   a per-row result. It is out of scope here (ticket: "Out: bulk actions") and would need its own ticket and
   criteria for partial failure.

</details>
