# Explanation — P6-02b One notice, urgent banner and attachments

> **PR:** #130 · **Source revision:** `10afcb64e5c04a974edd17488736323dcb5933e4`, the pre-merge PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (3, Codex
> `gpt-6.1-sol`, high) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 130 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** at `10afcb6`, re-read `git diff origin/main...HEAD` (24 paths): the backend `models.py`,
> `router.py`, `schemas.py` and `service.py` patches; all of `UrgentBanner.tsx`, `NoticeDetailDialog.tsx` and
> `NoticeAttachment.tsx`; the `api.ts`, `NoticesPage.tsx`, `NoticeList.tsx`, `AppShell.tsx`, `routes.tsx` and
> `Modal.tsx` patches; the names and assertions of the tests cited below; the PR body (no PR comments or reviews
> exist). Ran `npx vitest run src/features/notices src/features/packages src/features/residents` (16 files,
> `554 passed`) and `uv run pytest tests/notices/test_reads.py tests/notices/test_api.py` (`123 passed`).
> `make check` on `10afcb6` exited 0 (PR). Differences from the plan: yes, see §2 "Plan versus final code".
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: B (UI interaction).

## 1. What was built and why

A notice now has its own address. `/notices/<id>`, the link the notifications carry since P6-01c, opens the notice
in a dialog over the feed. A notice's attachment is fetched through a short-lived download URL at the moment it is
clicked. A JPEG, PNG or WebP image is shown in the dialog instead. On every page of a building with notices on, a
member with unread urgent notices sees a red banner. It names up to three of them, links to each, lets the member
acknowledge each one (that marks it read), and says the app is not an emergency alert system. The unused legacy
`EmergencyAlertPopup.jsx` is deleted.

Two decisions matter most. First, the banner finds its notices through two new filters on the existing list
endpoint, `priority` and `unread` (D2), driven by the 30 s summary poll it already had (D4). Second, the answer for a
notice now carries `attachment_content_type`, so the client can tell an image (shown inline) from a PDF (downloaded
in place). Review round 1 found that the planned "PDF only" assumption was wrong (D5, D6).

## 2. Decisions

### D1. The banner's disclaimer copy

- **Problem or constraint:** ADR-0012 says urgent notices are not emergency alerting. The ticket asked for exact
  copy, and no default was written down (open decision 1).
- **Chosen:** heading "Urgent building notice" (or "N urgent notices"), and the line "This app is not an emergency
  alert system: in an emergency, call 911." (`frontend/src/features/notices/UrgentBanner.tsx::DISCLAIMER`).
- **Alternatives rejected:** naming the front desk or security (not every building has one, and the app holds no
  numbers); a line each building configures (a new setting, out of scope).
- **Tradeoffs and accepted limitations:** 911 assumes North America; the seeded buildings are in Toronto.
- **Basis:** ADR-0012; autonomous. **Source:** recorded (ticket Frame notes decision 1, PR D1).

### D2. How the banner finds the unread urgent notices

- **Problem or constraint:** `notices_summary` has only counts (`unread`, `urgent_unread`), and the banner must name
  the notices.
- **Chosen:** `GET …/notices` gains `priority` and `unread=true`, both narrowing `visible_notices`
  (`backend/app/notices/service.py::list_notices`). The banner asks
  `live=true&priority=urgent&unread=true&limit=3` (`frontend/src/features/notices/api.ts::useUrgentNotices`).
- **Alternatives rejected:** paging the live feed on the client until `urgent_unread` notices are found (unbounded
  requests, and an older urgent notice can sit pages deep); a dedicated `/notices/urgent` route (a second route for
  what is a filter).
- **Tradeoffs and accepted limitations:** a backend change and a `schema.d.ts` regeneration (a hot file) in a lane-B
  ticket.
- **Basis:** decision rule 3 (simplest exact option); the ticket's open decision 2 allows a filter.
  **Source:** recorded (Frame notes decision 2, PR D2).

