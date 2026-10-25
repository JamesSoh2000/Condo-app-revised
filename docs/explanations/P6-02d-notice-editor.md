# Explanation — P6-02d Notice editor with preview and publish

> **PR:** #132 · **Source revision:** `b1aee2a1034cbea60f42cd21ba3aa01420fc1a9f`, the pre-merge PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (2, Codex `gpt-6.1-sol`,
> high) reviewed `d8d00a3`. `b1aee2a` adds only test assertions after it (§6).
> **Merge commit:** not known when written; after the merge, `gh pr view 132 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** at `b1aee2a`, re-read `git diff --stat origin/main...HEAD` (11 paths). Read whole:
> `NoticeEditor.tsx`. Read as patches: `ManagerNoticesPage.tsx`, `ManagerNoticeList.tsx`, `api.ts`,
> `api/client.ts` and `residents/Modal.tsx`. Also re-read the ticket diffs (P6-02d Frame notes, P6-02e, P6-02f,
> the index), the assertions of the tests cited below, the backend `backend/app/notices/schemas.py` and
> `service.py::update_notice` it relies on (unchanged), and the PR body (no PR comments or reviews exist). Ran
> `npx vitest run src/features/notices` (7 files, `162 passed`). CI was green on `b1aee2a` (5 checks). This pass
> found one defect (a server error on `priority` was placed but never shown). It was fixed test-first in `d8d00a3`
> and reviewed in round 2 (§6). Differences from the plan: the second split, see §2 "Plan versus final code".
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: B (UI interaction).

## 1. What was built and why

Property management can now write notices in the new app. Before this, a draft could only be created through the
API or the legacy Base44 form. On `/manage/notices` a **New notice** button, and an **Edit** button on each draft row,
open an editor dialog. The dialog has a title, a Markdown body with a Write / Preview switch, and a priority.
**Save draft** creates the draft (`notices_create`), or sends only the changed fields (`notices_update`). After a
save, **Publish** hands the saved draft to P6-02c's confirm dialog.

The decisions that matter most: the editor is a dialog, not a route (D2); publish is refused until everything is
saved (D3); and the ticket was split twice. The second split came after it was built and measured at 570 lines
(D7). The expiry field, the attachment and the deletion of the legacy Dashboard form are now
[P6-02f](../tickets/P6-02f-notice-expiry-and-attachment.md), with their criteria unchanged.

## 2. Decisions

### D1. Markdown editing: a plain textarea with Write / Preview

- **Problem or constraint:** open decision 1. The stub asks for "rich text limited to Markdown", with no WYSIWYG.
- **Chosen:** a textarea, plus two `aria-pressed` buttons that swap it for the preview.
- **Alternatives rejected:** a formatting toolbar: more code and controls to fit at 375 px, and no criterion asks for it.
- **Tradeoffs and accepted limitations:** managers type the Markdown syntax themselves.
- **Basis:** the stub's default; autonomous (simplest, reversible). **Source:** recorded (PR D1, Frame notes D1).

### D2. The editor is a dialog over `/manage/notices`, not its own route

- **Problem or constraint:** open decision 2.
- **Chosen:** `frontend/src/features/notices/NoticeEditor.tsx::NoticeEditor` renders in
  `frontend/src/features/residents/Modal.tsx::Modal`, with the new `wide` option. It gets the notice from its row, as
  P6-02c's `frontend/src/features/notices/NoticeActionDialog.tsx::NoticeActionDialog` does.
- **Alternatives rejected:** a route (`/manage/notices/new`, `/<id>/edit`). It would need the draft loaded by id,
  a not-found and a "no longer a draft" state, and the Back/Forward cases of the CLAUDE.md lesson. That is more code
  for no criterion.
- **Tradeoffs and accepted limitations:** you can't link to an editor, and a reload loses unsaved text (it would on
  a route too). The editor works from the row's snapshot at opening (§7).
- **Basis:** existing pattern; autonomous. **Source:** recorded (PR D2).

### D3. Publish is refused until everything is saved

- **Problem or constraint:** open decision 3: what Publish does when there are unsaved changes.
- **Chosen:** Publish shows only on a saved draft with no unsaved change, no save out and no 409. Otherwise a hint
  says "Save your changes to publish." Pressing it closes the editor and opens P6-02c's confirm dialog for the saved
  draft, so the confirmation, outcomes, messages and focus handling are P6-02c's.
- **Alternatives rejected:** save then publish in one press. That is two requests, and each partial outcome (saved but
  not published, or an older save published) would need its own message and tests.
- **Tradeoffs and accepted limitations:** one more press (Save, then Publish).
- **Basis:** autonomous (simplest, reversible). **Source:** recorded (PR D3).

### D7. Split again after building: expiry, attachment and legacy deletion moved to P6-02f

- **Problem or constraint:** the whole ticket was built test-first and measured **570 added non-test lines**
  (`git diff --numstat`), against the ~400 limit (playbook step 3: "Over the limit means split").
- **Chosen:** criteria 4 (expiry in building time), 5 (attachment), 10 (legacy deletion), the `null` half of 2 and
  the file-name half of 9 move word for word to P6-02f. Frame decisions D4 (per-type file limits) and D6 (DST
  resolution) go with them. The code was tested green, then reverted on this branch. P6-02f's ticket names the
  commits to start from (`383daa1`, `8cba241`, `620779a`, `0fcc09c`).
- **Alternatives rejected:** merging at 570 lines (breaks the rule other tickets kept; P6-02a split at ~490); moving
  only the attachment (~480, still over); squeezing the code (already at `LogPackageForm`'s density).
- **Tradeoffs and accepted limitations:** until P6-02f, the new editor can't set an expiry or an attachment, and the
  legacy Dashboard "Send Notice" form stays. A draft keeps the expiry and attachment it already has, because an
  update sends only changed fields (§5).
- **Basis:** playbook step 3; measurement. **Source:** recorded (PR D7 and "Deviation", ticket Frame notes "Split
  again").

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| P6-02c's two focus carries go to the new P6-02e | do them here | ~70 lines, in other features' lists | size | Frame notes D5 |
| Strip with Python's `str.strip()` set (`pyStrip`) | JavaScript `trim` | `trim` also strips U+FEFF, which Python keeps and counts | `backend/app/notices/schemas.py` | PR table |
| Escape doesn't close a dirty editor | close and discard | one key would lose up to 10 000 characters | autonomous | PR table |
| `api.patch` on the typed client | raw `client.PATCH` | hooks go through `api.*`, which throws `ApiError` | convention | PR table |
| Lone surrogates refused on the client | leave them to the server | pydantic answers `json_invalid`, with no field to place it on | `backend/app/units/schemas.py::printable` docstring | PR table |
| After a save, the form takes the server's values | keep the typed text | the server strips; unstripped text would read as "unsaved" right after a save | autonomous | PR table |

**Framing changes:** criteria 1–8 sharpened (for example: "changed" means different from the last saved version
after the strip; the preview renders the stripped text); cases 11–14 added (one request per press, unsaved work,
building switch, publish from the editor); none loosened. Two splits: P6-02e at framing, P6-02f after building.

**Plan versus final code:** the PR keeps the first plan's scope in its "Deviation" note. The final code is the
editor without expiry and attachment (D7). The review and reality-pass fixes added: going back to Write when the
server refuses the body from Preview; priority counting as unsaved work; and a priority error rendered on its
fieldset (§6). Nothing else differs from the written plan.

## 3. How it is implemented

### Overview

- `ManagerNoticesPage.tsx::ManagerNotices` holds `editing` (the notice, or null for a new one, plus the button that
  opened it) and renders the editor. On a create it switches to the Drafts list. On Publish it swaps the editor for
  `NoticeActionDialog`. On close, focus goes back to the opener, or to the list heading if the opener's row is gone.
- `ManagerNoticeList.tsx::Row` shows **Edit** on draft rows only.
- `NoticeEditor.tsx::NoticeEditor` holds the form, the last saved notice (`saved`), the checks, the change set and
  the error mapping.
- `api.ts::useSaveNotice` posts or patches, then cancels and re-asks every notices query.
- `api/client.ts::createApiClient` gains `patch`; the CSRF header middleware already covers every method.

### Walkthrough: the manager edits a draft's body and saves

1. **The action.** On a draft row the manager presses "Edit: Pool" (`ManagerNoticeList.tsx::Row` calls
   `onEdit(item, button)`). The page stores `{ item, opener }`, and the editor mounts with the title input focused.
2. **Form state.** `title`, `body` and `priority` start from the row's notice; `saved` is that notice. On every
   render, the editor strips the text (`pyStrip`) and builds `changes`, the fields that differ from `saved`. `dirty`
   is whether `changes` is empty (for a new notice: any text, or a priority other than Normal). While `dirty`, the
   dialog ignores Escape (`Modal busy={busy || dirty}`) and the close button reads Cancel.
3. **Checks before sending** (`problems`), as `app/notices/schemas.py` checks: a control character (title: any `Cc`;
   body: any `Cc` but tab, LF, CR) or a lone surrogate; blank after the strip; over 200 / 10 000 code points
   (`formErrors.ts::codePoints`). On a problem, Save shows each field's message (`aria-invalid`,
   `aria-describedby`), returns to Write if Preview was on, focuses the first bad field, and sends nothing. With no
   change it says "No changes to save." and sends nothing.
4. **The request.** The `inFlight` ref is checked and set first, so a second press in the same tick returns. Then
   `busy` disables Save, focus moves to the dialog (a disabled button would drop it to `<body>`), and
   `useSaveNotice` sends `PATCH /api/buildings/{b}/notices/{id}` (`notices_update`) with `changes`, here
   `{"body": "Closed until Friday."}`. The journey on the real API sent exactly that.
5. **Success.** The 200 `NoticeOut` becomes `saved`, and the fields take its values. The status says "Draft saved."
   and takes focus. `onSaved(result, created)` tells the page, which shows Drafts after a create. Publish now shows.
6. **Failure.** `failed()` places 422 `errors[]` on `title`, `body` or `priority` with `serverFieldErrors` and the
   editor's own messages, returning to Write for a body error, and focuses the field. A 409 `notice_not_editable`
   sets `moved`: a form alert, every field kept, and Save and Publish gone. Anything else (429, network, an
   unplaceable 422) is a form alert, focused.
7. **Cache.** `useSaveNotice`'s `onSettled` cancels, then invalidates, every `['b', buildingId, 'notices']` query,
   however the save ends. The list behind the dialog, the feed, the summary and the banner all ask again. The
   editor itself reads no query, so a refetch doesn't change what it shows.
8. **Publish.** `onPublish(saved)` closes the editor and opens `NoticeActionDialog` with action `publish` and the
   editor's opener, so after the confirm, focus follows P6-02c's rules.

States: no loading state (the notice comes from its row). The building switch unmounts everything, because the
page is keyed by building. At 375 px, the journey measured the page and the dialog inside the viewport with a
200-character unbroken title and a 10 000-character unbroken body.

### Data model changes

None.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `frontend/src/features/notices/NoticeEditor.tsx` | new: the editor | +287 |
| `frontend/src/features/notices/ManagerNoticesPage.tsx` | New notice, editing state, publish handoff | +40 −2 |
| `frontend/src/features/notices/ManagerNoticeList.tsx` | Edit on draft rows | +16 −3 |
| `frontend/src/features/notices/api.ts` | `useSaveNotice`, types | +27 |
| `frontend/src/api/client.ts` | `api.patch` | +10 −3 |
| `frontend/src/features/residents/Modal.tsx` | optional `wide` | +4 −2 |
| `frontend/src/features/notices/editor.test.tsx` | new: 36 tests | +575 |
| `docs/tickets/…` | frame, P6-02e, P6-02f, index | docs |

`frontend/src/features/notices/NoticeEditor.tsx::pyStrip`

```tsx
// Python's `str.strip()` whitespace, which the server strips (`app/notices/schemas.py`); JavaScript's `trim` also
// strips U+FEFF, which Python keeps and counts.
const SPACE = '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const EDGES = new RegExp(`^${SPACE}+|${SPACE}+$`, 'gu');
const pyStrip = (value: string) => value.replace(EDGES, '');
// The schema's `printable` (title) and `_markdown_before_strip` (body), plus lone surrogates, which pydantic refuses as
// `json_invalid`, with no field to show it on.
const TITLE_BAD = /[\p{Cc}\p{Cs}]/u;
const BODY_BAD = /\p{Cs}|(?![\t\n\r])\p{Cc}/u;
```

- The client's length check, the change set and the preview all use the text as the server will store it.
- Without it (`trim`): a title ending in U+FEFF passes 200 on the client while the server counts it, and the preview
  could differ from the feed. The mutation probe (`pyStrip` → `trim()`) failed `counts code points as Python
  does…`.

`frontend/src/features/notices/NoticeEditor.tsx::changes` (the change set and `dirty`)

```tsx
  const values = { title: pyStrip(title), body: pyStrip(body) };
  // What differs from the last save; for a new notice, everything it has.
  const changes: NoticeUpdate = {};
  if (values.title !== saved?.title) changes.title = values.title;
  if (values.body !== saved?.body) changes.body = values.body;
  if (priority !== (saved?.priority ?? 'normal') || !saved) changes.priority = priority;
  const dirty = saved ? Object.keys(changes).length > 0 : Boolean(title || body || priority !== 'normal');
