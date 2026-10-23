# Explanation — P5-02a Package create and read

> **PR:** #114 · **Source revision:** `02f726ee81afd6e53f949b2598bf857e9ee90d16` (pre-merge), the PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (1) reviewed this
> commit (`02f726e`).
> **Merge commit:** not known when written; after the merge, `gh pr view 114 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `02f726e` the diff (`git diff origin/main...HEAD`), the whole of
> `backend/app/packages/service.py`, `router.py`, `schemas.py`, the units changes, `kinds.py`, the three
> `package_arrived` templates, and the assertions of the tests cited below; compiled the three non-obvious
> statements to Postgres SQL (§3); ran `pytest tests/packages tests/units/test_occupants.py
> tests/notifications/test_notify.py`: 255 passed. Differences from the plan: two, both noted in the PR below
> the Plan (size, template shape; see §2).
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 1. Walkthrough variant: A.

## 1. What was built and why

The front desk (security, or the property manager) can now log a package with `POST /packages`. The request
must carry an `Idempotency-Key` header, so a desk tablet that retries on a flaky network never logs the same
parcel twice: a retry with the same body gets the same package back (201, `Idempotent-Replayed: true`),
and the same key with a different body is a 409. In the same transaction as the package, its photo is
attached, the recipient (or every active current occupant of the unit) gets an in-app notification and an
email job, and an audit row is written. Everyone reads packages (list, one package, a waiting count) only
through P5-01's `visible_packages(ctx)`. A new `GET /units/{id}/occupants` feeds the desk form's recipient
picker. The decisions that matter most: the replay check runs **before** validation, and the photo is
claimed **after** the insert wins (D1).

## 2. Decisions

### D1. Order of the create use case: replay check first, claim the photo after the insert

- **Problem or constraint:** a retry must return the original even if things changed since (the unit was
  deactivated; the photo is now attached, to this very package), and two concurrent first requests with one
  key must give one package and a replay, never a 422 or a 500.
- **Chosen:** (1) look the key up and answer from the row if there is one; (2) validate the unit and the
  recipient; (3) `INSERT … ON CONFLICT (building_id, idempotency_key) DO NOTHING RETURNING id` with no
  photo, where an empty result means another request won the race; (4) `claim_file`, then set
  `packages.photo_file_id`.
- **Alternatives rejected:** validate everything, then insert (the ticket's listed order): a retry after a
  deactivation would be a 409, and a retry with a photo a 422, because `claim_file` finds the photo
  attached. Claim the photo before the insert with a pre-generated id: the race loser's claim waits on the
  winner's row lock, then finds the file attached and answers 422 instead of the replay. Insert with
  `photo_file_id` set: a building-B file id fails the composite FK as an `IntegrityError` (a 500) before
  `claim_file` can answer 404.
- **Tradeoffs and accepted limitations:** one extra `UPDATE` when a photo is sent; the look-up in (1) is a
  plain read, so the conflict path in (3) is still needed for the race.
- **Basis:** ticket (ON CONFLICT, same-hash replay), P4-05a's join retry (it checks the retry before the
  unit), the P5-01 carry (both the file and the package must name each other).
- **Source:** recorded (PR #114 decision D1).

### D2. What the request hash covers

- **Problem or constraint:** "same key, same body" must not turn a genuine retry into a 409 because the
  client re-serialised its JSON.
- **Chosen:** sha256 of the **validated** `PackageCreate`, dumped as JSON with every field present (omitted
  optionals as `null`), keys sorted and compact separators.
- **Alternatives rejected:** the raw request bytes: key order or spacing would make a retry a 409.
- **Tradeoffs and accepted limitations:** adding a field with a default to `PackageCreate` changes every
  later hash, so a retry that spans such a deploy gets a 409.
- **Basis:** ticket ("canonical JSON body"); autonomous for the exact canonical form.
- **Source:** recorded (PR #114 decision D2; ticket criterion 2a).

### D3. A replay returns the package as it is now

- **Problem or constraint:** the ticket says a replay returns "201 with the original body".
- **Chosen:** the same package rendered from its row now. The fields the client sent never change; only the
  status fields can, once P5-02b adds pickup and return.
- **Alternatives rejected:** store the first response body: a new column for no client benefit.
- **Tradeoffs and accepted limitations:** a replay after a pickup would show `picked_up`.
- **Basis:** autonomous (ticket Frame notes).
- **Source:** recorded (PR #114 decision D3).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| An inactive unit is 409 `unit_inactive` | 404 like an unknown unit | Staff already see inactive units in the units list; P4-05b's approval uses the same code | Convention | Recorded (PR table) |
| Every refused recipient is one 422 `invalid_recipient` | 404 for building B's | Unknown and building-B ids must look alike (ADR-0004); a body id the domain refuses is a 422, like `invalid_file` | ADR-0004 | Recorded |
| Occupants route gated by the `packages` feature, active memberships only | Ungated; any status | Criterion 5 says every endpoint; the picker must not offer someone create refuses (P1-03 carry) | Ticket | Recorded |
| Lists ordered by id (uuid7) | Keyset on `received_at` | `backend/app/core/pagination.py::paginate` pages by id everywhere | Convention | Recorded |
| Key: 8–80 visible ASCII (`!`–`~`) | Any header value | Header values are Latin-1; a control or non-ASCII byte in an id the client repeats is a mistake | Autonomous | Recorded |
| Desk hours: a placeholder line, no building setting | A `buildings` column | No such field exists; the ticket says "placeholder" | Ticket | Recorded |
| The notification title is fixed text | A title with the carrier | Inferred: `notify` caps the title at 200 characters and the subject is the title (see "Plan versus final code"); the carrier goes in the body | Rationale not recorded beyond the code comment | Code comment in `create_package` |

**Framing changes:** criteria 1a (exact answers per persona and endpoint, including `a_former`), 1b (each
related id's answer, inactive units, suspended recipients), 2a (key format, what the hash covers, what a
replay writes), 2b (concurrency, tenant row 10), 4a (suspended occupant, the P1-03 carry), 7 (link and
template), 8 (audit), 9 (list filters), 10 (occupants), 11 (input Postgres refuses). Nothing was loosened.
The P3-03 carry was found already done: `_check_text` refuses lone surrogates, and this use case queues no
jobs besides `notify`'s, whose dedupe keys are taken in user-id order.

**Plan versus final code:** compared the PR's Plan with the code at `02f726e`. Two differences, both
deliberate and noted in the PR below the Plan:
- **Size:** 506 non-test lines added against a ~380 estimate (about 390 of them code without comments,
  docstrings and blank lines). Not split; the PR gives the reasons.
- **Template shape:** the existing gate `backend/tests/notifications/test_notify.py::test_every_kinds_template_renders`
  requires every emailing kind's template to render from `title`, `body` and `link` alone, with the subject
  ending in the title. So `package_arrived` is the generic notification layout plus a carrier, a received
  time and a desk-hours line, each shown when its value is present, and its subject is the title.

## 3. How it is implemented

### Overview

- `backend/app/packages/router.py`: five routes on `building_router(tags=["packages"])`; every route depends
  on `require_feature(Feature.PACKAGES)`, and create also on the desk roles.
- `backend/app/packages/service.py::create_package`: the one write use case; `list_packages`,
  `get_package` and `package_summary` read through `visible_packages(ctx)`.
- `backend/app/units/service.py::list_occupants`: the recipient picker's data.
- `backend/app/notifications/kinds.py`: `package.arrived` now emails with `package_arrived`.
- No table changes: P5-01 created `packages`, its unique `(building_id, idempotency_key)` and the indexes.

### Walkthrough (variant A): `POST /api/buildings/{b}/packages`

1. **HTTP:** `backend/app/packages/router.py::create`. FastAPI validates the body as `PackageCreate` (422
   `validation_error` on any bad field) and reads the `Idempotency-Key` header as an optional string.
2. **Dependencies, in order:** the session (401), `get_tenant_context` (404 `building_not_found` for a
   non-member, a pending or suspended member, or another building), `require_feature` (403
   `feature_disabled`), `require_roles(SECURITY, PROPERTY_MANAGEMENT)` (403 `forbidden_role`).
3. **Service:** `create_package` checks the key's format (`check_idempotency_key`: 400
   `idempotency_key_required` / `invalid_idempotency_key`) and hashes the body (`request_hash`).
4. **Replay look-up:** `_by_key` runs `visible_packages(ctx)` narrowed to the key. For staff it compiles to:

   ```sql
   SELECT packages.* FROM packages
   WHERE packages.building_id = $1 AND packages.idempotency_key = $2
   ```

   If a row comes back, `_replay` compares hashes: equal → `Created(replayed=True)`, nothing written;
   different → 409 `idempotency_key_reused`.
5. **Unit:** a share lock, so a deactivation committing at this moment makes the create wait and then read
   the committed `is_active`:

   ```sql
   SELECT units.label, units.tower, units.is_active FROM units
   WHERE units.id = $1 AND units.building_id = $2 FOR KEY SHARE
   ```

   No row → 404 `unit_not_found`; inactive → 409 `unit_inactive`.
6. **Recipient** (if named): `_recipient_user_id` joins the membership to a current occupancy of this unit,
   in this building, with `status = active`, and returns the user id, or 422 `invalid_recipient`.
7. **Insert:**

   ```sql
   INSERT INTO packages (building_id, unit_id, carrier, status, received_by_membership_id,
                         idempotency_key, request_hash, id, …)
   VALUES (…) ON CONFLICT (building_id, idempotency_key) DO NOTHING RETURNING packages.id
   ```

   If another transaction has inserted the same key and not yet finished, Postgres makes this statement
   wait on the unique index. Once that transaction commits, `DO NOTHING` returns no row, and a second
   `_by_key` (a new statement under READ COMMITTED, so it sees the committed row) answers as in step 4.
   If it rolls back, this insert goes ahead.
8. **Photo:** `claim_file(…, FilePurpose.PACKAGE_PHOTO, "package", package_id)` (404 `file_not_found` for an
   unknown or building-B file, 422 `invalid_file` for one already attached or not ready), then
   `UPDATE packages SET photo_file_id`.
9. **Side effects, same transaction:** `notify(kind="package.arrived")` writes one `notifications` row per
   recipient (one multi-row INSERT) and one `email.send` job per active recipient with a sendable address
   (dedupe key `package.arrived:{package_id}:{user_id}`). The recipients are the named recipient, or else
   `unit_resident_user_ids` (current occupancy and active membership). The email context adds
   `building_name`, `carrier`, `unit` and `received_at`, formatted in the building's time zone. Then
   `record_audit(action="package.received")` adds the audit row.
10. **Commit and response:** one `await db.commit()`; 201 with `PackageOut`. The router sets
    `Idempotent-Replayed: true` only for a replay.

Reads: `list_packages` narrows `visible_packages(ctx)` by `status` and `unit_id` and hands it to
`paginate` (id DESC, cursor). `get_package` is `visible_packages(ctx).where(id)` (404
`package_not_found`). `package_summary` counts `visible_packages(ctx)` with `status = received` in a
subquery.

### Data model changes

None. The create relies on P5-01's `uq_packages_building_id_idempotency_key` for the race, and on its
composite FKs for the related ids.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/packages/service.py` | New: create, list, get, summary, errors, hash | +274 |
| `backend/app/packages/router.py` | New: five routes | +76 |
| `backend/app/packages/schemas.py` | New: `PackageCreate`, `PackageOut`, `PackageSummary` | +64 |
| `backend/app/units/service.py`, `router.py`, `schemas.py` | `list_occupants`, the route, `OccupantOut` | +64 / −4 |
| `backend/app/email/templates/en/package_arrived.*` | New template (subject, text, HTML) | +23 |
| `backend/app/notifications/kinds.py` | `package.arrived` → `package_arrived` | +1 / −1 |
| `backend/app/audit/actions.py`, `backend/app/main.py` | `PACKAGE_RECEIVED`; include the router | +4 |
| `frontend/src/api/schema.d.ts` | Regenerated | +507 |
| `backend/tests/…` (4 new files), `test_notify.py`, `client.test.ts` | Tests | see the PR |

