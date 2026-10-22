# P4-08i — Invitation resend, revoke and pre-approved residents (split from P4-08g)

| Field | Value |
|---|---|
| Phase / lane | P4 / B |
| Risk tier | 2 |
| Depends on | P4-08g |
| Replaces old | — |
| Status | in progress |

Split from [P4-08g](./P4-08g-staff-invitations-screen.md) while framing it (2026-10-22): with these its estimate was
~470 non-test lines. Framed 2026-10-22.

## Goal

A property manager resends and revokes pending invitations, and invites a pre-approved resident to a unit, from the
"Invitations" tab.

## Scope

- In:
  - On each row of P4-08g's pending list: "Resend" (`invitations_resend`) and "Revoke" (`invitations_revoke`),
    with a confirmation, and 404 `invitation_not_found`, 409 `invalid_transition` and `invitation_pending` shown
    as clear messages.
  - Decide while framing whether expired invitations are listed too (resend works on them).
  - The invite form gains "Resident", with a unit (searched as `TransferDialog` does) and a relationship, both or
    neither; 404 `unit_not_found` and 409 `unit_inactive` keep the form open.
- Out: bulk actions.

## First follow-ups (playbook step 8, from P4-08g)

- Pattern "list refresh defeated by another fetch" reached 5 (PR #110 R1 F1: `useInvite` invalidated without
  cancelling a first load still out), **after** its `CLAUDE.md` lesson. Promote it to code: one shared helper for a
  mutation's list refresh (cancel the key's queries, then invalidate, not returned) used by every residents mutation,
  or a fitness test that finds `invalidateQueries` in an `onSettled` without a `cancelQueries` before it. Resend and
  revoke will need it.

## Acceptance criteria

(Written while framing, from P4-02a's API — `invitations_resend`, `invitations_revoke`, `InvitationCreate`'s unit —
P4-08g's tab, and P4-08c/e's dialogs and unit search.)

1. **Refresh helper (first follow-up).** `frontend/src/features/residents/api.ts` has one helper that refreshes a
   key after a mutation: it cancels the key's queries, then invalidates them, and is not awaited by the mutation.
   Every residents mutation (`useDecide`, `useMemberAction`, the roles change and transfer, including their `/me`
   refresh, `useInvite`, resend and revoke) refreshes through it, and no other `invalidateQueries` call is left in
   that file. A Vitest test parses `api.ts` with TypeScript's parser and fails if `invalidateQueries` or
   `cancelQueries` is called anywhere but in the helper (proven able to fail once). Neighbour: for a members
   action, a members first load still out when the action settles is asked for again (it was read before the
   action), as P4-08g's create.
2. **Shown: Pending or Expired.** Above the list, a "Show" select with "Pending" (default) and "Expired". It asks
   `invitations_list?status=pending` or `?status=expired` under keys `['b', buildingId, 'invitations', <status>]`,
   stale at once (the `queryFreshness` guard passes without an exemption); each change of the select starts from
   the first page (the cached pages of the other status are removed first, as `Members`' filters). The list is
   named "Pending invitations" or "Expired invitations"; the empty state is "No pending invitations." or "No
   expired invitations."; a pending row says "Expires <date>", an expired one "Expired <date>". P4-08g's list
   states, "Show more" rules and wording otherwise apply to both.
3. **Row actions.** Every listed row, pending or expired, has "Resend" and "Revoke" buttons whose accessible
   names include the email ("Resend the invitation to <email>"). Each opens a confirmation dialog (the residents
   `Modal`) naming the email and roles, with "Cancel" and the action's button: "Resend" says the old link stops
   working and the new one expires in 7 days; "Revoke" says the link stops working. Cancel and Escape close it
   with nothing sent and focus back on the row's button.
4. **Resend.** Confirm posts `invitations_resend` for that invitation. On 200: the dialog closes and the tab's
   status message "A new invitation was sent to <email>. It expires <date>." (the response's email and
   `expires_at`, the building's locale and time zone) takes focus.
5. **Revoke.** Confirm posts `invitations_revoke`. On 204: the dialog closes and "The invitation to <email> was
   revoked." takes focus.
6. **Refusals of resend and revoke.** Ending the dialog with the message focused: 404 `invitation_not_found` →
   "This invitation no longer exists."; 409 `invalid_transition` → "This invitation was already accepted or
   revoked."; 409 `invitation_pending` (resend) → "<email> already has another pending invitation. Revoke one of
   them first."; 403 `forbidden_role` → "You can no longer manage invitations in this building.". Keeping the
   dialog open with an alert that takes focus and the buttons enabled again: any other failure (a 429 with its
   wait when it has one, a 500, a network error) → "Could not resend the invitation. Try again." / "Could not
   revoke the invitation. Try again.". A `building_not_found` marks the building denied (both mutations keyed by
   building).
7. **Fresh after every outcome.** After each resend or revoke, whatever the outcome (success, refusal, failure,
   or after the dialog or the page is gone), every invitations query of that building is asked for again from the
   mutation (criterion 1's helper), so a resent expired invitation leaves the Expired list and shows in Pending,
   and a revoked one leaves the list.
8. **One request.** A double click on the dialog's confirm button sends exactly one request; while it is out the
   buttons are disabled, Escape does nothing and focus stays in the dialog.
9. **Leaving and switching.** **Given** the page is left, or another building chosen, while a resend or revoke is
   out, **then** nothing of it shows on the new screen and the first building's invitations are still asked for
   again when it settles.
10. **Resident in the invite form.** The form's title becomes "Invite people" and its "Roles" group gains
    "Resident" first (`Role` order). Ticking Resident shows a "Unit" search (the transfer dialog's: as you type,
    active units only, at most 20 characters, control characters refused with "Search with visible characters
    only.", the same loading, empty and failed states) and a "How they relate to the unit" group (Owner, Tenant,
    …, as the transfer). With Resident ticked, both are required ("Choose a unit." / "Choose how they relate to
    the unit.", shown from the first Send, nothing sent while one shows); unticking Resident hides them and they
    are not sent. Send posts `{email, roles, unit_id, relationship}` with Resident, and `{email, roles}` without.
    Only a unit the current search shows counts as chosen (typing a new search clears the choice).
11. **Unit refusals keep the form open.** 404 `unit_not_found` or 409 `unit_inactive` → the alert "That unit is no
    longer available. Choose another." takes focus, the unit choice is cleared, the units are asked for again, and
    everything else typed is kept. The rest of P4-08g's criteria 4–8 (checks, success, refusals, one request,
    leaving) hold for a resident invite too; the success message is unchanged.
12. **Labels and focus.** The row buttons, the dialogs and the new fields follow P4-08g criterion 10: each field
    labelled, each error linked (`aria-describedby`) and marking it `aria-invalid`, each group a `fieldset` with a
    legend. Focus after a resend, a revoke, a refusal and Cancel is checked in Chromium on the stack.
13. **Mobile.** At 375 px the select, a row with a 254-character email and its two buttons, the dialog and the
    form with Resident ticked fit without horizontal scrolling (Chromium on the stack).

Tenant table (`ENGINEERING_PRACTICES.md` §7): no new endpoint. Rows 1–4, 6, 8 and 10 for `invitations_resend`,
`invitations_revoke` and `invitations_create` with a unit are P4-02a's backend tests (another building's
invitation or unit is a 404). The UI's part: rows 3/4 as criterion 9 (nothing of another building shown under its
key), row 5 (a non-manager) as P4-08g criterion 9 (the tab's `/403`, unchanged), row 10 (two managers acting on one
invitation) as criterion 6's `invalid_transition` and `invitation_pending`.

