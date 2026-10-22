# Explanation — P4-08g Staff invitations screen

> **PR:** #110 · **Source revision:** `fe1197de612a972894cf06cced5af2ad619c65d5`, the pre-merge PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (3) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 110 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `fe1197d` the diff (`git diff origin/main...HEAD`, 12 paths), the whole of
> `InviteForm.tsx`, `Invitations.tsx`, the added hooks in `api.ts`, the `ResidentsPage.tsx` change, the
> `queryFreshness.test.ts` change, the J2 spec, and the assertions of the tests cited below; ran
> `npx vitest run src/features/residents/invitations.test.tsx src/test/queryFreshness.test.ts src/features/residents/residents.test.tsx`:
> 3 files, 132 passed. Differences from the plan: two review fixes (§2 "Plan versus final code").
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: B.

## 1. What was built and why

`/manage/residents` gets a third tab, **Invitations**: a form that invites staff (Security, Property manager,
Council) by email through the existing `invitations_create` endpoint, and the building's pending invitations
(`invitations_list?status=pending`). Before this, no screen created invitations, so the J2 browser journey called
the API directly (P4-09's recorded loosening); J2 now goes through the screen. The ticket was split while framing:
resend, revoke and inviting a resident to a unit moved to P4-08i. Two carried follow-ups ride along: the
freshness fitness test now sees React Query hooks called through renamed or namespace imports, and `CLAUDE.md`
gains a "parser, not a regex" lesson. No backend change.

## 2. Decisions

### D1. Split resend, revoke and the pre-approved resident to P4-08i

- **Problem or constraint:** the stub's scope was estimated at ~470 non-test lines against the ~400 limit.
- **Chosen:** this ticket does the tab, the staff invite form and the pending list (J2 needs exactly these);
  [P4-08i](../tickets/P4-08i-invitation-resend-revoke-and-residents.md) does resend, revoke and the resident with a
  unit.
- **Alternatives rejected:** splitting list from form (J2 needs the form, and the form's result shows in the
  list); keeping it whole (over the limit).
- **Tradeoffs and accepted limitations:** until P4-08i a pending invitation can't be resent or revoked from the
  screen, and a resident can't be invited from it. The final count was 329 non-test lines added.
- **Basis:** playbook step 1.4; costing in the ticket's Frame notes.
- **Source:** recorded (ticket Frame notes; PR #110 D1).

### D2. The form sits on the tab, above the list, not in a dialog

- **Problem or constraint:** where the invite action lives.
- **Chosen:** an inline `<form>` on the Invitations tab.
- **Alternatives rejected:** a dialog opened from a button: the residents dialogs each act on a row; this action
  has none, and a dialog would bring the `Modal` focus handling for no gain.
- **Tradeoffs and accepted limitations:** on a phone the list starts below the form.
- **Basis:** autonomous (simplest).
- **Source:** recorded (PR #110 D2).

### D3. After a create, cancel the list's fetches, then invalidate them (review round 1)

- **Problem or constraint:** the list must show the new invitation after a create, whatever was in flight.
- **Chosen:** `useInvite`'s `onSettled` cancels every `['b', id, 'invitations']` query, then invalidates them; the
  promise is not returned, so the form's `mutateAsync` doesn't wait for the refetch.
- **Alternatives rejected:** a plain `invalidateQueries` (the first version): React Query reuses a fetch that has
  no data yet instead of starting another, so a first load that read the list *before* the create was shown as
  the refreshed list (§6, round 1 F1).
- **Tradeoffs and accepted limitations:** a refresh that was nearly done is thrown away and asked again.
- **Basis:** review finding (round 1, Codex F1); existing convention (`frontend/src/features/residents/api.ts::useDecide`
  cancels the summary the same way).
- **Source:** recorded (PR #110 "Independent review", round 1).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Only `status=pending` is listed | all statuses | the ticket asks for the pending list; accepted/revoked ones need no action, and an expired email can be invited again | ticket | PR #110 table |
| Staff roles only | Resident without a unit | P4-08i adds Resident with its unit | D1 | PR #110 table |
| Email trimmed before checking and sending | send as typed | the server refuses a padded address (`backend/app/core/schemas.py::_email`) | convention (join form) | PR #110 table |
| The success message shows the response's email | the typed one | the server lowercases it, as the list shows it | autonomous | PR #110 table |
| Focus moves to the `<form>` while a Send is out | leave it on the button | a disabled button drops focus to `<body>` in a browser | convention (P4-08e dialogs) | PR #110 table |
| Client errors show from the first Send and follow later typing | validate on blur | as the residents dialogs; fewer states | autonomous | PR #110 table |
| A server-placed email error blocks Send until the email is edited | let Send retry | the same address would be refused again; criterion 4 says nothing is sent while an email error shows | review round 2 F1 | PR #110 round 2 |
| Freshness guard reads imports only from `@tanstack/react-query`; a hook's own name still counts without an import | resolve imports through the type checker | fail-closed as before; a checker program is slower and more code; `require`/default forms aren't used here | ticket follow-up | PR #110 table |
| `CLAUDE.md` stays at 150 lines by rewording two sentences to fit one line each | a fitness test instead of a lesson | the follow-up proposed a lesson; the freshness guard is itself the test for its case | ticket follow-up | PR #110 table |

**Framing changes:** the stub had no criteria; 14 were written (from P4-02a's API and P4-08b/c/e's patterns),
including three cases the stub missed (a colleague's invitation sent after the list loaded, a manager demoted while
the form is open, a padded or upper-case email). Nothing was loosened; the split moved scope to P4-08i.

**Plan versus final code:** compared with the PR's Plan. Two differences, both from review: `useInvite` cancels
before invalidating (D3, round 1), and `InviteForm` refuses to send while a server-placed email error shows
(round 2). Everything else (files, keys, client checks, refusal mapping, criterion → test map) is as planned.

## 3. How it is implemented

### Overview

- `frontend/src/features/residents/ResidentsPage.tsx::ResidentsPage` adds the tab; the panel stays keyed by building
  and history entry, so nothing of one entry's panel shows on another.
- `frontend/src/features/residents/Invitations.tsx::Invitations` owns the status message and the list, and renders
  the form.
- `frontend/src/features/residents/InviteForm.tsx::InviteForm` checks, sends once, and maps refusals.
- `frontend/src/features/residents/api.ts::useInvitations` (infinite query, `staleTime: 0`) and
  `frontend/src/features/residents/api.ts::useInvite` (mutation keyed by building, refreshing the list itself).

### Walkthrough (variant B: a manager invites a security guard)

1. **User action.** On `/manage/residents?tab=invitations` the manager types an email, ticks Security and presses
   "Send invitation" (a `type="submit"` button, so Enter works too).
2. **Validation.** `InviteForm`'s `submit` sets `checked`, trims the email, and returns early with focus on the
   email if `emailProblem` objects (`x@y` shape, at most 254 UTF-8 bytes) or the server already refused this
   email, then on the first role checkbox if none is ticked. Only the server checks the full address rules
   (`backend/app/core/config.py::is_email_address`: local part length, labels, ASCII).
3. **One request.** The `inFlight` ref returns any second submit; `busy` makes the email read-only, the boxes and
   button disabled, and focus moves to the `<form>`. `onStart` clears the previous success message.
4. **Hook and call.** `useInvite(buildingId).mutateAsync({ email, roles })` posts `invitations_create` with the
   roles filtered from `STAFF_ROLES`, so they go in `Role` order. The mutation key starts `['b', buildingId, …]`,
   so a `building_not_found` marks the building denied (`frontend/src/app/buildingDenial.ts::recordBuildingDenial`).
5. **Response.** 201: if the form is still mounted it clears and calls `onSent` with the response's email;
   `Invitations` shows "Invitation sent to …" in a `role="status"` paragraph and focuses it. A 422 placed on
   `email` by `serverFieldErrors` shows on the field. Anything else goes through `refusal`: 409
   `invitation_pending`, 403 `forbidden_role`, a 429's wait, else "Could not send the invitation. Try again." in a
   focused `role="alert"`; the typed values stay.
6. **Cache.** Whatever the outcome, `onSettled` cancels and invalidates `['b', id, 'invitations']` (D3). It runs
   from the mutation, so it happens even if the page was left.
7. **States.** The list shows "Loading invitations…", "No pending invitations.", load/refresh errors with "Try
   again" (and a 429's wait), and "Show more" disabled while any fetch is out and hidden after a failed refresh
   (P4-08b's guards). Each row: the email as a heading, role labels in `Role` order, "Expires <date>" in the
   building's locale and time zone. At 375 px in Chromium a 254-character email row fits (PR #110 transcript).

### Data model changes

None.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `frontend/src/features/residents/InviteForm.tsx` | new: the form | +175 |
| `frontend/src/features/residents/Invitations.tsx` | new: the tab's panel and list | +98 |
| `frontend/src/features/residents/api.ts` | `useInvitations`, `useInvite` | +49 |
| `frontend/src/features/residents/ResidentsPage.tsx` | third tab | +8 −4 |
| `CLAUDE.md` | parser lesson; two sentences reworded | +4 −4 |
| `frontend/src/test/queryFreshness.test.ts` | follows imports; new cases | +63 −2 |
| `frontend/src/features/residents/invitations.test.tsx` | new: criteria 1–10 and review cases | +724 |
| `e2e/tests/j2-staff-invite.spec.ts`, `e2e/README.md` | J2 through the screen; budget note | +13 −14 |
| `docs/tickets/…` (P4-08g, P4-08i, index) | frame, split, index | +144 −11 |

`frontend/src/features/residents/api.ts::useInvite`

```ts
export function useInvite(buildingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Keyed by building, so a `building_not_found` here marks the building denied (app/buildingDenial.ts).
    mutationKey: [...invitationsKey(buildingId), 'create'],
    mutationFn: (body: InvitationCreate) =>
      api.post('/api/buildings/{building_id}/invitations', { params: { path: { building_id: buildingId } }, body }),
    // Cancelled first, as `useDecide`'s summary: a first load still out has no data, so the invalidation would wait
    // for it instead of asking again, and it read the list before the create (review round 1, Codex F1).
    onSettled: () => {
      void queryClient
        .cancelQueries({ queryKey: invitationsKey(buildingId) })
        .then(() => queryClient.invalidateQueries({ queryKey: invitationsKey(buildingId) }));
    },
  });
}
```

- Refreshes the list after every create outcome, from the mutation rather than the form.
- Why: D3, and criterion 8 (the page may be gone when the answer arrives).
- Without the cancel, a first load still in flight wins and the new row is missing (round 1 F1's test fails
  with one GET instead of two).

`frontend/src/features/residents/InviteForm.tsx::InviteForm` (the submit path)

```tsx
  const emailError = serverEmail ?? (checked ? emailProblem(email.trim()) : null);
  const rolesError = checked && roles.size === 0 ? 'Choose at least one role.' : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return;
    setChecked(true);
    setFailure(null);
    const address = email.trim();
    // The server's word too: the same address would be refused again (review round 2, Codex F1).
    if (emailProblem(address) || serverEmail) return emailRef.current?.focus();
    if (roles.size === 0) return firstRole.current?.focus();
    inFlight.current = true;
    setBusy(true);
    onStart();
    // The button about to be disabled would drop focus to <body> in a browser.
    form.current?.focus();
    let sent;
    try {
      sent = await invite.mutateAsync({ email: address, roles: STAFF_ROLES.filter((role) => roles.has(role)) });
    } catch (error) {
      inFlight.current = false;
      if (!mounted.current) return;
      setBusy(false);
      const placed = serverFieldErrors(error, ['email'], SERVER_MESSAGES);
      if (placed) {
        setServerEmail(placed[0].message);
        return emailRef.current?.focus();
      }
      return setFailure({ message: refusal(error, address) });
    }
    // ...
    onSent(sent.email);
  };
```

- Checks, sends once, and routes each failure to the field or to the alert.
- `inFlight` is a ref, not state: two clicks in one tick both see the state from before the first, but the ref
  changes at once (criterion 7).
- Removing `mounted.current` checks would set state on an unmounted form after leaving the page (criterion 8).

`frontend/src/features/residents/InviteForm.tsx::refusal`

```tsx
function refusal(error: unknown, email: string): string {
  if (error instanceof ApiError && error.status === 409 && error.code === 'invitation_pending') {
    return `${email} already has a pending invitation.`;
  }
  if (error instanceof ApiError && error.status === 403 && error.code === 'forbidden_role') {
    return 'You can no longer invite people to this building.';
  }
  return rateLimitMessage(error) ?? 'Could not send the invitation. Try again.';
}
```

`frontend/src/test/queryFreshness.test.ts::libraryNames`

```ts
function libraryNames(tree: ts.SourceFile): { aliases: Map<string, string>; namespaces: Set<string> } {
  const aliases = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== '@tanstack/react-query') continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) aliases.set(element.name.text, (element.propertyName ?? element.name).text);
    }
  }
  return { aliases, namespaces };
}
```

- `inspect` maps a callee through these: a renamed import to the library's name, `RQ.useX` through a namespace,
  and a bare hook name still counts (fail-closed). Before, `import { useQuery as useRows }` or
  `RQ.useInfiniteQuery(…)` produced no call, so the guard passed them (PR #108 R3-F1).

## 5. Edge cases and tests

All in `frontend/src/features/residents/invitations.test.tsx` unless named otherwise.

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Double click / Enter twice sends twice | `inFlight` ref returns the second submit | "a double click sends one request; while out the fields are read-only and focus stays in the form" |
| A first list load out during a create hides the new row | cancel, then invalidate (D3) | "F1: the first load still out when the create succeeds is asked again, and the new row shows" |
| A refresh / next page out during a create | the same cancel; asked again from page 1 | the two "F1 neighbour" tests |
| A colleague invited the same email first | 409 message, list refreshed so the row shows | "invitation_pending asks for the list again, so the colleague's invitation shows" |
| The server refuses the email (e.g. 65-char local part) | message on the field; Send blocked until edited | "a 422 %s on the email shows on the field"; round 2 "F1: Send again sends nothing …" and its neighbours |
| Manager demoted while the form is open | 403 `forbidden_role` message | "%i %s: …" (403 row) |
| Page left / building switched mid-request | nothing shown; first building's list invalidated | "an answer after leaving the page …"; "a building switch while a create is out …" |
| `building_not_found` | the building is marked denied | "building_not_found marks the building denied" |
| Non-manager opens the tab | P4-08b's guard: `/403`, no list request | "a %s gets /403 and no invitations request" |
| Expiry across midnight UTC | formatted in the building's time zone | "a time past midnight UTC shows the building's own date" |
| Padded or upper-case email | trimmed and sent; message uses the server's lowercased email | "sends the trimmed email …"; "says to whom (as the server wrote it) …" |
| A hook called through an alias escapes the freshness guard | imports are read | `queryFreshness.test.ts` › "R3-F1: lists a call through %s …" and "R3-F1 neighbours …" |

Acceptance criteria → tests:

1. "is the third tab …", "opens from a link …", "Home goes to the first tab …"
2. the five "pending list (criterion 2)" tests and the time-zone test
3. "is keyed by building and asked for again when the tab comes back", "asks for the list again after a create answered %s"; `queryFreshness.test.ts` passes with no new exemption
4. "offers the three staff roles, no Resident", "the email %j says %s …", "no role says so …", "sends the trimmed email …", "a 254-byte email is sent"
5. "says to whom (as the server wrote it), takes focus, clears the form and shows the new invitation"
6. the "refusals (criterion 6)" tests
7. "a double click sends one request …"
8. the two "leaving and switching (criterion 8)" tests
9. "a %s gets /403 and no invitations request"
10. "links each error to its field and the roles group, and names the list"; Chromium focus transcript in PR #110
11. Chromium 375 px transcript in PR #110 (`scrollWidth 375 = clientWidth 375`)
12. `e2e/tests/j2-staff-invite.spec.ts`; `make e2e` three runs, 14 passed each; CI "E2E journeys" pass
13. `queryFreshness.test.ts` R3-F1 cases
14. `CLAUDE.md`'s last lesson; 150 lines

Mutation evidence: the round 1 and round 2 tests failed before their fixes (PR #110). The criterion tests were
written first and were red before the components existed (34 failed, 3 passed: the access cases already held);
no other mutation probe was run.

## 6. Review log

Reviewer for every round, per James's instruction for this run: Codex `gpt-6.1-sol` at high effort, a fresh
session each round; no Claude reviewer.

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex gpt-6.1-sol (high) | `19c21a5` | MERGE | Medium F1: stale first load swallows the refresh after a create; gap: time zone at a date boundary | F1 fixed in `7ef3dc9`; gap closed with a test |
| 2 | Codex gpt-6.1-sol (high) | `7ef3dc9` | MERGE | Low F1: Send re-posts an email the server refused; gap: Home and Forward on the tab | F1 fixed in `fe1197d`; gap closed with a test |
| 3 | Codex gpt-6.1-sol (high) | `fe1197d` | MERGE | none | — |

- **Round 1 F1.** Inputs: the list's first GET reads an empty list and is still in transit when the POST returns
  201. Outcome before: "Invitation sent to …" then "No pending invitations.", one GET in total. Evidence: the
  "F1: the first load still out …" test failed (`expected 1 to be 2`) and passes after D3.
- **Round 2 F1.** Inputs: `aaaa…(65)@example.test` passes the client's shape check; the API answers 422
  `email_address`; Send again. Outcome before: a second identical POST. Evidence: "F1: Send again sends nothing
  while it shows …" failed (`expected 2 to be 1`) and passes after.

## 7. Not verified, accepted risks and follow-ups

- Focus and layout in a real browser were checked once by a scratch Playwright script on the dev stack (PR #110),
  not by a committed test; J2 asserts only the success message's focus.
- `make e2e` was run three times on the dev stack locally; CI ran the prod-like E2E on each push. The Pixel 7
  project runs J2 too, but no test checks the 375 px layout.
- The `refusal` 403 branch assumes `forbidden_role` is the only 403 a create returns (true of
  `backend/app/memberships/service.py::refuse_stale` and `backend/app/tenancy/deps.py::ForbiddenRole` today); another 403 code would show the
  generic message.
- Resend, revoke, expired invitations and the pre-approved resident: [P4-08i](../tickets/P4-08i-invitation-resend-revoke-and-residents.md).
- The freshness guard still doesn't follow `require(…)`, default imports or re-exports of React Query hooks
  (recorded as out of the codebase's style; tracked only here).

## 8. How to change this safely

- Adding resend or revoke (P4-08i): add mutations under `invitationsKey` so `useInvite`'s invalidation pattern and
  the building denial apply; keep `cancelQueries` before `invalidateQueries` (the round 1 tests will fail
  otherwise).
- Adding Resident to the form: `STAFF_ROLES` filters it out on purpose; the API requires a unit and relationship
  together, and P4-08e's `TransferDialog` has the unit search to reuse.
- Changing the email checks: keep `emailProblem` and `SERVER_MESSAGES` in step with the join form
  (`frontend/src/features/onboarding/JoinPage.tsx`); "invite form checks (criterion 4)" and the 422 tests cover them.

## 9. Must explain, then quiz

**1. Why does the list's refresh after a create come from the mutation and not the form?** Because the answer
can arrive after the form is gone: the manager may have left the page or switched building. `InviteForm` stops
touching state once unmounted (`mounted` ref), but `frontend/src/features/residents/api.ts::useInvite`'s
`onSettled` belongs to the mutation in the query client, so it still cancels and invalidates the first building's
invitations; the next visit shows the new row. It also runs on failure, because a lost answer may follow a
committed create and a 409 means a row now exists.

**2. How does the freshness guard now tell a React Query hook from a function of the same name?** It doesn't
need to: it errs towards listing. `frontend/src/test/queryFreshness.test.ts::libraryNames` reads the file's imports
from `@tanstack/react-query`, so `useRows` imported `as` `useQuery` maps to `useQuery`, and `RQ.useInfiniteQuery`
counts through the namespace. A bare identifier that looks like a hook is still listed even without an import
(fail-closed), while a namespace member from another module (`Other.useQuery`) or a renamed non-query import
(`useQueryClient as qc`) is not.

Quiz:

1. Why does `InviteForm` use a ref for `inFlight` but state for `busy`?
2. A colleague invites `x@y.test` after your list loaded; you invite the same email. What do you see, and why does
   the colleague's row appear?
3. Why is the success message's email taken from the response and not the input?
4. What would break if `cancelQueries` were removed from `useInvite`'s `onSettled`?
5. How would you extend the form to invite a resident to a unit?

<details><summary>Answers</summary>

1. The ref changes synchronously, so a second click in the same tick is refused; state drives what is rendered
   (read-only fields, disabled button) and would be stale inside the same event loop turn.
2. "x@y.test already has a pending invitation." in a focused alert, with your typing kept; `onSettled`
   invalidates the list, which now includes the colleague's invitation.
3. The server lowercases the address (`backend/app/core/schemas.py::_email`), and that is the form the list shows.
4. A first load still in flight when the create settles would be reused by the invalidation; its pre-create
   answer would show "No pending invitations." with the new invitation missing (round 1 F1 test).
5. Add Resident to the roles, and when it is ticked a unit search and relationship (reuse `TransferDialog`'s parts)
   sent as `unit_id` and `relationship` together; map 404 `unit_not_found` and 409 `unit_inactive` to keep the
   form open (P4-08i's scope).

</details>
