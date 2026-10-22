# P4-08e — Member roles editor and unit transfer (split from P4-08c)

| Field | Value |
|---|---|
| Phase / lane | P4 / B |
| Risk tier | 2 |
| Depends on | P4-08c |
| Replaces old | part of [P4-08](./P4-08-frontend-onboarding-approval-screens.md) (M4-T08) |
| Status | done |

Split from [P4-08c](./P4-08c-members-administration.md) while framing it (2026-10-21): with these two actions
its estimate was ~585 non-test lines. Not framed yet: frame it when it is picked.

## Goal

Managers change a member's roles and move a resident to another unit from the members list.

## Scope

- In:
  - On the "Members" tab (P4-08c), for an `active` row: a roles editor (`members_roles_update`
    `{add, remove}`) and, for a member holding `resident`, "Transfer unit" (`members_transfer`
    `{unit_id, relationship}`), with a unit search over `GET /units?active=true&search=`.
  - 409 `last_manager`, `no_roles_left`, `resident_has_unit`, `membership_not_active`, `not_a_resident`,
    `unit_inactive`, `occupancy_changed`, and 404 `unit_not_found`, `member_not_found` shown as clear
    messages.
  - A change to the manager's own roles refreshes `/me` (the nav and page guards follow).
- Out: bulk actions.

## First follow-ups (playbook step 8, from P4-08d)

- Pattern "cached answer reused on remount" reached 2 (PR #98 R3 M1: `useMyOnboarding`; P4-08d R1 F2: the badge after
  "view as"): the client's 30 s `staleTime` serves a remounted component an answer from before it was hidden. Promote it
  (a `CLAUDE.md` lesson, keeping it within 150 lines, or a test): a query whose component can unmount and come back
  while its data changes elsewhere needs `refetchOnMount: 'always'` or `gcTime: 0`.
- Pattern "checked only in jsdom" reached 4 (focus: P2-06c, P4-07a, P4-08b; accessible name: P4-08d D4, Chromium spaced
  an `sr-only` part). Widen the focus lesson to accessible names when promoting, without growing `CLAUDE.md` past 150.
- This ticket changes roles: a manager removing their own `property_management` must lose the nav's Residents badge with
  the item (P4-08d's `ResidentsNavLabel` unmounts with it; `/me` refresh); add it to the criteria.

## Acceptance criteria

(The original criteria: 1 sharpened, 2 sharpened as P4-08c's criterion 2. 3–16 added while framing.)

1. **Last manager.** **Given** the building's only active manager opens "Change roles" on their own row,
   unticks Property manager and saves, and the server answers 409 `last_manager`, **then** the dialog closes,
   "The building must keep at least one active property manager, so this wasn't done." shows, the row still
   lists Property manager after the list is asked for again, and the nav still has "Residents". A transfer
   answered `last_manager` (a manager demoted while it waited) closes with the same message.
2. **Given** mobile width (375 px), **then** the row's buttons, the roles dialog and the transfer dialog (its
   unit search, unit list and relationship choices) fit without horizontal scrolling, also with a 254-character
   email and a long name without spaces (checked in Chromium on the stack).
3. **Buttons by row.** An `active` row has "Change roles" and, when it lists Resident, "Transfer unit", beside
   P4-08c's "Suspend" and "Move out"; no other status has them. Each accessible name includes the member's
   name ("Change roles of Robin Park", "Transfer Robin Park to another unit").
4. **Roles dialog.** It names the member and shows four checkboxes (Resident, Security, Property manager,
   Council) ticked as the row showed them when it opened. Save sends `members_roles_update` with `add` = the
   ticked roles the row didn't list and `remove` = the listed ones unticked (each sorted, as `Role` orders
   them). Nothing changed: "Change at least one role." and nothing is sent; nothing ticked: "A member must
   keep at least one role." and nothing is sent. On 200 the dialog closes, "<name>'s roles were updated."
   shows and the list is asked for again.
