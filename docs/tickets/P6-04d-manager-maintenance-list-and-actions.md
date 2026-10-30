# P6-04d — Manager maintenance list, filters and transitions

| Field | Value |
|---|---|
| Phase / lane | P6 / A |
| Risk tier | 2 |
| Depends on | P6-04c, P6-03c |
| Replaces old | M8-T03 (list and actions part) |
| Status | todo |

Split from the P6-04 stub ([P6-P7-backlog.md](./P6-P7-backlog.md)); after
[P6-04c](./P6-04c-maintenance-request-view.md), whose request view it opens.

## Goal

Property management works the building's requests on one page: a list filtered by status (and what else framing
adds), each request opening P6-04c's view with start, hold, resolve and reopen in a confirm dialog. Security sees
the list and the view without actions. The legacy `ManagementMaintenance` page is gone.

## Why

Journey 6's manager half ("The manager moves it through the states, adding a public comment and an internal
note"). P6-03c's actions are merged; this puts them in the UI with the codebase's action-dialog pattern (one
request per confirm, a 409 as a message; CLAUDE.md rule 7, `features/notices/NoticeActionDialog.tsx`).

## Scope

- In (`frontend/src/features/maintenance/`):
  - **staff page** at the path framing picks (default `/manage/maintenance`, as `/manage/notices`),
    `PAGE_ACCESS.ManagementMaintenance` with the roles framing settles from P6-03a's visibility (stub default:
    security reads and comments, so property management and security; council as P6-03a decided), route
    `<path>/:requestId?` under `RequirePageAccess`, keyed by building
  - **list** of the building's requests, 25 a page with "Load more", newest first; a status filter (toggle buttons
    with `aria-pressed`, as `ManagerNoticesPage`, "Open" = `submitted`, `in_progress`, `on_hold` by default, plus
    each status and "All"); each row with status, category, location, the requester's name, the submit time and
    the comment count if the API returns one
  - **API:** `maintenance_list`'s `status` becomes repeatable (`?status=submitted&status=in_progress&…`, as
    `app/packages/router.py`'s `Statuses`), so "Open" is one paged query; one value keeps P6-03b's behaviour, an
    unknown one stays 422. Additive, ~10 lines, tested
  - other filters only where the API filters (category, location); a filter the API lacks is either added to
    `maintenance_list` here (small, additive, tested) or left as a follow-up, as framing decides; the browser never
    filters a page it was given
  - **transition dialog** on the request view for property management: the actions `ALLOWED` gives from the
    current status (start, hold, resume as P6-03a named it, resolve, reopen while P6-03c's window is open), one
    request per confirm; 409 `invalid_transition` and the window error turned into messages, the dialog staying
    open; afterwards the list, the view and the resident's list key refreshed (cancel, then invalidate; P6-05b
    adds the dashboard key)
  - focus: Cancel and Escape return to the opener; after a success focus goes to the view's status line (it stays
    mounted), as P6-02c sharpened
  - delete `src/pages/ManagementMaintenance.jsx`, `/ManagementMaintenance` redirects (`LegacyRedirect`); the
    tests that use `/ManagementMaintenance` as "a legacy staff page" (P6-02c D7: `shell.test.tsx`,
    `building.test.tsx`, `nav.test.tsx`) move to another legacy page with the same shape, or to a fixture, with
    the same assertions; lower the ratchet
- Out: a kanban board (see "Open decisions"); assigning, scheduling, priority (P6-03c Out); bulk actions

## Interfaces

Consumes `maintenance_list` (with `status`, repeatable from this ticket, and the filters framing adds), `maintenance_get`,
`maintenance_start`, `maintenance_hold`, `maintenance_resolve`, `maintenance_reopen` (and resume if separate), as
P6-03c merged them; 403 `forbidden_role` for non-managers, 409 `invalid_transition`, the window error's code.

## Acceptance criteria

1. **Given** `a_manager` and requests in every status, **then** "Open" lists `submitted`, `in_progress` and
   `on_hold` only, each status filter lists only its own, "All" lists every one, in the API's order; filters are
   sent to the API, and a filter change doesn't show the previous filter's rows while the new ones load.
2. **Given** a `submitted` request, **when** the manager confirms start, **then** exactly one request is sent
   (also for two clicks in one tick), the view and the list show `in_progress`, and focus is on the status line.
   Each allowed move works the same; an action `ALLOWED` doesn't give from the shown status has no button.