**Key excerpts**

`backend/app/packages/service.py::create_package` (the replay and the race)

```python
    key = check_idempotency_key(idempotency_key)
    digest = request_hash(data)
    # First, so a retry gets the original even if the unit was deactivated or the photo attached
    # (to this package) since.
    existing = await _by_key(db, ctx, key)
    if existing is not None:
        return _replay(existing, digest)
    # ...
    package_id = await db.scalar(
        insert(Package)
        .values(
            # ...
            idempotency_key=key,
            request_hash=digest,
        )
        .on_conflict_do_nothing(index_elements=[Package.building_id, Package.idempotency_key])
        .returning(Package.id)
    )
    if package_id is None:
        # READ COMMITTED: this statement sees the row the other request committed.
        existing = await _by_key(db, ctx, key)
        assert existing is not None  # noqa: S101 (the conflicting row is committed)
        return _replay(existing, digest)
```

- The early look-up makes a retry independent of what changed since (D1). The mutation probe m2 (PR) shows
  that removing it fails `test_a_replay_answers_with_the_package_as_it_is_now`.
- Without `on_conflict_do_nothing`, the race loser's INSERT raises `IntegrityError` after the wait, a 500.
  Mutation m3 fails four of the five tests in `test_create_concurrency.py`.

`backend/app/packages/service.py::create_package` (the photo, after the insert won)

