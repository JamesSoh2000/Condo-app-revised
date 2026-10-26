# P6-04c — One maintenance request: timeline and comments

| Field | Value |
|---|---|
| Phase / lane | P6 / A |
| Risk tier | 2 |
| Depends on | P6-04a, P6-04b, P6-03c, P6-03d |
| Replaces old | M8-T02 (detail part), M8-T03 (comments part) |
| Status | todo |

Split from the P6-04 stub ([P6-P7-backlog.md](./P6-P7-backlog.md)); after
[P6-04a](./P6-04a-resident-maintenance-list.md) and [P6-04b](./P6-04b-maintenance-submit-and-cancel.md), whose
`EmergencyNotice` it reuses (both also edit `api.ts` and `MyMaintenancePage.tsx`, so they don't run at once). [P6-04d](./P6-04d-manager-maintenance-list-and-actions.md) opens
the same view from the manager's list.

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
  - comment hooks over `maintenance_list_comments` (cursor pages, oldest first; "Show earlier" or "Load more" as
    the API's order needs) and `maintenance_comment`
  - **comment box**: body with P6-03d's `max_length`; for a caller with a staff role P6-03d lets write internal,
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
3. **The toggle.** A resident has no internal toggle and never sends `internal: true`; a staff caller's toggle is
   off by default, its state is part of the button's accessible name or an adjacent text ("Send internal note"),
   and it is off again after a send; a multi-role member gets it only in a building where they hold the staff role
   (`multi_in_a` does not in A).
4. **Sending.** One `maintenance_comment` per send (a double press sends one); the new comment shows in the
   timeline afterwards (from the refetch, not an optimistic insert that could mislabel it); focus stays on the
   comment box, which stays mounted; a 404 (the request no longer visible) shows the not-found state; 422 and 429
   show messages and keep the text; a closed request refuses as P6-03d decides, with that message.
5. **Not found.** A request of another resident, of building B (under A's path), a random UUID and a non-UUID id
   each show "Request not found", with no second request for the comments of a request that wasn't found.
6. **Refresh.** After a status change by another session, reopening the view or refocusing the tab shows the new
   status and timeline (no 30 s stale answer, the CLAUDE.md `refetchOnMount` lesson).
7. **Back/Forward.** Opening a request, then Back, shows the list where it was; Forward reopens the request; the
   page stays mounted (P6-04a's single route).
8. **375 px in Chromium** with the longest description, the longest comment without spaces and the longest author
   name, the view and the comment box stay inside the viewport.

## Test plan

- `frontend/src/features/maintenance/request.test.tsx`: criteria 1, 5–7
- `frontend/src/features/maintenance/comments.test.tsx`: criteria 2–4
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

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