### D3. "Acknowledged" means marked read; opening a notice marks nothing

- **Problem or constraint:** criterion 2 requires the summary and P6-02a's unread state to agree after an
  acknowledgement.
- **Chosen:** Acknowledge sends `notices_read`. Opening `/notices/<id>` sends nothing, and the dialog's own "Mark as
  read" button does, as P6-02a D4 decided for the feed.
- **Alternatives rejected:** a separate dismissal (new state, which would disagree with the summary); marking read
  on open (a notification click or an accidental open would count as reading).
- **Tradeoffs and accepted limitations:** acknowledging from the banner marks a notice read without opening it.
- **Basis:** ticket criterion 2; P6-02a D4. **Source:** recorded (Frame notes decisions 3–4, PR D3).

### D4. When the banner's list is asked

- **Problem or constraint:** lists don't poll (ADR-0012), but the banner must follow the 30 s summary poll.
- **Chosen:** the list is enabled only while `urgent_unread > 0`. When `urgent_unread` changes, it is cancelled and
  then invalidated. Because it lives under the notices key (`['b', id, 'notices', 'urgent']`), every read asks it
  again too. Rows from before a count change are hidden until a newer answer arrives. That change is marked during
  render, so not even one frame shows them.
- **Alternatives rejected:** polling the list (against ADR-0012); keying the list by the count (two keys in flight,
  and the old one's data shows at a change); showing cached rows (a notice read elsewhere would reappear for a
  moment).
- **Tradeoffs and accepted limitations:** suppose, within one poll, one urgent notice is read on another device and
  another is published. The count doesn't move, so the old row stays until a focus refetch, a remount or its own
  Acknowledge (a harmless 204).
- **Basis:** ADR-0012; CLAUDE.md lesson (P5-04 R1 F1, R2 F1). **Source:** recorded (PR D4 and its smaller
  decisions).

### D5. A non-image attachment downloads in place, from a URL asked at the click

- **Problem or constraint:** the URL must be fetched at click time (ADR-0007: it is short-lived, and authorized
  through the notice) and must never sit in the page (criterion 6: its path holds the S3 key).
- **Chosen:** the click asks `files_download_url`, then calls `window.location.assign(url)`. S3 serves a PDF with
  `Content-Disposition: attachment` (`backend/app/files/service.py::content_disposition`; only images are `inline`),
  so the browser downloads it and the app stays where it is.
- **Alternatives rejected:** a blank tab opened during the click, then pointed at the URL. This was the plan and the
  first implementation. On the stack, Chromium downloaded `minutes.pdf` and left the new tab on `about:blank`, so
  every download would leave an empty tab behind. Also rejected: an `<a href>` fetched in advance (it can expire, and
  it puts the presigned URL in the DOM).
- **Tradeoffs and accepted limitations:** a PDF always downloads and never opens in a browser viewer. The server's
  disposition decides that, and changing it is the files module's call.
- **Basis:** ADR-0007; an experiment on the stack. **Source:** recorded (PR D5, with both stack transcripts).

### D6. The notice answer names its attachment's type; images show inline (review round 1, F1)

- **Problem or constraint:** the server accepts PNG, JPEG, WebP and HEIC notice attachments
  (`backend/app/files/purposes.py::PURPOSES`, `_PDF | _IMAGES`), and S3 serves images `inline`. "Download" for an
  image navigated the tab to it and replaced the app. The client couldn't tell the types apart, because `NoticeOut`
  had only `attachment_file_id`.
- **Chosen:** `NoticeOut.attachment_content_type`, read from `files.content_type` inside the notice's building.
  List and get read it through `with_expression`, as `read_at`; every write's answer reads it in `_out`, which
  create now uses too. The dialog shows JPEG, PNG and WebP through `PrivateImage`. A PDF gets "Download attachment
  (PDF)", and HEIC (no browser shows it) or a missing type gets "Download attachment".