```python
    if data.photo_file_id is not None:
        # Both sides (the file's attachment and the package's column) must agree for the photo
        # hook to grant it (app.packages.photos, the P5-01 carry).
        await claim_file(
            db,
            ctx,
            data.photo_file_id,
            FilePurpose.PACKAGE_PHOTO,
            PACKAGE_ATTACHED_TYPE,
            package_id,
        )
        await db.execute(
            update(Package).where(Package.id == package_id).values(photo_file_id=data.photo_file_id)
        )
```

- `backend/app/packages/photos.py::can_view_package_photo` grants a download only when the file is attached
  to the package **and** the package names the file. Setting one side alone would make the photo invisible
  to everyone.

`backend/app/packages/service.py::_recipient_user_id`

```python
    user_id = await db.scalar(
        select(BuildingMembership.user_id)
        .join(
            UnitOccupancy,
            (UnitOccupancy.membership_id == BuildingMembership.id)
            & (UnitOccupancy.building_id == BuildingMembership.building_id),
        )
        .where(
            BuildingMembership.id == data.recipient_membership_id,
            BuildingMembership.building_id == ctx.building_id,
            BuildingMembership.status == MembershipStatus.ACTIVE,
            UnitOccupancy.unit_id == data.unit_id,
            UnitOccupancy.ended_at.is_(None),
        )
    )
    if user_id is None:
        raise InvalidRecipient(detail="The recipient must currently live in this unit.")
```