5. **Roles refusals that end the dialog** (the list is asked for again each time; focus goes to the
   message): 409 `no_roles_left` → "A member must keep at least one role, so this wasn't done."; 409
   `resident_has_unit` → "<name> lives in a unit, so Resident can't be removed while they do.";
   409 `membership_not_active` → "<name> is no longer active, so this wasn't done. Check the list and try
   again."; 404 `member_not_found` → "This member is no longer in this building."; `last_manager` as
   criterion 1.
6. **Own roles follow.** **Given** a roles change or transfer on the caller's own membership (the row's
   `user_id` is `/me`'s user), **then** `/me` is asked for again after every outcome, also when the page is
   gone by then (from the mutation, not the dialog); a change to another member doesn't ask for it. **Given**
   the caller removed their own Property manager while another manager remains, **then** the nav loses
   "Residents" with its pending badge (no summary request after it went: P4-08d's `ResidentsNavLabel`
   unmounts with the item), and the page's guard shows `/403`.
7. **Transfer dialog.** It names the member and their current unit ("no unit" without one). A unit search
   (label prefix, at most 20 characters, asked 300 ms after typing stops, as the join form) lists the first
   page of `GET /units?active=true&search=` as radio choices (`A-1203` / `1203`); a relationship choice
   (Owner, Tenant, Household member) starts on the current relationship, if any. Confirm without a unit shows
   "Choose a unit."; without a relationship "Choose how they relate to the unit."; nothing is sent. Confirm
   sends `members_transfer` `{unit_id, relationship}`; on 200 the dialog closes, "<name> now lives in unit
   <unit> as <relationship>." (from the response) shows and the list is asked for again. The same unit and
   relationship gets 200 too (nothing written) and the same message.
8. **Unit search states.** A unit picked and then the search changed is no longer picked unless the new list
   shows it. No match: "No active unit starts with "<text>"."; the units request failing: "Could not load the
   units." with "Try again" (the 429's wait when it has one). A control character (`Cc`, as `SearchText`
   refuses) shows "Search with visible characters only." and is not sent.
9. **Transfer refusals.** 404 `unit_not_found` and 409 `unit_inactive`: the dialog stays open, the unit is
   no longer picked, the units are asked for again, and "That unit is no longer available. Choose another."
   shows. Closing the dialog with a message (the list asked for again): 409 `not_a_resident` → "<name> is no
   longer a resident, so this wasn't done."; `membership_not_active` and `member_not_found` as criterion 5;
   409 `occupancy_changed` → "<name>'s unit changed at the same time, so this wasn't done. Check the list and
   try again."; `last_manager` as criterion 1.
10. **One request.** **Given** a double-click on Save or Confirm, **then** exactly one request is sent.
    Cancel and Escape close the dialog and send nothing; focus returns to the row's button. While a request is
    out, nothing closes the dialog.
11. **Other failures** (429, 500, network): the dialog stays open with its choices, shows "Could not change
    <name>'s roles. Try again." / "Could not transfer <name>. Try again." (the 429's wait when it has one),
    and the button works again.
