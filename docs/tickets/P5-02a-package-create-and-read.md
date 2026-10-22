# P5-02a — Package create and read

| Field | Value |
|---|---|
| Phase / lane | P5 / A |
| Risk tier | 1 |
| Depends on | P5-01, P3-03, P2-04, P4-01 |
| Replaces old | M7-T02 (create/list part), M7-T05 (summary part) |
| Status | in progress |

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

Added or sharpened in framing (step 1):

1a. The 10-case table, per endpoint, with these exact answers: unauthenticated 401 `not_authenticated`;
    `b_manager`, `b_resident1`, `a_pending` and `a_suspended` get 404 `building_not_found`; on create and
    occupants every resident (`a_resident1`, `a_council`) gets 403 `forbidden_role`, and security and
    property management succeed; list, get and summary are open to every active member, filtered by
    `visible_packages(ctx)` (council alone sees none). `a_resident2` and `a_former` (for a package received
    after `T1`) get 404 `package_not_found` on `a_resident1`'s package, the same body as a random id.
1b. Related IDs in the create body, each with **no package, notification, job or audit row written**:
    a building-B or unknown `unit_id` gives 404 `unit_not_found`; an inactive unit of A gives 409
    `unit_inactive`; a `recipient_membership_id` that is unknown, of building B, not a current occupant of
    the unit, or not an active membership (`a_suspended` in 201) gives 422 `invalid_recipient`; a
    building-B or unknown `photo_file_id` gives 404 `file_not_found`, and a photo already attached to
    another package gives 422 `invalid_file` (`claim_file`'s answers).
2a. Idempotency, precisely: the key is 8–80 visible ASCII characters (`!`–`~`); missing gives 400
    `idempotency_key_required`, any other value 400 `invalid_idempotency_key`. The hash is of the
    **validated** body (strings stripped, omitted optionals as null, keys sorted), so `{"carrier": " UPS"}`
    and `{"carrier": "UPS", "description": null}` are the same request. A replay returns 201, the same
    package id and the package's current fields, with `Idempotent-Replayed: true`, and writes nothing
    (no notification, job, audit row or second photo claim), even if the unit was deactivated since.
    The first response has no `Idempotent-Replayed` header. The same key in building B is a different
    request.
2b. Concurrency (row 10): two concurrent creates with one key and body give one package, one 201 and one
    replay; with one key and two bodies, one 201 and one 409 `idempotency_key_reused`. Never a 500.
4a. With no named recipient, a suspended current occupant (`a_suspended` in 201) gets no notification and
    no email (the P1-03 carry); a named recipient gets the only notification.
7. The `package.arrived` notification links `/packages/{id}`, has `entity_type` `package`, and its email
   uses the `package_arrived` template with the carrier, the received time in the building's timezone
   and the pickup-desk hours placeholder.
8. Audit `package.received` names the package, the actor and the building, with IDs only in its metadata.
9. `GET /packages` filters by `status` and `unit_id` (a building-B `unit_id` gives an empty page, not
   another building's packages), pages with `cursor`, newest first; an unknown `status` gives 422.
10. `GET /units/{id}/occupants` lists current occupants with an **active** membership, earliest start
    first; a building-B or unknown unit gives 404 `unit_not_found`.
11. Input that Postgres would refuse never reaches it: control characters (NUL, newline) in `carrier` or
    `description` give 422; `tracking_last4` is exactly 4 ASCII letters or digits; over-long strings 422.

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

- Criteria added or sharpened: 1a (exact answers per persona and endpoint, including `a_former`), 1b (each
  related ID's answer, and inactive units and suspended recipients), 2a (key format, what the hash covers,
  what a replay writes), 2b (row 10, concurrency), 4a (suspended occupant, the P1-03 carry), 7 (the
  notification's link and template), 8 (audit), 9 (list filters), 10 (occupants), 11 (input Postgres
  refuses). Missed cases added: a photo already attached to another package, a replay after the unit was
  deactivated, the same key in another building, `a_former` on a package after `T1`.
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - "The original body" of a replay is the same package as it is now (its id and the fields sent never
    change; P5-02b may move its status), not a stored copy of the first response: storing responses would
    need a column, and the fields a client sent are immutable. Autonomous.
  - The hash covers the validated body, not the raw bytes, so whitespace and key order don't make a retry a
    409. Autonomous; criterion 2a.
  - The replay check runs first, before the unit, recipient and photo checks, so a retry after the unit was
    deactivated or the photo attached still returns the original (as P4-05a's join retry). The insert keeps
    `ON CONFLICT DO NOTHING` for the race between two first requests. Ticket + convention.
  - An inactive unit is a 409 `unit_inactive`, not a 404: staff already see inactive units in the units
    list, and P4-05b's approval uses the same code. Convention.
  - One 422 `invalid_recipient` for every refused recipient (unknown, building B, not an occupant, not
    active), so building B's IDs are indistinguishable from unknown ones (ADR-0004). Autonomous.
  - The occupants endpoint is gated by the `packages` feature too (criterion 5 says every endpoint) and
    lists only active memberships, so the form never offers a recipient create refuses. Ticket + P1-03 carry.
  - "Newest first" is id order (uuid7, as every list here, `app.core.pagination`); for packages created
    through the API it is received order. Seeded or backfilled `received_at` values may sort differently.
    Convention.
  - P3-03 carry: `_check_text` already refuses lone surrogates (tested in
    `tests/notifications/test_notify.py`), and this use case queues no jobs of its own beside `notify`'s,
    whose dedupe keys are taken in user-id order: nothing further to do. Checked in the code.
- Split: none. Estimate about 380 non-test lines (schemas ~70, service ~190, routers ~70, occupants ~40,
  template and kind ~30); no migration (P5-01 made the table).
