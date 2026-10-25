# Explanation — P6-02a Notices feed

> **PR:** #128 · **Source revision:** `1418b4ebe025776af31ac2f7b76a9a6d38e3dd23`, the pre-merge PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (4) reviewed
> `274b68b`; `1418b4e` is that commit rebased onto `main` after #129, and `git diff 274b68b 1418b4e` touches only
> #129's `docs/AGENT_MISTAKES_LOG.md` and `docs/HUMAN_INBOX.md` lines (the rebase conflicted only in
> `docs/tickets/README.md`'s P6-02a/b rows, resolved to the branch's rows).
> **Merge commit:** not known when written; after the merge, `gh pr view 128 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read `git diff origin/main...HEAD` (29 paths) at `1418b4e`: the backend `router.py` and
> `service.py` patches, the whole of every new file under `frontend/src/features/notices/`, the `app/` patches,
> `Dashboard.jsx`, `renderApp.tsx`, the rewritten `frontend/src/test/buildingDenial.test.ts` (resolver, `analyze`,
> the inventory and the P6-02a cases), the ticket with its Frame notes, the PR description and the four review
> reports; ran `npx vitest run src/features/notices src/test/buildingDenial.test.ts src/app/nav.test.tsx
> src/app/building.test.tsx`: **5 files, 168 passed**, and `make test DB_PORT=55432`: **2744 passed**. CI on this
> commit: all five jobs green. Differences from the plan: see §2 "Plan versus final code".
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: B.

## 1. What was built and why

Every member of a building with `notices` on now has a `/notices` page: the building's live notices, newest
written first, each a card with its title, an "Urgent" label, "Published"/"Until" times in the building's zone, the
body rendered from Markdown, and for an unread one an "Unread" label and a "Mark as read" button. The nav item shows
the unread count ("Notices, 2 unread"). The API's list gained `live=true` so the feed is exactly what the badge
counts, by the database clock (D2). The legacy Base44 feed and its archive modal are deleted (ratchet 270 → 247).

Two decisions carry most of the weight: the body is Markdown with **no HTML path at all** (D1), and the ticket's
follow-up rewrote the `buildingDenial` fitness test to ask the TypeScript checker which function a call names (D6).
That rewrite drew every review finding: four rounds, six High gate regressions against the P5-05 inspector, each
fixed test-first; round 3 blocked the ticket (inbox B-9) and James chose one more fix-and-verify round, which
returned `MERGE`.

## 2. Decisions

### D1. The body is Markdown through `react-markdown`, with no raw HTML, no images and only four link schemes

- **Problem or constraint:** a manager writes the body; members' browsers render it. The stub's default: no raw
  HTML. P6-02d's editor preview will reuse the same renderer, so the rule is set here.
- **Chosen:** `react-markdown` (already a dependency) with no HTML plugin, so raw HTML is shown as text; images are
  rendered as their alt text; a `urlTransform` keeps a URL only for `http:`, `https:`, `mailto:`, `tel:`; links open
  in a new tab with `rel="noopener noreferrer"`; body headings shift down two levels.
- **Alternatives rejected:** DOMPurify over an HTML render (a new dependency and an HTML path the stub rules out);
  `skipHtml` (it would hide the author's text silently); `disallowedElements: ['img']` (it keeps no alt text).
- **Tradeoffs and accepted limitations:** a notice can't embed an image; notice images are P6-02b's attachments.
- **Basis:** stub default + autonomous; the `img` choice is a test result.
- **Source:** recorded (ticket Frame notes D1; PR "Smaller decision" rows).

### D2. `notices_list` takes `live=true`, and the feed always sends it

- **Problem or constraint:** the badge counts live notices (published, unexpired by the database clock); a manager's
  plain list also has drafts, archived and expired ones. A feed that filtered in the browser by the device clock
  could disagree with the badge (the P5-04 lesson).
- **Chosen:** `live: bool = False` on the list; `backend/app/notices/service.py::list_notices` adds `backend/app/notices/queries.py::live` when it is set,
  after `visible_notices` and any `status`. Additive.
- **Alternatives rejected:** filtering expired notices in the browser; showing the manager everything, labelled
  (the manager's full list is P6-02c's page).
- **Basis:** autonomous; `backend/app/notices/queries.py::live` already exists for the summary.
- **Source:** recorded (Frame notes D2).

### D3–D5 (framing)

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| D3 The legacy `Dashboard.jsx`'s `BuildingUpdatesFeed` embeds are removed with nothing in their place | a replacement card | the page isn't routed (`BeingMigrated`); P6-05 replaces it | code | Frame notes |
| D4 Mark read by an explicit button | mark everything on screen read | the body shows in the feed, so there is no "open"; auto-marking would clear notices nobody read | autonomous, reversible | Frame notes |
| D5 Order: newest written first (`Notice.id`) | `published_at` | needs a keyset and an index migration; a draft published late sorts below newer notices (accepted, follow-up) | existing API (P6-01b D4) | Frame notes |

### D6. The fitness test resolves callees with the TypeScript checker

- **Problem or constraint:** the P5-05 round-3 open Medium: the inspector's hand-written name tables missed scope
  (function-local aliases, shadowing) and wrappers (`!`, parentheses, `.call`).
- **Chosen:** one `ts.createProgram` over the files given (`noLib`, `noResolve`, the app's `@/` paths): every non-test
  `.ts`/`.tsx` under `src` for the inventory, or the stub provider plus a case's files for each inspector case. Each
  call's callee is unwrapped and resolved with `getSymbolAtLocation`, following aliases. **Only a binding that can't
  change earns the denial**: an import or namespace member, a `const` alias, a function declaration never reassigned,
  an anonymous function, or the first argument of React's `memo`/`forwardRef` while nothing in the program can have
  replaced them. Anything else earns nothing and counts as `useBuilding` if it may be it (fail-closed). An import the
  program can't follow keeps the name it is exported by, as the P5-05 inspector did.
- **Alternatives rejected:** extending the name tables with scopes (another hand-written resolver is what failed five
  times in P5-05); a full program with libraries (slower; types aren't needed to bind names).
- **Tradeoffs and accepted limitations:** a hook passed as an argument or returned from a function is unresolved
  (fail-closed only for the name `useBuilding`); trusting `memo` turns off for the whole program if any file writes a
  `memo`/`forwardRef` member or lets React or the global object escape (fail-closed, may flag more than needed).
- **Basis:** the P6-02 stub's follow-up; review rounds 1–3 (six findings); the round-3 fixes' differential run.
- **Source:** recorded (PR D6 and "Independent review").

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| The service keyword is `live_only`; the query parameter stays `live` | `live` | it would shadow `queries.live` in `service.py` | code | PR |
| A double press is stopped by a ref set before `mutate`, besides `disabled` | `disabled={isPending}` only | two clicks in one tick both run before `isPending` renders | test result | PR |
| The 404 "no longer available" message is the list's, not the card's | on the card | the refresh the 404 triggers removes the card and its message | test result | PR deviations |
| `frontend/src/features/notices/NoticesPage.tsx::Notices` is exempt in the fitness test | read the denial | rendered only under `BuildingLoaded`, as `frontend/src/features/packages/pages/MyPackagesPage.tsx::Packages` | code | PR gate changes |
| A named function expression earns its variable nothing in the fitness test | trust it (round 2's rule) | the P5-05 inspector knew it only by its own name and rejected these readers | differential run | PR round-3 fixes |

**Framing changes:** criteria 1–7 and 9 sharpened, 10 (switching building) and 11 (building time) added; the drafted
criteria for one notice at `/notices/<id>` and its not-found state moved unchanged to P6-02b, because the drafted
ticket measured ~490 non-test lines (ticket Frame notes).

**Plan versus final code:** compared with the PR's Plan. Differences: criterion 10's test follows the nav link after
the switch (a switch goes home, P2-06a) instead of seeing B's feed in place; `frontend/src/lib/i18n.js` is unchanged (its keys are
also read by `Dashboard.jsx`); the 404 message moved to the list (above); the `Notices` exemption (above). The
fitness test's final rules (D6) differ from the Plan's one line on it through review rounds 1–4 (§6).

## 3. How it is implemented

### Overview

- **API:** `backend/app/notices/router.py::list` takes `live`; `backend/app/notices/service.py::list_notices` narrows.
- **Hooks** (`frontend/src/features/notices/api.ts`): `useNoticeFeed` (infinite, `live: true`), `useNoticeSummary`
  (polled 30 s), `useMarkNoticeRead`; all keys under `noticesKey(buildingId)` = `['b', buildingId, 'notices']`.
- **Page:** `frontend/src/features/notices/NoticesPage.tsx::NoticesPage` keys `Notices` by building; `Notices` waits for the first count and asks
  the feed again when the count moves; `frontend/src/features/notices/NoticeList.tsx::NoticeList` renders states and cards; `NoticeBody.tsx`
  renders Markdown.
- **Nav:** `frontend/src/app/pages.ts::PAGE_ACCESS` row `Notices` (feature `notices`, any role); `frontend/src/app/routes.tsx` routes
  `/notices/*` under `RequirePageAccess`; `frontend/src/app/MainNav.tsx::NavLabel` shows `NoticesNavLabel`.

### Walkthrough (variant B: a resident marks a notice read)

1. **Page.** `/notices` → `RequirePageAccess access={PAGE_ACCESS.Notices}` → `NoticesPage`, which renders
   `<Notices key={buildingId} …>`. A building with `notices` off gives `/403` before any notices request.
2. **First count, then the feed.** `Notices` calls `useNoticeSummary`; `ready` is true once there is a count or the
   summary failed, and `NoticeList` passes it as `enabled` to `useNoticeFeed`. So the feed is never older than the
   count it is compared with.
3. **Request.** `GET /api/buildings/{b}/notices?live=true[&cursor=…]` (`notices_list`); the server returns
   `visible_notices(ctx)` ∩ `live()`, each `NoticeOut` with the caller's `read_at`.
4. **Card.** `Card` shows "Unread" and "Mark as read: <title>" when `read_at === null`. A press sets the `sending` ref,
   then `read.mutate(item.id)` → `POST …/notices/{id}/read` (204).
5. **Response.** On settle, `useMarkNoticeRead` cancels every query under the notices key, then invalidates them: the
   feed returns the notice with `read_at` set (label and button gone) and the summary drops by one (badge). A failure
   keeps the card unread with "Could not mark the notice read." on it; a 404 sets the list's `gone` message
   ("“<title>” is no longer available.") and the refresh removes the card.
6. **The badge moves on its own.** Every 30 s on a visible tab the summary is polled; if `unread` changes, `Notices`
   cancels then invalidates the feed key, so a list asked before the change is not what stays.
7. **States and width.** Loading, empty ("No notices right now."), failed (with "Try again") and failed-"Load more";
   cards and the body use `[overflow-wrap:anywhere]` and `min-w-0`, so long unbroken text stays inside 375 px.

### Data model changes

None (one query parameter).

## 4. The code

**Files changed** (non-docs)

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/notices/router.py`, `service.py` | `live` parameter | +15 / −3 |
| `backend/tests/notices/test_api.py` | criterion 9 | +38 |
| `frontend/src/features/notices/api.ts` | hooks and keys | +68 |
| `frontend/src/features/notices/NoticesPage.tsx` | page, follows the badge | +51 |
| `frontend/src/features/notices/NoticeList.tsx` | states, cards, mark read | +131 |
| `frontend/src/features/notices/NoticeBody.tsx` | Markdown renderer | +48 |
| `frontend/src/features/notices/NoticesNavLabel.tsx` | nav count | +23 |
| `frontend/src/features/notices/notices.test.tsx`, `noticeBody.test.tsx` | criteria 1–5, 10, 11; 3 | +510 |
| `frontend/src/app/pages.ts`, `routes.tsx`, `MainNav.tsx` | row, route, label | +16 / −2 |
| `BuildingUpdatesFeed.jsx`, `ArchivedUpdatesModal.jsx` (`frontend/src/components`) | deleted | −1168 |
| `frontend/src/pages/Dashboard.jsx` | embeds removed | +1 / −10 |
| `frontend/src/test/buildingDenial.test.ts` | checker-based rewrite | +637 / −123 |
| `frontend/base44-baseline.txt` | 270 → 247 | ±1 |
| tests that list nav items or requests, `renderApp.tsx`, `schema.d.ts` | the new item, its summary request, the parameter | +26 / −12 |

`backend/app/notices/service.py::list_notices`

```python
    stmt = visible_notices(ctx).options(with_expression(Notice.read_at, _read_at(ctx)))
    if status is not None:
        stmt = stmt.where(Notice.status == status)
    if live_only:
        stmt = stmt.where(live())
    return await paginate(db, stmt, Notice.id, params, NoticeOut.model_validate)
```

- `live()` is the summary's own predicate, so the feed and the badge count the same rows (D2). Removing the two
  lines fails `test_live_lists_only_published_unexpired_notices_for_the_manager` (backend mutation probe in the PR).

`frontend/src/features/notices/NoticeBody.tsx::NoticeBody`

```tsx
const SAFE_URL = /^(https?:|mailto:|tel:)/i;

function safeUrl(url: string): string | null {
  return SAFE_URL.test(url.trim()) ? url : null;
}
// ...
  img: ({ alt }) => <>{alt}</>,
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer" className="underline">
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
// ...
      <Markdown components={COMPONENTS} urlTransform={safeUrl}>
        {markdown}
      </Markdown>
```

- No `rehypePlugins` (no `rehype-raw`): raw HTML in the source stays text. `urlTransform` empties any other scheme,
  and the `a` override then renders the text alone. Dropping `urlTransform` fails 2 tests, dropping the `img` override
  1 (PR mutation probes).

`frontend/src/features/notices/NoticesPage.tsx::Notices` (the feed follows the badge)

```tsx
  const summary = useNoticeSummary(buildingId);
  const unread = summary.data?.unread;
  const ready = unread !== undefined || summary.isError;
  const blind = useRef(false);
  const seen = useRef(unread);
  useEffect(() => {
    if (unread === undefined) {
      blind.current ||= ready;
      return;
    }
    if (seen.current === undefined ? blind.current : seen.current !== unread) {
      const filters = { queryKey: noticeFeedKey(buildingId) };
      void queryClient.cancelQueries(filters).then(() => queryClient.invalidateQueries(filters));
    }
    seen.current = unread;
  }, [unread, ready, buildingId, queryClient]);
```

- Copied from `MyPackagesPage` (P5-04 criterion 9): `blind` covers a feed that started after a failed count and must
  be asked again when the first count arrives. Without the cancel, a list answer already on its way would be kept
  ("a feed answer that started before a change is not kept"; the PR's "invalidate without cancel" probe fails 1).

`frontend/src/test/buildingDenial.test.ts::resolver` (the round-3 rules: wrapper trust and unreadable imports)

```ts
    if (ts.isCallExpression(at)) {
      const inner = at.arguments[0] && unwrap(at.arguments[0]);
      if (!inner || !isReactWrapper(unwrap(at.expression))) return unknown();
      if (!(ts.isArrowFunction(inner) || ts.isFunctionExpression(inner) || ts.isCallExpression(inner))) return unknown();
      const found = ofExpression(inner, seen);
      return 'fn' in found ? found : unknown();
    }
// ...
  const isReactWrapper = (callee: ts.Expression): boolean => {
    if (patchable) return false;
    if (ts.isIdentifier(callee)) {
      if (checker.getSymbolAtLocation(callee) === undefined) return isWrapperName(callee.text);
      const imported = reactImport(callee);
      return !!imported && ts.isImportSpecifier(imported) && isWrapperName((imported.propertyName ?? imported.name).text);
    }
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
      const imported = reactImport(callee.expression);
      return isWrapperName(callee.name.text) && !!imported && ts.isNamespaceImport(imported);
    }
    return false;
  };
// ...
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration) return { unresolved: start.flags & ts.SymbolFlags.Alias ? exportedName(start, name) : name };
```

- Only the first argument is the wrapped function (`memo`'s second is its comparison); only a named import whose
  imported name is the wrapper, the `* as React` namespace, or an undeclared global is trusted, never React's default
  export, and nothing at all once `patchable` (a write to a `memo`/`forwardRef` member anywhere, a computed write to
  React or the global object, or React or the global object used other than read by name). An import whose chain ends
  in a module the program can't read goes by `exportedName`, the last name the chain exports it as. Each line has a
  mutation probe that fails a test (PR "Round 3 fixes").

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| A body with `<script>`, `<img onerror>`, a raw `<a>`, an inline handler, an `<iframe>` | shown as text; no element, nothing runs | `noticeBody.test.tsx` "raw HTML is text, not elements" |
| `javascript:`, `data:`, `vbscript:`, `file:` or relative links | text without `href` | `noticeBody.test.tsx` "links" |
| A Markdown image | its alt text, no `<img>` | `renders no image, from Markdown or a reference, but keeps its alt text` |
| A double press of Mark as read | one request | `sends one read, then the label, the button and one of the badge go, without a reload`; `keeps the button disabled while the read is out` |
| The read fails, or the notice left meanwhile (404) | card stays unread with a message; 404: list message and refetch | `a failed read keeps the card unread with a message on it`; `a notice gone meanwhile (404) says so and the feed is asked again` |
| A list answer that started before the count moved | cancelled, asked again | `a feed answer that started before a change is not kept` |
| The feed asked before the first count | waits | `waits for the first count before asking for the feed` |
| A building with `notices` off | `/403`, no notices request, no nav item | `a building with notices off gives /403, no notices request and no nav item` |
| Switching building with the feed open | B's badge at once; no A card while B's feed loads | `shows only the new building’s badge and feed` (B's cards never answer in this test, §7) |
| A manager's feed with drafts and expired notices | `live=true` hides them | `test_live_lists_only_published_unexpired_notices_for_the_manager` |
| A passive building reader that reads no denial, through any shape reviews found | the fitness test fails | `buildingDenial.test.ts` (33 tests, the `P6-02a R1`–`R3` cases among them) |

Acceptance criteria → tests:

1. `notices.test.tsx` "the feed and the badge (criteria 1, 11)" (the stub refuses a list without `live=true`).
2. `notices.test.tsx` "marking read (criterion 2)", four tests.
3. `noticeBody.test.tsx`, 19 tests.
4. `notices.test.tsx` "access (criterion 4)".
5. `notices.test.tsx` "the feed follows the badge (criterion 5)", four tests.
6. Chromium at 375 px (PR transcript): `scrollWidth 375 clientWidth 375`, rightmost edge 359, with a 200-character
   unbroken title and a 10 000-character body; repeated by Codex in rounds 2–3.
7. `frontend/src/test/buildingDenial.test.ts` (33 tests) and the PR's mutation probes.
8. `Base44 references under frontend/src: 247 (baseline: 247)` in `make check`.
9. `backend/tests/notices/test_api.py::test_live_lists_only_published_unexpired_notices_for_the_manager`,
   `::test_live_gives_other_members_the_list_they_already_see`, `::test_live_through_another_building_is_404`.
10. `notices.test.tsx` "switching building (criterion 10)" (partial, §7).
11. `shows "Published" and "Until" in the building timezone`.

## 6. Review log

Run-specific (James's instruction): Codex `gpt-6.1-sol` at high effort, a fresh run per round, no Claude reviewer.

| Round | Reviewer | Commit reviewed | Verdict | Findings (severity: one line) | Outcome |
|---|---|---|---|---|---|
| 1 | Codex | `e688f1d` | BLOCK | High: a `let`/`var` alias of `useBuilding` escaped; High: any call taking a hook was read as returning it | fixed in `8f341c1` |
| 2 | Codex | `8f341c1` | BLOCK | High: a named inline callback given to any call earned the denial; High: an object's member kept its original value's credit | fixed in `c338cd3` |
| 3 | Codex | `c338cd3` | BLOCK | High: a renamed `useBuilding` imported through a module outside the scan escaped; High: `memo`'s comparison callback, and a replaced `React.memo` on React's default export, were trusted | ticket blocked (B-9); James: fix and verify; fixed in `f50381c`, `274b68b` |
| 4 | Codex (verification of round 3's fixes) | `274b68b` | MERGE | F1 FIXED, F2 FIXED; no regression from the fixes | — |

Every finding was in the fitness-test rewrite; the feed drew none. The failures, each "the P5-05 inspector rejects
this reader, the rewrite passed it":

- R1: `let read = useBuilding; function A() { read({ passive: true }); }`; `const useNoDenial =
  makeHook(useBuildingDenied)`. Fix: a `let`/`var` earns nothing and is `useBuilding` if any value it holds may be; a
  call given a hook by name is unknown.
- R2: `makeHook(function useDiscarded() { return useBuildingDenied(); })`; `hooks.useBuildingDenied = () => false`
  after `const hooks = { useBuildingDenied }`. Fix: only React's wrappers keep an inline function; object members,
  methods and reassigned declarations earn nothing.
- R3: `import { useBuilding as read } from '@/lib/building'` (the scan excluded `src/lib`; the unresolved symbol kept
  only `read`); `memo(NoDenial, function useCompare() { return useBuildingDenied(); })`; `React.memo = makeHook` then
  `React.memo(function useDiscarded() {…})`. Fix: §4's excerpt. While testing the fix's neighbours, a differential run
  (scratch: the P5-05 inspector from `origin/main` against the new one over 10 584 generated sources; old flagged 5096,
  new missed 0 after the fix) found that a **named** function expression in `memo(…)` or a `const` also earned the
  denial; fixed in the same commit. Probing the real repo also showed `variables.self` in
  `frontend/src/features/residents/api.ts` tripping the global-object rule (switching wrapper trust off everywhere); member and
  declaration names are now ignored (`isMemberOrDeclarationName`), with a test.
- R4: Codex reran the three round-3 proofs (`origin/main` rejects → `c338cd3` accepts → HEAD rejects) plus 75
  variants: 78 passed, rerun by the implementer: 78 passed.

**Root cause, rounds 1–3:** the rewrite granted the denial through approximations (a `let`'s first value, any call's
argument, an object member's first value, an import's local name, any argument of a wrapper). The rule now stated in
the file's header is the inverse: only what can't change earns it.

## 7. Not verified, accepted risks and follow-ups

- **Criterion 10 is partly proven:** the test checks B's badge and that no A card shows while B's feed loads, but
  B's feed never answers, so B's cards are not asserted (noted by Codex rounds 3–4). Tracked only here.
- The fitness test is a guard against mistakes, not an adversary: a hook passed as an argument or returned from a
  function stays unresolved (fail-closed only for the name `useBuilding`), and a `.js` module is never read (an
  import from one goes by its exported name). The P5-05 inspector is not kept as a committed oracle; the differential
  runs were scratch (B-9's option (a) proposed committing one; not done).
- D5: a notice published long after it was written sorts below newer ones (creation order). Follow-up: a `published_at`
  keyset needs an index migration. Tracked in the PR follow-ups and this file.
- The journey on the real stack ran at `c338cd3` (PR transcript); rounds 3–4 changed only the fitness test.
- `/notices/<id>` shows the whole feed until P6-02b (tracked in P6-02b's criteria).

## 8. How to change this safely

- A new notices query goes under `noticesKey(buildingId)`, so a read still refreshes it; `notices.test.tsx` "marking
  read" fails if the badge or the card doesn't clear.
- Never add `rehype-raw` or another HTML path to `NoticeBody`; `noticeBody.test.tsx` fails on any raw element. A new
  link scheme goes in `SAFE_URL` with a test row.
- A new page that reads `useBuilding({ passive: true })` must also read `useBuildingDenied()` (or a hook that does),
  or get an `EXEMPT` entry with its reason; `buildingDenial.test.ts` lists it otherwise. A change to the resolver
  should keep every `P6-02a R…` case and be run against the P5-05 inspector (`git show
  680dea1:frontend/src/test/buildingDenial.test.ts`, the last `main` before this PR, as the round proofs did).

## 9. Must explain, then quiz

1. **Which server function decides what the feed shows?** `backend/app/notices/queries.py::visible_notices` (who may
   see which notice) narrowed by `backend/app/notices/queries.py::live` (published, unexpired by `now()`), applied in
   `backend/app/notices/service.py::list_notices` when `live=true`. The browser never filters again because the device clock could
   disagree with the server's, and the badge is counted with the same `live()` (D2).
2. **Why can't a body run script?** `frontend/src/features/notices/NoticeBody.tsx::NoticeBody` passes the Markdown to `react-markdown` with no HTML
   plugin, so raw HTML is never parsed into elements; `safeUrl` (`urlTransform`) drops every scheme but four, so no
   `javascript:` href exists; the `img` override renders alt text, so no image request.
3. **How do the label and the badge clear, and what keeps them agreeing?** `frontend/src/features/notices/api.ts::useMarkNoticeRead`'s `onSettled`
   cancels then invalidates the whole `noticesKey`, so the feed (with `read_at`) and the summary are both asked again;
   both are counted from the same rows (`live=true` and `live()`), and the page re-asks the feed whenever the polled
   count moves (`frontend/src/features/notices/NoticesPage.tsx::Notices`).
4. **How does the fitness test know which function a call names?** `frontend/src/test/buildingDenial.test.ts::analyze` builds a
   program and, per call, `resolver` asks `checker.getSymbolAtLocation` for the callee's symbol, follows aliases
   (`getAliasedSymbol`) and `const` initialisers, and accepts a function only through a binding that can't change;
   calls and functions are matched by the function node's position (`keyOf`), so a name alone never counts.

Quiz:

1. Why does the feed wait for the first unread count before it asks for the list?
2. A manager opens `/notices` while a draft and an expired notice exist. What do they see, and which line decides it?
3. A notice body contains `[pay](javascript:steal())`. What is in the DOM?
4. What would break if `useMarkNoticeRead` invalidated only `noticeFeedKey` instead of `noticesKey`?
5. How would you let P6-02b mark a notice read when it is opened at `/notices/<id>`, without the badge and the feed
   disagreeing?

<details><summary>Answers</summary>

1. So the list is never older than the count it is compared with: a list asked first could predate a change the
   count then reports, and the effect would have nothing to compare (P5-04 criterion 9; `frontend/src/features/notices/NoticesPage.tsx::Notices`).
2. Only published, unexpired notices: the feed always sends `live=true` (`frontend/src/features/notices/api.ts::useNoticeFeed`), and
   `backend/app/notices/service.py::list_notices` adds `live()`.
3. The text "pay" with no `<a>` and no `href`: `safeUrl` returns null for the scheme, and the `a` override renders
   the children alone.
4. The badge would keep the old count after a read until its next 30 s poll (the summary is under `noticesKey`, not
   the feed key); the "one of the badge go" assertion would fail (the PR's probe "read invalidates only the feed key"
   failed 1 test).
5. Call `useMarkNoticeRead(buildingId).mutate(id)` from the notice view (its `onSettled` already refreshes every
   notices query), and keep the view's own query under `noticesKey` so the same invalidation covers it.

</details>
