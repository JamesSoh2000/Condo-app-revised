# Explanation — P6-02f Notice editor: expiry and attachment

> **PR:** #134 · **Source revision:** `c98f8edbe97eff464ce046b81a8c48742872d9cb`, the pre-merge PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (3, Codex `gpt-6.1-sol`,
> high) reviewed this commit and said `MERGE` with no findings.
> **Merge commit:** not known when written; after the merge, `gh pr view 134 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** at `c98f8ed`, re-read `git diff --stat origin/main...HEAD` (13 paths) and the patches of
> `frontend/src/features/notices/NoticeEditor.tsx`, `frontend/src/features/files/FileUpload.tsx`,
> `frontend/src/features/files/purposes.ts`, `frontend/src/features/notices/expiry.ts` and
> `frontend/src/features/notices/ManagerNoticesPage.tsx`; `frontend/src/features/files/useUpload.ts::useUpload` (unchanged, its
> `cancel` and status) and the backend `backend/app/notices/service.py` / `schemas.py` it relies on (unchanged); the
> assertions of every test cited below; the PR body (no PR comments or reviews exist). Ran `npx vitest run
> src/features/notices/editor.test.tsx src/features/notices/expiry.test.ts src/features/files/files.test.tsx`
> (3 files, `138 passed`). CI was green on `c98f8ed` (5 checks). Differences from the plan: see §2 "Plan versus
> final code".
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: B.

## 1. What was built and why

The manager's notice editor (P6-02d's dialog on `/manage/notices`) gets two optional fields. **Expires** is typed as a
wall time in the building's timezone, never the device's, and sent as a UTC instant. **Attachment** is one PDF or
image uploaded through the shared `FileUpload`, sent as its `file_id` only. Either can be cleared, which sends
`null`. The client's copy of the file rules now has a size limit per content type, like the server's registry. The
legacy Base44 "Send Notice" form on the Dashboard and its `NoticeAttachmentUpload` are deleted, and the Base44 ratchet
drops from 227 to 225.

The code began as P6-02d's reverted commits (D1). Three review findings then reshaped it. Unsaved upload and expiry
states now block Publish (D4 and §6). A half-typed date is read from the browser's `validity.badInput` (D4). And
`FileUpload` keeps keyboard focus when its own controls disable or remove themselves, for every form that uses it (D5).

## 2. Decisions

### D1. Start from P6-02d's reverted commits

- **Problem or constraint:** P6-02d wrote and tested this code, then reverted it to stay under its size limit.
- **Chosen:** re-apply `383daa1` (per-type limits), `8cba241` (building-time conversion), the editor part of `620779a`,
  and `0fcc09c` (legacy deletion) onto today's editor, which P6-02d changed after them (priority errors, and Preview
  switching back to Write on a body error).
- **Alternatives rejected:** rewriting from scratch, which loses tested work for no gain.
- **Tradeoffs and accepted limitations:** that code's earlier review history belongs to P6-02d; this PR was reviewed
  afresh, and the review found two defects in it (§6 round 1).
- **Basis:** ticket. **Source:** recorded (PR D1, ticket Frame notes D1).

### D2. P6-02d's follow-up becomes a test (criterion 11), not a CLAUDE.md lesson

- **Problem or constraint:** P6-02d twice focused a field whose element wasn't rendered.
- **Chosen:** a test that, for each entry of `NoticeEditor.tsx`'s `FIELDS`, makes a server 422 on that field, then
  checks that focus lands on the element with id `${id}-<field>` and that its `aria-describedby` points at a non-empty
  message. `FIELDS` and `SERVER_MESSAGES` are exported for it.
- **Alternatives rejected:** a CLAUDE.md lesson, which asks a reader to remember and never fails.
- **Tradeoffs and accepted limitations:** two exports used only by the test.
- **Basis:** autonomous (ticket follow-up). **Source:** recorded (PR D2).
- It paid off at once. P6-02d's carried attachment markup had no element with id `${id}-attachment_file_id`. A mutation
  that removes it fails the test (`1 failed | 4 passed`), so the attachment block became a focusable group (D3).

### D3. A refused attachment focuses the attachment group

- **Problem or constraint:** an error on `attachment_file_id` must move focus to something that stays mounted.
  `FileUpload` is re-keyed after a refusal, so its button is replaced.
- **Chosen:** the wrapper `div` is `role="group"` with `tabIndex={-1}`, labelled by "Attachment (optional)" and
  described by the field error. Remove attachment focuses it too.
- **Alternatives rejected:** focusing `FileUpload`'s "Choose file" button (it needs a ref through `FileUpload`, and the
  key change replaces the button); a form-level alert (the error belongs to the field, as with every other field).
- **Tradeoffs and accepted limitations:** a focus stop that only code reaches (`tabIndex=-1`).
- **Basis:** criterion 11, and P6-02d's priority fieldset as precedent. **Source:** recorded (PR D3).

### D4. Unsaved work includes a running or failed upload and a half-typed expiry, read from `validity.badInput`

- **Problem or constraint:** Publish on a saved draft is offered only when nothing is unsaved (P6-02d D3). Two states
  weren't counted. (a) A replacement upload that was running or had failed left `changes` empty, so Publish would
  publish the old attachment (review round 1 F1, High). (b) In Chromium, a `datetime-local` with a segment deleted
  reports `value: ''`, the same as a cleared field, so Save sent `{"expires_at": null}` and silently removed the expiry
  (round 1 F2, Medium). Worse, Chromium sends **no** input event when a segment is typed into an empty field (the
  value stays `''`), and React's `onChange` skips an input event whose value didn't change.
- **Chosen:** `pending = expiryBad || upload.status === 'uploading' || upload.status === 'error'` joins `dirty`, so
  Publish waits and the dialog's Escape stays blocked. `syncExpiry` reads `expiryRef.current.validity.badInput` on
  `onInput`, `onKeyUp` and `onBlur`. A bad input refuses Save with "Enter a date and time." on the field and shows
  Remove expiry, which also writes `input.value = ''` to clear the segments (React won't, since its value is already
  `''`).
- **Alternatives rejected:** `onChange` or `onInput` alone (misses the empty-field case: Chromium showed `"12" typed
  into an empty field: {"value":"","badInput":true}` with Publish still offered); three separate date and time inputs
  (a larger UI change, and it loses the native picker); reading `badInput` only at submit (Publish and Escape would
  still treat the field as clean).
- **Tradeoffs and accepted limitations:** a `badInput` change that comes with no key-up, input event or blur would be
  noticed only at the next one. None is known.
- **Basis:** review round 1 F1 and F2. **Source:** recorded (PR D4, "Independent review" round 1).

### D5. `FileUpload` hands focus to its next control (review round 2 F1)

- **Problem or constraint:** choosing a file disables "Choose file", and Cancel and Retry unmount when the status
  changes. In Chromium each drops focus to `<body>` (Codex's proof: `{"tag":"BODY","inside":false}`), which in the
  editor means focus leaves the modal. The cause is the shared widget.
- **Chosen:** in `FileUpload`, if the control about to be disabled or removed had focus, the next status's control
  takes it after the render. Uploading → Cancel. Cancel → Choose file. An upload that ends with Cancel focused → Retry
  on error, else Choose file. Retry → Cancel. Focus outside the widget (a drop) is never taken.
- **Alternatives rejected:** handling it in `NoticeEditor` through `onStatusChange` (fixes one of the two forms that use
  the widget, and the editor can't see Cancel or Retry); focusing the widget's wrapper (no name to announce, while
  the next action is a control).
- **Tradeoffs and accepted limitations:** the other form that uses it, `LogPackageForm`, gets the same behaviour
  (its tests pass unchanged). When the owning form has set `disabled`, Choose file can't take focus; those forms move focus before
  they submit.
- **Basis:** review round 2 F1, and the CLAUDE.md lesson "a control that disables or removes itself". **Source:**
  recorded (PR D5).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| `Intl.DateTimeFormat` for building time (`expiry.ts`) | a Temporal polyfill, date-fns-tz | a dependency for one conversion | convention (no dependency without a reason) | recorded (PR table, Frame D3) |
| DST gaps and overlaps resolve as Temporal's `compatible` | refusing skipped times | the browser's and Temporal's default | ticket (carried D6) | recorded |
| Per-type limits `Record<type, bytes>` in `purposes.ts` | one `maxBytes` per purpose | can't say "PDF 20 MB, images 10 MB" | ticket, ADR-0007 "Limits" | recorded (carried D4) |
| After a 422 `invalid_file` / 404 `file_not_found`, drop the upload (`resetUpload`) | keep the `file_id` and let the user retry | the server refused that id; resending it fails again | Frame notes, criterion 5 | recorded |

**Framing changes** (ticket Frame notes, commit `3b74e2a`): criterion 2 now also covers replacing and removing an
upload and "unchanged sends nothing"; criterion 4 adds the existing draft's display (Toronto and Tokyo) and the
`datetime_range` 422; criterion 5 adds that a refused `file_id` is not sent again; criterion 11 is new (D2). Tenant
table rows: n/a, since there is no new endpoint and the server's P6-01 tests cover another building's file. Nothing
was loosened.

**Plan versus final code.** The Plan named the files and the criterion map, and the final code follows it, with three
additions recorded below the Plan or in a review round: the focusable attachment group (D3, from criterion 11), the
Remove buttons moving focus before they unmount (commit `1e76684`, the CLAUDE.md lesson), and the review-round
changes D4 (`pending`, `expiryBad`) and D5 (`FileUpload.tsx`, a file the Plan didn't list).

## 3. How it is implemented

### Overview

- `frontend/src/features/notices/expiry.ts::toInstant` turns `2026-12-15T18:00` read in `America/Toronto` into
  `2026-12-15T23:00:00.000Z`; `toLocalInput` goes the other way to show a saved expiry.
- `NoticeEditor` keeps `expiry` (the input's text), `expiryBad`, `kept` (the saved attachment while kept) and
  `upload` (`FileUpload`'s status and, once ready, its `file_id`). It derives `changes` (what differs from the last save),
  `dirty` and `problems` from them on every render.
- `FileUpload` (shared) runs the presigned-POST upload through `useUpload`, now checks per-type limits from
  `frontend/src/features/files/purposes.ts::ruleFor`, and hands focus on (D5).
- `ManagerNoticesPage` passes `building.timezone` and renders the editor only once the building has loaded.

### Walkthrough: the manager replaces an attachment and sets an expiry on a saved draft

1. **Open.** "Edit: Pool" on a draft row opens `NoticeEditor` with `item` and `timeZone`. `expiry` starts as
   `toLocalInput(item.expires_at, timeZone)` (for example `2999-07-15T18:00`), and `kept` as `item.attachment_file_id`.
   The attachment group says "A PDF is attached." when `saved.attachment_content_type` is `application/pdf`.
2. **Choose a file.** `FileUpload` checks it with `checkFile` against `ruleFor('notice_attachment')`: PDF up to 20 MB,
   JPEG, PNG, WebP or HEIC up to 10 MB. A wrong type or size shows the purpose's message and sends nothing. Otherwise
   `useUpload` asks the API for a presigned POST (`POST /files`), posts to S3, then calls `POST /files/{id}/complete`.
   Each status reaches the editor through `onStatusChange`. While it is `uploading`, `pending` is true: no Publish,
   Escape doesn't close, and Save is refused with "Wait for the attachment to finish uploading." If Choose file had
   focus, Cancel takes it (D5).
3. **Ready.** `onUploaded(fileId)` sets `upload = { status: 'ready', fileId }`. Now `attachment` is that id, which
   differs from `saved.attachment_file_id`, so `changes.attachment_file_id = fileId`.
4. **Type an expiry.** The input's `onChange` sets `expiry`. `toInstant(expiry, timeZone)` becomes
   `changes.expires_at` when it differs from the saved one. A half-typed value sets `expiryBad` through `syncExpiry`
   (D4) and is refused on Save.
5. **Save.** `submit` checks `problems` (title, body, expiry, upload state) and then sends only `changes` through
   `useSaveNotice` (`PATCH /notices/{id}`, or `POST` for a new draft). The answer replaces `saved`, re-derives `expiry`
   from `result.expires_at`, sets `kept = result.attachment_file_id`, and re-keys `FileUpload` (`resetUpload`) so the
   finished upload's message goes away.
6. **Errors.** `failed` places a 422 on its field through `serverFieldErrors` (`datetime_range` → expiry,
   `uuid_parsing` → attachment). A problem with code `notice_expired` goes on the expiry. `invalid_file` or
   `file_not_found` goes on the attachment and drops the upload, so the refused id isn't resent. Focus moves to the
   first field with an error (the attachment group for a file error).
7. **Cache.** Unchanged from P6-02d: `useSaveNotice` refreshes the manager's lists. The editor itself keeps no query.
8. **375 px.** Measured in Chromium with a 255-character file name: page 375, dialog client and scroll width 343.

### Data model changes

None. The API (`NoticeCreate` / `NoticeUpdate` with `expires_at` and `attachment_file_id`) exists since P6-01a.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `frontend/src/features/notices/NoticeEditor.tsx` | expiry and attachment fields, `pending`, `syncExpiry`, error mapping | +145 / −10 |
| `frontend/src/features/notices/expiry.ts` | new: building-time conversion | +60 |
| `frontend/src/features/files/purposes.ts` | per-type limits | +29 / −22 |
| `frontend/src/features/files/FileUpload.tsx` | focus handoff (D5) | +43 / −4 |
| `frontend/src/features/notices/ManagerNoticesPage.tsx` | passes `timeZone` | +4 / −2 |
| `frontend/src/pages/Dashboard.jsx`, `NoticeAttachmentUpload.jsx` (deleted) | legacy notice form deleted | +2 / −254 |
| `frontend/base44-baseline.txt` | 227 → 225 | +1 / −1 |
| `editor.test.tsx`, `expiry.test.ts`, `files.test.tsx` | tests | +508 / −8 |

`frontend/src/features/notices/NoticeEditor.tsx::NoticeEditor`: what a save sends, and what counts as unsaved

```tsx
  const attachment = upload.status === 'ready' ? upload.fileId : kept;
  const savedExpiry = saved?.expires_at ? toLocalInput(saved.expires_at, timeZone) : '';
  const values = { title: pyStrip(title), body: pyStrip(body) };
  // What differs from the last save; for a new notice, everything it has.
  const changes: NoticeUpdate = {};
  // ...
  if (expiry !== savedExpiry) changes.expires_at = expiry ? toInstant(expiry, timeZone) : null;
  if (attachment !== (saved?.attachment_file_id ?? null)) changes.attachment_file_id = attachment;
  // An upload running or failed, or a half-typed expiry, is unsaved work too, so Publish waits (review round 1 F1, F2).
  const pending = expiryBad || upload.status === 'uploading' || upload.status === 'error';
  const dirty = saved ? Object.keys(changes).length > 0 || pending : Boolean(title || body || priority !== 'normal' || expiry || attachment || pending);
