# Explanation — P6-02c Manager notice list, publish and archive

> **PR:** #131 · **Source revision:** `ade605653c803c360981f34f70362196108681a5`, the pre-merge PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (2, Codex
> `gpt-6.1-sol`, high) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 131 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** at `ade6056`, re-read `git diff --stat origin/main...HEAD` (19 paths): all of
> `ManagerNoticeList.tsx`, `ManagerNoticesPage.tsx` and `NoticeActionDialog.tsx`; the `api.ts`, `NoticeList.tsx`,
> `pages.ts`, `routes.tsx`, `CLAUDE.md` and `buildingDenial.test.ts` patches; the backend `backend/app/notices/router.py`
> (publish, archive) and `backend/app/notices/queries.py::visible_notices` it relies on, unchanged; the names and assertions of the
> tests cited below; the PR body (no PR comments or reviews exist). Ran `npx vitest run
> src/features/notices/managerNotices.test.tsx src/features/notices/notices.test.tsx src/test/buildingDenial.test.ts
> src/app/nav.test.tsx` (4 files, `133 passed`). CI was green on `ade6056` (5 checks). `make check` could not
> run its database steps locally (Docker unreachable; §7). Differences from the plan: one addition from review, see
> §2 "Plan versus final code".
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: B (UI interaction).

## 1. What was built and why

Property management now manages the building's notices at `/manage/notices`. One list shows at a time: Drafts,
Published or Archived. Each row shows its title, labels ("Urgent", and "Expired" for a published notice past its
expiry), times and Markdown body. A draft has **Publish** and **Archive** buttons, a published notice has
**Archive**, and an archived one has none. Each button opens a confirm dialog that sends one `POST …/publish` or
`POST …/archive`. Whatever the answer, every notices query of the building (the three lists, the residents' feed,
the unread badge, the urgent banner) is cancelled and asked again. A refusal (409 "someone else moved it", 422
"expired", any other failure) stays in the dialog as a message.

The page replaces the legacy Base44 `ManagementNotices.jsx` (deleted, 607 lines), and its old URL
`/ManagementNotices` redirects here. Security and council lose the old nav item, which only led to a "being
migrated" placeholder. They read notices in the `/notices` feed (D1).

Two carried items from P6-02b ride along. The feed's "Mark as read" no longer drops keyboard focus to `<body>` when
its button disappears (criterion 9). And `CLAUDE.md` gains the lesson behind that bug, which had been logged five
times (criterion 10).

Why now: this is the manager half of journey 5 ("the manager publishes a normal notice and an urgent notice";
PRODUCT_SCOPE). The authoring API merged in P6-01b; the editor that writes drafts is P6-02d, so until then drafts
come from the API.

## 2. Decisions

### D1. Only property management opens the page (autonomous; ticket open decision 1)
- **Problem.** The old page row allowed every staff role, but only property management may publish or archive.
- **Chosen.** `PAGE_ACCESS.ManagementNotices.roles = ['property_management']` (`frontend/src/app/pages.ts::PAGE_ACCESS`).
- **Rejected.** A read-only page for security and council. The API's `visible_notices` already gives them only
  live notices, the same list the feed shows. Their page would have been the feed again, minus drafts, with
  actions that answer 403.
- **Tradeoff.** Two roles lose a nav item that led nowhere. Council's "read-only oversight: notices"
  (PRODUCT_SCOPE) is served by `/notices`.
- **Basis.** Recorded in the ticket's Frame notes and the PR (D1); the backend facts are `backend/app/notices/router.py`
  (`_AUTHOR`) and `backend/app/notices/queries.py::visible_notices`.

### D4. "Expired" is judged by the device's clock (autonomous)
- **Problem.** "Expired" isn't a status. The database decides liveness with its own clock (`backend/app/notices/queries.py::live`),
  but `NoticeOut` has no "expired" flag.
- **Chosen.** A published row whose `expires_at` ≤ `useNow()` gets the label; `useNow` re-reads `Date.now()` every
  minute.
- **Rejected.** A second query (`live=true&status=published`), marking published rows that query lacks. It costs
  twice the requests, and the two paged lists would have to be matched up.
- **Tradeoff.** A device clock that is off shows the label early or late. It is only a label: publishing checks the
  server's clock and answers 422 `notice_expired`.
- **Basis.** Recorded in the PR (D4).

### D6. One dialog for both actions, which stays open on every refusal (ticket criterion 2)
- **Problem.** Criterion 2 says a 409 or 422 shows in the dialog and the dialog stays open. The packages dialogs'
  `usePackageSubmit` closes on 409.
