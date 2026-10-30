# Explanation — P6-04c One maintenance request: timeline and comments

> **PR:** #159 · **Source revision:** `86e542c9d51a3abda906451bd09cb40120fe9b33`, the pre-merge PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (3) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 159 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read `git diff origin/main...HEAD` (19 paths) at `86e542c`, the whole of
> `Timeline.tsx`, `RequestDetailDialog.tsx`, the `api.ts`, page, list and backend diffs, the PR body and the three
> review files; ran `npx vitest run src/features/maintenance src/api/client.test.ts`: 179 passed (6 files), and
> `uv run pytest tests/maintenance/test_status_events_api.py`: 17 passed. Differences from the plan: see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: B.

## 1. What was built and why

A resident opens one maintenance request at `/maintenance/<id>`, from a new "Details" link on each card or from a
notification's link. It opens in a dialog over the list. The dialog shows the request's details and photos, then a
**timeline**: the submit, every status change, the cancel and the comments, in time order, in the building's
timezone, with internal comments labelled "Internal" for staff. The timeline needed every status change, which only
`maintenance_status_events` (P6-03c) holds and nothing read, so this PR adds a backend read,
`GET …/maintenance-requests/{id}/status-events`. With that added the ticket went over its size limit, so framing
moved the comment box, the internal toggle and sending to a new ticket, **P6-04g**. The decisions that matter most:
the timeline merges two paged reads without ever moving a shown entry (D2), and every query of one request is keyed
by whether the caller reads as staff, so a staff answer cached in the tab is never shown to a resident (D3).

## 2. Decisions

### D1. The status-event read is built here, as a cursor-paged endpoint

- **Problem or constraint:** the row keeps only the current status and its latest `*_at` times; a resume, a second
  hold or a reopen is only in `maintenance_status_events`, and there was no read of it (P6-03c's follow-up assigned
  it to this ticket).
- **Chosen:** `backend/app/maintenance/router.py::list_status_events` (`maintenance_list_status_events`), oldest first
  by uuid7 id, returning `MaintenanceStatusEventOut` (`id`, `request_id`, `from_status`, `status`, `at`). Visibility
  is exactly `maintenance_get`'s: `backend/app/maintenance/service.py::list_status_events` calls `_visible` first.
- **Alternatives rejected:** the row's `*_at` columns (they lose every repeated move; P6-03a ruled it out); the events
  inside `maintenance_get` (an unbounded list in a response shape the list endpoint shares).
- **Tradeoffs and accepted limitations:** `by_membership_id` is left out, so no caller learns which manager acted
  (as `author_name` hides staff names from residents); adding it later is additive.
- **Basis:** P6-03a/P6-03c records; copies `backend/app/maintenance/service.py::list_comments`. Autonomous.
- **Source:** recorded (PR #159 D1; ticket Frame notes D1).

### D2. The timeline is a merge that keeps each read in the API's order

- **Problem or constraint:** two oldest-first cursors (status events and comments), each paged 25 at a time, must
  show as one time-ordered list. An entry on a page not yet loaded must never belong above an entry already shown.
- **Chosen:** `frontend/src/features/maintenance/Timeline.tsx::buildTimeline` merges three sequences (the row's submit and cancel, the events, the
  comments), each kept in its own order. Each step takes the earliest head (time to the microsecond, then a status
  change before a comment, then id). It stops as soon as a read that has another page runs out. One "Load more" asks
  the next page of each read that has one.
- **Alternatives rejected:** the plan's *time horizon* (show entries older than the newest time both reads had
  loaded). Review round 1 F2 showed it wrong: a comment's `created_at` is its transaction's start, so a comment that
  waited has a larger id but an earlier time, and arrives on a later page; the horizon then inserted it above rows
  already shown. Ordering the API by `(created_at, id)` (changes P6-03d's merged cursor; the shared `paginate` has no
  composite cursor). Loading every page on open (unbounded requests).
- **Tradeoffs and accepted limitations:** such a delayed comment shows after the one before it in the API's order,
  though its time is earlier. Inferred: the gap is the transaction's wait, well under the minute the timeline shows.