```

- The two `if` lines produce criterion 2: an emptied field or a removed attachment sends `null`, and an unchanged one
  sends nothing. The expiry is compared as building-time text (`savedExpiry`), so typing the saved time back is no
  change.
- Remove `pending` and you are back to round 1 F1: on a saved draft, `canPublish` (`saved !== null && !dirty && …`)
  would offer Publish during a replacement upload and publish the old attachment.

`frontend/src/features/notices/NoticeEditor.tsx::syncExpiry`: a half-typed date (D4)

```tsx
  const syncExpiry = () => {
    const bad = expiryRef.current?.validity.badInput ?? false;
    if (bad === expiryBad) return;
    setExpiryBad(bad);
    setStatus('');
    setErrors((current) => ({ ...current, expires_at: undefined }));
  };
```

```tsx
              onChange={(event) => edit(setExpiry, 'expires_at')(event.target.value)}
              // Not in onChange: React skips an input event whose value stays ''. And Chromium sends none at all for a
              // segment typed into an empty field, so key-up and blur read the field again (review round 1 F2).
              onInput={syncExpiry}
              onKeyUp={syncExpiry}
              onBlur={syncExpiry}
```

- It reads the element, not the event, so any of the three events gives the current answer. The early return keeps a
  blur from clearing a server error when nothing changed.
- With only `onInput`, the jsdom test "on a draft with no expiry counts as unsaved…" fails (shown in §6), and so did
  Chromium.

`frontend/src/features/notices/expiry.ts::toInstant`: the wall time in the building's zone

```ts
export function toInstant(local: string, timeZone: string): string | null {
  const match = LOCAL.exec(local);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
  const wall = utc(year, month, day, hour, minute, second);
  const check = new Date(wall);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
  // The offsets a day before and after: a candidate is right if the zone shows `wall` at it.
  const before = wall - (wallAt(wall - DAY, timeZone) - (wall - DAY));
  const after = wall - (wallAt(wall + DAY, timeZone) - (wall + DAY));
  const right = [before, after].filter((t) => wallAt(t, timeZone) === wall);
  // None is right in a gap: the offset from before it lands the gap's length later.
  return new Date(right.length ? Math.min(...right) : before).toISOString();
}
```

- `wallAt(t, zone)` is what the zone's clock shows at instant `t`, built with `Intl.DateTimeFormat.formatToParts`. The
  zone's offset a day before and a day after the wall time gives at most two candidate instants. A candidate is right
  if the zone's clock shows `wall` at it.
- Two right candidates mean an overlap (the repeated hour), and `Math.min` takes the earlier one. None means a gap
  (the skipped hour): the offset from before the change lands the gap's length later. Together that is Temporal's
  `compatible` resolution.
- `utc` uses `setUTCFullYear` because `Date.UTC` maps years 0–99 to 1900–1999.

`frontend/src/features/files/FileUpload.tsx::FileUploadFor`: the focus handoff (D5)

```tsx
  // Choose file is disabled while uploading, and Cancel and Retry go away, which drops focus to <body>. When one of
  // them had focus, the next status's control takes it (P6-02f review round 2 F1). A removed Cancel gets no blur, so
  // `cancelFocused` stays true until then.
  const refocus = useRef(false);
  const cancelFocused = useRef(false);
  // ...
  useEffect(() => {
    if (!refocus.current && !cancelFocused.current) return;
    refocus.current = false;
    cancelFocused.current = false;
    (status === 'uploading' ? cancelRef : status === 'error' && retryRef.current ? retryRef : chooseRef).current?.focus();
  }, [status]);
  const focusInside = () => root.current?.contains(document.activeElement) ?? false;
