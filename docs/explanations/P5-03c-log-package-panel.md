# Explanation — P5-03c Log package panel

> **PR:** #118 · **Source revision:** `3e44dc54d61c38e7770d072a57de6bc255295df3`, the pre-merge PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (2) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 118 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read `git diff origin/main...3e44dc5` (all nine paths), the whole of
> `frontend/src/features/packages/LogPackageForm.tsx`, the changed hooks in `api.ts`, `FileUpload.tsx` and
> `UnitPicker.tsx`, and the assertions of every test cited below; ran
> `npx vitest run src/features/packages src/features/files`: `Tests 123 passed (123)` (stderr holds only React
> Router's future-flag warnings, as in every `renderApp` test). Differences from the plan: see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: B.

## 1. What was built and why

The package desk (`/security/packages`) now has a "Log package" panel above the "Waiting" list: unit,
recipient, carrier (a quick-pick of six carriers plus "Other"), description, last 4 of tracking and a photo.
The desk works on a tablet on flaky Wi-Fi, so the important part is the **`Idempotency-Key`**: a header the
backend (P5-02a) uses to recognise a repeated request. The form makes one key per form and sends it on every
retry of that form, so a lost response followed by a retry gives back the first package instead of logging a
second one. After a 201 the form clears, says "Logged ✓", focuses the unit search for the next package, and
every packages query is fetched again. No API changed; this is a frontend ticket.

## 2. Decisions

### D1. When the Idempotency-Key changes

- **Problem or constraint:** a retry must never log a package twice (ticket "Why"). But the backend answers
  409 `idempotency_key_reused` when a known key arrives with a different body
  (`backend/app/packages/service.py::_replay`).
- **Chosen:** one key per form. It is made when the form mounts and after each success, and kept across
  every failure: a network error, a 5xx, a 4xx refusal, and edits made after a failure. If the server answers
  409 `idempotency_key_reused`, the first attempt *was* logged with the earlier details: the form says so,
  "Waiting" is fetched again, and a new form with a new key starts (`LogPackageForm.tsx::failed`).
- **Alternatives rejected:** a new key per click (a retry after a lost response logs twice); a new key
  whenever a field changes after a failure (if the lost attempt committed, the edited retry logs a second
  package without anyone noticing).
- **Tradeoffs and accepted limitations:** after a 409 the earlier package keeps the details it was first sent
  with. There is no edit endpoint, so the desk has to deal with it by hand.
- **Basis:** ticket "Carried from P5-02a"; `create_package` looks the key up before anything else. The 409
  handling is **autonomous**.
- **Source:** recorded (PR #118 D1; ticket Frame notes).

Keeping the key across a 4xx is safe. Nothing was written under it, so `create_package` finds no package for
the key and logs the corrected body as a new request (Frame notes: "nothing was written under it").

### D2. The photo is optional, but never silently dropped

- **Problem or constraint:** `PackageCreate.photo_file_id` is optional, and a desk on flaky Wi-Fi must still
  be able to log. Submitting while an upload runs would log the package without the photo the user sees.
- **Chosen:** the photo is optional. Submit is refused while it uploads ("Wait for the photo to finish
  uploading.") or after it failed ("The photo didn't upload. Retry it or remove it."), and a "Remove photo"
  button clears it. `FileUpload` reports its status through a new optional `onStatusChange` prop. The form
  keeps a `file_id` only while that status is `ready`.
- **Alternatives rejected:** a required photo (blocks logging when uploads fail); submitting without the
  photo (silent loss); reading `useUpload` directly in the form (duplicates `FileUpload`).
- **Tradeoffs and accepted limitations:** one new optional prop on a shared component, plus a second one
  (`disabled`) after review round 1 (§6).
- **Basis:** API contract (`backend/app/packages/schemas.py::PackageCreate`); **autonomous**.
- **Source:** recorded (PR #118 D2).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| The unit field is the residents `UnitPicker` (search plus radios), labelled "Unit" | A new ARIA combobox | One unit search in the app; P5-03b D1 reused it | Convention (P5-03b D1) | PR #118 table |
| Carrier quick-pick as radio buttons plus "Other" | A select | One tap on a tablet; radios work from the keyboard natively | Ticket ("quick-pick") | PR #118 table |
| Invalidate `packagesKey` when the request settles, whatever the outcome | Insert the new row into the cache | The list is filtered and paged on the server, and a lost response may still have committed | Ticket ("Invalidation"); residents `refresh` pattern | PR #118 table |
| Any change of unit resets the recipient to "Anyone in the unit" | Keep the previous recipient | An occupant of another unit is a 422; and see §6 F2 | API (`invalid_recipient`); review round 1 | PR #118 table, review log |
| `UnitPicker` gets an optional `label` | Scoping P5-03b's tests only | Two identically named "Unit number" fields on one page are ambiguous for screen readers and tests | Inferred: the PR's Plan lists the risk "two unit searches on one page (labels must differ)" | PR #118 Plan |

**Framing changes:** criteria 1–3 sharpened (what "appear" and "logical order" mean, and when the key
changes); criteria 4–7 added: client checks and double submit, an edit between a failure and its retry (the
case the ticket missed), per-field server refusals, and the building switch. Nothing loosened.

**Plan versus final code:** two differences, both from review round 1.
- `FileUpload` also gained a `disabled` prop, and the form disables "Remove photo" while submitting (F1).
  The plan only listed `onStatusChange`.
- The recipient is now one membership id, cleared whenever the chosen unit changes, instead of a
  `{unitId, membershipId}` pair checked against the current unit (F2).
- `FileUpload`'s root also wraps long words (F3).

Everything else (files, hooks, keys, the criterion → test map) is as planned.

## 3. How it is implemented

### Overview

- `frontend/src/features/packages/LogPackageForm.tsx::LogPackageForm` holds the form state, the key, the
  client checks and the mapping from error codes to fields.
- `frontend/src/features/packages/api.ts::useUnitOccupants` reads the recipients, and
  `frontend/src/features/packages/api.ts::useLogPackage` sends the create with the key and refreshes the
  packages queries.
- `frontend/src/features/files/FileUpload.tsx::FileUpload` uploads the photo and now reports its status
  and can be locked.
- `frontend/src/features/packages/pages/SecurityPackagesPage.tsx::SecurityPackagesPage` renders the panel
  above the list, both inside the existing `key={buildingId}` wrapper.

### Walkthrough (variant B: logging one package)

1. **The user action.** On `/security/packages` the desk types into "Unit" and picks a unit radio. They
   then pick a recipient (default "Anyone in the unit") and a carrier, optionally fill in the description,
   tracking and photo, and press "Log package". The panel is a `<form>` named by its heading, so it reads as
   the "Log package" form.
2. **Form and validation.** There is no zod schema. `LogPackageForm` computes `problems` on every render:
   - no unit;
   - no carrier, or "Other" left blank;
   - control characters or lone surrogates (`INVISIBLE`) in the typed carrier or the description;
   - tracking not matching `TRACKING` (`^[A-Za-z0-9]{4}$`, the backend's pattern);
   - the photo uploading or failed.

   `submit` sets `tried`, so the messages show, and sends nothing while any problem remains. The `maxLength`
   attributes (50, 200, 4) mirror the column limits. Only the server checks whether the unit, the recipient
   and the photo are still valid.
3. **Hook.** `useLogPackage(buildingId).mutate({ key, body })`. While the request is out, `create.isPending`
   (`busy`) disables the submit button, the radios, the select, "Remove photo" and `FileUpload`, and makes
   the text inputs read-only. `submit` also returns early if `busy`.
4. **API call.** `api.post('/api/buildings/{building_id}/packages', { params: { header: { 'idempotency-key': key } }, body })`,
   operation `packages_create`.
5. **Response handling** (`failed`):
   - a 201, fresh or replayed, runs `startAgain()` (new key, everything cleared, unit search focused) and
     shows "Logged ✓";
   - 409 `idempotency_key_reused` starts a new form, as in D1;
   - 404 `unit_not_found` / 409 `unit_inactive` call `picker.unitGone()`, which refetches the units, and
     show the unit message;
   - 422 `invalid_recipient` clears the recipient and refetches the occupants;
   - the file codes (`file_not_found`, `invalid_file`, `upload_incomplete`) remove the photo;
   - a 429 shows the wait; any other 422 shows "Check the details and try again."; everything else shows
     "Could not log the package. Your details are kept; try again."

   In every non-success case except the 409 reuse, the key and the other fields stay. A
   `building_not_found` is handled by the app-wide denial, because the mutation key starts with
   `['b', buildingId, …]`.
6. **Cache.** `onSettled` cancels, then invalidates, everything under `['b', buildingId, 'packages']`. That
   covers the waiting list and any later summary key. It runs on errors too, because a request the browser
   saw fail may have committed.
7. **States.**
   - The occupants select is disabled until a unit is chosen, and shows its own retry if the occupants fail
     to load.
   - "Logged ✓" sits in a `role="status"` region.
   - At 768 px the panel is two columns; at 375 px it is one. The stack transcript in PR #118 shows neither
     width scrolls horizontally.

### Data model changes

None.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `frontend/src/features/packages/LogPackageForm.tsx` | New: the form | +292 |
| `frontend/src/features/packages/api.ts` | `useUnitOccupants`, `useLogPackage`, `NewPackage` | +42 −1 |
| `frontend/src/features/files/FileUpload.tsx` | `onStatusChange`, `disabled`, wrapping | +16 −7 |
| `frontend/src/features/packages/pages/SecurityPackagesPage.tsx` | Renders the panel | +11 −4 |
| `frontend/src/features/residents/UnitPicker.tsx` | Optional `label` | +4 −2 |
| `frontend/src/features/packages/logPackage.test.tsx` | New: 28 tests | +670 |
| `frontend/src/features/packages/packages.test.tsx` | Five radio lookups scoped to the filter's group | +7 −5 |
| `docs/tickets/P5-03c-log-package-panel.md`, `docs/tickets/README.md` | Frame and status | |

**Key excerpts**

`frontend/src/features/packages/LogPackageForm.tsx::LogPackageForm` (the key and the recipient reset)

```tsx
  const [key, setKey] = useState(newKey);
  const [recipient, setRecipient] = useState<string | null>(null);
  // Any change of unit forgets the recipient, even a return to the unit it was chosen in (R1 F2).
  const [recipientUnit, setRecipientUnit] = useState(picker.chosen);
  if (recipientUnit !== picker.chosen) {
    setRecipientUnit(picker.chosen);
    setRecipient(null);
  }
  // ...
  // A recipient counts only while the unit's list still has them.
  const recipientId = recipient && occupants.data?.some((o) => o.membership_id === recipient) ? recipient : '';
```

- `useState(newKey)` passes the function, so React calls it once, on mount. The key changes only through
  `setKey` in `startAgain`.
- The recipient reset is React's "adjust state while rendering" pattern. When the chosen unit differs from
  the one seen on the last render, the recipient is cleared before anything is shown. Without it, choosing
  Sam in unit A, switching to B and back to A would send Sam again (§6 F2).

`frontend/src/features/packages/LogPackageForm.tsx::submit`

```tsx
  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setTried(true);
    setLogged(false);
    setError(null);
    if (picker.chosen === null || carrierValue === null || Object.values(problems).some(Boolean)) return;
    create.mutate(
      {
        key,
        body: {
          unit_id: picker.chosen,
          recipient_membership_id: recipientId || null,
          carrier: carrierValue,
          description: description.trim() || null,
          tracking_last4: trackingValue || null,
          photo_file_id: photo.fileId,
        },
      },
      {
        // A replayed 201 (`Idempotent-Replayed: true`) is the same package: logged too.
        onSuccess: () => {
          startAgain();
          setLogged(true);
        },
        onError: failed,
      },
    );
  }
```

- `key` is the same value on every attempt until `startAgain` runs. That is the whole idempotency mechanism
  on the client.
- Replacing `key` with `newKey()` here makes 9 tests fail. This mutation was run in the PR (mutation probe).

`frontend/src/features/packages/LogPackageForm.tsx::failed` (the 409 branch)

```tsx
    if (err instanceof ApiError && err.status === 409 && code === 'idempotency_key_reused') {
      startAgain();
      setError({
        field: 'form',
        message: 'Your earlier attempt was logged with the details sent then. Check it in “Waiting”; this form is for the next package.',
      });
    } else if (unitGone(err)) {
```

- This is the only failure that replaces the key. Re-sending under the old key would keep getting 409; a
  silent new key would log a second package. `setError` after `startAgain` works because React batches both
  updates and the last `setError` wins.

`frontend/src/features/packages/LogPackageForm.tsx::onPhotoStatus` and the `FileUpload` side

```tsx
  const onPhotoStatus = useCallback(
    (status: UploadStatus) => setPhoto((current) => ({ status, fileId: status === 'ready' ? current.fileId : null })),
    [],
  );
```

```tsx
  const busy = status === 'uploading';
  const locked = busy || disabled;
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  useEffect(() => onStatusChangeRef.current?.(status), [status]);
```

- `useUpload` calls `onUploaded(fileId)` in its mutation's `onSuccess`, before the status becomes `ready`.
  The form stores the id there, and any later status other than `ready` drops it: a new upload, a failed
  one, or a file the client check refused (which resets the upload to `idle`).
- Without the drop, an uploaded photo followed by a refused file would send the earlier photo, although the
  preview is gone. "never sends a finished photo once a refused file has replaced it" catches that. It was
  added after a mutation probe showed the earlier tests did not.
- The ref follows `useUpload`'s own `onUploadedRef`, so an inline callback can't re-fire the effect.

`frontend/src/features/packages/api.ts::useLogPackage`

```ts
    mutationKey: [...packagesKey(buildingId), 'create'],
    mutationFn: ({ key, body }: { key: string; body: NewPackage }) =>
      api.post('/api/buildings/{building_id}/packages', {
        params: { path: { building_id: buildingId }, header: { 'idempotency-key': key } },
        body,
      }),
    onSettled: () => {
      const filters = { queryKey: packagesKey(buildingId) };
      void queryClient.cancelQueries(filters).then(() => queryClient.invalidateQueries(filters));
    },
```

- Cancelling first means a list fetch already out (it read before the package existed) cannot settle after
  the invalidation and show stale data. The pattern comes from the residents `refresh`.
- The refresh is not returned, so `mutate`'s `onSuccess` does not wait for it.

## 5. Edge cases and tests

All tests are in `frontend/src/features/packages/logPackage.test.tsx` unless named otherwise.

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Lost response, then retry | Same key; the server replays | "sends the same key when a network failure is retried, then a new key for the next package"; stack transcript (`201 Idempotent-Replayed: true`, 1 package) |
| Replayed 201 treated as an error | Any 201 is success | "counts a replayed 201 as logged" |
| Edit between a failure and its retry | Same key, edited body | "keeps the key when the form is edited between a failure and its retry" |
| Key already used for other details | New form, new key, list refreshed | "starts a new form with a new key when the server says the key was used for other details" |
| Double click | One request; button disabled | "sends one request for a double click" |
| Incomplete form | No request; per-field messages | "sends nothing without a unit and a carrier, and says what is missing"; "sends nothing while "Other" is blank or the tracking is not 4 letters or digits" |
| Control characters | No request | "sends nothing with a control character in the carrier or description" (tab and BEL; lone surrogates use the same regex, no test of their own) |
| Submit during or after a failed upload | Refused until it finishes or is removed | "sends nothing while the photo is uploading, nor after it failed, until it is removed" |
| Stale photo id | Dropped on any non-`ready` status | "never sends a finished photo once another upload has started"; "never sends a finished photo once a refused file has replaced it" |
| Photo changed while submitting | `FileUpload` locked; "Remove photo" disabled | "F1: locks the photo while a submission is out…"; "F1: locks "Remove photo" while a submission is out, and sends the photo it had" |
| Recipient from another unit | Cleared on any unit change | "lists the chosen unit's occupants and goes back to "Anyone in the unit" when the unit changes"; both "F2: …" tests |
| Unit gone / recipient gone / photo refused | Field message, fresh list or cleared photo, key kept | the six "the server's refusals (criterion 6)" tests |
| 429 | Shows the wait | "a 429 says how long to wait" |
| Building switch | Page keyed by building: new form, new key | "carries nothing of a half-filled form into the other building" |
| Two unit searches on the page | Different labels; P5-03b tests scoped | `packages.test.tsx` passes unchanged in its assertions |
| Long file names on a phone | `FileUpload` wraps anywhere | No committed test; Codex's Chromium proof (§6 F3) |

Acceptance criteria → tests:
1. "sends every field with the photo, then says "Logged ✓", clears the form, focuses the unit and refetches Waiting", plus the stack transcript (768 and 375 px, "Waiting" without reload).
2. "sends the same key when a network failure is retried…", "counts a replayed 201 as logged", plus the stack transcript.
3. "orders the controls unit, recipient, carrier, description, tracking, photo, submit" (DOM order), plus the Chromium keyboard-only run in the PR.
4. The "the form's checks (criterion 4)" tests.
5. "keeps the key when the form is edited…", "starts a new form with a new key…".
6. The "the server's refusals (criterion 6)" tests.
7. "carries nothing of a half-filled form into the other building".

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings (severity: one line) | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol` (high), the only reviewer by James's instruction | `c09b70b` | MERGE | F1 Medium: a photo chosen during a pending submit is dropped. F2 Medium: a hidden recipient comes back on a return to a unit. F3 Medium: a long file name widens the page | All fixed in `3e44dc5` (tests first in `ee42cd7`) |
| 2 | Codex `gpt-6.1-sol` (high), a new run over the whole diff | `3e44dc5` | MERGE | None | — |

- **F1.** Submit without a photo, then upload one while the create is out: the request had already gone
  with `photo_file_id: null`, and the 201's reset cleared the new photo. Fix: `FileUpload` takes `disabled`
  (button, file input, drop, Retry), the form passes `busy`, and "Remove photo" is disabled. Both "F1: …"
  tests failed before the fix and pass after it.
- **F2.** Unit A + Sam → unit B → unit A: Sam was selected and sent. The old code kept
  `{unitId, membershipId}` and showed it again when the unit matched. Fix: the recipient is cleared on any
  change of unit (the excerpt in §4). Both "F2: …" tests failed before and pass after.
- **F3.** A valid 255-character name without spaces widened the page to 3541 px at 375 px, and 3900 px at
  768 px. Fix: `FileUpload`'s root has `min-w-0 [overflow-wrap:anywhere]`. Evidence: Codex's Chromium proof,
  run by the implementer with the class reverted (`scrollWidth` 3541 / 3900, assertion failed) and with it
  (375 / 768, no overflowing element). The proof was scratch and is not committed.

## 7. Not verified, accepted risks and follow-ups

- **No committed browser test** for the keyboard flow, the widths or long file names. They rest on the PR's
  Playwright transcripts (dev and prod-like) and Codex's proofs. P5-05 adds the packages E2E.
- **The first prod-like journey run timed out** waiting for the browser's file chooser after Enter on
  "Choose photo"; the second run passed unchanged. Not reproduced. Tracked in the PR's follow-ups.
- **Focus drops to `body` during an upload:** `FileUpload` (P3-06) disables its own button while
  uploading. Chromium's Tab then continues from the right place, but a screen reader loses its position.
  Both reviewers noted it as residual. PR follow-ups; to be added to the inbox in the bookkeeping commit.
- **After a 409 `idempotency_key_reused`** the earlier package keeps its first details; there is no edit
  endpoint (D1). Accepted.
- **`crypto.randomUUID()` needs a secure context** (https or localhost). Every deployed stack is one. Tracked
  only here and in the PR.
- **Lone surrogates** are refused by the same `INVISIBLE` regex as control characters, but no test sends
  one.
- **The database-level "exactly one package"** is proven by P5-02a's backend tests and this PR's stack run,
  not by a test in this PR.

## 8. How to change this safely

- **A new field on the create body:** add it to the form state, `problems` (mirror the backend schema's
  limits) and the `body` in `submit`, and to `startAgain`. Remember that the backend hashes the whole body
  (P5-02a D2), so the field becomes part of "the same request". Extend the first test's `toEqual` body.
- **Keep the key's lifecycle:** only `startAgain` may call `setKey`. The 9 key tests fail if a key is
  generated anywhere else.
- **Another `FileUpload` caller** can ignore both new props. A form that submits should pass `disabled` while
  submitting, and should watch `onStatusChange` if it must not submit during an upload.
- **Changing the page:** both unit searches must keep distinct labels. P5-03b's tests find the filter
  through its "Show packages for" group.

## 9. Must explain, then quiz

**1. When exactly is a new `Idempotency-Key` generated, and why not on every click?**
On mount (`useState(newKey)` in `LogPackageForm`), after a 201 (`startAgain`, from `submit`'s `onSuccess`),
and after a 409 `idempotency_key_reused` (`failed`). Never on a click. A click after a failure is a retry of
the same submission: if the first attempt reached the server and only its response was lost, the same key
makes `create_package` find that package and replay it (`Idempotent-Replayed: true`) instead of inserting a
second. A new key per click would turn every lost response into a duplicate package and a duplicate
notification to the resident. The stack transcript shows exactly this case: the first response aborted in
the browser, the retry answered `201 Idempotent-Replayed: true` under the same key, and one package exists.

**2. Why invalidate queries instead of manually inserting the new package into the cache?**
`useLogPackage` invalidates everything under `packagesKey(buildingId)`. "Waiting" is a set of server-side
queries: one per unit/carrier filter, paged by cursor, ordered by the server, `status=received` only. A
hand-inserted row would have to decide which of those queries it belongs to, and where. Inferred: it would
also miss the recipient name and unit label the server adds (`PackageOut`). More importantly, the invalidation
runs on errors too: a request the browser saw fail may have committed, and only asking the server shows
that. Cancelling first stops an older fetch from overwriting the fresh answer.

**Quiz**

1. A desk user submits, the network drops, they change the description and press "Log package" again. What
   key is sent, and what are the two possible server answers?
2. Why does the form keep a `file_id` only while `FileUpload`'s status is `ready`, rather than whatever
   `onUploaded` last reported?
3. Why is the recipient stored as a bare membership id, cleared on unit change, rather than a
   `{unitId, membershipId}` pair?
4. What would break if `useLogPackage`'s `onSettled` were changed to `onSuccess`?
5. How would you extend this to keep the last carrier selected for the next package, without weakening the
   idempotency guarantee?

<details><summary>Answers</summary>

1. The same key as the first attempt. If the first attempt never reached the server, there is no package
   under the key, so the edited body is logged as a new package (201). If it was logged, the body hash
   differs, so the answer is 409 `idempotency_key_reused`, and the form starts again, telling the user to
   check "Waiting" (D1; "keeps the key when the form is edited…", "starts a new form with a new key…").
2. A new upload, a failed one, or a file the client check refused all leave the last `onUploaded` id
   behind. Sending it would attach a photo the user no longer sees. The status-based drop is what "never
   sends a finished photo once a refused file has replaced it" proves; it failed when the drop was removed.
3. The pair showed the old recipient again when the user returned to the same unit (review round 1, F2),
   because the check only compared the unit. Clearing on any change matches what the PR promised: a unit
   change resets to "Anyone in the unit".
4. A request that failed in the browser but committed on the server would not refresh "Waiting", so the
   package would stay invisible until the next focus or Refresh. The 409-reuse case would not refresh either,
   though its message tells the user to look in "Waiting".
5. Leave `setCarrier(null)` (and `setOtherCarrier`) out of the reset after a 201 only, so `startAgain` takes a
   flag or a separate success path. The key still changes in `startAgain`. Idempotency depends only on when
   the key changes, not on which fields are pre-filled. Update the first test's "no radio checked"
   assertion, and keep the 409 path clearing everything.

</details>