3. **Given** two managers acting on one request at once (or the requester cancelling), **then** one succeeds and the
   other's dialog shows "Already changed by someone else", stays open with its buttons enabled, and both screens end
   on the same status after the refresh (tenant row 10, UI side).
4. **Reopen window.** **Given** a request resolved more than 14 days ago by the server's clock, **then** reopen,
   if shown, gives the window message; the server decides, the browser's clock only hides the button early.
5. **Access (tenant rows 1, 2, 4).** Property management and the roles framing admits open the page; security sees
   no action buttons and the API's 403 is never invited from this page; a resident-only member gets `/403` without
   asking the API; signed out goes to login; `maintenance` off gives `/403` and no nav item.
6. **Tenant row 3, UI side.** Only the selected building's URLs are asked; `building_not_found` marks the building
   denied; switching building closes an open dialog and shows only B's rows.
7. **375 px in Chromium** with the longest values (description, common-area detail, requester name), the list,
   the filters and the dialog stay inside the viewport.
8. The legacy page is deleted, `/ManagementMaintenance` reaches the new page with query and hash, the moved shell
   tests keep their assertions, and the ratchet is lowered.

## Test plan

- `frontend/src/features/maintenance/managerMaintenance.test.tsx`: criteria 1, 5, 6, 8
- `frontend/src/features/maintenance/transitions.test.tsx`: criteria 2–4
- `frontend/src/app/{shell,building,nav}.test.tsx` updated (criterion 8)
- `backend/tests/maintenance/test_api.py`: the repeated `status` (several, one, an unknown one 422, cursor paging
  across statuses), and any other filter added to `maintenance_list` (10-case rows 1, 3)
- Chromium check at 375 px and focus after a transition (criteria 2, 7), output in the PR
- `make check DB_PORT=55432`; on `make up`, a request moved through every state, transcript in the PR

## Likely files

`frontend/src/features/maintenance/{ManagerMaintenancePage.tsx,ManagerMaintenanceList.tsx,TransitionDialog.tsx,
api.ts,RequestView.tsx}`, `frontend/src/app/{pages.ts,routes.tsx,shell.test.tsx,building.test.tsx,nav.test.tsx}`,
`frontend/src/pages/ManagementMaintenance.jsx` (deleted), `frontend/base44-baseline.txt`. Copy from
`features/notices/{ManagerNoticesPage,ManagerNoticeList,NoticeActionDialog}.tsx`.

Estimate: ~390 non-test lines (page ~110 against `ManagerNoticesPage.tsx` 129, list ~150 against
`ManagerNoticeList.tsx` 148, dialog ~100 against `NoticeActionDialog.tsx` 108, hooks and routes ~30), plus ~10 for
the repeatable `status`. Another backend filter adds ~30; if framing adds more than one, it is a follow-up.

## Must explain (learning checkpoint)

1. Why does the UI never send `PATCH status`, and how does it know which actions to offer?
2. Of two managers starting one request, which wins and how does the loser's screen recover?
3. Which roles open this page, which see actions, and what would the API answer if the UI were wrong?

## Open decisions (resolve while framing)

From the stub:
- **A board or a list.** The stub says "a manager board or list with filters". Default: a list with a status
  filter (one paged query per filter, keyboard-usable, fits 375 px); a kanban board needs one paged query per
  column and drag interactions the codebase doesn't have.
- **Can security see or act on maintenance?** Stub default (P6-03a–d): read and comment only, so security opens
  the page without actions.

Left open by the stub:
- the page's path and label (`/manage/maintenance`, "Manage maintenance", as P6-02c D2)
- which filters beyond status, and whether `maintenance_list` gains them here
- whether council opens the page (follows P6-03a's council decision; if council alone sees no rows, no)

## Follow-ups from P6-04c (PR #159)

- Every maintenance notification links `/maintenance/<id>` (`backend/app/maintenance/service.py`), a resident-only
  page, so a manager's notification (a new request, a resident's comment) opens a page they can't use. This ticket's
  route must take those links (a redirect from `/maintenance/<id>` for staff, or a role-aware link).
- The request view (`RequestDetailDialog`) is reached by a pure manager only through this ticket's route: run P6-04c's
  internal-label tests (`comments.test.tsx`) for a manager-only member there.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