```

- `refocus` is set just before an action that changes the status: in `start` (only if focus is inside the widget),
  on Cancel's click, and on Retry's click (if focus is inside). `cancelFocused` covers the upload that finishes on its
  own while Cancel has focus.
- The effect runs after the render with the new status, when the target control exists and is enabled. Without it,
  Codex's Chromium proof shows focus on `BODY` after Choose file and after Cancel.

`frontend/src/features/files/purposes.ts::checkFile`: per-type limits

```ts
export function checkFile(file: File, rule: FileRule): string | null {
  const limit = rule.limits[contentTypeOf(file)];
  if (limit === undefined) return `This file must be a ${typesLabel(Object.keys(rule.limits))} file.`;
  if (file.size === 0) return 'This file is empty.';
  if (file.size > limit) return `This file is larger than ${formatMegabytes(limit)}.`;
  return null;
}
```

- `PURPOSE_RULES.notice_attachment` is `{ limits: { ...PDF, ...IMAGE } }`, which matches the server's
  `backend/app/files/purposes.py::PURPOSES`. Before this change the client allowed a notice attachment to be a PDF
  only (P6-02b review round 1 F1, carried).

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Expiry read in the device's zone | converts in `building.timezone` | `editor.test.tsx` "reads and writes the building's zone, not a fixed one: a Tokyo building"; `expiry.test.ts` (Toronto and Tokyo) |
| DST: summer vs winter, skipped and repeated hours | `toInstant` as `compatible` | `expiry.test.ts` "18:00 in summer is EDT", "a skipped time moves forward by the gap", "a repeated time is the earlier one" |
| Years 0–99 | `utc` via `setUTCFullYear` | `expiry.test.ts` "a year below 100 is that year, not 19xx" |
| Past expiry | the API's 422 `notice_expired` on the field, focused | "shows the API's 422 notice_expired on the expiry field…" |
| Half-typed expiry silently cleared | refused, field message, no request | "is refused on save with the field's message, not sent as null…" |
| Half-typed into an empty field, no input event | key-up reads `badInput`; no Publish, Escape kept | "on a draft with no expiry counts as unsaved: no Publish, and Save is refused" |
| Publish during a replacement upload, or after it failed | `pending` blocks it | "a saved draft whose replacement upload runs / failed offers no Publish…" |
| Save while uploading or after a failure | refused with a field message | "refuses to save while the upload runs, and after it failed" |
| Wrong type, image over 10 MB, PDF of 15 MB | refused / refused / accepted, before any request | "accepts an image too, and refuses a wrong type or an image over 10 MB…" |
| Server refuses the file | message on the attachment; the id isn't resent | "422 invalid_file / 404 file_not_found on save … doesn't resend the refused file" |
| Remove buttons unmount themselves | focus to the expiry input / attachment group | "clearing the expiry and removing the attachment send null for them" (asserts `document.activeElement`) |
| Upload controls disable or unmount | focus to the next control; never taken from outside | `files.test.tsx` "focus stays in the widget…" (4 cases) |
| A field in `FIELDS` with no element | the test fails | "a server error on %s focuses its element…" (5 cases) |
| 255-character file name at 375 px | wraps (`[overflow-wrap:anywhere]`, P5-03c) | Chromium transcript in the PR (no jsdom test: layout) |

Acceptance criteria → tests:
- **2:** "clearing the expiry and removing the attachment send null for them", "an emptied expiry field sends null
  too", "a new upload replaces the draft's attachment…", "the saved expiry typed again… sends nothing", "Remove on a
  new draft's finished upload sends no attachment".
- **4:** `expiry.test.ts` (18 cases); "sends 18:00 Toronto time as its instant, DST included", the Tokyo test, "opens
  with the saved values, the expiry in building time", the `notice_expired` / `datetime_range` test.
- **5:** `files.test.tsx` "P6-02d criterion 5: a notice attachment is a PDF up to 20 MB or an image up to 10 MB…"; the
  attachment tests in `editor.test.tsx` ("the attachment (P6-02f criterion 5)", 6 tests).
- **9:** Chromium transcript (PR evidence).
- **10:** "NoticeAttachmentUpload is deleted and the Dashboard has no notice form"; `base44-count` 225.
- **11:** "a server error on %s focuses its element and shows in its error slot".

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol`, high | `1e76684` | BLOCK | High: Publish offered during a replacement upload; Medium: a half-typed expiry sent as `null` | both fixed in `d5d2016` (D4) |
| 2 | Codex `gpt-6.1-sol`, high (fresh) | `d5d2016` | MERGE | Medium: upload controls drop focus to `<body>` | fixed in `c98f8ed` (D5) |
| 3 | Codex `gpt-6.1-sol`, high (fresh) | `c98f8ed` | MERGE | none | — |

Codex was the only reviewer: James's instruction for this run (no Claude reviewer).

- **Round 1 F1.** Inputs: a saved draft with an attachment; the manager picks a replacement and presses Publish while
  it uploads, or after it failed. Wrong outcome: the old attachment is published, and published notices can't be
  edited. Evidence: Codex's proof failed 2/2; the two-case test failed before `d5d2016` and passes after. Chromium on
  the live stack: `F1 replacement uploading → Publish offered: 0`.
- **Round 1 F2.** Inputs: in Chromium, Home then Backspace on a saved expiry, then Save. Wrong outcome:
  `PATCH {"expires_at":null}`. Evidence: the three "a half-typed expiry" tests. While fixing it, Chromium showed that an
  `onInput`-only version missed a segment typed into an empty field (`badInput: true`, Publish still offered). The
  key-up test fails against that version (`× on a draft with no expiry counts as unsaved…`) and passes with
  `onKeyUp`/`onBlur`. Codex's Chromium proof passed 2/2 after the fix.
- **Round 2 F1.** Inputs: Choose file focused, a valid file chosen; or Cancel clicked. Wrong outcome:
  `document.activeElement` is `<body>`, outside the modal. Evidence: "Choose file → Cancel while it uploads; Cancel →
  Choose file" and "…fails with Cancel focused → Retry; Retry → Cancel" failed before `c98f8ed`. Chromium after it:
  every handoff lands on a named button inside the dialog.