- **Alternatives rejected:** a new tab for every attachment opened after the request (a popup blocker may refuse
  it, and a PDF leaves it blank, per D5); a blank tab closed if it stays blank (timing-based); a second request per
  notice to the files module (no such endpoint).
- **Tradeoffs and accepted limitations:** one more scalar subquery per notice row; `NoticeOut` grows a field
  (additive). The HEIC download relies on the browser's handling of an `inline` type it can't show. That was not
  verified.
- **Basis:** review round 1 finding F1. **Source:** recorded (PR D6, review log).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| At most 3 banner rows + "and N more" → `/notices` | list all | an unbounded banner covers the page | autonomous | PR |
| Banner between nav and `<main>`, in flow | a fixed overlay | criterion 7: mustn't cover the nav | ticket | PR |
| A failed summary refresh keeps the banner (last count) | hide it, as the badge does | it shouldn't blink away on one lost poll | autonomous | PR |
| While the list loads or has failed: "See the notices" | nothing | the banner still leads somewhere | autonomous | PR |
| Live region is an `aria-live="polite"` wrapper, not `role="status"` | `role="status"` | it would be one more match for 13 existing unnamed `getByRole('status')` queries | test result | PR deviations |
| Feed cards get an "Open" link (state `fromList`) | none | criterion A: "from the feed"; Close then goes back | ticket | PR |
| `useMarkReadOnce` shared by card, dialog and banner rows | copy the guard 3× | one double-press guard | convention | PR |
| `Modal`'s Tab trap includes `a[href]` (R1 F2) | a notice-only trap | every dialog with a link had the gap | review round 1 | PR |
| A read's click focuses the dialog, or the banner's live slot (`tabIndex={-1}`) (R2 F1) | the next row, or the page heading | only those are sure to stay mounted | review round 2 | PR |
| Base44 baseline stays 247 | lower it | the deleted file had no `base44` reference | `scripts/base44-count.sh` | Frame notes |

**Framing changes:** criteria A, B, 1–3 and 5–7 were sharpened. Criterion 8 was corrected: the popup has no Base44
reference, so the ratchet can't move. Criteria 9 (an urgent notice gone before Acknowledge), 10 (building switch and
denial) and 11 (the API filters) were added. None was loosened. Two frame notes were later updated to the final
code: the live region (criterion 7) and the in-place download (criterion 6).

**Plan versus final code:** (1) D5: the plan's blank tab became an in-place download, after the stack experiment.
(2) The live region: `aria-live` wrapper, not `role="status"`. (3) D6 and the `Modal` change came from review round
1, and the focus handoff from round 2. None of them is in the plan. All are recorded in the PR.

## 3. How it is implemented

### Overview

- **Backend:** `list_notices` takes `priority` and `unread_only`. Every notice answer gets `attachment_content_type`
  (`backend/app/notices/service.py::_expressions`, `backend/app/notices/service.py::_out`).
- **Shell:** `AppShell` renders an always-mounted `aria-live` slot after `MainNav`. Inside it, `LoadedBuildingBanner`
  renders `UrgentBanner` only for a loaded, non-denied building with notices on, keyed by building.
- **Banner:** `UrgentBanner` reads `useNoticeSummary` (the 30 s poll), enables `useUrgentNotices` while
  `urgent_unread > 0`, and renders rows with Acknowledge.
- **Notice:** the route `/notices/:noticeId?` keeps `NoticesPage` mounted. With an id it adds `NoticeDetailDialog`
  (`useNotice`), which shows the body, the labels, an image through `PrivateImage` or a `NoticeAttachment` button,
  and "Mark as read".

### Walkthrough (variant B): a resident acknowledges an urgent notice from the banner

1. **The signal.** The manager publishes an urgent notice. Within 30 s (the tab is visible),
   `frontend/src/features/notices/api.ts::useNoticeSummary` refetches and `urgent_unread` goes from 0 to 1.
