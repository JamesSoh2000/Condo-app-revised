# Explanation — P6-04b Maintenance submit form and the emergency text

> **PR:** #155 · **Source revision:** `c82b876` (pre-merge), the PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (3) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 155 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `c82b876` the diff (`git diff origin/main...HEAD`, 16 paths), the whole of
> `SubmitRequestForm.tsx`, `frontend/src/features/maintenance/pages/MyMaintenancePage.tsx`, `EmergencyNotice.tsx`, `useFocusedRetry.ts`, the `api.ts`,
> `MyMaintenanceList.tsx` and `MyPackageList.tsx` patches, the test names and assertions in `submit.test.tsx` and the
> new `myPackages.test.tsx` block, and the PR body (plan, decisions, rounds 1–3); ran
> `npx vitest run src/features/maintenance/ src/features/packages/myPackages.test.tsx`: `Test Files 3 passed, Tests
> 129 passed`. Differences from the plan: photos and cancel were split out (§2 "Plan versus final code").
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: B (UI interaction).

## 1. What was built and why

A resident can now file a maintenance request from `/maintenance`: a "New request" button opens a panel with the
location (their current unit, from `/me`, or a common area they name), a category and a description. Choosing
`emergency` shows a fixed text saying the request alerts no one and to call. After the 201 the text repeats with
the building's emergency phone from the response, and stays until its own Dismiss. The legacy Base44
Maintenance page is deleted. A focus fix from P6-04a's review now covers the packages list too.

The ticket also asked for photos and cancel. The full version measured ~750 non-test lines against the ~400 limit,
so those two moved to [P6-04f](../tickets/P6-04f-maintenance-photos.md) and
[P6-04e](../tickets/P6-04e-maintenance-cancel-ui.md). The decisions that matter most are one `Idempotency-Key` per
opened form (D2), and that the emergency text promises nothing and only links a phone that is plainly a number (D3).

## 2. Decisions

### D1. The form is an inline panel opened by "New request", not a dialog

- **Problem or constraint:** the ticket left panel or dialog open; the form holds a 2,000-character description and
  had to fit 375 px (and, before the split, five file controls).
