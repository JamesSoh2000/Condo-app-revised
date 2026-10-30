# P6-04g — Maintenance comment box and the internal toggle

| Field | Value |
|---|---|
| Phase / lane | P6 / A |
| Risk tier | 2 |
| Depends on | P6-04c, P6-03d |
| Replaces old | M8-T03 (comments part) |
| Status | todo |

Split from [P6-04c](./P6-04c-maintenance-request-view.md) in its framing (the status-event read took its room).
Adds the comment box to P6-04c's request view.

## Follow-ups from P6-04c (fix first, test-first; PR #159 review round 3, Codex, confirmed and not fixed)

1. **Medium: a background refetch drops focus from "Load more".** Focus "Load more", then a comments refetch (focus,
   or after a send) disables it; that change re-renders only `Timeline`, so `RequestDetailDialog`'s "focus on `<body>`
   back to the dialog" effect doesn't run and focus stays on `<body>` (Chromium: Escape no longer closes the dialog).
   A send's refetch here makes it likely. Fix at the dialog level (any change inside it), not per control.
2. **Medium: a new request's success steals focus from an open request view.** File a request, open another from its
   Details link while the create is out; the create's success focuses the page's outcome message
   (`MyMaintenancePage`) behind the modal. Don't move focus behind an open dialog.
3. **Low: an uppercase UUID splits the cache.** The dialog keys by the URL's id, `Timeline` by the API's lowercase
   id, so a later timeline 404 shows "Could not load more…" instead of "Request not found". Lowercase the id once.

## Goal

Anyone who can see a request comments on it from the view; staff get an "Internal note (staff only)" toggle that is
hard to misuse.

## Scope

- In (`frontend/src/features/maintenance/`): the `maintenance_comment` mutation hook; **comment box** in
  P6-04c's view: body with P6-03d's `max_length` (2000); for a caller with a staff role P6-03d lets write internal
  (`sees_internal_comments`: security or property management in the building), an "Internal note (staff only)"
  checkbox, off by default and reset to off after each send; one request per send; errors as messages, the text kept.
- Out: editing or deleting comments (no API); comment photos (P6-03d D3: none).

## Acceptance criteria

1. **The toggle** (P6-04c criterion 3). A resident has no internal toggle and never sends `internal: true`; a staff
   caller's toggle is off by default, its state is part of the button's accessible name or an adjacent text ("Send
   internal note"), and it is off again after a send; a multi-role member gets it only in a building where they hold
   the staff role (`multi_in_a` does not in A).
2. **Sending** (P6-04c criterion 4). One `maintenance_comment` per send (a double press sends one); the new comment
   shows in the timeline afterwards (from the refetch, not an optimistic insert that could mislabel it); focus stays
   on the comment box, which stays mounted; a 404 (the request no longer visible) shows the not-found state; 422 and
   429 show messages and keep the text. P6-03d accepts a comment at any status, so a closed request takes one too.
3. **375 px in Chromium** (P6-04c criterion 8's box part): the box, its toggle and its messages stay inside the
   viewport.

## Test plan

- `frontend/src/features/maintenance/commentBox.test.tsx`: criteria 1–2
- Chromium check at 375 px and focus after a send, output in the PR
- `make check DB_PORT=55432`; on `make up`, a public and an internal comment sent as the manager and read as the
  resident, transcript in the PR

Estimate: ~120 non-test lines (box ~100, mutation ~20).

## Open decisions (resolve while framing)

- how the toggle is shown (checkbox and button text, or two buttons "Reply" and "Add internal note")

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken:
- Split:
