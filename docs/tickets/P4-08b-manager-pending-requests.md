# P4-08b — Manager pending requests (split from P4-08)

| Field | Value |
|---|---|
| Phase / lane | P4 / B |
| Risk tier | 2 |
| Depends on | P4-08a, P4-05b, P2-06c |
| Replaces old | part of [P4-08](./P4-08-frontend-onboarding-approval-screens.md) (M4-T08) |
| Status | in progress |

Split from P4-08 while framing P4-08a (2026-10-21). Framed 2026-10-21, and split again: the nav pending
badge and the follow-ups carried from P4-08a moved to [P4-08d](./P4-08d-pending-badge-and-onboarding-follow-ups.md)
(see the Frame notes).

## Goal

Managers review the pending join requests and approve or deny them in the new typed frontend.

## Scope

- In:
  - **Manager `/manage/residents`** (replaces the legacy `Residents` placeholder route; the nav item keeps its
    label and place and links here): tabs "Pending requests" and "Members" (the members tab's content is
    [P4-08c](./P4-08c-members-administration.md); until then it says so).
  - Pending tab (`onboarding_list`): approve, and deny (dialog with a required reason, 3–500 characters
    as `OnboardingDecisionIn`); confirmation dialogs.
  - 409 `already_decided` ("Already decided by someone else", and the list refreshes),
    `membership_not_pending` and `unit_inactive` as clear messages.
  - Remove `Residents` from the route allowlist, delete `pages/Residents.jsx` if unused, lower the ratchet.
  - The `CLAUDE.md` lesson for the pattern "size estimate too low" (playbook step 8, first follow-up).
- Out: a bulk-approval UI; document evidence; the nav pending badge and the carried P4-08a / P4-07b fixes
  ([P4-08d](./P4-08d-pending-badge-and-onboarding-follow-ups.md)); the members tab's content (P4-08c).

## Interfaces

Consumes `onboarding_list` (`GET …/onboarding-requests`, pending by default, cursor pages),
`onboarding_approve` and `onboarding_deny` (`POST …/onboarding-requests/{id}/approve|deny`). No API change.

## Acceptance criteria

1. **Given** a double-click on the dialog's Approve (or Deny) button, **then** exactly one decision request
   is sent: an in-flight guard ahead of the button's `disabled`, which stays on until the answer. A 409
   `already_decided` (a colleague decided first) closes the dialog, shows "Already decided by someone else"
   and refetches the list, so the row goes.
2. **Given** mobile width (375 px), **then** the pending list, its buttons and both dialogs fit without
   horizontal scrolling, also with a 254-character email and a long name without spaces (checked in Chromium
   on the stack).
3. **Given** the ratchet, **then** `pages/Residents.jsx` is deleted, `base44-baseline.txt` drops by its 17
   references, and `/Residents` is "Page not found".
4. **Given** a property manager of the selected building, **then** the nav's "Residents" item (same label and
   place as today) links to `/manage/residents`, which shows the heading, the two tabs with "Pending requests"
   selected, and the pending requests newest first: name, email, unit (`A-1203` / `1203`), relationship
   label and the date asked, in the building's time zone. A resident, security or council-only member gets
   the `/403` page there and no nav item; no request is made for the list.
5. **Given** the tabs, **then** they are a keyboard-usable tablist (`aria-selected`, arrow keys) and the
   chosen one is in the URL (`?tab=members`), so Back and Forward switch it; the Members tab says member
   administration is coming (P4-08c).
6. **Given** no pending request, **then** "No pending requests." shows; given a list request that fails,
   an error with "Try again"; given a `next_cursor`, "Show more" loads the next page below.
7. **Given** Approve on a row, **then** a dialog names the person, unit and relationship; Confirm sends
   `onboarding_approve` for that row's id; on success the dialog closes, "<name> was approved." shows, and
   the list refetches. Cancel and Escape close it and send nothing; focus returns to the row's button.