2. **The banner list.** `UrgentBanner` sees `count` 1. During render, `change.count !== count` records
   `change.at = Date.now()`. `useUrgentNotices(buildingId, true)` is now enabled and fetches
   `GET /api/buildings/{b}/notices?live=true&priority=urgent&unread=true&limit=3` (operation `notices_list`). The
   effect also cancels and invalidates that key. Until an answer with `dataUpdatedAt >= change.at` arrives, the banner
   shows its heading, "See the notices" and the disclaimer.
3. **The server.** `list_notices` builds `visible_notices(ctx)`, then `live()`, then `Notice.priority == 'urgent'`,
   then `_read_at(ctx) IS NULL`: the caller's own `notice_reads` row, so another member's read hides nothing. It
   pages with the usual keyset.
4. **The row.** The title links to `/notices/<id>`. Acknowledge (`aria-label "Acknowledge: <title>"`) first moves
   focus to the shell's slot, then calls `useMarkReadOnce().markRead`. A ref guard makes a second press in the same
   tick send nothing.
5. **The mutation.** `useMarkNoticeRead` POSTs `…/notices/{id}/read` (204). `onSettled` cancels, then invalidates
   every `['b', id, 'notices', …]` query: the summary, the feed, the one notice and the banner list.
6. **Settling.** The summary answers `urgent_unread: 0`, so `UrgentBanner` returns `null` and the banner is gone on
   every page (it lives in the shell). Focus stays on the slot, and Tab carries on into the page. The nav badge reads
   the same summary, so it agrees.
7. **Errors.** A 404 (the notice was archived or expired before the press) shows nothing; the refresh drops the row
   (criterion 9). Any other failure shows "Could not acknowledge the notice, try again." (or the rate-limit text). A
   `building_not_found` marks the building denied through the mutation key, and `LoadedBuildingBanner` then renders
   nothing.

### Data model changes

None in the database. `Notice.attachment_content_type` is a `query_expression()`: a mapped attribute loaded only
by `with_expression`, with no column and no migration (`alembic check`: "No new upgrade operations detected.").

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/notices/router.py` | `priority`, `unread` query params | +9/−3 |
| `backend/app/notices/service.py` | filters; `_attachment_content_type`, `_expressions`; `_out` reads the type; create uses `_out` | +48/−11 |
| `backend/app/notices/models.py`, `schemas.py` | `attachment_content_type` | +4 |
| `frontend/src/features/notices/UrgentBanner.tsx` | new: the banner | +99 |
| `frontend/src/features/notices/NoticeDetailDialog.tsx` | new: `/notices/<id>` | +118 |
| `frontend/src/features/notices/NoticeAttachment.tsx` | new: the download button | +57 |
| `frontend/src/features/notices/api.ts` | `useNotice`, `useUrgentNotices`, `useMarkReadOnce` | +59 |
| `frontend/src/features/notices/NoticeList.tsx` | card "Open" link; `NoticeLabels`, `NoticeTimes` extracted | +56/−34 |
| `frontend/src/features/notices/NoticesPage.tsx` | the dialog over the feed, close and focus | +26/−4 |
| `frontend/src/app/AppShell.tsx`, `routes.tsx` | the slot and `LoadedBuildingBanner`; `/notices/:noticeId?` | +23/−3 |
| `frontend/src/features/residents/Modal.tsx` | `a[href]` in the Tab trap | +1/−1 |
| `EmergencyAlertPopup.jsx` (under `frontend/src/components/`) | deleted | −126 |
| `frontend/src/api/schema.d.ts` | regenerated | |
| tests: `banner.test.tsx`, `notice.test.tsx`, `attachment.test.tsx`, `frontend/src/test/notices.ts`, `backend/tests/notices/test_reads.py`, `test_api.py`, `notices.test.tsx` | new and extended | |

`backend/app/notices/service.py::list_notices`, with the new filters:

```python
    stmt = visible_notices(ctx).options(*_expressions(ctx))
    if status is not None:
        stmt = stmt.where(Notice.status == status)
    if live_only:
        stmt = stmt.where(live())
    if priority is not None:
        stmt = stmt.where(Notice.priority == priority)
    if unread_only:
        # The caller's own reads, as the summary counts them.
        stmt = stmt.where(_read_at(ctx).is_(None))
    return await paginate(db, stmt, Notice.id, params, NoticeOut.model_validate)