- **Chosen.** `NoticeActionDialog`, parameterised by `action`, with its own guard and submit. It copies the
  structure of `usePackageSubmit` (a ref guard taken before anything else, focus moved to the dialog before the
  buttons disable) but keeps every failure inside.
- **Rejected.** A flag on `usePackageSubmit`, which would mix two domains' error codes. Two files
  (`PublishDialog`, `ArchiveDialog`, as the ticket's "likely files" guessed), which would differ only in wording.
- **Basis.** Recorded in the PR (D6).

| Smaller decision | Basis |
|---|---|
| D2: path `/manage/notices`, label "Manage notices" (told apart from the feed's "Notices") | convention (`/manage/residents`, P4-08b); PR |
| D3: one list at a time behind `aria-pressed` toggle buttons, Drafts first. Each list has its own query key | autonomous; PR. A tablist needs arrow-key handling the codebase doesn't have yet |
| D5: the body shows inline through `NoticeBody`; no link to `/notices/<id>` | PR. That view closes back to the feed, which has no drafts |
| D7: tests that used `/ManagementNotices` as "a legacy staff page" now use `/ManagementMaintenance` | PR; same assertions on a page that still has the old shape |
| D8: one `EXEMPT` entry in the `buildingDenial` fitness test for `frontend/src/features/notices/ManagerNoticesPage.tsx::ManagerNotices` | PR; the same reason as the P6-02a `NoticesPage` entry |
| D9: the feed card takes focus before "Mark as read" disables itself; a failure gives it back to the button | carried P6-02b follow-up; PR |
| D10: review by Codex `gpt-6.1-sol` (high) only, no Claude reviewer | James's in-session instruction for this run |

**Plan versus final code.** The Plan's files, interfaces and criterion map hold. One thing was added in review:
`frontend/src/features/notices/ManagerNoticeList.tsx::Row` tracks focus and reports `onFocusLost` when it unmounts holding focus (round 1 F1,
§6). The Plan's risk 4 only covered "the opener left while the dialog was open". The fix covers any refresh that
removes the focused row.

## 3. How it is implemented

### Overview

```
/manage/notices ─ RequirePageAccess(property_management, notices)
  └ ManagerNoticesPage (keyed by building)
      └ ManagerNotices: toggle [Drafts|Published|Archived] · outcome message · list heading
          ├ ManagerNoticeList(status) ── useManagedNotices → GET …/notices?status=&limit=25[&cursor=]
          │    └ Row × n: labels, NoticeTimes, NoticeBody, Publish/Archive buttons
          └ NoticeActionDialog(action, item) ── useNoticeAction → POST …/{id}/publish | …/archive
                                                 onSettled: cancel, then invalidate ['b', id, 'notices']
```

### Walkthrough (variant B): a manager publishes a draft another manager already published

1. The manager presses **Publish: Elevator works** in Drafts. `ManagerNotices.act` remembers the action, the
   notice as the row showed it, and the button (`opener`), and the dialog mounts. It focuses itself.
2. Meanwhile another manager publishes the same draft. The server row is now `published`.
3. The manager presses **Publish** in the dialog. `NoticeActionDialog.confirm` takes the `inFlight` guard (a
   second click in the same tick returns at once) and moves focus to the dialog before `busy` disables the
   buttons. Then it awaits `useNoticeAction().mutateAsync`.
4. The server locks the row (`backend/app/notices/service.py::publish_notice`, `_locked`), sees it is no longer a draft, and
   `assert_transition` answers **409 `invalid_transition`**. The mutation's `onSettled` cancels every
   `['b', buildingId, 'notices', …]` query, then invalidates them. The Drafts list (mounted) is asked again; the feed,
   badge and banner refetch when next used, or at once if mounted.
5. The dialog sets its failure ("This notice is no longer a draft: it was published or archived elsewhere."), and
   the alert takes focus. The dialog stays open with its buttons enabled again.
6. The refreshed Drafts list no longer has the notice, so its row unmounts. Focus is in the dialog, not the
   row, so nothing moves.
7. The manager presses **Cancel**. `close(null)` checks `open.opener.isConnected`: the row is gone, so focus goes to
   the list heading "Drafts". In the other order (Cancel before a slow refresh), focus first returns to the opener;
   when the refresh then removes that row, `Row`'s unmount sees it held focus and calls `onFocusLost`, which also
   focuses the heading (§6, round 1 F1).
8. Under **Published**, both managers' screens now show the notice.

A success instead ends in `close("“<title>” was published.")`: the outcome message appears, and focus goes to it,
since the row is about to leave its list.

### Data model changes

None. Frontend only; no API change (`make gen-api` produced no diff).

## 4. The code

| File | Change |
|---|---|
| `frontend/src/features/notices/api.ts` | `useManagedNotices`, `useNoticeAction`, `ManagedStatus`, `NoticeAction` |
| `frontend/src/features/notices/ManagerNoticesPage.tsx` | new: the page, toggle, outcome message, focus return |
| `frontend/src/features/notices/ManagerNoticeList.tsx` | new: one status's rows, Load more, row focus tracking |
| `frontend/src/features/notices/NoticeActionDialog.tsx` | new: both confirm dialogs |
| `frontend/src/features/notices/NoticeList.tsx` | feed card focus around "Mark as read" |
| `frontend/src/app/{pages.ts,routes.tsx}` | the page row (roles, path, label) and its route |
| `ManagementNotices.jsx` (legacy, `src/pages`) | deleted; `frontend/base44-baseline.txt` 247 → 227 |
| `CLAUDE.md` | one "Lessons learned" item |
| tests | `managerNotices.test.tsx` (new, 31 cases), `notices.test.tsx` (+1), `buildingDenial.test.ts` (+1 exemption), retargets in `shell`, `building`, `nav`, `residents` tests |

### `frontend/src/features/notices/api.ts::useNoticeAction`

```ts
export function useNoticeAction(buildingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Keyed by building, so a `building_not_found` here marks the building denied (app/buildingDenial.ts).
    mutationKey: [...noticesKey(buildingId), 'action'],
    mutationFn: ({ id, action }: { id: string; action: NoticeAction }) => {
      const params = { path: { building_id: buildingId, notice_id: id } };
      return action === 'publish'
        ? api.post('/api/buildings/{building_id}/notices/{notice_id}/publish', { params })
        : api.post('/api/buildings/{building_id}/notices/{notice_id}/archive', { params });
    },
    onSettled: () => {
      const filters = { queryKey: noticesKey(buildingId) };
      void queryClient.cancelQueries(filters).then(() => queryClient.invalidateQueries(filters));
    },
  });
}
```

What it does: sends one action endpoint, never `PATCH status`. In every case it refreshes everything under
`['b', buildingId, 'notices']`. That prefix covers the manager lists (`'manage', status`), the feed, the summary
badge, the urgent banner and a single notice. Why cancel first: a list request already on its way may have been
read before the change, and `invalidateQueries` alone would reuse it (the CLAUDE.md "refreshes on a signal"
lesson). What breaks without `onSettled` on errors: after a 409, the loser's lists would still show the draft as a
draft (criterion 4 test).

### `frontend/src/features/notices/NoticeActionDialog.tsx::NoticeActionDialog` (the submit)

```ts
  const confirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    // The button about to be disabled would drop focus to <body> in a browser.
    root.current?.focus();
    try {
      await mutation.mutateAsync({ id: item.id, action });
    } catch (error) {
      inFlight.current = false;
      if (!mounted.current) return;
      setBusy(false);
      const code = error instanceof ApiError ? error.code : null;
      setFailure(code === 'invalid_transition' ? words.moved : code === 'notice_expired' ? EXPIRED : (rateLimitMessage(error) ?? words.failed));
      return;
    }
    if (mounted.current) onClose(`“${item.title}” was ${words.done}.`);
  };
```

The `inFlight` ref, not `busy`, is what makes two clicks send one request: `busy` only reaches the button's
`disabled` after a render, and a second click in the same tick comes before that. `mounted` stops a late answer
from touching a dialog the building switch already removed. A `building_not_found` falls through to `words.failed`
here, but the mutation key makes the app mark the building denied and replace the page (criterion 11 test).

### `frontend/src/features/notices/ManagerNoticesPage.tsx::ManagerNotices` (closing)

```ts
  const [focusTo, setFocusTo] = useState<{ target: HTMLElement | 'message' } | null>(null);
  useEffect(() => {
    if (focusTo) (focusTo.target === 'message' ? messageRef.current : focusTo.target)?.focus();
  }, [focusTo]);

  const close = (outcome: string | null) => {
    if (outcome) setMessage(outcome);
    const back = open?.opener.isConnected ? open.opener : headingRef.current;
    setFocusTo({ target: outcome || !back ? 'message' : back });
    setOpen(null);
  };
```

The same shape as `frontend/src/features/packages/WaitingList.tsx::WaitingList`. Focus is set in an effect after the commit, so
the message element has its text (it is `empty:hidden` before) when it is focused.

### `frontend/src/features/notices/ManagerNoticeList.tsx::Row` (focus tracking, review round 1)

```ts
  const focused = useRef(false);
  const lost = useRef(onFocusLost);
  lost.current = onFocusLost;
  useEffect(() => () => void (focused.current && lost.current()), []);
  // ...
    <li
      onFocus={() => (focused.current = true)}
      onBlur={() => (focused.current = false)}
```

React's `onFocus`/`onBlur` bubble, so the `<li>` knows whether any of its buttons has focus. A browser fires no blur
on a node that is removed, so a row that unmounts with `focused` still true was holding focus. Its unmount cleanup
then calls the page's `onFocusLost`, which focuses the list heading. Without it, any refresh that removes the
focused row drops focus to `<body>`: a slow 409 refresh after Cancel, or another manager's action seen on a focus
refetch. `lost` is a ref so the cleanup calls the latest callback, not the one from the first render.

### `frontend/src/app/pages.ts::PAGE_ACCESS` (the row)

```ts
  // Only property management publishes and archives (P6-01b); the others read the feed (P6-02c D1).
  ManagementNotices: { roles: ['property_management'], feature: 'notices', label: 'Manage notices', path: '/manage/notices' },
```

Setting `path` makes `frontend/src/app/routes.tsx::AppRoutes` render `LegacyRedirect` at `/ManagementNotices` (query and hash
kept), and `navPages` lists the item only for property management in a building with `notices` on. The guard is UX
only: the API checks the role again (403).

## 5. Edge cases and tests

All in `frontend/src/features/notices/managerNotices.test.tsx` unless named.

| Case | Test |
|---|---|
| Each list shows only its status, in API order, `limit=25`, no `live` | `the three lists › shows each status’s notices …` (asserts the query params of each request) |
| Expired label on a past `expires_at` only; Urgent label | same test |
| Body rendered as Markdown for drafts too; actions per status | `… shows the body through NoticeBody …` |
| Load more with the cursor; empty and failed lists | `… loads more with the cursor …` |
| Two clicks → one publish; moves to Published; badge asked again; feed cache invalidated | `publish › sends one request for two clicks …` |
| 422, 409, 500, 429 keep the dialog open, alert focused, buttons enabled, lists asked again | `publish › shows %s as a message …` (4 cases) |
| Archive from Drafts and from Published | `archive › moves a notice from %s to Archived` |
| Archive of an already archived notice → 409 message | `archive › archiving one already archived …` |
| Two managers: the loser's lists end like the winner's | `two managers publish the same draft …` |
| Resident, security, council → `/403`, no list request, no nav item | `access › %s gets /403 …` |
| Signed out → login with the way back; `notices` off → `/403` | `access › …` |
| Cancel and Escape → opener; Escape ignored while sending | `focus after a dialog › …` |
| Success → outcome message focused; opener gone → heading | `focus after a dialog › …` |
| A refresh removing the focused row (late 409 refresh; plain refetch); another row removed leaves focus | `a refresh that removes the focused row (review round 1, Codex F1)` (3 cases) |
| `/ManagementNotices?from=mail#top` → `/manage/notices?from=mail#top` | `the legacy page (criterion 7)` |
| Switching building closes the dialog and shows none of A's rows | `switching building (criterion 8)` |
| Only the selected building's URLs; `building_not_found` on either action denies the building | `the selected building only …` (3 cases) |
| Feed "Mark as read": card focused after success, button after failure | `notices.test.tsx › focus after "Mark as read" (P6-02c criterion 9)` |
| The page's passive building read is covered by the denial guard | `buildingDenial.test.ts` (EXEMPT entry, and the "still needed" check) |

Criterion 6's 375 px layout has no automated test. It was measured in Chromium against the real API with a
200-character unbroken title (widest right edge 375 with the dialog open and closed), and a probe showed the
measurement can fail (3143 with `overflow-wrap` off); the transcript is in the PR. Criterion 10 is a text change,
checked by reading it.

## 6. Review log

Reviewer: Codex `gpt-6.1-sol` at high effort, by James's instruction for this run (D10).

- **Round 1** (commit `0981208`): `MERGE`, with one Medium. **F1:** another manager publishes first → this
  manager's confirm gets 409 → the list refresh is slow → Cancel returns focus to the opener → the refresh removes
  that row → focus drops to `<body>`. Codex proved it in jsdom and Chromium. Fixed in `ade6056` with the row focus
  tracking in §4. The two tests that reproduce it failed before the fix and pass after. In Chromium on the real
  API, with only the list GET delayed 3 s, focus went from the opener to `H2 "Drafts"`. The neighbours (Escape,
  success, failed refresh, list switch, building switch, Load more) are listed in the PR with a test or an n/a
  reason.
- **Round 2** (commit `ade6056`, a new session on the whole diff): `MERGE`, with one Low. **F1:** "Load more" that
  fetches the last page removes itself and drops keyboard focus. Not fixed: the same shape is in every "Load more"
  in the app; carried to P6-02d (§7).

## 7. Not verified, accepted risks and follow-ups

- **Not run locally:** backend `pytest` and the `make up`/`make prodlike` stack. Docker wasn't reachable in the
  WSL distro this session ran in. CI ran the backend tests, the prod-like smoke and E2E on `ade6056`, all green.
  The local journey ran on a scratch Postgres **16** (CI uses 18) with uvicorn and Vite; `alembic check` passed
  there. No backend file changed.
- **Two managers at once** was exercised in sequence (one publishes, then the other confirms), in jsdom and in
  Chromium on the real API. Truly simultaneous requests are the backend's row lock, tested in P6-01b, not here.
- **Accepted:** the "Expired" label follows the device's clock (D4).
- **Follow-ups (carried to P6-02d in this PR's bookkeeping commit):** "Load more" drops focus when it removes itself
  (round 2 F1; every list in the app); the P6-02a feed card has round 1 F1's shape (a refresh that removes the
  focused card).
- The legacy `Dashboard.jsx` still links `createPageUrl('ManagementNotices')`; it works through the redirect until
  P6-05 replaces that card.

## 8. How to change this safely

- New list or action: keep its query key under `noticesKey(buildingId)`, or `useNoticeAction`'s invalidation misses
  it.
- Another role on this page: change `PAGE_ACCESS.ManagementNotices.roles`, and know the API answers 403 to anyone
  else's publish or archive; `access (criterion 5)` will need its role list changed.
- A component in a row that can remove itself: it is covered by `Row`'s focus tracking only while it lives inside
  the `<li>`.
- Run `managerNotices.test.tsx`, `notices.test.tsx`, `nav.test.tsx` and `buildingDenial.test.ts`.

## 9. Must explain, then quiz

**1. Why does the UI never send `PATCH status`, and what does a 409 tell it?** State changes go through action
endpoints with a conditional update (CLAUDE.md rule 7): the server moves a notice only from the states the action
allows (`draft → published`, `draft|published → archived`) and answers 409 `invalid_transition` when the row is no
longer in one of them. To the UI, a 409 means "someone else moved this first", not "you did something wrong", so
the dialog says so and every list is asked again to show where the notice went.

**2. Of two publishes at once, which wins and how does the loser's screen recover?** The first to take the row
lock and update it (P6-01b `backend/app/notices/service.py::publish_notice`, `_locked`). The second sees a published row and gets 409.
Its `useNoticeAction` refreshes every notices query anyway, so its Drafts list loses the notice and its Published
list gains it. The dialog shows the 409 message until Cancel, and focus lands on the list heading if the row is
gone (`two managers publish the same draft …`; round 1 F1).

**3. Which roles open this page and which only the feed, and why?** Property management opens `/manage/notices`.
Every member, including property management, opens `/notices`. Only property management may publish or archive,
and the API shows the other roles only live notices, which is exactly the feed (D1).

<details><summary>Quiz (answers inside)</summary>

1. What breaks if `onSettled` in `useNoticeAction` became `onSuccess`?
   *After a 409 the loser's lists keep showing the notice as a draft; criterion 4's test fails.*
2. What breaks if `NoticeActionDialog` dropped the `inFlight` ref and relied on `disabled={busy}`?
   *Two clicks in the same tick send two publishes; `publish › sends one request for two clicks` fails.*
3. Why does `Row` track focus with `onFocus`/`onBlur` instead of checking `document.activeElement` in its unmount
   cleanup?
   *A passive effect's cleanup runs after React has removed the node, when focus is already on `<body>`, so the
   check can't tell "this row held focus" from "nothing was focused".*
4. How would you extend the page with an "Unarchive" action?
   *The backend would need a transition and endpoint first (archived is final today). Then add it to `NoticeAction`,
   `useNoticeAction`'s endpoint choice, `ACTIONS.archived` and `WORDS` in the dialog, with the same tests per refusal.*
5. Why is the "Expired" label harmless when the device clock is wrong?
   *It is display only; publishing asks the server, which uses the database clock and answers 422 `notice_expired`.*

</details>