## 7. Not verified, accepted risks and follow-ups

- **Not run locally:** backend `pytest` and `alembic check` (Docker is unreachable in this WSL distro, inbox PRE-8). No
  backend file changed; CI's backend job passed on `c98f8ed`.
- **The stack journey ran on a scratch stack, not `make up`:** `pgserver` Postgres 16 and `moto` as the S3 emulator,
  instead of compose's LocalStack. moto's presigned-POST policy enforcement may differ from LocalStack's;
  `make s3-smoke`, which checks LocalStack's, was not run.
- **Only Chromium:** the `badInput` behaviour (D4) was measured in Chromium. Firefox and Safari render
  `datetime-local` differently, and whether they send key-up for a segment, or report `badInput` the same way, was not
  checked.
- **D5 in the other form:** `frontend/src/features/packages/LogPackageForm.tsx::LogPackageForm` uses the changed `FileUpload`. Its jsdom
  tests pass unchanged; its focus was not driven in Chromium.
- **`toInstant`** assumes at most one offset change within a day either side of the wall time. True for every IANA
  zone in practice; tracked only here.
- **The attachment shows without its file name** ("A PDF is attached."): `NoticeOut` has no name field. Accepted, out
  of scope; tracked in the PR's follow-ups and here.
- Carried from P6-02d, unchanged: `notices_create` has no `Idempotency-Key`; two managers editing one draft is
  last-writer-wins per field (inbox, P6-02d line).

