# P5-02a — Package create and read

| Field | Value |
|---|---|
| Phase / lane | P5 / A |
| Risk tier | 1 |
| Depends on | P5-01, P3-03, P2-04, P4-01 |
| Replaces old | M7-T02 (create/list part), M7-T05 (summary part) |
| Status | todo |

Split from the original P5-02 (Package API) because 7 endpoints plus the 10-case table were too big for one
PR even without counting tests. Pickup and return are in [P5-02b](./P5-02b-package-pickup-and-return.md).

## Goal

Front-desk staff log packages, idempotently and with a photo. Residents are notified in-app and by email in
the same transaction. Everyone sees exactly the packages they are allowed to see.

## Why

This proves most platform pieces together: tenancy, visibility, files, notifications, email jobs, audit and
idempotency. It is the template for every later slice's create and read paths.

## Scope

- In (building router, `require_feature(packages)`):
  - **`POST /packages`** (security, property_management):
    - **`Idempotency-Key` header required** (8–80 chars; missing gives 400 `idempotency_key_required`)
    - body `{unit_id, recipient_membership_id?, carrier, description?, tracking_last4?, photo_file_id?}`
    - `request_hash = sha256(canonical JSON body)`
    - insert with `ON CONFLICT (building_id, idempotency_key) DO NOTHING RETURNING`. If no row comes back,
      load the existing one: same hash returns **201 with the original body and header
      `Idempotent-Replayed: true`**; a different hash gives 409 `idempotency_key_reused`.
    - validate: the unit is active in this building; the recipient (if given) is a current occupant of that
      unit; `claim_file(..., purpose=package_photo)`
    - **in the same transaction:**
      - `notify(kind="package.arrived")` to the named recipient, or else to all current occupants of the unit
        (in-app + email template `package_arrived`), with `link` `/packages/{id}`
      - audit `package.received`
  - **`GET /packages?status=&unit_id=&cursor=`** uses `visible_packages(ctx)`, newest first.
    **`GET /packages/{id}`** returns 404 if not visible.
  - **`GET /packages/summary`** returns `{waiting}` (visible packages with `status=received`), for badges and
    the dashboard.
  - **`GET /units/{id}/occupants`** (security, property_management) returns current occupants
    `{membership_id, full_name, relationship}`, used by the front-desk form (and by P5-02b's pickup form).
  - **Email template `package_arrived`:** carrier, received time in the building timezone, and the
    pickup-desk hours placeholder.
- Out:
  - pickup and return (P5-02b)
  - reminders for packages waiting more than N days (P6/P7 option)
  - retention cleanup (pilot)

## Interfaces

`packages_create`, `packages_list`, `packages_get`, `packages_summary`, `units_occupants`.

## Acceptance criteria

1. **The 10-case table** ([04 §7](../ENGINEERING_PRACTICES.md#7-testing-standards)) holds for every
   endpoint in this ticket:
   - residents get 403 on create and on `units/{id}/occupants`
   - `a_resident2` gets 404 on `a_resident1`'s package
   - building B gets 404 everywhere
   - `a_pending` gets 404
   - a building-B `unit_id` or `photo_file_id` in the body gives 404/422 with no row written
2. **Given** the same `Idempotency-Key` and body twice, **then** one package, one notification set, one
   email-job set, and the second response has `Idempotent-Replayed: true`. The same key with a different
   body gives 409.
3. **Given** a forced exception after the package insert but before commit (monkeypatched `notify`), **then**
   no package, notification, job or audit row persists.
4. **Given** a package for unit 101 with no named recipient, **then** notifications go to current occupants
   only, not to `a_former`.
5. **Given** the `packages` feature is disabled for A, **then** every endpoint in this ticket returns 403
   `feature_disabled`.
6. **Given** `GET /packages/summary` for `a_resident1`, **then** `waiting` equals the count of their visible
   `received` packages.

## Test plan

- `tests/packages/test_api.py` (create, list, get, summary, occupants), `tests/packages/test_idempotency.py`.
- Commands: `make test`, `make gen-api`.

## Likely files

`backend/app/packages/{service,router,schemas}.py`, `backend/app/units/router.py` (occupants),
`backend/app/notifications/kinds.py`, `backend/app/email/templates/en/package_arrived.*`,
`backend/tests/packages/*`.

## Must explain (learning checkpoint)

1. Trace `POST /packages` from HTTP to COMMIT, naming every row written in the one transaction.
2. Explain the idempotency logic, and why "same key, different body" is a 409.
3. Why notify current occupants rather than "everyone ever linked to unit 101"?

## Carried from P1-03 (decide while framing)

From the P1-03 reviews (PR #45). `current_occupants(db, building_id, unit_id)` returns memberships with a
current occupancy **of any membership status**. Keep only active memberships before notifying people or
accepting one as a package recipient or pickup person, and test it with a suspended occupant.

## Carried from P3-03 (do while framing)

From PR #76. The first ticket that calls `notify` (P4-05 or P5-02a, whichever lands first) does both:
- If the use case also enqueues its own deduplicated jobs in the same transaction, take every dedupe key in one
  stable order, as `notify` does for its emails (sorted by user id). Otherwise two concurrent operations can
  deadlock on the jobs table's unique index (Codex review round 2 on P3-03).
- Make `notify`'s text checks (`backend/app/notifications/service.py::_check_text`) refuse what `str.encode()`
  can't encode (lone surrogates), with a test. Today asyncpg raises `DBAPIError` instead of the documented
  `ValueError` (found after P3-03's last review round; unfixed).

## Carried from P5-01 (do while framing)

From PR #109 (explanation `docs/explanations/P5-01-package-schema-state-machine.md` §7):
- Attach the photo in `POST /packages` with `claim_file(db, ctx, photo_file_id, FilePurpose.PACKAGE_PHOTO,
  PACKAGE_ATTACHED_TYPE, package.id)` before the single commit, and set `photo_file_id` on the package: the
  photo hook (`app/packages/photos.py`) grants only when both agree.
- Read packages only through `visible_packages(ctx)` (list, get, summary).
- `Package` has no ORM relationships: flush the package after the rows it names exist (they already do in
  a request), or add relationships if a use case inserts both in one flush.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