- **Chosen:** an inline panel above the list (as the desk's `LogPackageForm`), shown in place of the "New request"
  button; Close and a 201 hide it.
- **Alternatives rejected:** a `Modal` dialog: a focus trap and an inner scroll around a long form on a phone.
- **Tradeoffs and accepted limitations:** the list stays below the form and can shift when it refreshes; nothing in
  the list holds focus then.
- **Basis:** ticket open decision; existing convention; autonomous. **Source:** recorded (PR #155 D1).

### D2. One `Idempotency-Key` per opened form; `idempotency_key_reused` keeps the values and takes a new key

- **Problem or constraint:** criterion 2: a retry after a network failure must send the same key and body, so a
  201 lost on the way can't become a second request. P6-03b answers 409 `idempotency_key_reused` when a key's first
  attempt landed with other details.
- **Chosen:** `crypto.randomUUID()` when the form mounts (`useState(newKey)`), sent on every attempt of that form.
  On `idempotency_key_reused` the form says the earlier attempt was submitted with the details sent then, keeps what
  was typed and takes a new key; the list is refreshed by the create's `onSettled`.
- **Alternatives rejected:** a key per press (a lost 201 then duplicates on retry); clearing the form on that 409, as
  `LogPackageForm` does (the desk form is for the next package; here the resident likely edited after a network
  failure and may still want the edit).
- **Tradeoffs and accepted limitations:** after that message a second press files a second request; the message
  says to check the list first.
- **Basis:** ticket criterion 2; P6-03b's documented 409; autonomous. **Source:** recorded (PR D2).

### D3. The emergency text promises nothing; the phone shows only after the 201, linked only when plainly a number

- **Problem or constraint:** criterion 6 and P6-03b criterion 7: filing alerts no one, so the app must say to call and
  never imply anyone was told. The API returns `emergency_phone` only on the emergency request it created; the phone
  is free text up to 32 printable characters (P6-03e).
- **Chosen:** before submit, a fixed text without a phone. After the 201, the same promise with the phone, or "call
  the emergency services and building staff directly" when it is null. A `tel:` link only when the phone is digits
  with an optional leading `+` and spaces, brackets, dots or dashes; anything else is shown whole as text.
- **Alternatives rejected:** exposing the phone on `BuildingOut` to show it before submit (an API change; the stub's
  default says after the 201). Linking every phone by stripping non-digits: round 1 F1 showed `;ext=123` becoming
  part of the number dialled.
- **Tradeoffs and accepted limitations:** a phone with an extension is not tappable; the resident reads and dials it.
- **Basis:** ticket default; review round 1 F1. **Source:** recorded (PR D3, round 1).

### D4. The emergency outcome has its own state, cleared only by its own Dismiss

- **Problem or constraint:** criterion 6 says the text with the phone "stays on screen until dismissed". Round 1 F2:
  pressing New request removed it.
- **Chosen:** `emergency` and `submitted` are separate states in `frontend/src/features/maintenance/pages/MyMaintenancePage.tsx::Maintenance`.
  An ordinary outcome goes when the next form opens; the emergency one is shown above the form and goes only with its
  Dismiss.
- **Alternatives rejected:** none recorded beyond the original single outcome that F2 replaced.
- **Basis:** review round 1 F2. **Source:** recorded.

### D5. The packages list's "Try again" shares one focus hook with the maintenance list

- **Problem or constraint:** carried from P6-04a review round 1 F1: a failed first page's "Try again" is removed
  while its refetch runs, dropping focus to `<body>`; `MyPackageList` had the same drop.
- **Chosen:** P6-04a's code moved unchanged into `frontend/src/features/lists/useFocusedRetry.ts::useFocusedRetry`
  next to `useLoadMore`, used by both lists.
- **Alternatives rejected:** a second copy in `MyPackageList` (Inferred: two copies of the same focus rule drift).
- **Basis:** ticket "Carried from P6-04a". **Source:** recorded (ticket, Frame notes).

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Category as a `<select>`, `CATEGORY_LABEL` order | radio chips | 8 chips wrap tall at 375 px | autonomous | PR |
| Unit pre-selected when the resident has one | no default | most requests are for the unit | autonomous | PR |
| No draft across reload | `sessionStorage` | ticket default | ticket | PR |
| A unit refusal (`unit_not_occupied`, `unit_not_found`, `unit_inactive`, `occupancy_changed`) asks `/me` again | leave `/me` | the unit choice comes from `/me` | autonomous | PR |
| Counter in code points after the strip | `value.length` | the server counts `len()` of the stripped string | ticket | PR |
| `maxLength` twice the limit in UTF-16 units | the limit itself | 2,000 emoji are 4,000 units | convention (`ReasonField`) | PR |
| A refused submit focuses the first invalid field | a summary | the submit stays enabled, focus is never lost | autonomous | PR |
| Review by a fresh Codex `gpt-6.1-sol` (high) per round, no Claude reviewer | playbook's Tier 2 Claude reviewer | James's in-session instruction | James | PR |

**Framing changes:** sharpened criteria 1, 2, 4, 5, 7, 8 (exact messages, focus targets, the error codes P6-03b
returns, the client checks mirroring `MaintenanceRequestCreate`); added the shared retry. Then, while building, the
split moved criteria 3 and 7 and the photo or dialog parts of 1, 4, 8 and 9 to P6-04f and P6-04e. Each is marked
"moved" in the ticket and stated in full in its new ticket. None is loosened.

**Plan versus final code:** the PR's Plan named `PhotoList.tsx`, `CancelDialog.tsx`, `useCancelMaintenance` and a
card button; none is in this PR (the split, noted in the PR below the Plan). An unreviewed draft of them is on the
local branch `p6-04-photos-cancel-draft` (`71e043c`). Review rounds added D3's link rule, D4 and two focus fixes (§6).

## 3. How it is implemented

### Overview

- `frontend/src/features/maintenance/pages/MyMaintenancePage.tsx::Maintenance` owns the page state: `formOpen`, the last ordinary outcome
  (`submitted`), the emergency outcome (`emergency`), and focus after each closes. It is keyed by building
  (`MyMaintenancePage`).
- `frontend/src/features/maintenance/SubmitRequestForm.tsx::SubmitRequestForm` owns the fields, the key, the checks, the request and the messages.
- `frontend/src/features/maintenance/api.ts::useCreateMaintenance` sends the POST with the key header, and refreshes every maintenance query of the
  building afterwards (cancel, then invalidate).
- `frontend/src/features/maintenance/EmergencyNotice.tsx::EmergencyNotice` is the only place the safety text is worded.

### Walkthrough (variant B): a resident files a unit request

1. "New request" (`frontend/src/features/maintenance/pages/MyMaintenancePage.tsx::openForm`) clears the last ordinary outcome and renders the form in the button's
   place. The form's mount effect focuses its first `input, select`: the "My unit" radio, or the common-area field
   when the resident has no unit.
2. The location comes from `/me`: `useBuildingContext().active` holds the memberships, and the one for this building
   gives `occupancy` (unit id, tower, label). With none, the form shows a sentence and the common-area field only.
3. The resident picks a category (the emergency text appears for `emergency`) and types a description; the counter
   shows code points of the stripped text.
4. Submit (`frontend/src/features/maintenance/SubmitRequestForm.tsx::submit`): returns at once if `inFlight` is set. It shows every problem and focuses the
   first invalid field if any. Otherwise it builds the body (`unit_id` from the occupancy, or the trimmed
   `common_area`), sets `inFlight`, disables the controls, and moves focus to the status line ("Sending…"), which
   stays mounted.
5. `create.mutateAsync({ key, body })` sends `POST …/maintenance-requests` with `Idempotency-Key`. The server checks
   the unit again under a lock (P6-03b `_check_unit`: the caller must live there now).
6. On 201 `onSubmitted` closes the form. An emergency request sets `emergency` (its effect focuses the emergency
   box); any other sets `submitted` (its effect focuses "Your request was submitted."). The mutation's `onSettled`
   cancels and invalidates the list, so the new request shows first.
7. On a refusal `failed` turns the code into a message on the location, a field or the form; an effect focuses that
   alert. The typed values stay, `inFlight` is released, and the next press reuses the same key.

### Data model changes

None.

## 4. The code

| File | Change | Lines (+/−) |
|---|---|---|
| `frontend/src/features/maintenance/SubmitRequestForm.tsx` | new: the form | +279 |
| `frontend/src/features/maintenance/pages/MyMaintenancePage.tsx` | panel, outcomes, focus | +96 / −9 |
| `frontend/src/features/maintenance/EmergencyNotice.tsx` | new: the safety text and phone | +40 |
| `frontend/src/features/maintenance/api.ts` | `useCreateMaintenance`, `refresh` | +28 / −1 |
| `frontend/src/features/lists/useFocusedRetry.ts` | new: shared "Try again" focus | +34 |
| `frontend/src/features/maintenance/MyMaintenanceList.tsx` | uses the hook | +2 / −24 |
| `frontend/src/features/packages/MyPackageList.tsx` | uses the hook | +5 / −2 |
| the legacy Base44 Maintenance page, `frontend/base44-baseline.txt` | page deleted; ratchet 225 → 220 | −270, ±1 |
| `frontend/src/features/maintenance/submit.test.tsx`, `frontend/src/test/maintenance.ts`, `myPackages.test.tsx` | tests | +726 |
| `docs/tickets/` | frame, split, P6-04e, P6-04f | +226 / −20 |

`frontend/src/features/maintenance/SubmitRequestForm.tsx::submit`: one request per press, focus held while it runs.

```tsx
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    setTried(true);
    setError(null);
    const first = (Object.keys(problems) as (keyof typeof problems)[]).find((field) => problems[field]);
    if (first) {
      formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
      return;
    }
    // ...
    inFlight.current = true;
    setBusy(true);
    // The submit is about to be disabled, which drops focus to <body> in a browser: the status line, which stays,
    // holds it until the outcome or a message takes it.
    statusRef.current?.focus();
    let made;
    try {
      made = await create.mutateAsync({ key, body });
    } catch (err) {
      inFlight.current = false;
      if (!mounted.current) return;
      setBusy(false);
      failed(err);
      return;
    }
    if (mounted.current) onSubmitted(made);
  }
```

The ref is read before anything renders: two presses in one tick both find the button enabled (React hasn't
re-rendered), and only the ref stops the second. Without it, `a double press sends one create` and `Enter in the
common-area field then a press sends one create` fail (mutation probe in the PR). `key` is state made once per
mount, so every retry of this form sends the same header.

`frontend/src/features/maintenance/SubmitRequestForm.tsx::failed`: each refusal to a place and a message.

```tsx
    if (code === 'idempotency_key_reused') {
      // The key's first attempt was filed with what was sent then; the list is refreshed (`useCreateMaintenance`).
      setKey(newKey());
      setError({ field: 'form', message: 'An earlier attempt of this form was already submitted with the details sent then. Check your list below before sending again.' });
    } else if (code !== null && (UNIT_GONE_CODES.includes(code) || code === 'occupancy_changed')) {
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      // ...
      setError({ field: 'location', message });
    } else {
      const placed = serverFieldErrors(err, ['common_area', 'category', 'description'] as const, {
        common_area: textMessages(COMMON_AREA_MAX, NO_COMMON_AREA),
        description: textMessages(DESCRIPTION_MAX, NO_DESCRIPTION),
      });
      if (placed) return setError(placed[0]);
      const message = rateLimitMessage(err) ?? (err instanceof ApiError && err.status === 422 ? 'Check the details and try again.' : FAILED);
      setError({ field: 'form', message });
    }
```

`frontend/src/features/maintenance/SubmitRequestForm.tsx::SubmitRequestForm`: keeping focus when `/me` removes
the radios (round 1 F3).

```tsx
  const focusCommonArea = useRef(false);
  const [hadUnit, setHadUnit] = useState(occupancy !== null);
  if (hadUnit !== (occupancy !== null)) {
    setHadUnit(occupancy !== null);
    if (occupancy === null && locationRef.current?.contains(document.activeElement)) focusCommonArea.current = true;
  }
```

The render that first sees the occupancy gone runs before React removes the radios, so it can still tell whether
focus is in them. An effect on `hadUnit` then focuses the common-area field. Without it, focus falls to `<body>` in
Chromium (Codex reproduced it).

`frontend/src/features/maintenance/EmergencyNotice.tsx::Phone`: a link only for a number.

```tsx
const DIALLABLE = /^\+?[\d\s().-]*\d[\d\s().-]*$/;

function Phone({ phone }: { phone: string }) {
  if (!DIALLABLE.test(phone.trim())) return <span className="font-semibold">{phone}</span>;
  return (
    <a href={`tel:${phone.replace(/[^+\d]/g, '')}`} className="font-semibold underline">
      {phone}
    </a>
  );
}
```

`frontend/src/features/maintenance/pages/MyMaintenancePage.tsx::dismissEmergency`: focus to something that stays.

```tsx
  function dismissEmergency() {
    setEmergency(null);
    // ...
    const target =
      newRef.current ??
      sectionRef.current?.querySelector<HTMLElement>('form :is(input, select, textarea):not(:disabled), form [role="status"]') ??
      headingRef.current;
    target?.focus();
  }
```

`frontend/src/features/maintenance/api.ts::refresh`: after any create, however it ended.

```ts
function refresh(queryClient: QueryClient, buildingId: string) {
  const filters = { queryKey: maintenanceKey(buildingId) };
  void queryClient.cancelQueries(filters).then(() => queryClient.invalidateQueries(filters));
}
```

Cancelled first so a list request already on its way isn't reused as the refreshed answer (the CLAUDE.md lesson
from P5-04).

## 5. Edge cases and tests

All in `frontend/src/features/maintenance/submit.test.tsx` unless named.

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| A double press / Enter then a press sends two creates | `inFlight` ref | `a double press sends one create`, `Enter in the common-area field then a press sends one create` (both presses in one `act`) |
| A retry after a lost answer duplicates | same key and body | `a retry after a network failure sends the same key and body` |
| A replayed 201 | treated as success | `a replayed 201 is a success` |
| Disabled submit drops focus while sending | status line holds it | `while the create is out, focus is on the status line, not on the disabled submit` (`expectFocusKept`) |
| Each server refusal | a message there, focused, values kept | `errors from the server (criterion 4)` › 9 cases; `unit_not_occupied asks /me again` |
| Key reused with other details | message, new key, values kept | `idempotency_key_reused says the earlier attempt was filed…` |
| Client checks (empty, 2,001 code points, control characters, 121-character area) | hints, first invalid field focused | `the checks before sending` (5 tests; the one named "…and refuses 2,001" proves 2,000 accepted after the strip, the next one proves 2,001 refused) |
| No occupancy | common area only, with a sentence | `no current unit (criterion 5)` |
| Emergency copy before/after, phone or none, no promise | fixed text | `emergency (criterion 6)` (3 tests, exact text and a regex for "notified/alerted/…") |
| A phone with an extension or words | text, no link | `review round 1` › `F1: a phone that is not plainly a number (…)` (4), `F1 neighbour` (3 numbers) |
| The emergency text removed by New request | own state | `F2: the emergency text and phone stay…`, `F2 neighbour` (2) |
| `/me` drops the occupancy with a radio focused | common-area field focused | `F3: losing the occupancy…` (`expectFocusKept`), `F3 neighbour` (2) |
| Emergency Dismiss while the next request sends | first enabled field / status line | `review round 2` › `F1: Dismiss on the emergency text while the next request is sending…` |
| Building switch with the form open | form gone, nothing sent | `switching building (criterion 8)`; passes even without the page's `key` (the switch remounts from above) |
| Packages "Try again" drops focus | `useFocusedRetry` | `myPackages.test.tsx` › `a failed list’s Try again keeps focus…` (3 tests) |
| 375 px with the longest values; 32-character phone | `[overflow-wrap:anywhere]` | no Vitest test (jsdom has no layout); Chromium on the stack in the PR: `scrollWidth 375`, probe 1337 |

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings (severity: one line) | Outcome (fixed in commit / dismissed: why) |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol` (high), fresh | `b89aef0` | BLOCK | High: `tel:` link folded an extension into the number; Medium: New request removed the emergency text; Medium: `/me` losing the occupancy dropped focus | all fixed in `384b091` |
| 2 | Codex `gpt-6.1-sol` (high), fresh | `384b091` | MERGE | Medium: emergency Dismiss focused a disabled radio while sending; Medium: a 32-character unbroken phone widened the page to 528 px | both fixed in `c82b876` |
| 3 | Codex `gpt-6.1-sol` (high), fresh | `c82b876` | MERGE | Medium: occupancy lost then a different unit given while the form is open restores `unit` over a typed common area | not fixed (last round; follow-up, §7) |

- **R1 F1.** Failure: `+1-416-555-0199;ext=123` linked as `tel:+14165550199123`. Evidence: 4 `F1` tests failed at
  `b89aef0`, pass now; a mutation linking every phone fails all 4.
- **R1 F2.** Failure: emergency 201, then New request → text and phone gone without Dismiss. Evidence: the `F2` test
  failed, passes; the mutation "New request clears it" fails it and a neighbour; Chromium: `emergency text still
  shown: true`.
- **R1 F3.** Failure: unit radio focused, `/me` drops the occupancy → `<body>`. Evidence: the `F3` test
  (`expectFocusKept`) failed, passes; Chromium: `focus input "Which common area?"`.
- **R2 F1.** Failure: the old selector `form input` found a disabled radio. Evidence: the round 2 test failed,
  passes; the old selector fails it; Chromium: `focus textarea "Description"`.
- **R2 F2.** Failure: `scrollWidth` 528 at 375 px. Evidence: Chromium after the fix: 375.

## 7. Not verified, accepted risks and follow-ups

- **Round 3 F1 (Medium), unfixed.** If `/me` drops the occupancy, the resident types a common area, and `/me` then
  gives a different unit while the form is open, `chosenLocation` is still `unit`. The radios return with "My unit"
  chosen, the field and its focus go, and a submit files for the new unit. The resident sees the choice before
  sending, and the server files only for a unit they live in. Tracked as P6-04f's first follow-up.
- Criterion 4's 422 placement is tested on `description` only; `common_area` and `category` use the same
  `serverFieldErrors` call but no test sends a 422 on them.
- Criterion 8's test doesn't isolate the page's `key={buildingId}` (it passes without it); a create already sent
  when the building switches is not cancelled, and its answer is dropped.
- The 375 px checks are a scratch Playwright run on the stack (Vite → uvicorn → scratch Postgres 16), not a committed
  test. Firefox and Safari were not run.
- `trim()` also strips U+FEFF, unlike Python's `strip()`: a description of only U+FEFF is refused here though the
  server would take it (stricter, never looser).
- Local backend tests: 20 environment failures (Postgres 16 vs CI's 18, `moto`), the same as on `main`; no backend
  file changed; CI green.
- Photos (P6-04f) and cancel (P6-04e) are not built; their draft is unreviewed.

## 8. How to change this safely

- New error code from the create: add a branch in `frontend/src/features/maintenance/SubmitRequestForm.tsx::failed` and a row in the
  `errors from the server (criterion 4)` table test; the row checks the message, its focus and that values stay.
- Photos (P6-04f): add the `photos` state and `photo_file_ids` to the body in `frontend/src/features/maintenance/SubmitRequestForm.tsx::submit`; keep
  `inFlight` and the status-line focus; the draft branch has `PhotoList.tsx`.
- Any wording change to the emergency text goes in `frontend/src/features/maintenance/EmergencyNotice.tsx::EmergencyNotice` only, and the three exact-
  text tests in `emergency (criterion 6)` must change with it; keep the "no promise" regex test.
- A control that disables or removes itself: move focus first to something that stays, and prove it with
  `expectFocusKept` and a Chromium run.

## 9. Must explain, then quiz

**1. Where does the unit a resident files for come from, and what does the server check again?** From `/me`: the
membership for the selected building (`useBuildingContext().active`) carries `occupancy`, passed to
`SubmitRequestForm`, whose `submit` sends `unit_id: occupancy.unit_id`. The browser offers no other unit. The server
re-checks under a lock that the unit is in the building and active and that the caller lives there now, refusing
with `unit_not_found`, `unit_inactive`, `unit_not_occupied` or `occupancy_changed` (P6-03b). The form shows a
location message and asks `/me` again.

**2. How does the form send exactly one request for a double press, and what makes a retry safe?** The `inFlight`
ref in `frontend/src/features/maintenance/SubmitRequestForm.tsx::submit` is checked and set synchronously, before React re-renders the disabled button,
so a second press in the same tick returns. A retry is safe because the `Idempotency-Key` is made once per form
(`useState(newKey)`) and sent with the same body. If the first attempt landed, the server replays its 201 instead
of writing again; if the body changed, it answers `idempotency_key_reused` (D2).

**3. What does the emergency text promise, and why does it promise nothing more?** That the request alerts no one,
and to call the emergency services or building staff (with the phone when the building has one). Filing a request
records it and tells the managers through the app (`backend/app/maintenance/router.py::create`: "File a request …
and tell the managers"; the emergency phone is returned because "the app alerts no one"). Nothing guarantees anyone
sees it in time, so anything more ("staff have been notified") could delay a real call (P6-03b criterion 7, ticket
"Why").

<details><summary>Quiz (5 questions, answers inside)</summary>

1. *What breaks if `statusRef.current?.focus()` is removed from `submit`?* While the request is out, the focused
   submit is disabled and Chromium drops focus to `<body>`. `while the create is out…` fails.
2. *Why is the key `useState(newKey)` and not made in `submit`?* A key per press would make a retry after a lost 201
   a new request (a duplicate). One per mount keeps every attempt of this form idempotent.
3. *Why read `document.activeElement` during render in the F3 fix, not in an effect?* By the effect the radios are
   gone and focus is already on `<body>`; only the render that sees the change can still tell where focus was.
4. *How would you extend this to show the phone before submit?* Expose `emergency_phone` on the building read (an
   API change: `BuildingOut` or the feature's config), pass it to `EmergencyNotice`, keep the `DIALLABLE` rule, and
   add exact-text tests for the pre-submit copy with and without a phone.
5. *Why does an ordinary outcome go with the next form, and the emergency one not?* Criterion 6 requires the
   emergency guidance to stay until dismissed. The ordinary confirmation is just feedback, and the list shows the
   request anyway (D4).

</details>