## 8. How to change this safely

- **Adding a field to the editor:** add it to `Field` and `FIELDS`, give its control the id `${id}-<field>` and a
  `fieldError(<field>)`, add its diff to `changes`, its server messages to `SERVER_MESSAGES`, its check to `problems`,
  and anything that can be unsaved without a value (like `expiryBad`) to `pending`. The criterion-11 test fails if the
  element is missing.
- **Another file purpose or limit:** change `frontend/src/features/files/purposes.ts::PURPOSE_RULES` together with the server's
  `backend/app/files/purposes.py::PURPOSES`. Nothing links them; `files.test.tsx` has the per-type limit tests.
- **Another control in `FileUpload` that disables or removes itself:** set `refocus` before the status change and add
  its target to the effect's chain. The "focus stays in the widget" tests show the pattern.
- **A different expiry input** (separate date and time fields, a library picker): keep `toInstant` / `toLocalInput`
  as the only conversion; `expiry.test.ts` covers DST.

## 9. Must explain, then quiz

The ticket lists no "Must explain" questions.

1. Why does the editor compare `expiry` with `toLocalInput(saved.expires_at, timeZone)` rather than comparing
   `toInstant(expiry)` with `saved.expires_at`?
2. A manager types "12" into an empty Expires field in Chromium and then presses Publish. Walk through what stops it.
3. Why does `toInstant` look at the zone's offset a day before and a day after the wall time, and what does it return
   for 2026-03-08 02:30 in Toronto?