- One query enforces all four rules (building, active, this unit, current). Mutation m1 (drop
  `status = active`) fails `test_a_recipient_who_is_not_an_active_current_occupant_is_refused[a_201-a_suspended]`.

`backend/app/packages/service.py::request_hash`

```python
def request_hash(data: PackageCreate) -> str:
    """sha256 of the validated body: every field, keys sorted, so a retry that spells the same
    request differently (key order, spacing, an explicit null) is the same request."""
    canonical = json.dumps(data.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()
```

- `PackageCreate` strips strings (`InputModel`) and fills omitted optionals with `None`, so `" UPS "` and
  `"UPS"`, or an omitted and an explicit `null` description, hash alike (D2).

`backend/app/packages/schemas.py::PackageCreate` (input Postgres would refuse)

```python
Carrier = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=50),
    BeforeValidator(printable_before_strip),
]
# ...
TrackingLast4 = Annotated[
    str, StringConstraints(strip_whitespace=True, pattern=r"^[A-Za-z0-9]{4}$")
]
```

- `printable_before_strip` (from `backend/app/units/schemas.py`) refuses control characters on the raw
  value, so `"UPS\n"` is a 422, not silently stripped. NUL can't reach the `notify` text checks or the
  INSERT, and the lengths match the columns.

`backend/tests/packages/test_create_concurrency.py::test_a_create_waits_for_a_concurrent_insert_of_the_same_key`

