# P6-04c — One maintenance request: timeline and comments

| Field | Value |
|---|---|
| Phase / lane | P6 / A |
| Risk tier | 2 |
| Depends on | P6-04a, P6-04b, P6-03c, P6-03d, P6-03e |
| Replaces old | M8-T02 (detail part), M8-T03 (comments part) |
| Status | in progress |

Split from the P6-04 stub ([P6-P7-backlog.md](./P6-P7-backlog.md)); after
[P6-04a](./P6-04a-resident-maintenance-list.md) and [P6-04b](./P6-04b-maintenance-submit-and-cancel.md), whose
`EmergencyNotice` it reuses (both also edit `api.ts` and `MyMaintenancePage.tsx`, so they don't run at once). [P6-04d](./P6-04d-manager-maintenance-list-and-actions.md) opens
the same view from the manager's list. **Split in framing:** the comment box, the internal toggle and sending
(criteria 3 and 4, and the box's part of 8) moved to [P6-04g](./P6-04g-maintenance-comment-box.md); this ticket
adds the status-event read the timeline needs (Frame notes).

## Goal

Anyone who can see a request opens it at `<path>/<id>` and sees its details, its photos, a timeline of its status
changes and comments, and a comment box; staff get an "Internal" toggle, and an internal comment is marked as
such for them and never shown to a resident.

## Why

Journey 6's privacy promise in the UI ("The resident sees the status changes and the public comment, never the
internal note"). The server already hides internal comments (P6-03d); this view must not reintroduce one (a
cached staff thread shown to a resident after a building or account switch, an optimistic insert) and must make
the toggle hard to misuse. Every P6-03c/d notification links here.

## Scope

- In (`frontend/src/features/maintenance/`):
  - **request view** at `<path>/<id>` (P6-04a's route; a dialog over the list or a panel, as framing picks, as
    `PackageDetailDialog` and `NoticeDetailDialog` are): status, category, location, description (as text, never
    HTML), submit time, the requester as P6-03b decides residents see them, the emergency phone on an emergency
    request (P6-04b's copy), photos through `features/files/PrivateImage.tsx`
  - **timeline**: the status changes (from the row's `*_at` columns, or a status-event read, as P6-03a's framing
    settled) merged with the comments in time order, each with its time in the building's timezone and its author
    as P6-03d returns them
  - **(added in framing) the status-event read** (backend): `GET …/maintenance-requests/{id}/status-events`
    (`maintenance_list_status_events`), cursor pages oldest first like `maintenance_list_comments`, 404 exactly as
    `maintenance_get`; each item `id`, `from_status`, `status`, `at` (no `by`: who moved it is not shown)
  - comment hooks over `maintenance_list_comments` (cursor pages, oldest first; "Show earlier" or "Load more" as
    the API's order needs) and `maintenance_comment`
  - **comment box** (moved to P6-04g): body with P6-03d's `max_length`; for a caller with a staff role P6-03d lets write internal,
    an "Internal note (staff only)" checkbox, off by default and reset to off after each send; an internal comment
    in the thread shows an "Internal" label as text; one request per send; errors as messages, the text kept
  - not-found state: a hidden, other-building, random or non-UUID id shows "Request not found" (the same screen
    for each, as P6-02b's notice view), and closes back to the list
  - the manager's view reached from P6-04d's list uses the same component; its route is P6-04d's
- Out: status actions (P6-04d adds them to this view for property management); editing or deleting comments (no
  API); comment photos unless P6-03d added them (then they render through `PrivateImage`, and uploading one is a
  follow-up)

## Interfaces

Consumes `maintenance_get`, `maintenance_list_comments`, `maintenance_comment` and
`GET /files/{id}/download-url` (through `PrivateImage`), as P6-03b–d merged them. Keys
`['b', buildingId, 'maintenance', 'request', id]` and `[…, 'comments']`; both `staleTime: 0` (the view can close
and reopen while a manager acts).

## Acceptance criteria

1. **Given** a request with photos, two status changes and two public comments, **when** its requester opens
   `<path>/<id>` (also from a notification's link, P6-03c/d), **then** the details, the photos and the timeline in
   time order show; times are in the building's timezone.
2. **Internal comments.** **Given** one public and one internal comment, **then** `a_manager` sees both, the
   internal one labelled "Internal"; the resident sees only the public one (the server's answer, rendered as
   given); and nothing of a staff thread cached in the tab shows to a resident: switching to a building where the
   caller is a resident, or a new user signing in on the tab (the session epoch), shows only that caller's answer.
3. **The toggle.** Moved to [P6-04g](./P6-04g-maintenance-comment-box.md) criterion 1, unchanged.
4. **Sending.** Moved to [P6-04g](./P6-04g-maintenance-comment-box.md) criterion 2, unchanged.
5. **Not found.** A request of another resident, of building B (under A's path), a random UUID and a non-UUID id
   each show "Request not found", with no second request for the comments of a request that wasn't found.
6. **Refresh.** After a status change by another session, reopening the view or refocusing the tab shows the new
   status and timeline (no 30 s stale answer, the CLAUDE.md `refetchOnMount` lesson).
7. **Back/Forward.** Opening a request, then Back, shows the list where it was; Forward reopens the request; the
   page stays mounted (P6-04a's single route).
8. **375 px in Chromium** with the longest description, the longest comment without spaces and the longest author
   name, the view stays inside the viewport (the comment box's part: P6-04g).

### Added or sharpened in framing

1a. **The timeline's entries and order.** "Submitted" at `submitted_at`; one entry per status event, named by its
   move: `submitted → in_progress` "Work started", `on_hold → in_progress` "Work resumed", `resolved → in_progress`
   "Reopened", `→ on_hold` "Put on hold", `→ resolved` "Resolved"; "Cancelled" at `cancelled_at`; each comment with
   its body as text (line breaks kept) and its author: `author_name`, else "Building management" when
   `author_is_staff`, else "Resident". Ascending time; at the same instant a status change comes before a comment,
   then by id. Each time is shown in the building's timezone.
1b. **Paging.** Both reads are oldest first. While either has a next page, the timeline shows only entries up to the
   newest time both have loaded (the horizon), and one "Load more" asks the next page of each read that has one; so
   nothing shows out of order, and a cancel or a comment newer than the horizon waits for it.
1c. **Text only.** A description or comment holding HTML or Markdown shows as literal text.
2a. **A role change while the view is open** (`/me` says the caller lost the staff role in the building): the
   comments' key holds whether the caller reads internal comments, so the staff answer is never shown under the
   resident's; and the request and comment queries drop their cache when the view closes (`gcTime: 0`).
5a. **A failed read** (500) of the comments or status events shows "Could not load the timeline." with Try again,
   and the details still show; a 404 from either (the request left while open) shows "Request not found".
5b. **The status-event read** (backend), the 10-case table rows that apply: the requester, a co-occupant and staff
   get the events; another resident's request, building B's under A's path and a random id are the same 404;
   signed out 401; an outsider `building_not_found`; the feature off 403; the council-only member sees only their
   own request's; pages are oldest first with no gap.
7a. **The card's link.** Each card has a "Details" link (accessible name with the category and submit time) to
   `<path>/<id>` with `fromList`; Close goes back (Back) to the list, a link from elsewhere closes to the list in its
   place, and focus returns to the link, or the heading if it is gone.

## Test plan

- `frontend/src/features/maintenance/request.test.tsx`: criteria 1, 5–7
- `frontend/src/features/maintenance/comments.test.tsx`: criteria 2, 2a (3–4 moved to P6-04g)
- `backend/tests/maintenance/test_status_events_api.py`: criterion 5b
- Chromium check at 375 px and focus after a send (criteria 4, 8), output in the PR
- `make check DB_PORT=55432`; on `make up`, a public and an internal comment checked as the resident and the
  manager, transcript in the PR

## Likely files

`frontend/src/features/maintenance/{RequestView.tsx,Timeline.tsx,CommentBox.tsx,api.ts}`. Copy from
`features/notices/NoticeDetailDialog.tsx`, `features/packages/PackageDetailDialog.tsx`, `features/files/PrivateImage.tsx`.

Estimate: ~380 non-test lines (view ~130 against `NoticeDetailDialog.tsx` 118, timeline ~90, comment box ~100,
hooks ~60). If P6-03a chose a status-event read the timeline merges, it stays in this range; if the merge needs
its own paging across two cursors, move the comment box to its own ticket.

## Must explain (learning checkpoint)

1. Which server function keeps an internal comment from a resident, and what in this view could still have shown
   one?
2. How is the timeline built from two reads, and what is its order when a comment and a status change share a
   timestamp?
3. Why is the new comment shown from the refetch rather than inserted optimistically?

## Open decisions (resolve while framing)

From the stub: the "internal" toggle is required; who may use it is P6-03d's decision, which this view follows.

Left open by the stub:
- the view as a dialog over the list (as packages and notices) or a page section
- the timeline's paging when comments are many (load all of a request's comments, or page them with the timeline
  showing status changes only up to the oldest loaded comment)
- how the toggle is shown (checkbox and button text, or two buttons "Reply" and "Add internal note")

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: 1a (entries, names, tie order), 1b (paging horizon), 1c (text only), 2a (a role
  change while open; `gcTime: 0`), 5a (a failed or 404 timeline read), 5b (the status-event read's tenant table),
  7a (the card's Details link and focus on close). "No second request" in criterion 5 now covers both timeline
  reads: they start only after `maintenance_get` answered.
- Criteria loosened (with reason; also listed in the inbox): none. Criteria 3 and 4 moved unchanged to P6-04g, and
  the comment box's part of criterion 8 with them (a split, not a loosening).
- Decisions taken:
  - **D1 The status-event read is built here (backend).** Problem: the timeline needs the moves, the row keeps only
    the current state, and no read of `maintenance_status_events` exists (P6-03c's follow-up assigns it to this
    ticket). Chosen: a cursor-paged `GET …/status-events`, visibility exactly as `maintenance_get` (`_visible`).
    Alternatives: the row's `*_at` columns (lose every resume, reopen and repeat; P6-03a ruled it out); the events
    inside `maintenance_get` (an unbounded list in a response the list also shares). Basis: P6-03a/P6-03c records,
    simplest pattern (copies `list_comments`). Fields without `by_membership_id`: a resident is never told which
    manager acted (as `author_name`'s rule), and nothing here needs it; adding it later is additive.
  - **D2 Dialog over the list**, as `PackageDetailDialog`/`NoticeDetailDialog`. Basis: convention (ticket's
    "as … are").
  - **D3 Timeline paging by a horizon** (1b) rather than loading every page on open. Alternatives: fetch all pages
    automatically (unbounded requests on open); comments only paged and events all loaded (events are unbounded
    too). Basis: autonomous, simplest that never misorders.
  - **D4 Toggle shape**: left to P6-04g with the box.
  - **D5 Author fallback "Resident"** for a non-staff comment without a name (a co-occupant's, seen by another
    resident, P6-03d D7). Basis: autonomous; the API gives no name by design.
- Split: over ~400 non-test lines once the status-event read is added (backend ~45, hooks ~70, view ~130, timeline
  ~110, page and card link ~35, comment box and send ~120: ~510). The comment box, toggle and sending go to
  **P6-04g** (criteria 3, 4, the box's part of 8); this ticket keeps ~390.
- Found while framing (follow-up, P6-04d): every maintenance notification links `/maintenance/<id>`
  (`app/maintenance/service.py`), a resident-only page, so a manager's notification lands on a page they can't open
  until P6-04d routes it.