4. What would break if we removed `cancelFocused` from `FileUpload` but kept `refocus`?
5. How would you extend the editor to allow up to three attachments?

<details><summary>Answers</summary>

1. The input holds building-time text, so comparing text with text makes "typed the saved time back" no change
   without a round trip. The two instant strings differ in form anyway (`…00.000Z` from `toISOString` vs the server's
   `…00Z`), so comparing instants would see a change that isn't one. (Established by the code; the "test" is "the
   saved expiry typed again… sends nothing".)
2. Chromium sends no input event (the value stays `''`), but the key-up runs `syncExpiry`, which reads
   `validity.badInput === true` and sets `expiryBad`. `pending` becomes true, so `dirty` is true and `canPublish` is
   false: Publish isn't rendered. Save is refused with "Enter a date and time." (`problems.expires_at`), and Escape
   doesn't close the dialog. Test: "on a draft with no expiry counts as unsaved…"; Chromium: `F2 neighbour`.
3. A wall time's offset is unknown until you know the instant, so `toInstant` tries the offsets in force a day either
   side (at most one change in between) and keeps the candidates where the zone's clock shows that wall time.
   02:30 on 2026-03-08 doesn't exist in Toronto, so neither candidate is right, and it returns the "before" candidate
   (EST offset): `2026-03-08T07:30:00.000Z`, which is 03:30 EDT, the gap's length later.
4. An upload that finishes or fails on its own while Cancel has focus would remove Cancel and leave focus on `<body>`.
   `refocus` is only set by a user action (choose, Cancel, Retry), not by the upload ending. The test "an upload that
   finishes with Cancel focused → Choose file" would fail.
5. That is outside this ticket and needs the API first: `NoticeCreate` has one `attachment_file_id`, and the server's
   claim and `can_view` hook assume one. On the client, `kept`/`upload` would become a list keyed by `file_id`, each
   with its own `FileUpload` key and Remove; `changes` would send the list when it differs; `pending` would be any
   upload `uploading` or `error`; and criterion 11 would need an element per entry or one group for the list.

</details>
