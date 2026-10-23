# P5-03c — Log package panel

| Field | Value |
|---|---|
| Phase / lane | P5 / B |
| Risk tier | 2 |
| Depends on | P5-03b |
| Replaces old | M7-T03 (logging part) |
| Status | in progress |

Split from the original P5-03 (Security packages page) while framing P5-03a. The page and the "Waiting"
list are [P5-03b](./P5-03b-package-desk-page-and-waiting-list.md).

## Goal

Front-desk staff log packages with a photo in under 30 seconds.

## Why

Logging is the desk's most frequent action, on a tablet with flaky Wi-Fi: a retry must never log a package
twice.

## Scope

- In (on `SecurityPackagesPage`):
  - **"Log package" panel:**
    - unit combobox (`units_list` search)
    - recipient select (`units_occupants`; "Anyone in unit" as the default)
    - carrier (a quick-pick of common carriers plus "Other"), description, last 4 of tracking (optional)
    - photo via `FileUpload` (`purpose=package_photo`, `capture="environment"`)
  - **Idempotency:** generate a UUID `Idempotency-Key` when the form opens and reuse it for retries of the
    *same* submission. Reset it after success. Show "Logged ✓" and keep the unit field focused for the next
    package.
  - **Invalidation:** after create, invalidate the package list and summary keys.
  - Layout works at tablet (768 px) and phone (375 px) widths.
- Out:
  - barcode scanning, bulk logging

## Interfaces

Consumes `units_list`, `units_occupants`, `packages_create`, plus the file components.

## Acceptance criteria

1. **Given** a security user on a tablet viewport, **then** they can log a package with a photo and see it
   appear in "Waiting" without a reload. (Original P5-03 criterion 1.) *Sharpened:* after a 201 the form shows
   "Logged ✓" in a polite status region, clears every field and the photo, focuses the unit search, and the
   waiting list refetches (every key under `['b', buildingId, 'packages']` is invalidated, which also covers
   the summary key when one exists). The panel and the list have no horizontal page scroll at 768 px and 375 px.
2. **Given** a network failure on submit followed by a retry, **then** exactly one package exists (same
   `Idempotency-Key`). (Original criterion 2.) *Sharpened:* the key is generated once per form (on mount and
   after each success), sent on every attempt of that form, and replaced only after a 201 (fresh or
   `Idempotent-Replayed: true`) or a 409 `idempotency_key_reused` (criterion 5). A failed attempt keeps every
   field.
3. **Given** keyboard only, **then** the full log-package flow completes. The focus order is logical.
   (Original criterion 4.) *Sharpened:* unit search → unit options → recipient → carrier → "Other" text when
   chosen → description → tracking → photo button → "Log package"; checked in Chromium, not only jsdom.
4. *(Added)* **Given** the form is incomplete (no unit, no carrier, "Other" left blank, tracking not 4
   letters or digits) or the photo is still uploading, **then** no request is sent and the field says why;
   while a submission is out the button is disabled, so a double click sends one request.
5. *(Added, the case the ticket missed)* **Given** a failed submit after which the user edits the form and
   submits again, **then** the same key is sent; if the server answers 409 `idempotency_key_reused` (the
   first attempt was in fact logged with the earlier details), the form says so, refreshes "Waiting" and starts
   a new form with a new key, instead of logging a second package silently.
6. *(Added)* **Given** the server refuses the unit (404 `unit_not_found`, 409 `unit_inactive`), the recipient
   (422 `invalid_recipient`) or the photo (404 `file_not_found`, 422 `invalid_file`, 409 `upload_incomplete`),
   **then** the matching field shows the reason and its options are fetched again (units, occupants) or the
   photo is cleared for a new upload; the other fields and the key are kept. A 429 shows the wait.
7. *(Added, tenant table "switch building")* **Given** the user switches building with the form half filled,
   **then** nothing of it (fields, photo, key) carries into the other building.

## Test plan

- Vitest for the form validation and idempotency-key lifecycle (mock the client).
- Manual on the local stack with devtools device mode; the upload on `make prodlike` too (CSP).
- E2E in P5-05.

## Likely files

`frontend/src/features/packages/{api.ts,components/LogPackageForm.tsx}`, the page.

## Must explain (learning checkpoint)

1. When exactly is a new `Idempotency-Key` generated, and why not on every click?
2. Why invalidate queries instead of manually inserting the new package into the cache?

## Carried from P3-06

- Use `FileUpload` with `purpose="package_photo"`. Send `onUploaded`'s `file_id` to the package endpoint, which
  claims it.
- Run the upload on `make prodlike` too (CSP), as P3-06 did with a harness.
- Accepted in P3-06 round 3 (inbox): `useUpload` keeps a failed attempt's form if the `purpose` prop changes
  before Retry. Keep `purpose` constant here (or key `FileUpload` by purpose).

## Carried from P5-02a

From PR #114 (explanation `docs/explanations/P5-02a-package-create-and-read.md` §7):
- Generate one `Idempotency-Key` per form submission and keep it across retries of that submission (a new
  key per click would log the package twice). A 201 with `Idempotent-Replayed: true` is a success.
- The recipient picker reads `GET /units/{id}/occupants` (active current occupants only).

## Carried from P5-03b

- **First follow-up (step 8):** the pattern "overflow at 375 px with long text" now has three entries in
  `docs/AGENT_MISTAKES_LOG.md` (P4-08a, P4-08c, P5-03b round 1 F1) and was never promoted (P4-08c flagged it for
  P4-08d). Promote it: a `CLAUDE.md` lesson, or better a check, that every new control, fieldset and message is
  measured in Chromium at 375 px with the longest values the API allows (`max_length`), not realistic text.
- The P3-05 fitness test (every component under `src/app` or `src/features` that reads
  `useBuilding({ passive: true })` also calls `useBuildingDenied()`) is still open. P5-03b did not pick it up: as
  worded it fails on `app/AccountMenu.tsx::BuildingChoices`, so it needs either that component changed or an
  exemption with a reason.
- After a create, invalidate `packagesKey(buildingId)` (`features/packages/api.ts`); the waiting list follows.
  `CARRIERS` in the same file is the quick-pick's list. Put the panel inside `SecurityPackagesPage`'s keyed `div`.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: 1–3 sharpened (what "appear" and "logical order" mean; when the key changes);
  4–7 added. Criterion 5 is the case the ticket missed: an edit between a failed attempt and its retry.
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - Unit field: the residents `UnitPicker` (search + radio list), not a new combobox, as P5-03b D1 did for
    the waiting list's filter (basis: convention; one unit search in the app).
  - Photo optional: the API takes none, and a desk on flaky Wi-Fi must still log the package (basis: API
    contract, P5-02a). Submit waits while an upload is in progress (criterion 4).
  - On 409 `idempotency_key_reused`, start a new form rather than re-sending (criterion 5; basis:
    autonomous, the ticket's "never log twice").
  - The key is kept across a 4xx refusal: nothing was written under it, so the corrected body is a new
    request under the same key (basis: `create_package` looks the key up first; P5-02a D2).
- Tenant table (ENGINEERING_PRACTICES §7): the endpoints and their 10 cases are P5-02a's and tested there.
  The page's role guard is P5-03b's. Applies here: "switch building" (criterion 7).
- Size: ~300 non-test lines (form ~230, api hooks ~40, page ~10). No split.
- Split: from P5-03 while framing P5-03a (see P5-03a's Frame notes for the sizing).