```python
        async with sessions() as first:
            held = await _hold_insert(first, world, _data(world))
            task = asyncio.create_task(_create(sessions, world, _data(world)))
            await asyncio.sleep(1.0)
            assert not task.done(), "the create did not wait for the open insert of its key"
            if first_commits:
                await first.commit()
            else:
                await first.rollback()
            outcome, package_id = await asyncio.wait_for(task, timeout=10)

        if first_commits:
            assert (outcome, package_id) == ("replayed", held.id)
```

- It runs on real connections in a scratch database (the test harness's single connection can't
  interleave two transactions). It proves the wait, the replay after a commit and the create after a
  rollback.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| A retry logs a second package | Same key and hash → replay, nothing written | `backend/tests/packages/test_idempotency.py::test_the_same_key_and_body_twice_gives_one_package_and_a_replay` |
| A retry after the unit was deactivated is refused | The look-up runs before validation | `backend/tests/packages/test_idempotency.py::test_a_replay_answers_with_the_package_as_it_is_now` |
| A retry with a photo fails because the photo is attached | Replay before `claim_file` | `backend/tests/packages/test_idempotency.py::test_a_replay_with_a_photo_does_not_claim_it_again` |
| Re-serialised JSON makes a retry a 409 | Hash of the validated, sorted body | `backend/tests/packages/test_idempotency.py::test_the_hash_ignores_key_order_spacing_and_explicit_nulls` |
| A key reused for another parcel silently returns the wrong package | 409 `idempotency_key_reused` | `backend/tests/packages/test_idempotency.py::test_the_same_key_with_another_body_is_a_409` (5 fields) |
| A refused first request burns the key | Nothing is inserted before validation passes | `backend/tests/packages/test_idempotency.py::test_a_refused_first_request_does_not_burn_the_key` |
| Two first requests race | One inserts; the other waits, then replays or 409s | `test_create_concurrency.py` (4 tests, 5 cases) |
| A failure after the insert leaves half a package | One commit, at the end | `backend/tests/packages/test_api.py::test_a_failure_after_the_insert_leaves_nothing`, `test_a_failure_in_the_audit_after_notify_leaves_nothing` |
| A former or suspended occupant is notified | `unit_resident_user_ids`: current and active | `backend/tests/packages/test_api.py::test_a_unit_package_notifies_current_occupants_not_former_ones`, `test_without_a_recipient_only_active_current_occupants_are_notified` |
| Building B's unit, recipient or photo is accepted | Each loaded with `ctx.building_id`; the same answer as unknown | `backend/tests/packages/test_api.py::test_a_unit_of_another_building_looks_like_an_unknown_unit`, `test_a_recipient_who_is_not_an_active_current_occupant_is_refused`, `test_a_photo_of_another_building_looks_like_an_unknown_photo` |
| A resident reads someone else's package | `visible_packages` → 404, same body as a random id | `backend/tests/packages/test_api.py::test_others_get_404_on_a_residents_package` |
| A list filter on building B's unit leaks | The filter narrows `visible_packages`, already scoped to A | `backend/tests/packages/test_api.py::test_a_unit_of_another_building_lists_nothing` |
| A newline or NUL in staff text reaches Postgres | 422 before the service | `backend/tests/packages/test_api.py::test_invalid_input_is_a_422_and_writes_nothing` (15 cases), `test_a_lone_surrogate_in_the_body_is_refused` |
| The feature is off but routes answer | `require_feature` on all five | `backend/tests/packages/test_api.py::test_every_package_route_is_403_when_the_feature_is_off` |
| The occupants picker offers a suspended member | `list_occupants` filters `status = active` | `backend/tests/units/test_occupants.py::test_staff_list_a_units_active_current_occupants_earliest_first` |

