# P4-08c — Members administration screen (split from P4-08)

| Field | Value |
|---|---|
| Phase / lane | P4 / B |
| Risk tier | 2 |
| Depends on | P4-08b, P4-06b |
| Replaces old | part of [P4-08](./P4-08-frontend-onboarding-approval-screens.md) (M4-T08) |
| Status | done |

Split from P4-08 while framing P4-08a (2026-10-21). Framed 2026-10-21; the roles editor and the unit transfer
moved to [P4-08e](./P4-08e-member-roles-and-transfer.md) (see the Frame notes).

## Goal

Managers find a building's members in the new typed frontend, and suspend, reactivate or move them out.

## Scope

- In:
  - The "Members" tab of `/manage/residents` ([P4-08b](./P4-08b-manager-pending-requests.md)): the members
    list (`members_list`) with a role filter, a status filter and a search, one page at a time.
  - Row actions with confirmation dialogs: suspend (with a reason), reactivate, and move out
    (`members_deactivate`, with a reason).
  - 409 `last_manager`, `cannot_target_self`, `invalid_transition`, `occupancy_changed` (reload and retry)
    and 404 `member_not_found` shown as clear messages.
- Out: bulk actions; the roles editor and the unit transfer, with their codes `no_roles_left`,
  `resident_has_unit`, `membership_not_active`, `not_a_resident`, `unit_inactive` and `unit_not_found`
  ([P4-08e](./P4-08e-member-roles-and-transfer.md)); pending members are decided in the "Pending requests"
  tab (P4-08b), so their rows have no action here.

## Acceptance criteria

(The original criteria: 1 moved to P4-08e unchanged, with the roles editor it needs; 2 sharpened here as
criterion 2 and repeated in P4-08e for its dialogs. 1 and 3–15 added while framing.)

1. **Last manager.** **Given** a suspend or move-out answered 409 `last_manager` (the race where two managers
   act on each other: P4-06a criterion 3, P4-06b criterion 9), **then** the dialog closes, "The building must
   keep at least one active property manager, so this wasn't done." shows, nothing else changes on screen,
   and the list is asked for again.
2. **Given** mobile width (375 px), **then** the filters, the members list, its buttons and every dialog fit
   without horizontal scrolling, also with a 254-character email and a long name without spaces (checked in
   Chromium on the stack).
3. **List.** **Given** the "Members" tab, **then** the building's members show newest first (the server's
   order): name, email, status (Active, Pending, Suspended, Moved out, Denied), roles (Resident, Security,
   Property manager, Council; sorted as the server sends them), the unit (`A-1203` / `1203`) and
   relationship label when they have a current one, and for a suspended or moved-out member the reason
   ("Reason: …"). With none, "No members match." shows; a list request that fails shows an error with
   "Try again"; with a `next_cursor`, "Show more" loads the next page below.
4. **Filters and search.** A role select (All roles and the four roles) and a status select (All statuses
   and the five statuses) send `role=` / `status=`; a search form (Enter or its "Search" button) sends the
   trimmed text as `search=` and leaves it out when empty. They combine; each change asks for the first page
   of that combination. A search over 100 characters can't be typed, and one with a control character
   (`Cc`, as `MemberSearch` refuses) shows "Search with visible characters only." and sends nothing; a 422
   anyway shows the same message.
5. **Actions by status.** An `active` row has "Suspend" and "Move out"; a `suspended` row "Reactivate" and
   "Move out"; `pending`, `denied` and `deactivated` rows have none. Each button's accessible name includes
   the member's name ("Suspend Robin Park").
6. **Suspend.** The dialog names the member and their unit, asks for a reason ("Reason (only managers see
   it)") with P4-08b's reason rules and messages (3–500 code points after trimming, no `Cc`/`Cf`/`Zl`/`Zp`,
   a 422 on `reason` placed by its `type`), and Confirm sends `members_suspend` `{reason}` for that row. On
   200: the dialog closes, "<name> was suspended." shows and the list is asked for again.
7. **Reactivate.** The dialog names the member; Confirm sends `members_reactivate`; on 200 "<name> was
   reactivated." shows and the list is asked for again.
8. **Move out.** The dialog names the member and says their current unit's occupancy ends and they lose
   access to the building; it asks for a reason with the same rules; Confirm sends `members_deactivate`
   `{reason}`; on 200 "<name> was moved out." shows and the list is asked for again.
9. **One request.** **Given** a double-click on a dialog's confirm button, **then** exactly one request is
   sent (an in-flight guard ahead of `disabled`, which stays on until the answer). Cancel and Escape close
   the dialog and send nothing; focus returns to the row's button. While a request is out, nothing closes
   the dialog.
10. **Refusals that end the dialog** (the list is asked for again each time): 409 `cannot_target_self` →
    "You can't suspend yourself." / "You can't move yourself out."; 409 `invalid_transition` → "<name>'s
    status changed in the meantime, so this wasn't done. Check the list and try again."; 409
    `occupancy_changed` (move-out) → "<name>'s unit changed at the same time, so this wasn't done. Check the
    list and try again."; 404 `member_not_found` → "This member is no longer in this building." After a
    dialog closes with a message, focus goes to the message.
11. **Other failures** (429, 500, network): the dialog stays open with its reason, shows "Could not suspend
    (reactivate, move out) <name>. Try again." (the 429's wait when it has one), and the button works again.
12. **Refresh failure.** **Given** the list's refresh after an action fails, **then** "Could not refresh the
    members." with "Try again" shows above the old rows, and "Show more" is not offered until a refresh
    succeeds (P4-08b round 3 F1: a next page would hide the error without repairing the first page).
    "Show more" is also unavailable while any fetch of the list is out (P4-08b round 2 F1).
