# P5-03c — Log package panel

| Field | Value |
|---|---|
| Phase / lane | P5 / B |
| Risk tier | 2 |
| Depends on | P5-03b |
| Replaces old | M7-T03 (logging part) |
| Status | todo |

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
   appear in "Waiting" without a reload. (Original P5-03 criterion 1.)
2. **Given** a network failure on submit followed by a retry, **then** exactly one package exists (same
   `Idempotency-Key`). (Original criterion 2.)
3. **Given** keyboard only, **then** the full log-package flow completes. The focus order is logical.
   (Original criterion 4.)

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

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split: from P5-03 while framing P5-03a (see P5-03a's Frame notes for the sizing).