12. **Leaving and switching.** **Given** the page is left while a request is out, **then** nothing of it shows
    on the new screen and the building's members (and `/me`, criterion 6) are still asked for again. The units
    query is keyed `['b', buildingId, 'units', …]`; a `building_not_found` from either action marks the
    building denied (the mutations are keyed by building, as P4-08c's).
13. **Server-driven change.** **Given** a refetch changes or drops the row while a dialog is open, **then** the
    dialog keeps what it showed: the roles diff is computed from the roles shown when it opened, and the
    server's answer decides (criteria 5 and 9).
14. **Lesson "cached answer reused on remount"** (follow-up from P4-08d): `CLAUDE.md` "Lessons learned" says a
    query whose component can unmount and come back while its data changes elsewhere needs
    `refetchOnMount: 'always'` or `gcTime: 0` (PR #98 R3 M1, P4-08d R1 F2), `CLAUDE.md` staying ≤ 150 lines.
15. **Lesson "checked only in jsdom"** (follow-up from P4-08d): the Chromium lesson covers accessible names as
    well as focus (P4-08d D4), in the same line budget.

Tenant table (`ENGINEERING_PRACTICES.md` §7): no new endpoint. Rows 1–4, 6, 8 and 10 for
`members_roles_update`, `members_transfer` and `units_list` are P4-06a/P4-06b/P1-05's backend tests; the UI's
part is rows 3/4 as criterion 12 (another building's members and units are never shown or acted on), P4-08b's
page guard (a non-manager gets `/403` and no request), and row 10 as criteria 10 and 13.

## Test plan

- Vitest (`frontend/src/features/residents/roles.test.tsx`): criteria 1, 3–13.
- Manual on the local stack: a roles change and a transfer as a transcript, and 375 px Chromium checks (2).
- Commands: `make check`.

## Must explain (learning checkpoint)

1. Why is the roles change sent as `{add, remove}` computed from the dialog's snapshot, not the full role set?
2. Why does a change to one's own membership refresh `/me`, and how do the nav and the guards follow from it?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: 1 names the message, what stays and the transfer's `last_manager`; 2 names
  the inputs and the browser (P4-08c's wording). Added: 3 (buttons by row), 4–5 (roles dialog and each
  documented code), 6 (`/me` after a change to oneself, with P4-08d's badge follow-up), 7–9 (transfer
  dialog, unit search, each documented code), 10–11 (double-click, Cancel, Escape, generic failures), 12
  (abandoned caller, building switch, denial), 13 (server-driven change under an open dialog), 14–15 (the
  P4-08d follow-ups). The cases the ticket missed: 8's stale unit pick and 13.
- Criteria loosened (with reason; also listed in the inbox): none. Criterion 5's `resident_has_unit` message was
  reworded during implementation (same trigger and outcome): "transfer them" was wrong advice, since a transfer keeps
  a unit and only a move-out ends it.
- Decisions taken (with basis):
  - **No split (playbook step 1.4).** Costing: hooks for the two actions and the units search ~50, the roles
    dialog with its checks and codes ~100, the transfer dialog with search, states and codes ~150, the
    rows' buttons and `/me` ~25: ~325.
  - **Two dialogs, `RolesDialog` and `TransferDialog`, beside `MemberDialog` (autonomous):** their fields
    differ from a reason; they reuse the `Modal` shell and the closing-refusal messages.
  - **`{add, remove}` from the snapshot the dialog opened with (ticket scope; P4-08c's "the dialog keeps the
    member it was opened with"):** the server ignores a role already held or not held, so a change made
    elsewhere meanwhile is only overwritten for the roles this manager touched.
  - **"No change" and "no roles" checked before sending (autonomous, simplest):** the API refuses both
    (422 `no_change`, 409 `no_roles_left`); the 409 is still shown for a race.
  - **"Transfer unit" only on rows listing Resident (ticket scope).**
  - **Unit search as you type, debounced, first page only (convention: the join form, P4-08a):** a prefix
    narrows the list; no "Show more". `useDebounced` moves to a shared module instead of a copy.
  - **`unit_not_found` / `unit_inactive` keep the dialog open (convention: the join form's `unit_not_found`):**
    the manager can pick another unit.
  - **Removing one's own Property manager ends on `/403` (ticket: "the nav and page guards follow"):** no
    special redirect.
  - **Lessons in `CLAUDE.md`, not a fitness test (ticket follow-up allows either):** neither pattern is
    detectable statically without false positives.
- Split: none.

## Follow-ups (from PR #107)

- Pattern "cached answer reused on remount" reached 3 (R1 F2: the transfer's units served from the 30 s cache), in the
  same PR that added its `CLAUDE.md` lesson: first follow-up of [P4-08f](./P4-08f-account-menu-and-notifications-follow-ups.md).
- Accepted: the unit search shows only the first page; a self change reaches the nav after two requests (`/me`, then the
  building); 496 non-test lines. See [the explanation](../explanations/P4-08e-member-roles-and-transfer.md) §7.