```

- Each filter only narrows `visible_notices(ctx)`, so the visibility rule (CLAUDE.md rule 3) is never re-written.
- `_read_at(ctx)` is the same correlated subquery the summary counts with, filtered by `ctx.membership_id`.
  Removing it leaves read notices in the banner. The mutation probe "`unread` filter → `true()`" failed
  `test_each_filter_narrows_on_its_own` (PR evidence).

`backend/app/notices/service.py::_attachment_content_type`:

```python
def _attachment_content_type() -> ScalarSelect[Any]:
    """The content type of the enclosing query's notice's attachment, in its building; null without
    one (P6-02b)."""
    return (
        select(File.content_type)
        .where(File.building_id == Notice.building_id, File.id == Notice.attachment_file_id)
        .scalar_subquery()
    )
```

- It matches by building as well as id, as the composite FK `(building_id, attachment_file_id)` does. A null
  `attachment_file_id` matches nothing and gives null.

`frontend/src/features/notices/UrgentBanner.tsx::UrgentBanner`, the signal and the stale-row guard:

```tsx
  const count = useNoticeSummary(buildingId).data?.urgent_unread ?? 0;
  const list = useUrgentNotices(buildingId, count > 0);

  const [change, setChange] = useState({ count, at: 0 });
  if (change.count !== count) setChange({ count, at: Date.now() });
  const seen = useRef(count);
  useEffect(() => {
    if (seen.current === count) return;
    seen.current = count;
    const filters = { queryKey: urgentNoticesKey(buildingId) };
    void queryClient.cancelQueries(filters).then(() => queryClient.invalidateQueries(filters));
  }, [count, buildingId, queryClient]);

  if (count === 0) return null;
  const rows = list.data && list.dataUpdatedAt >= change.at ? list.data.items : undefined;