Cases the ticket missed: the invitee accepts while the dialog is open (409 `invalid_transition`, criterion 6); a
colleague invites the same email while an expired one is being resent (409 `invitation_pending`, criterion 6); a
unit deactivated between the search and Send (criterion 11); a members first load still out when an action settles
(criterion 1's neighbour).

## Test plan

- Vitest: `frontend/src/features/residents/invitations.test.tsx` (criteria 2–11), `refresh.test.ts` (1, the parser
  check), the existing residents and roles tests (1's refactor, the unit search shared with the transfer).
  `queryFreshness.test.ts`: 2.
- Manual on the stack, Chromium: 12's focus, 13; a curl/Playwright transcript of resend, revoke and a resident
  invite.
- Commands: `make check`, `make e2e`.

## Must explain (learning checkpoint)

1. Why does the refresh helper cancel before it invalidates, and why is it not awaited?
2. Why can an expired invitation be resent, and when does the server refuse it?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: the stub had none; 1–13 written from P4-02a's API (resend's new token and 7-day
  expiry, revoke on any open invitation, `invitation_pending` on resend, the create's `unit_with_relationship` and
  `unit_needs_resident` rules, `unit_not_found`/`unit_inactive`), P4-08g's tab and P4-08c/e's dialogs. 1 is the
  first follow-up.
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis):
  - **Expired invitations are listed, behind a "Show" select (ticket: decide while framing; autonomous,
    simplest).** Resend works on them (`_open()` is "not accepted, not revoked"), and an invitee who missed the 7
    days is the main reason to resend. One list with a status select reuses P4-08g's list states and `Members`'
    filter pattern; two lists on one tab would double the list states. Accepted and revoked ones are not listed:
    nothing can be done with them.
  - **Revoke is offered on expired rows too (API allows it):** it ends a link that can no longer be used, but
    leaves the list tidy and makes the email's state explicit; cheap, same dialog.
  - **With Resident ticked, a unit and relationship are required (ticket: "both or neither"; autonomous).** The
    request sends both or neither, as the API requires. A resident without a unit, which the API allows, is not
    offered: the point of the form is a pre-approved resident of a unit, and a unit-less resident can be given a
    unit later by the members' transfer. Recorded so P4-later can add it if wanted.
  - **The unit search is shared with `TransferDialog` (ticket: "searched as `TransferDialog` does"; convention:
    reuse).** It moves into one component used by both, rather than copying ~70 lines.
  - **Refresh helper, not a fitness test alone (first follow-up offers either):** one helper fixes the pattern by
    construction; a parser-based test keeps new mutations on it (CLAUDE.md lesson: parser, not regex).
  - **Refusals that end the dialog (convention: `MemberDialog`):** a 404, `invalid_transition`,
    `invitation_pending` or `forbidden_role` can't be fixed by trying again, so the dialog closes and the tab says
    why; a transient failure keeps it open.
- Estimate (from P4-08c's `MemberDialog` ~165 and P4-08e's transfer search): helper and hooks ~45, the
  confirmation dialog ~110, the list's select, row buttons and dialog wiring ~60, the unit search moved into a
  shared component (net ~+25), the form's Resident, unit and relationship ~70: ~310. No split.