- **Basis:** review finding (round 1, Codex F2 and F3).
- **Source:** recorded (PR #159 D2, Independent review round 1).

### D3. One request's queries are keyed by the caller's role class, and dropped when the view closes

- **Problem or constraint:** criterion 2 (nothing of a staff thread cached in the tab shows to a resident) and 2a (a
  role change seen through `/me` while the view is open). `staleTime: 0` alone still *shows* the cached answer while it
  asks again.
- **Chosen:** `frontend/src/features/maintenance/api.ts::maintenanceRequestKey` is `['b', b, 'maintenance', 'request', id, 'staff' | 'member']`, with
  `'events'` and `'comments'` under it, and `gcTime: 0` on all three. `staff` means security or property management in
  this building, the server's `_SEE_ALL`.
- **Alternatives rejected:** removing the queries on a role change (an effect racing the render that shows them);
  keying by the full role list (council or resident alone change nothing the server answers).
- **Tradeoffs and accepted limitations:** reopening the view always shows "Loading request…" first. The role segment
  on the events is redundant in practice (re-keying the request unmounts the timeline and `gcTime: 0` drops the old
  events; a probe without it still passed); kept so one request's queries share one prefix.
- **Basis:** ticket criterion 2a; review finding (round 1, F1: the plan keyed only the comments, and the request
  itself kept another resident's details).
- **Source:** recorded (PR #159 D3).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| A wide `Modal` dialog over the list | a page section | the ticket names the packages and notices dialogs as the pattern | ticket, convention | recorded (Frame D2) |
| The two timeline reads start only after `maintenance_get` answered | in parallel | criterion 5: no second request for a request not found | ticket | recorded |
| Same instant: status change first, then id | comment first | Inferred in the PR: the comment is usually about the change | autonomous | recorded (PR table) |
| A non-staff comment without a name reads "Resident" | "A co-occupant" | the API hides other residents' names (P6-03d D7) | autonomous | recorded (Frame D5) |
| Photo alt "Photo N of M" | file name | the API gives no name | autonomous | recorded |
| The `Timeline` reads the two queries itself as well as the dialog | queries only in the dialog | see "Plan versus final code" | test result | recorded (PR deviations) |
| Split P6-04g (comment box, toggle, sending) | one PR | ~510 non-test lines with the status-event read | playbook size rule | recorded (Frame notes) |
| Review by fresh Codex `gpt-6.1-sol` (high) sessions, no Claude reviewer | the playbook's Tier 2 Claude reviewer | James's instruction for this run | James | recorded (PR table) |

**Framing changes:** added 1a (entry names, tie order), 1b (paging), 1c (text only), 2a (role change), 5a (a failed or
404 timeline read), 5b (the status-event read's tenant rows), 7a (Details link and focus); moved criteria 3 and 4,
and the comment box's part of 8, unchanged to P6-04g. None loosened. After review round 1, 1b and 2a were rewritten in
the ticket to the final design (commit `3613cd8`).

**Plan versus final code:** (1) `buildTimeline` stayed in `Timeline.tsx` (the plan named a `timeline.ts`). (2) The
plan's horizon became the order-keeping merge (D2, round 1). (3) The plan keyed only the comments by role; the request
key now holds it (D3, round 1). (4) `Timeline` subscribes to the two queries as well as the dialog: with the queries
only in the dialog, `useLoadMore`'s effect ran on the Timeline's own state update before the parent re-rendered, saw
25 rows instead of 28, and sent focus to the dialog (found by the focus test before review). (5) Size: 436 added
non-test lines against ~400.

## 3. How it is implemented

### Overview

- `MyMaintenancePage` (route `/maintenance/:requestId?`) keeps the list mounted and renders
  `RequestDetailDialog` when there is a `requestId`.
- `RequestDetailDialog` reads the request, then (once it answered) its events and comments; any 404 means "Request not
  found".
- `Timeline` reads the same two queries, merges them with `buildTimeline`, and pages them with one "Load more".
- The backend adds one read endpoint; no table or migration changes.

### Walkthrough (variant B: a resident opens a request)

1. **The action.** `frontend/src/features/maintenance/MyMaintenanceList.tsx::Card` renders a `Link` "Details" (name
   "Details: Plumbing, submitted Oct 20, 2026, …") to `/maintenance/<id>` with `state={{ fromList: true }}`; its
   `onClick` hands the link to the page (`onOpen`) so focus can return to it. The route doesn't change component, so
   the page and its list stay mounted (`frontend/src/features/maintenance/pages/MyMaintenancePage.tsx::Maintenance`).
2. **Validation.** `RequestDetailDialog` checks the id against a UUID pattern; a non-UUID id is "Request not found"
   with no request sent.
3. **Hooks.** `frontend/src/features/maintenance/api.ts::useMaintenanceRequest` (key `['b', b, 'maintenance', 'request', id, 'member']`), then, enabled
   by `query.isSuccess`, `useMaintenanceStatusEvents` and `useMaintenanceComments` (`[…, 'events']`,
   `[…, 'comments']`). All three: `staleTime: 0`, `gcTime: 0`.
4. **API calls.** `maintenance_get`, `maintenance_list_status_events` and `maintenance_list_comments`, each with
   `limit=25` and a `cursor` after the first page.
5. **Responses.** Any of the three answering 404 → "Request not found" (`notFound`). The request failing otherwise →
   "Could not load the request." with Try again. A timeline read failing → "Could not load the timeline." with Try
   again inside the dialog, details still shown (`Timeline`'s `failed`). A failed next page → "Could not load more of
   the timeline.", rows kept.
6. **Cache.** Nothing is invalidated (the view writes nothing yet; P6-04g will). The role segment and `gcTime: 0` are
   what keep one caller's answer from another (D3). The list's queries and the view's are separate keys.
7. **States and focus.** The dialog takes focus on mount. Close or Escape goes back in history (`fromList`) or
   replaces the URL with `/maintenance`; the page's effect then focuses the Details link, or the heading if the link is
   gone. After every render, focus on `<body>` goes back to the dialog (round 2). At 375 px the dialog is 343 px wide
   with nothing past the viewport (Chromium, PR evidence).

### Data model changes

None. The endpoint reads `maintenance_status_events` (P6-03c) through its existing index
`ix_maintenance_status_events_building_id_request_id_id`.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/maintenance/router.py` | the status-event route | +14 |
| `backend/app/maintenance/schemas.py` | `MaintenanceStatusEventOut` | +11 |
| `backend/app/maintenance/service.py` | `list_status_events` | +21 |
| `backend/tests/maintenance/test_status_events_api.py` | the endpoint's tenant table (17 tests) | +215 |
| `frontend/src/features/maintenance/api.ts` | the request key and three hooks | +70 −1 |
| `frontend/src/features/maintenance/RequestDetailDialog.tsx` | the dialog | +140 |
| `frontend/src/features/maintenance/Timeline.tsx` | the merge and the timeline | +180 |
| `frontend/src/features/maintenance/MyMaintenanceList.tsx` | the Details link | +25 −4 |
| `frontend/src/features/maintenance/pages/MyMaintenancePage.tsx` | the route param, close, focus return | +32 −4 |
| `frontend/src/features/maintenance/{request,comments}.test.tsx`, `timeline.test.ts`, `frontend/src/test/maintenanceView.ts` | tests and fixtures | +954 |
| `frontend/src/api/schema.d.ts`, `client.test.ts` | generated types; the GET-path list gains the path | +124 |
| `docs/tickets/…` | frame, P6-04g split, P6-07b dependencies | — |

`backend/app/maintenance/service.py::list_status_events`

```python
async def list_status_events(
    db: AsyncSession, ctx: TenantContext, request_id: UUID, params: CursorParams
) -> Page[MaintenanceStatusEventOut]:
    """A request's manager moves, oldest first (P6-04c); 404 for a request the caller can't see.
    Whoever sees the request sees every move: no move is private."""
    await _visible(db, ctx, request_id)
    stmt = select(MaintenanceStatusEvent).where(
        MaintenanceStatusEvent.building_id == ctx.building_id,
        MaintenanceStatusEvent.request_id == request_id,
    )
    return await paginate(
        db,
        stmt,
        MaintenanceStatusEvent.id,
        params,
        MaintenanceStatusEventOut.model_validate,
        descending=False,
    )
```

- `_visible` is the one record-visibility check (`visible_maintenance`, CLAUDE.md rule 3): another resident's, another
  building's and a random id all raise the same 404. Without it any member of the building could list any request's
  moves (mutation probe: 3 tenant tests fail).
- The `building_id` filter keeps the read on the tenant (rule 1) even though `_visible` already checked the request.

`frontend/src/features/maintenance/api.ts::maintenanceRequestKey`

```ts
export const maintenanceRequestKey = (buildingId: string, requestId: string, staff: boolean) =>
  [...maintenanceKey(buildingId), 'request', requestId, staff ? 'staff' : 'member'] as const;
```

- Every query of the view sits under this key (D3). When `/me` drops the caller's staff role, the next render asks
  for a new key with no data, so the dialog shows "Loading request…" instead of the staff answer. Without the segment
  (probe R1-M4) 6 tests in `comments.test.tsx` fail: the other resident's description stays on screen.

`frontend/src/features/maintenance/Timeline.tsx::buildTimeline` (trimmed)

```ts
function instant(at: string): number {
  const micros = /\.\d{3}(\d{0,3})/.exec(at)?.[1] ?? '';
  return Date.parse(at) * 1000 + Number(micros.padEnd(3, '0'));
}
// ...
  const next = reads.map(() => 0);
  const merged: Entry[] = [];
  for (;;) {
    let pick = -1;
    for (const [i, read] of reads.entries()) {
      if (next[i] === read.items.length) {
        if (read.more) return merged;
      } else if (pick === -1 || before(read.items[next[i]], reads[pick].items[next[pick]])) pick = i;
    }
    if (pick === -1) return merged;
    merged.push(reads[pick].items[next[pick]++]);
  }
```

- A k-way merge: each step compares only the heads, so each read keeps its own order. `return merged` when a read
  with another page runs out is the paging rule: that page could hold the next entry.
- Why the prefix never changes: each step before the stop compared the same heads it will compare after a page
  loads, so the merged list after "Load more" starts with the list shown before (`timeline.test.ts` › `F2: rows shown
  before a page loads are the first rows after it…`).
- `instant` keeps microseconds: `Date.parse` alone makes `.000100` and `.000900` a tie (round 1 F3; probe R1-M2 fails
  one test).

`frontend/src/features/maintenance/RequestDetailDialog.tsx::RequestDetailDialog` (the not-found rule and the focus
effect)

```tsx
  const query = useMaintenanceRequest(buildingId, requestId, staff, valid);
  // Read here for their 404 only; the timeline reads them again (the same queries) to show them.
  const events = useMaintenanceStatusEvents(buildingId, requestId, staff, query.isSuccess);
  const comments = useMaintenanceComments(buildingId, requestId, staff, query.isSuccess);
  // ...
  useEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) dialogRef.current?.focus();
  });

  const notFound = !valid || [query, events, comments].some((read) => isNotFound(read.error));
  // A failed request hides an answer cached from before, so an old status never reads as current (as packages).
  const item = notFound || query.isError ? undefined : query.data;
```

- `enabled: query.isSuccess` is criterion 5's "no second request" (probe M3: 3 tests fail when they start at once).
- `notFound` over all three reads: a request that leaves while open (a later 404 from comments or events) becomes
  "Request not found" (probe M6).
- The effect without dependencies runs after every render of the dialog; it observes all three reads, so an error or
  404 that removes the focused entry re-renders it and focus comes back from `<body>` (round 2 F1). It does **not** run
  on a change only the Timeline renders (round 3 F1, §7).

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Times in the device's zone | `buildingTime` formats in the building's zone | `request.test.tsx` › `shows the details, the photos and the timeline in time order…` (across the EDT change) |
| A hold and a comment at one instant | status first | same test (rows 4–5) |
| Each move named by where it came from; a cancel; a co-occupant's comment | `moveName`, the row's `cancelled_at`, "Resident" | `names every move from where it came from…` |
| An entry from an unloaded page belongs above shown rows | the merge stops where a read with more runs out | `timeline.test.ts` (7 tests); `request.test.tsx` › `pages both reads at once…`, `shows nothing past the newest time both reads have loaded…` (named after the replaced horizon; its assertions are the merge rule's: 26 rows, the resolve waits) |
| A comment whose transaction waited (earlier time, larger id) | kept after the one before it | `timeline.test.ts` › `F2: a comment whose time is earlier…` |
| Microsecond times in one millisecond; a non-Z offset | `instant` | `timeline.test.ts` › `F3…` (3 tests) |
| HTML or Markdown in a description or comment | rendered as text | `shows HTML and Markdown in a description or comment as typed` |
| A staff answer shown to a resident (role change, building switch, new user, reopen) | role-class key, `gcTime: 0`, `removeQueries` on a new user | `comments.test.tsx` (12 tests incl. `F1: losing the staff role hides a request only staff could see…`) |
| Another resident's, B's, random, non-UUID id | "Request not found", no timeline request | `request.test.tsx` › `shows "Request not found" for …` (4) |
| The request leaves while open | 404 from either timeline read → not found | `turns into "Request not found" when the status events answer 404…`, `…when the comments answer 404` |
| A timeline read fails | alert with Try again; details kept | `shows a failed timeline read…`, `shows a failed status-event read…` |
| A status change made elsewhere | asked on every open and on focus | `shows a manager's change when the view is opened again…`, `asks again when the tab is refocused…` |
| Back/Forward | the page stays mounted; list asked once | `opens and closes with Back and Forward…` |
| Focus after Close, Try again, Load more, an error | link, heading, dialog or first new entry | `opens from a card's Details link…`, `returns focus to the heading when the list refreshed the Details link away…`, the three `known failure cases` tests, the five `review round 2` tests |
| The status-event read's tenant rows | `_visible`, building filter, feature and auth guards | `test_status_events_api.py` (17 tests incl. `test_a_council_only_member_sees_no_requests_moves`) |
| 375 px with the longest values | wraps anywhere | No test (jsdom has no layout); Chromium run in the PR |

**Acceptance criteria → tests:** 1 and 1a → `the requester opens a request` (4 tests); 1b → `timeline.test.ts`,
`pages both reads at once…`; 1c → `text only`; 2 and 2a → `comments.test.tsx`; 3 and 4 → moved to P6-04g; 5 and 5a →
`not found` and the round 1 coverage tests; 5b → `test_status_events_api.py`; 6 → `refresh`; 7 and 7a → `Back,
Forward and the card's link`; 8 → Chromium in the PR (dialog 343/343 px, no element past the viewport).

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol` (high), fresh | `2a5e991` | BLOCK | F1 High: the request's cache survives a role downgrade; F2 Medium: the horizon assumes time order within a read; F3 Low: millisecond sorting; 3 coverage gaps | all fixed in `705bd70`; gaps tested |
| 2 | Codex `gpt-6.1-sol` (high), new fresh | `3613cd8` | MERGE | F1 Medium: an error or 404 removes the focused entry, focus on `<body>`; a council-only gap | fixed in `86e542c`; council-only test added |
| 3 | Codex `gpt-6.1-sol` (high), new fresh | `86e542c` | MERGE | F1, F2 Medium; F3 Low (below) | confirmed, not fixed: the last round (§7) |

- **R1 F1.** A member who is a resident and the property manager opens another resident's request; `/me` drops the
  manager role; while the resident's read is out the dialog still showed that request's description, common area and
  requester name. Fixed by D3. Evidence: `comments.test.tsx` › `F1: losing the staff role hides…` and 4 neighbours,
  failing before `705bd70`.
- **R1 F2.** Codex's backend proof wrote comments from two sessions: in id order, `created_at` went 16.883402 then
  16.868250. With the horizon, "Load more" inserted the delayed comment above shown rows. Fixed by D2. Evidence:
  `timeline.test.ts` F2 tests, failing before `705bd70`.
- **R1 F3.** `.000100` and `.000900` parsed as one millisecond, so the later status change came first. Fixed by
  `instant`.
- **R2 F1.** "Load more" parks focus on the last entry; the next page answering 404 turned the dialog into "Request
  not found", the entry went, focus fell to `<body>`, and Escape no longer closed the dialog (Codex, Chromium). Fixed by
  the dialog's focus effect. Evidence: five `review round 2` tests, 4 failing before `86e542c`; Chromium after the fix
  with the next page intercepted as 404: `focus=DIV role=dialog`, Escape → `/maintenance`.

## 7. Not verified, accepted risks and follow-ups

- **Review round 3, confirmed and not fixed** (reproduced here: `3 failed (3)` on Codex's proofs). Round 3 is the
  last the playbook allows, so a fix would merge unreviewed; each is P6-04g's to fix first (step 6 adds them there):
  - **R3 F1 Medium:** a background refetch disables a focused "Load more"; that change re-renders only the Timeline,
    so the dialog's focus effect doesn't run and focus stays on `<body>` (Chromium: Escape then doesn't close it).
  - **R3 F2 Medium:** filing a new request, then opening a request while the create is out: the create's success
    focuses the page's outcome message behind the open dialog.
  - **R3 F3 Low:** an uppercase UUID in the URL: the dialog keys by the URL's id, the Timeline by the API's lowercase
    id, so a later timeline 404 shows "Could not load more…" instead of "Request not found".
- **A manager can't reach this view in the app yet:** `/maintenance` is resident-only. The internal-label tests use a
  member who is a resident and the property manager. P6-04d's route mounts the same dialog. The manager's internal
  comment on the stack was checked by API only (journey transcript in the PR).
- **Managers' notifications link a resident-only page** (`/maintenance/<id>`, from `backend/app/maintenance/service.py`): for
  P6-04d (added in step 6).
- **The header's account button overflows** with a 200-character name without spaces (Chromium `scrollWidth` 2317 at
  375 and 768 px on every page); the dialog fits. Pre-existing; inbox (step 6).
- 375 px and focus were checked in Chromium by a scratch Playwright run on the stack, not a committed test; Firefox and
  Safari not run.
- Criterion 5b's council-only row: the wording ("sees only their own request's") came from `a_council`, who is also a
  resident; a council-only member sees no request at all, own included (P6-03a), which the test asserts.
- 436 added non-test lines against ~400.

## 8. How to change this safely

- **P6-04g's comment box** goes inside `RequestDetailDialog`'s body. After a send, invalidate
  `[...maintenanceRequestKey(b, id, staff), 'comments']` (cancel first, as `frontend/src/features/maintenance/api.ts::refresh` does) so the new comment
  comes from the refetch; `comments.test.tsx` keeps the role isolation honest, and the round 3 findings belong there.
- **P6-04d's actions** add buttons to the same dialog: after a move, refresh the request and its `'events'`; the
  `review round 2` tests show where focus must land when the dialog's content changes.
- Changing the merge: run `timeline.test.ts` first; the prefix test fails if a shown row can move.
- A new field on the events endpoint: add it to `MaintenanceStatusEventOut`, run `make gen-api`, and extend
  `test_members_who_see_the_request_list_its_moves_oldest_first`, which asserts the exact field set.

## 9. Must explain, then quiz

1. **Which server function keeps an internal comment from a resident, and what in this view could still have shown
   one?** `backend/app/maintenance/queries.py::visible_maintenance_comments` (P6-03d) filters them in the query, for
   every caller who isn't security or property management (`sees_internal_comments`). The view could still have shown
   one from the tab's cache: a staff answer under the same key after a role change, a building switch or a new user,
   or an optimistic insert. D3's key and `gcTime: 0`, the building in every key, and `removeQueries` on a new user
   close those (`comments.test.tsx`); there is no optimistic insert.
2. **How is the timeline built from two reads, and what is its order when a comment and a status change share a
   timestamp?** `frontend/src/features/maintenance/Timeline.tsx::buildTimeline` merges the row's submit and cancel, the status events and the comments,
   each in its read's order, by time to the microsecond, and stops where a read with another page runs out. At the
   same instant the status change comes first, then by id.
3. **Why is the new comment shown from the refetch rather than inserted optimistically?** (Sending is P6-04g's; the
   reason is recorded in the ticket.) An insert built in the browser would decide the comment's internal flag,
   author name and time itself; the server's answer is the one rule for what each caller sees (`author_name` is null
   for some callers, `is_internal` is staff-only), so a mislabelled or misplaced comment could show. The refetch
   shows exactly the server's answer.

Quiz:

1. Why does the merge stop when a read with another page runs out, instead of showing every loaded entry?
2. A resident and property manager is viewing another resident's request when a manager removes their manager role.
   Walk through what the dialog shows next, and why.
3. Why does `Timeline` call `useMaintenanceComments` again when `RequestDetailDialog` already reads it?
4. What would break if `enabled: query.isSuccess` were removed from the two timeline reads in the dialog?
5. How would you show who moved each status, for staff only?

<details><summary>Answers</summary>

1. The next page could hold an entry earlier than the next one available elsewhere; showing past that point would
   later need an insertion above shown rows. Stopping keeps every "Load more" an append (`timeline.test.ts` F2).
2. `/me` changes the roles; `staff` becomes false; the dialog's queries move to the `'member'` keys, which have no
   data, so it shows "Loading request…". The server then answers 404 (the resident can't see it): "Request not found".
   Nothing of the staff answer shows meanwhile (`F1: losing the staff role…` and its 404 neighbour).
3. `useLoadMore` moves focus in an effect after the page lands. With the queries only in the parent, the Timeline's
   own state update rendered it with the parent's old props (25 rows), so focus went to the dialog. Reading the
   queries itself, the Timeline renders the new rows in that same update. Same keys, so no extra request.
4. The timeline reads would be sent for an id that turns out not found, against criterion 5 (probe M3: 3 tests fail).
5. Add `by_membership_id`-derived `by_name` to `MaintenanceStatusEventOut`, filled only when
   `sees_internal_comments(ctx)` (as `_comment_outs` does for authors), regenerate the types, render it in
   `buildTimeline`'s title for staff, and add the staff/resident cases to `test_status_events_api.py`.

</details>