8. **Given** Deny on a row, **then** a dialog asks for the reason the resident will read: empty or under 3
   characters after trimming shows "Give a reason of at least 3 characters." and sends nothing; over 500
   (code points, as the server counts) "Use at most 500 characters."; a line break or an invisible
   character (`Cc`, `Cf`, `Zl`, `Zp`, as `OnboardingDecisionIn`'s `Reason` refuses) "Write the reason on one
   line, with visible characters only." and sends nothing. On success "<name>'s request was denied." shows
   and the list refetches. A 422 on `reason` anyway (the browser's Unicode tables differ from Python's)
   shows the same field messages by its `type` and keeps the dialog and its text.
9. **Given** a 409 `membership_not_pending`, **then** the dialog closes, "This request can no longer be
   decided: the person's membership changed (for example, they accepted an invitation)." shows and the
   list refetches. A 409 `unit_inactive` on approve: "Unit <unit> is no longer active, so this request
   can't be approved. Deny it instead." with the list refetched. A 404 `onboarding_request_not_found`:
   "This request no longer exists." with the list refetched.
10. **Given** any other failure (429, 500, network), **then** the dialog stays open with its input, shows
    "Could not approve (deny) the request. Try again." (the 429's wait when it has one) and the button
    works again.
11. **Given** the page is left (another route, Back, a building switch) while a decision is in flight,
    **then** nothing of it shows on the new screen, and the building's list is still refetched when the
    answer comes (the invalidation is the mutation's, not the component's). Each history entry and
    building gets its own screen (keyed by `location.key` and building), so an open dialog doesn't follow
    the user.
12. **Given** a building switch, **then** the list is the new building's (`['b', buildingId, …]` keys), and
    a decision's `building_not_found` marks the building denied as other building requests do
    (`buildingDenial.ts`: the mutation is keyed by building).
13. **Given** a refetch (focus) while a dialog is open drops its row, **then** the dialog stays on what it
    showed, and Confirm gets the server's 409 `already_decided` path (criterion 1): the server's conditional
    update decides, not the list.

Tenant table (`ENGINEERING_PRACTICES.md` §7): no new endpoint. Rows 1–4, 6, 8 and 10 for these routes are
P4-05b's backend tests (`backend/tests/onboarding/`); the UI's part is rows 3/4 as criteria 4 and 12 (another
building's data is never shown or decided; a non-manager gets `/403` and no request), and row 10 as
criteria 1 and 13.

## Test plan

- Vitest: the page, tabs and list (4–6), the dialogs and their errors (1, 7–10, 13), leaving and switching
  (11, 12), routes and nav (3, 4).
- Manual on the local stack: the approve and deny journey as a transcript, and 375 px Chromium screenshots
  (2).
- Commands: `npm run test`, `npm run typecheck`, `npm run lint`, `make check`.

## Likely files

`frontend/src/features/residents/**` (new), `frontend/src/app/{routes.tsx,routeScope.ts,pages.ts,MainNav.tsx}`,
legacy `frontend/src/pages/Residents.jsx` (removed), `frontend/base44-baseline.txt`, `CLAUDE.md`.

## Must explain (learning checkpoint)

1. Why disable the button *and* rely on the server's conditional update?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: 1 says how one request is guaranteed (guard ahead of `disabled`) and what the
  409 does; 2 names what "usable" means and the hard inputs (P4-08a round 2 M2); 3 names the reference
  count and the 404. 4–13 are added: the route, nav and page contents; the tabs; empty, error and paging
  states; each dialog; the other documented error codes; generic failures; the abandoned caller and Back
  (`CLAUDE.md` lesson); building switch and denial; a server-driven refetch under an open dialog.
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis):
  - **Split (autonomous, playbook step 1.4).** Estimate, costing the error and race criteria as the new
    lesson says: residents feature API ~70, page and tabs ~55, list ~100, the decision dialog (both modes,
    focus, errors) ~150, route/nav/page-table plumbing ~25: ~400. The nav badge (`onboarding_summary`,
    polling, aria) ~45 and the carried P4-08a/P4-07b fixes ~25 would take it to ~470, so they moved to
    P4-08d, which depends on this ticket. The four `AccountMenu` Lows stay carried (neither touches the
    menu); they move to P4-08d with the other carried items.
  - **Nav item stays "Residents" (default: keep what exists).** The page table keeps the `Residents` row in
    its place with a `path`; only its link changes. Existing nav tests stay as they are.
  - **`/Residents` becomes 404 (ADR-0011 / P4-08a precedent: removed legacy routes are "Page not found"),**
    not a redirect.
  - **Tab in the URL (`?tab=`, autonomous):** Back/Forward and links work; the lesson on routes that stay
    mounted applies, so the screen is keyed by `location.key`.
  - **One dialog component for both decisions (autonomous, simplest):** a `role="dialog"` with
    `aria-modal`, initial focus, Escape and focus return; no new dependency (the features use no UI kit).
  - **Members tab placeholder** text until P4-08c (ticket).
- Split: the nav pending badge and the carried items → [P4-08d](./P4-08d-pending-badge-and-onboarding-follow-ups.md).