```

- For a draft, `changes` is the PATCH body. For a new notice (`saved` null) every field differs, so it is the create
  body, priority included.
- It compares with `saved`, the latest server answer, so a second save of a new draft is a PATCH of what changed
  since (test `a second save of the new draft updates it…`).
- Without the `priority !== 'normal'` term, Escape discarded a new notice whose only change was Urgent (review round
  1 F2).

`frontend/src/features/notices/NoticeEditor.tsx::submit` (trimmed)

```tsx
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    setTried(true);
    // ...
    const first = FIELDS.find((field) => problems[field]);
    if (first) {
      setPreview(false);
      return setFocusTo({ target: first });
    }
    if (saved && !dirty) {
      setStatus('No changes to save.');
      return setFocusTo({ target: 'status' });
    }
    inFlight.current = true;
    setBusy(true);
    // The button about to be disabled would drop focus to <body> in a browser.
    root.current?.focus();
    try {
      const result = saved
        ? await save.mutateAsync({ id: saved.id, body: changes })
        : await save.mutateAsync({ id: null, body: changes as NoticeCreate });
      if (!mounted.current) return;
      setSaved(result);
      // ...the fields take the server's values
      setStatus('Draft saved.');
      setFocusTo({ target: 'status' });
      onSaved(result, !saved);
    } catch (error) {
      if (mounted.current) failed(error);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
```

- The ref guard runs before any state, because `disabled` only applies after the next render. The mutation probe
  without it failed `a double click on Save sends one create…`, which clicks twice inside one `act`.
- `mounted` stops a late answer from touching an editor a building switch removed (`switching building with a save
  out…`).
- `focusTo` is state, so the effect focuses after the commit that renders the target.

`frontend/src/features/notices/NoticeEditor.tsx::failed`

```tsx
  function failed(error: unknown) {
    const code = error instanceof ApiError ? error.code : null;
    const placed = serverFieldErrors(error, FIELDS, SERVER_MESSAGES);
    let next: Partial<Record<Field, string>> = {};
    if (placed) next = Object.fromEntries(placed.map(({ field, message }) => [field, message]));
    else if (code === 'notice_not_editable') setMoved(true);
    const first = FIELDS.find((field) => next[field]);
    setErrors(next);
    // The body's textarea isn't there in Preview (review round 1 F1).
    if (next.body) setPreview(false);
    if (first) return setFocusTo({ target: first });
    setFailure(
      code === 'notice_not_editable'
        ? M.moved
        : (rateLimitMessage(error) ??
            (error instanceof ApiError && error.status === 422 ? 'Check the details and try again.' : 'Could not save the notice. Your changes are kept; try again.')),
    );
    setFocusTo({ target: 'failure' });
  }
```

- `serverFieldErrors` (P2) returns null unless every error has a field and a message; then it's a form alert. It
  never shows the server's `msg`.
- Each entry in `FIELDS` needs an element with id `${id}-<field>` and a `fieldError(<field>)`. The `priority` one was
  missing until the reality pass (§6); now the `fieldset` has both.

`frontend/src/features/notices/ManagerNoticesPage.tsx::ManagerNotices` (the editor's part)

```tsx
  const closeEditor = () => {
    const back = editing?.opener.isConnected ? editing.opener : headingRef.current;
    if (back) setFocusTo({ target: back });
    setEditing(null);
  };
  // ...
      {editing && (
        <NoticeEditor
          item={editing.item}
          onSaved={(_, created) => created && setStatus('draft')}
          // P6-02c's confirm dialog takes over; focus goes back to the editor's opener after it (D3).
          onPublish={(item) => {
            setEditing(null);
            setOpen({ action: 'publish', item, opener: editing.opener });
          }}
          onClose={closeEditor}
        />
      )}
```

- A 409 after another manager published the draft removes its row; `isConnected` then sends focus to the heading
  (journey: `after Cancel, focus on: H2 "Drafts"`).

## 5. Edge cases and tests

All tests are in `frontend/src/features/notices/editor.test.tsx`, run at the source revision (part of the 162).

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Spaces around the text sent or counted | stripped as Python strips | `a new draft (criterion 1) › sends one create…` (body `'\n Tuesday **9–11**.\n'` sent as `'Tuesday **9–11**.'`) |
| A no-op edit sends a PATCH | "No changes to save.", nothing sent | `a change undone, or only spaces added around the text…` |
| Editing wipes the draft's expiry or attachment | only changed fields sent | `a body change sends only body, and keeps the draft’s expiry and attachment` |
| Preview differs from the feed, or runs HTML | `NoticeBody` of the stripped text | `renders the stripped body through NoticeBody…` (same `outerHTML` as a `NoticeBody` render; no `pre, code, img, b, a[href]`) |
| 201 / 10 001 characters, NUL, a tab in the title, a lone surrogate, blank | refused, focused, nothing sent | `the schema’s limits before sending` ×8, `counts code points as Python does…` |
| Server 422 on a field, from Write or Preview | on the field, focused; back to Write for body | `places the API’s own 422 field errors…`, `a refused field while Preview is shown` ×4, `a server error on priority` ×2 |
| Another manager published meanwhile | alert, fields kept, no Save or Publish | `409 notice_not_editable: the message shows…` |
| Double click on Save | one request | `a double click on Save sends one create…` |
| Escape loses typing | ignored while dirty or saving | `unsaved work (case 12)` ×4 |
| Building switch, idle or mid-save | editor gone; the late 201 shows nothing in the new building | `switching building (case 13)`, `switching building with a save out…` |
| Publish of unsaved text | Publish hidden until saved and clean | `publish from the editor (case 14)`, plus the save-out assertions in `Escape doesn’t close while a save is out…` |
| A non-manager writes notices | `/403`, no entry point | `access (criterion 8)` ×3 |

Acceptance criteria → tests:
1 `a new draft (criterion 1)` ×2 · 2 `an existing draft (criterion 2)` ×4 · 3 `preview (criterion 3)` ×2 · 4, 5, 10
moved to P6-02f · 6 the four criterion-6 `describe`s · 7 `published elsewhere meanwhile` · 8 `access` ×3 and `only
draft rows have Edit` · 9 Chromium journey at 375 px (PR transcript) · 11–14 as in the table.

Mutation probes (PR "Mutation probes"): send every field, `trim`, Escape closes a dirty editor, no in-flight guard,
no focus on a refused field, `canPublish` without `!dirty && !busy`. Each failed tests; the baseline passed.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol` (high) | `3fe62a6` | MERGE | F1 Medium: a server body error from Preview leaves the field hidden. F2 Low: Escape discards a priority-only new notice | both fixed in `f41238e` |
| reality pass | implementer (step 6) | `f41238e` | defect | a server error on `priority` placed but never rendered | fixed in `d8d00a3`, sent to round 2 |
| 2 | Codex `gpt-6.1-sol` (high), fresh run | `d8d00a3` | MERGE | none; noted no direct test of "no Publish while a PATCH is out" | test added in `b1aee2a` |

Only Codex reviewed, with no Claude reviewer: James's instruction for this run.

- **F1.** New notice → Preview → Save → 422 on `body`: the message rendered, but the textarea wasn't mounted, so
  focus stayed on the dialog (Codex reproduced it in Chromium). Fix: `failed()` returns to Write for a body error.
  Evidence: `a server error on body goes back to Write and focuses the body` failed, then passed. Codex's Chromium
  proof passed after the fix (`active: TEXTAREA`).
- **F2.** New notice → Urgent → Escape closed the editor, because `dirty` ignored priority. Fix: the
  `priority !== 'normal'` term. Evidence: `a priority chosen on an empty new notice counts as unsaved…` failed, then
  passed.
- **Reality pass.** `priority` was in `FIELDS`, so a 422 `missing` on it was placed (with `serverFieldErrors`'
  fallback "This field is required.") on a field the editor never rendered. The message vanished and focus had no
  target. That contradicted Frame criterion 6. Fix: the `fieldset` gets the id, `tabIndex={-1}`,
  `aria-describedby` and its error, plus a message for `enum`. Evidence: `a server error on priority › enum / missing`
  failed against `f41238e`'s editor (focus on the alert, and on the dialog) and pass now. In Chromium, focus lands on
  `FIELDSET`, described by "Choose Normal or Urgent.".

## 7. Not verified, accepted risks and follow-ups

Not verified:
- **Backend pytest locally**: not run. Docker isn't reachable in this WSL distro, and the scratch Postgres listens on a
  socket, which `tests/conftest.py` refuses. No backend file changed; CI's backend job passed on `b1aee2a`.
- **`make up` / `make prodlike`**: not run (Docker). The journey ran on uvicorn and Vite over a scratch Postgres 16
  instead; CI's prod-like smoke and E2E jobs passed. No E2E journey covers the editor.
- **Screen readers**: names, roles and focus were checked in jsdom and Chromium, not with a screen reader.

Accepted risks:
- **A lost 201 then a retry makes a second draft**: `notices_create` has no `Idempotency-Key`. Tracked: PR
  follow-ups; added to the inbox in the bookkeeping commit.
- **Two managers editing one draft**: each save sends only its changed fields, so the last writer wins per field,
  with no conflict warning. Tracked only here and in the PR.

Follow-ups: [P6-02f](../tickets/P6-02f-notice-expiry-and-attachment.md) (expiry, attachment, legacy deletion;
criteria 4, 5, 10) and [P6-02e](../tickets/P6-02e-list-focus-fixes.md) (P6-02c's focus carries), both in the index.

## 8. How to change this safely

- **Adding a field** (P6-02f's expiry and attachment): add it to `Field` and `FIELDS`, give its control the id
  `${id}-<field>` and a `fieldError(<field>)`, add its diff to `changes`, its server messages to `SERVER_MESSAGES`,
  and its check to `problems`. The priority bug in §6 is what happens when a field is in `FIELDS` without the
  element. The criterion-6 tests and `a body change sends only body…` tell you if the diff or the mapping broke.
- **Changing a server limit** in `app/notices/schemas.py`: change `TITLE_MAX` / `BODY_MAX` / the patterns here
  too. Nothing links them automatically; the criterion-6 table is the check.
- **Another dialog on this page**: route its focus through the page's `focusTo`, as `closeEditor` does, and test
  `document.activeElement` after closing.

## 9. Must explain, then quiz

**1. Why does the request carry a `file_id` and never a URL or key?** The attachment moved to P6-02f, so this PR
sends no file. The rule it will follow: ADR-0007 and CLAUDE.md rule 9. The client uploads through the files API
and gets a `file_id`. The server claims it (`backend/app/notices/service.py::_claim`), loading it with the
building's id, the purpose and `ready` status. A key or URL from a client could point at another building's object,
or one that was never checked.

**2. How is a building-local expiry turned into the instant the API stores?** Not in this PR (P6-02f, criterion
4). The API takes an aware datetime (`backend/app/notices/schemas.py::Expiry`) and converts it to UTC. The client
must read the wall time in `building.timezone`, not the device's, and resolve DST's skipped and repeated hours
(P6-02f carries the framing: Temporal's `compatible`).

**3. Why does an update send only the changed fields, and what does `null` mean in it?**
`backend/app/notices/schemas.py::NoticeUpdate` changes only the fields sent (`model_fields_set`), and
`backend/app/notices/service.py::update_notice` writes and audits only those. Sending only what changed means a
save doesn't overwrite fields this manager didn't touch: another manager's edit, or the expiry and attachment the
editor doesn't show yet (`a body change sends only body, and keeps the draft’s expiry and attachment`). A `null`
means "clear it", allowed only for `expires_at` and `attachment_file_id`; for `title`, `body` and `priority` the
validator refuses it. This PR sends no `null`; clearing arrives with P6-02f.

Quiz:

1. A manager opens a draft, types two trailing spaces after the title and presses Save. What is sent, and what does
   the editor say?
2. Why does `submit` check a ref (`inFlight`) when the Save button is already `disabled={busy}`?
3. The manager is in Preview and the server answers 422 on `body`. What does the editor do, and what went wrong
   before round 1's fix?
4. What breaks if `priority` stays in `FIELDS` but the `fieldset` loses its `id`?
5. How would you add the expiry field (P6-02f) without breaking "only changed fields are sent"?

<details><summary>Answers</summary>

1. Nothing: `pyStrip` makes the title equal `saved.title`, so `changes` is empty. The editor says "No changes to
   save." and focuses that status (`a change undone, or only spaces added around the text…`).
2. `disabled` applies only after React renders, so a second click in the same tick still submits. The ref is set
   synchronously before the request. Without it, `a double click on Save sends one create…` fails.
3. It shows the message, switches to Write so the textarea is there, and focuses it. Before the fix the textarea
   wasn't mounted, so focus stayed on the dialog (F1).
4. `failed()` would still place the error and pick `priority` as the first field, but `document.getElementById`
   would find nothing to focus. The `a server error on priority` tests would fail on `document.activeElement`.
5. Keep the field as a local input string. Compare it with the same string made from `saved.expires_at`, and add
   `changes.expires_at` (the instant, or `null` when emptied) only when they differ. Add it to `FIELDS` with an
   element id and `fieldError`, and map `notice_expired` to it in `failed()`.

</details>