13. **Leaving and switching.** **Given** the page is left (another route, Back, a building switch) while an
    action is in flight, **then** nothing of it shows on the new screen, and the building's list is still
    asked for again when the answer comes (the mutation's invalidation, not the component's). A building
    switch lists the new building's members (`['b', buildingId, 'members', …]` keys), and an action's
    `building_not_found` marks the building denied (`buildingDenial.ts`: the mutation is keyed by building).
14. **Server-driven change.** **Given** a refetch (window focus) while a dialog is open changes or drops its
    row, **then** the dialog stays on what it showed, and Confirm gets the server's answer
    (`invalid_transition` or `member_not_found`, criterion 10): the server's conditional update decides,
    not the list.
15. **Carried backend test (P4-06b, PR #94 round 2 L1).** `backend/tests/memberships/test_members_concurrency.py::test_stale_manager_cannot_move_a_member`
    gets a `[noop]` case: a demoted manager's same-unit, same-relationship transfer gets 403 / 404 like the
    others, and nothing is written.

Tenant table (`ENGINEERING_PRACTICES.md` §7): no new endpoint. Rows 1–4, 6, 8 and 10 for these routes are
P4-06a/P4-06b's backend tests (`backend/tests/memberships/`); the UI's part is rows 3/4 as criterion 13
(another building's members are never shown or acted on) and P4-08b's page guard (a non-manager gets `/403`
and no request), and row 10 as criteria 9 and 14.

## Test plan

- Vitest (`frontend/src/features/residents/members.test.tsx`): list, filters and states (3–5, 12), each
  dialog and its errors (1, 6–11), leaving and switching (13), the server-driven change (14).
- Pytest: criterion 15.
- Manual on the local stack: suspend, reactivate and move-out as a transcript, and 375 px Chromium checks (2).
- Commands: `make check` (frontend lint, typecheck, build and tests included).

## Likely files

`frontend/src/features/residents/**`, `backend/tests/memberships/test_members_concurrency.py`.

## Must explain (learning checkpoint)

1. Why does every outcome (success or refusal) ask for the list again, from the mutation and not the dialog?
2. Why may "Show more" not run while the list's refresh is out or has failed?

## Carried from P4-06b (via P4-08)

- Backend test gap (review round 2, L1 of PR #94): criterion 15.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: 2 names the inputs and the browser (P4-08b's wording). Added: 1 (the
  `last_manager` path this ticket can reach, from suspend and move-out), 3–5 (list, filters, search, actions by
  status), 6–8 (each dialog), 9 (double-click, Cancel, Escape, focus return), 10–11 (every documented code of
  these three routes, and generic failures), 12 (refresh failure and "Show more", the two P4-08b review
  findings, applied from the start), 13 (abandoned caller, Back, building switch, denial), 14 (server-driven
  change under an open dialog; the case the ticket missed), 15 (the carried test).
- Criteria loosened (with reason; also listed in the inbox): none. Criterion 1 (last manager removing their
  own role) moved unchanged to P4-08e, which builds the roles editor it needs.
- Decisions taken (with basis):
  - **Split (playbook step 1.4).** Costing the error and race criteria: API hooks ~55, the list with filters,
    search, states and paging ~170, a dialog for the three status actions with errors ~140, the shared modal
    shell and reason rules taken out of `DecisionDialog` ~+15 net, the tab ~5: ~385. The roles editor (role
    checkboxes, `no_roles_left`, `resident_has_unit`, `last_manager` on own role, `/me` refresh after a change
    to oneself) ~90 and the transfer (unit search over `GET /units?active=true`, relationship, four codes)
    ~110 would take it to ~585, so they moved to [P4-08e](./P4-08e-member-roles-and-transfer.md), which
    depends on this ticket. Default.
  - **Filters in component state, not the URL (autonomous, reversible):** the tab is in the URL (P4-08b);
    the filters reset on Back, as the panel is keyed by history entry. Simplest.
  - **Search on submit, not as you type (autonomous):** one request per search, no timer, no out-of-order
    answers to reconcile (each combination is its own query key).
  - **Default filters "All" (matches the API's default: every status), so a manager finds a suspended or
    moved-out member (P4-06a's list default).** Default.
  - **Own row keeps its buttons (autonomous, simplest):** the server's `cannot_target_self` decides and
    criterion 10 shows it; hiding them would duplicate the server's rule from `/me`.
  - **Pending rows have no action (ticket scope: they are decided in "Pending requests").**
  - **One status dialog for suspend, reactivate and move out; the modal shell (backdrop, `role="dialog"`,
    Escape, Tab trap) and the reason rules move out of `DecisionDialog` into shared modules (autonomous,
    convention: no UI kit; reuse over a copy).** `DecisionDialog`'s tests stay as they are.
- Split: the roles editor and the transfer → [P4-08e](./P4-08e-member-roles-and-transfer.md).

## Follow-ups (from PR #100)

- P4-08b's `PendingRequests` outcome message has no `[overflow-wrap:anywhere]` (a long name in "<name> was
  approved." overflows at 375 px; PR #100 D3): carried to [P4-08d](./P4-08d-pending-badge-and-onboarding-follow-ups.md).
- The roles editor, the transfer and the original criterion 1: [P4-08e](./P4-08e-member-roles-and-transfer.md).
- Accepted: re-submitting the same search doesn't refresh (PR #100 D4); the round 1 fix commits were not re-reviewed
  (round 1 said `MERGE`). See [the explanation](../explanations/P4-08c-members-administration.md) §7.