```

- `count > 0` keeps the list from being asked at all with only normal notices. Mutating it to `true` failed 3
  banner tests.
- The `setChange` during render (a React-supported "state from props" pattern) marks the change before the commit.
  An effect would have let one frame show the old rows. Removing the `dataUpdatedAt >= change.at` check fails
  "never shows a row cached from before the count changed".

`frontend/src/features/notices/NoticeDetailDialog.tsx::Detail`, the attachment branch and the focus handoff:

```tsx
      {item.attachment_file_id &&
        (INLINE.has(item.attachment_content_type ?? '') ? (
          // An image S3 serves inline is shown here, so going to its URL never replaces the app (R1 F1).
          <PrivateImage fileId={item.attachment_file_id} alt={`Attachment: ${item.title}`} className="mt-3 max-h-96 w-full rounded object-contain" />
        ) : (
          <NoticeAttachment fileId={item.attachment_file_id} pdf={item.attachment_content_type === 'application/pdf'} />
        ))}
      {item.read_at === null && (
        <button
          type="button"
          disabled={read.isPending}
          onClick={() => {
            // The button is disabled, then gone: focus would drop to <body>, out of the dialog's Escape (R2 F1).
            dialogRef.current?.focus();
            markRead(item.id);
          }}
```

`frontend/src/features/notices/NoticeAttachment.tsx::NoticeAttachment`, the click:

```tsx
    try {
      const { url } = await api.get('/api/buildings/{building_id}/files/{file_id}/download-url', {
        params: { path: { building_id: buildingId, file_id: fileId } },
      });
      window.location.assign(url);
    } catch (error) {
      const notFound = error instanceof ApiError && error.status === 404;
      setFailure(notFound ? 'The attachment is not available.' : (rateLimitMessage(error) ?? 'Could not open the attachment, try again.'));
    }
```

- No cache: each click asks again, and the URL never enters the DOM. Whether the caller may have it is decided on
  the server by `backend/app/notices/attachments.py::can_view_notice_attachment` (visibility of the owning notice).

`frontend/src/app/AppShell.tsx::LoadedBuildingBanner`:

```tsx
function LoadedBuildingBanner({ slotRef }: { slotRef: RefObject<HTMLDivElement> }) {
  const building = useBuilding({ passive: true });
  const denied = useBuildingDenied();
  if (!building.data || denied || !hasFeature(building.data, 'notices')) return null;
  return <UrgentBanner key={building.data.id} buildingId={building.data.id} slotRef={slotRef} />;
}
```

- It reads the building passively, so a session-only page (`/403`, onboarding) asks for nothing. Dropping the
  `hasFeature` check fails "in a building with notices off, and no notices request at all".

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| A double press of Acknowledge or Mark as read | the ref guard in `useMarkReadOnce` | banner "marks the notice read once…"; notice "marks it read once…" (mutation: guard removed → 2 failed) |
| Another member's read hides my urgent notice | `_read_at(ctx)` is per membership | `test_priority_and_unread_keep_the_callers_own_unread_urgent_live_notices` |
| A draft, expired notice or another building's notice in the banner | `visible_notices` + `live()` | same test (draft, expired, building B rows) |
| A bad `priority` / `unread` value | FastAPI validation | `test_a_bad_filter_is_422` (3 cases) |
| A cached row from before a count change | `dataUpdatedAt >= change.at` | "never shows a row cached from before the count changed (read elsewhere, then a new one)" |
| A notice archived before Acknowledge | a 404 is silent; the refresh drops it | "drops the row after the refresh, without an error" |
| A hidden tab | the summary doesn't poll there | "appears within one 30 s poll of publication while the tab is visible, and not in a hidden tab" |
| Notices off / signed out / `/403` | no banner, no notices request | the four "no banner" tests |
| Building switch / denial | keyed by building; denied → nothing | "shows nothing of A’s banner in B, and B’s own"; "goes when the building is denied mid-session" |
| A non-UUID `/notices/<x>` | not sent; "Notice not found" | "shows it for a segment that is not a UUID, without asking the API" |
| A notice leaves while open | the read's refresh gives 404 → not found | "a notice that leaves while open shows "Notice not found"…" |
| An image attachment | inline via `PrivateImage`, no navigation | "shows an image attachment inline…", "shows %s inline" ×3 |
| HEIC / unknown type | in-place download | "a HEIC attachment…", "an attachment of unknown type…" |
| Download URL 404 / 500 / 429 | a message, no navigation | "shows a message on %s and goes nowhere" (3 cases) |
| The URL or S3 key in the page | never rendered | "never puts the URL, an S3 key or an attachment_url in the page" |
| A body link unreachable by Tab | `a[href]` in the trap | "F2: a link in the body is a Tab stop inside the dialog, both ways" |
| Focus lost after a read | focus to the dialog or the slot | "F1: focus stays in the dialog after "Mark as read"…"; "after Acknowledge, focus is kept by the banner’s slot…" |

Acceptance criteria → tests:
- **A**: notice.test.tsx "one notice (criterion A)". **B**: "a notice the member may not see (criterion B)".
- **1–5**: banner.test.tsx criterion blocks 1–5; stack: "banner back after 29.4 s (poll 30 s)".
- **6**: attachment.test.tsx; stack: `download minutes.pdf`, S3 `200 application/pdf attachment … signed=true`,
  `tabs opened 0`.
- **7**: Chromium at 375 px (PR): `scrollWidth 375 = innerWidth`, banner top 160 ≥ nav bottom 160, `position
  static`, `aria-live polite`, focus on `BODY`. No jsdom test; it is browser evidence only.
- **8**: `git grep EmergencyAlertPopup -- frontend/src` empty; Base44 247/247.
- **9, 10**: banner.test.tsx criterion 9 and 10 blocks. **11**: the four `test_reads.py` filter tests.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol` (high) | `c719660` | MERGE | F1 Medium: an image attachment replaced the app; F2 Medium: body links skipped by the Tab trap | both fixed in `3c4df69` |
| 2 | Codex `gpt-6.1-sol` (high), new session | `3c4df69` | MERGE | F1 Medium: focus fell to `<body>` after Mark as read, and Escape stopped working | fixed in `10afcb6` (+ banner neighbour) |
| 3 | Codex `gpt-6.1-sol` (high), new session | `10afcb6` | MERGE | none | — |

The reviewer for this run was Codex `gpt-6.1-sol` at high effort, by James's instruction for the run, in place of the
fresh Claude reviewer the playbook names for Tier 2.

- **R1 F1:** a PNG attachment is accepted by the server (`purposes.py`) and served `inline`, so the button's
  `location.assign` navigated to the image. Codex's Chromium proof showed the dialog disappear. Evidence for the fix:
  the backend `test_every_answer_names_the_attachments_content_type` failed first (`1 failed`), then passed. The
  image tests in `attachment.test.tsx` failed first, then passed. On the stack: `F1 image loaded: 2 px wide |
  download button: 0`. This produced D6.
- **R1 F2:** `[Safety instructions](https://…)` in a body rendered an `<a>` that `Modal`'s trap
  (`input, textarea, button`) skipped. The test "F2: a link in the body is a Tab stop…" failed first. In Chromium:
  `Tab from the dialog focuses: A safety instructions`, and `Shift+Tab wraps to: BUTTON Close`.
- **R2 F1:** Enter on "Mark as read" → the button is disabled, then removed → Chromium focuses `<body>` → Escape
  no longer reaches the dialog's handler. The test "F1: focus stays in the dialog…" failed first. The banner's
  Acknowledge had the same drop, and "after Acknowledge, focus is kept by the banner’s slot…" failed first. In
  Chromium: `focus after Enter on Mark as read → DIV[role=dialog]`, then `Escape closed it → /notices`; and for the
  banner, `DIV[aria-live]`, then `next Tab lands on → A Details`.

## 7. Not verified, accepted risks and follow-ups

- **No screen reader was run** (criterion 7). Only the markup (a polite live region mounted before its content) and
  the focus behaviour were checked. All three review rounds named this.
- **D4's unchanged-count case:** a stale banner row can stay until a focus refetch, a remount or its own Acknowledge.
  Accepted; tracked only here and in the PR.
- **HEIC:** the in-place download of an `inline` HEIC was not tried on the stack or in more than one browser (D6).
- **Popup and download behaviour in Safari and Firefox:** only headless Chromium was used.
- **911:** assumes North America (D1).
- **`frontend/src/features/files/purposes.ts::PURPOSE_RULES`** still says notice attachments are PDF only, while the
  server also accepts images. It decides what P6-02d's editor accepts. Follow-up for P6-02d (added to its ticket in
  the bookkeeping commit).
- **The feed card's "Mark as read"** (P6-02a) still drops focus to `<body>` when it disappears. It's outside any
  dialog, so Low. Follow-up for P6-02c (added to its ticket in the bookkeeping commit).
- Cosmetic: `UrgentBanner.tsx`'s doc comment sits above `interface Props` rather than the component, and
  `Modal.tsx`'s doc comment doesn't mention links. Neither changes behaviour.

## 8. How to change this safely

- **To show more banner rows**, change `frontend/src/features/notices/api.ts::BANNER_ROWS`. The "and N more" link follows. Run `banner.test.tsx`
  ("lists the newest three of five…" asserts 3).
- **To add a filter to the list**, narrow `visible_notices(ctx)` in `list_notices`, never a new base query (CLAUDE.md
  rule 3). Extend `test_each_filter_narrows_on_its_own`, then `make gen-api`.
- **To show another attachment type inline**, add it to `NoticeDetailDialog.tsx`'s `INLINE` only if browsers render
  it and the server serves it `inline` (`backend/app/files/service.py::content_disposition`). Add a case to "shows %s
  inline".
- **Anything that removes a focused control** inside the dialog or the banner must move focus first, as the read
  buttons do. The two round-2 tests catch the read paths only.

## 9. Must explain, then quiz

**1. What is the worst-case delay before the banner shows, and why is that acceptable here?** About 30 s plus one
request, while the tab is visible. `frontend/src/features/notices/api.ts::useNoticeSummary` polls every 30 s
(`refetchInterval: 30_000`, never in a hidden tab, again on focus and on mount). A rising `urgent_unread` enables
and invalidates `useUrgentNotices`. On the stack it took 29.4 s. In a hidden tab it waits until the tab is visible
again. That is acceptable because ADR-0012 promises "about a minute while the app is open" and explicitly not
emergency alerting, and the banner says so (D1). Urgent notices also get an email (P6-01c).

**2. What makes the banner go away, and why does it stay away after a reload?** Acknowledge sends `notices_read`.
The server writes a `notice_reads` row for the caller's membership, the mutation invalidates the notices queries,
and the summary's `urgent_unread` drops. At 0, `UrgentBanner` returns `null`. After a reload the summary is
computed on the server from `notice_reads` (`backend/app/notices/service.py::notice_summary`), so it is still 0. With a count of 0 the
banner list isn't even asked ("a reload doesn’t bring it back, and a later urgent notice does"). Nothing is
remembered in the browser.

**3. Why is the download URL fetched at click time, and who decides whether the member may have it?** The URL is
presigned and expires (ADR-0007), and its path holds the S3 key, so it is neither cached nor rendered. It is fetched
when needed and used at once (`frontend/src/features/notices/NoticeAttachment.tsx::NoticeAttachment`). The server decides:
`GET …/files/{id}/download-url` runs the purpose's hook,
`backend/app/notices/attachments.py::can_view_notice_attachment`. That grants the file only if it is the
attachment of a notice the caller can see through `visible_notices`. A file the caller may not have is a 404, shown
as "The attachment is not available."

Quiz:

1. Why does the banner list filter `unread=true` on the server, instead of filtering `read_at === null` on the
   client after fetching `priority=urgent`?
2. A resident reads urgent notice X on their phone, and within the same 30 s the manager publishes urgent notice
   Y. What does the laptop's banner show at the next poll, and why?
3. What would break if `UrgentBanner` marked the count change in a `useEffect` instead of during render?
4. What would break if `NoticeDetailDialog`'s "Mark as read" didn't call `dialogRef.current?.focus()` first?
5. How would you extend the banner to show a building-specific emergency number instead of "call 911"?

<details><summary>Answers</summary>

1. With `limit=3`, older read urgent notices would fill the page and push unread ones out, so the banner could name
   none of them while the count says 1. The server filter pages over exactly the unread ones, by the same
   `_read_at` the summary counts (D2).
2. It still shows X. `urgent_unread` was 1 and is still 1, so nothing asks the list again. The row stays until a
   focus refetch, a remount, or pressing Acknowledge on X (a 204, then the refresh shows Y). This is D4's accepted
   limitation.
3. The first render after the change would still have the old `change.at`, so a cached list answer (say, from
   before the count went to 0) would pass the `dataUpdatedAt` check and show a notice already read, for one commit.
   That could also be announced by the live region.
4. The button is disabled and then removed, so the browser focuses `<body>`. Escape is handled by the dialog's
   `onKeyDown` and would no longer close it (R2 F1).
5. Add a building setting (a new column and its admin UI, its own ticket and ADR, since D1 rejected it as out of
   scope), return it on `BuildingOut`, and have `UrgentBanner` build the disclaimer from it, with 911 as the
   fallback. Extend the "says the app is not an emergency alert system…" test for both.

</details>