Acceptance criteria → tests:

- 1, 1a: `test_api.py` role, 401, cross-building and visibility tests; `test_occupants.py` role and 404 tests.
- 1b: the five "another building / inactive / recipient / photo / attached photo" tests in `test_api.py`.
- 2, 2a: `test_idempotency.py` (all 12 tests). 2b: `test_create_concurrency.py`.
- 3: `test_a_failure_after_the_insert_leaves_nothing`. 4, 4a: the two notification tests above.
- 5: `test_every_package_route_is_403_when_the_feature_is_off`. 6: `test_the_summary_counts_the_residents_visible_waiting_packages`.
- 7: `test_the_notification_links_the_package_and_emails_with_package_arrived`, `test_the_received_time_is_shown_in_the_buildings_timezone`.
- 8: `test_creating_a_package_records_package_received`. 9: the five list tests. 10: `test_occupants.py`.
- 11: `test_invalid_input_is_a_422_and_writes_nothing`, `test_a_lone_surrogate_in_the_body_is_refused`.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol`, high effort, fresh, with the security pass | `02f726e` | `MERGE` | None | — |

The reviewer setup followed James's instruction for this run: one fresh Codex reviewer instead of the Tier 1
default (a fresh Claude reviewer with the security pass, plus Codex). Codex ran the full backend suite (2337
passed), the linters, mypy, the frontend checks and the OpenAPI drift check, plus four proof tests of its own
(concurrent retries sharing a photo, a create behind a unit deactivation, occupant order, a replay after a
status change), all passing. No finding changed the code.

## 7. Not verified, accepted risks and follow-ups

- **Summary happy path for every role:** no HTTP test calls `GET /packages/summary` as `a_manager` or a
  council-only member (Codex's note). Security and residents are tested; the logic is shared through
  `visible_packages`, which P5-01 tests per persona. Tracked only here.
- **Recipient move-out race:** `_recipient_user_id` takes no lock on the occupancy, so a recipient who
  moves out between the check and the commit still gets the package and the notification. Accepted (PR
  follow-ups); no test.
- **The unit's `FOR KEY SHARE` lock has no race test.** It follows P4-05a's tested pattern, but no test here
  holds a deactivation open against a create. Codex's proof of "creation behind unit deactivation" passed
  but is not committed. Tracked only here.
- **Order is id (uuid7), not `received_at`:** seeded or backfilled rows with older `received_at` sort by
  insertion; the `received_at DESC` indexes are not used by this order. No `EXPLAIN` was run. PR follow-ups.
- **`PackageOut` has no unit label or recipient name:** the P5-03/P5-04 lists will need them (additive).
  PR follow-ups; added to P5-03 in the bookkeeping commit.
- **A schema change to `PackageCreate` changes every hash** (D2). Accepted.
- **Real email delivery:** proven only to mailpit on the local stack (PR transcript), not SES.
- **Flaky test seen, unrelated:** `backend/tests/jobs/test_worker.py::test_database_error_keeps_no_parameters_in_last_error`
  (`[64]`) failed twice locally on this branch and passed 14/14 on `main`. It touches no file this PR
  changes. PR follow-ups.

## 8. How to change this safely

- **A new field on the create body:** add it to `PackageCreate`, with its column limits and
  `printable_before_strip` for text, then to the `insert(Package).values(...)` in `create_package`. Remember
  it changes `request_hash` for every request (D2). `test_the_hash_is_sha256_of_the_sorted_validated_body`
  will fail, on purpose.
- **Another write that should be idempotent:** copy the shape (look-up, validate, `ON CONFLICT DO
  NOTHING`, look up again), and claim attachments only after the insert wins. Start from
  `test_create_concurrency.py`.
- **Changing who is notified:** edit `unit_resident_user_ids` or the recipient branch in `create_package`.
  The notification tests in `test_api.py` and `test_without_a_recipient_only_active_current_occupants_are_notified`
  pin the current rule.
- **The email:** keep `package_arrived` rendering from `title`, `body` and `link` alone, or
  `test_every_kinds_template_renders` fails.

## 9. Must explain, then quiz

**1. Trace `POST /packages` from HTTP to COMMIT, naming every row written in the one transaction.**
The dependencies run first (§3 step 2). Inferred from the comment in `backend/app/tenancy/deps.py`:
`get_current_user` refreshes the session's activity and commits that on its own, before this use case
starts. Then `create_package` writes, in one transaction: the `packages` row (INSERT … ON CONFLICT DO
NOTHING); with a photo, the `files` row's `attached_type`/`attached_id` (`claim_file`'s conditional UPDATE)
and `packages.photo_file_id` (UPDATE); one `notifications` row per recipient (one multi-row INSERT in
`notify`); one `jobs` row (`email.send`) per recipient who is active and has a sendable address
(`queue_email` → `enqueue`); and one `audit_events` row (`package.received`). Then the single
`db.commit()`. A replay writes none of these.

**2. Explain the idempotency logic, and why "same key, different body" is a 409.**
The key names one intended operation at the building's desk; the hash records what that operation was. Same
key and same hash means the client is retrying something that already happened, so it gets that result
(`_replay`). Same key and a different hash means the client is using one key for two different parcels.
Answering with the first package would tell the desk the second parcel was logged when it wasn't, so
`IdempotencyKeyReused` (409) surfaces the client bug. The unique index decides the race between two first
requests (§3 step 7).

**3. Why notify current occupants rather than "everyone ever linked to unit 101"?**
A unit-addressed package belongs to whoever lives there when it arrives: `visible_packages` grants it through
`occupancy_window` at `received_at` (ADR-0016). A former occupant can't see the package, so a notification
would leak that a parcel arrived for the new resident and link to a 404. Suspended members are left out
too (the P1-03 carry), because they can't act in the building.

**Quiz**

1. Two desk tablets send the same key and body at the same moment. Which statement makes the second one
   wait, and what does it answer if the first rolls back?
2. Why does `create_package` insert the package with no photo and set `photo_file_id` afterwards?
3. A client retries with `{"carrier":"UPS","unit_id":"…"}` after first sending `{"unit_id":"…","carrier":" UPS","description":null}`.
   What happens, and which function makes it so?
4. What would break if the look-up before validation (`_by_key` at the top of `create_package`) were
   removed?
5. How would you extend this so a package can be logged for a unit with no current occupant and the
   building's managers are told instead?

<details><summary>Answers</summary>

1. The `INSERT … ON CONFLICT DO NOTHING`: it waits on `uq_packages_building_id_idempotency_key` until the
   first transaction ends. After a rollback the insert goes ahead and the second request creates the
   package itself (`test_a_create_waits_for_a_concurrent_insert_of_the_same_key[rolls-back]`).
2. So that only the request whose insert won claims the photo (a loser that claimed first would get a 422
   instead of the replay), and so that a building-B file id gets `claim_file`'s 404 instead of a composite-FK
   `IntegrityError`. The photo hook needs both sides set (D1).
3. A replay (201, `Idempotent-Replayed: true`): `request_hash` hashes the validated model, so the stripped
   carrier, the key order and the explicit null make no difference.
4. A retry after the unit was deactivated would get 409 `unit_inactive` instead of its package (mutation m2
   fails `test_a_replay_answers_with_the_package_as_it_is_now`). A retry with a photo would still replay,
   through the conflict path, because the photo is claimed after the insert.
5. In `create_package`, when there is no named recipient and `unit_resident_user_ids` returns nobody, call
   `staff_user_ids(db, ctx.building_id, [Role.PROPERTY_MANAGEMENT])` with a new kind (registered in
   `kinds.py`, with a template that renders from title, body and link). Then add a test next to
   `test_a_unit_with_no_current_occupant_gets_a_package_and_no_notification`, which would change.

</details>
