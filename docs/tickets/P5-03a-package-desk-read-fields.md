# P5-03a — Package desk read fields

| Field | Value |
|---|---|
| Phase / lane | P5 / A |
| Risk tier | 1 |
| Depends on | P5-02a, P5-02b |
| Replaces old | — (split from P5-03) |
| Status | done |

Split from the original P5-03 (Security packages page) while framing: the page, its form, its list and its
two dialogs measure about 850 non-test lines, and the list needs API fields that `PackageOut` lacks (the
P5-02a carry). This part is the additive API change. The page is
[P5-03b](./P5-03b-package-desk-page-and-waiting-list.md), the "Log package" panel
[P5-03c](./P5-03c-log-package-panel.md), pickup and return [P5-03d](./P5-03d-package-pickup-and-return-dialogs.md).

## Goal

The desk's waiting list can show each package's unit and recipient, and filter by carrier, from the package
API alone, without a request per row.

## Why

`PackageOut` names the unit and the recipient by id only, and `GET /packages` filters by status and unit
only. Joining client-side would need the whole units list and one occupants request per unit, and occupants
lists only current occupants, so a recipient who moved out would show no name. A carrier filter over loaded
pages would miss packages on pages not loaded yet.

## Scope

- In (building router; no new endpoint, no migration):
  - **`PackageOut` gains** `unit_tower` (string or null), `unit_label` (string) and `recipient_name`
    (string or null), on every endpoint that returns it: `POST /packages` (also a replay), `GET /packages`,
    `GET /packages/{id}`, `POST …/pickup`, `POST …/return`.
  - **`GET /packages?carrier=`** filters by carrier, with the other filters.
  - `make gen-api`.
- Out:
  - who collected a package and the return reason (the P5-02b carry): the waiting list shows `received`
    packages only; a later page that shows history adds them
  - the UI (P5-03b–d)

## Interfaces

`PackageOut` (additive fields); `packages_list` gains the optional `carrier` query parameter.

## Acceptance criteria

1. **Unit fields.** Every `PackageOut`, from each endpoint in scope, has `unit_tower` and `unit_label` equal
   to the package's unit's current `tower` and `label`, read from a unit of `ctx.building_id`. A deactivated
   unit's package still shows them. The unit's later rename shows on the next read.
2. **Recipient name.** For a caller with the `security` or `property_management` role, `recipient_name` is
   the recipient membership's user's current `full_name`, also when that membership is suspended or has
   moved out since; it is null for a package addressed to the unit. For every other caller (a resident) it
   is always null, also on their own packages. Read from a membership of `ctx.building_id`.
3. **Carrier filter.** `GET /packages?carrier=X` returns the visible packages whose carrier equals `X`
   ignoring case (Postgres `lower()` on both sides), combined with `status` and `unit_id`, newest first;
   the cursor pages through the filtered list only. `X` is validated as the create body's carrier (stripped,
   1–50 characters, no control characters): otherwise 422 and nothing is listed. No match is an empty page.
4. **Tenant table** (rows that this change touches; the rest are P5-02a/P5-02b's tests, unchanged):
   1. security and property management see the three fields filled; a resident sees the unit fields and a
      null `recipient_name`; council-only still lists nothing
   2. unauthenticated `GET /packages?carrier=…` is 401
   3. a member of another building gets 404 with `?carrier=` too
   4. n/a: no endpoint changes its roles
   5. a resident's `?carrier=` never lists another resident's package of the same carrier
   6. a suspended member gets 404 with `?carrier=` (operational route)
   7. n/a: no new request-body id
   8. n/a: no transition changes
   9. a create replay's body has the same three fields as the first 201
   10. n/a: reads only
5. **No query per row.** Listing a page of 25 packages, each with a different unit and recipient, runs the
   same number of SQL statements as a page of 1.
6. **Contract.** `frontend/src/api/schema.d.ts` is regenerated and the OpenAPI drift check is green.

## Test plan

- pytest against real Postgres, in `backend/tests/packages/` (new `test_desk_fields.py`), with the world
  fixtures and the tenant helpers.
- The statement count with a SQLAlchemy `before_cursor_execute` listener.
- On the stack: curl the list as security and as a resident, transcript in the PR.

## Likely files

`backend/app/packages/{schemas.py,service.py,router.py}`, `backend/tests/packages/test_desk_fields.py`,
`frontend/src/api/schema.d.ts`.

## Must explain (learning checkpoint)

1. Why does the resident's `PackageOut` carry a null `recipient_name` rather than their co-occupant's name?
2. Why compare `lower(carrier)` in Postgres instead of lower-casing the parameter in Python?
3. How does the list stay at a fixed number of statements however many packages a page holds?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: all of this part is new, from the P5-02a carry ("`PackageOut` has no unit
  label or recipient name … decide while framing") and the original P5-03 scope ("search by unit and filter
  by carrier"). Missed cases added: a renamed unit and user (live values, not copies), a deactivated unit, a
  suspended or moved-out recipient, a carrier with control characters, the statement count (5).
- Criteria loosened (with reason; also listed in the inbox): none. The original P5-03's criteria 1–5 are
  all kept, in P5-03b (5), P5-03c (1, 2, 4) and P5-03d (3); see each part's Frame notes.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - **Add the fields to the API, not join client-side** (the P5-02a carry offered both). Client-side needs
    the whole units list and an occupants request per unit, and can't name a recipient who moved out.
    Additive, reversible. Autonomous.
  - **`recipient_name` for the desk only.** Residents read `PackageOut` too (the P5-02b carry: "staff-only
    fields need care"); a resident sees packages received at their unit for a co-occupant, and today no
    endpoint shows a resident a co-occupant's name. P5-04's page doesn't need it. Null for residents keeps
    exposure where it was; a later ticket may widen it. Autonomous; "Decisions to audit" in step 6.
  - **Search by unit uses the existing `unit_id` filter** (P5-03b picks the unit with the units search), so
    only the carrier filter is new. Ticket + existing API.
  - **Carrier match ignores case**, exact otherwise: the quick-pick sends fixed names, and "Other" is typed
    by hand. Autonomous.
- Split: from P5-03, into P5-03a–d. Estimate for this part about 70 non-test lines (schemas ~15, service
  ~50, router ~5) plus the regenerated `schema.d.ts`. Sizing of the others, from measured components of
  their kind: `InviteForm.tsx` 196 lines and `Invitations.tsx` 161 (P4-08g/i), `DecisionDialog.tsx` 154
  (P4-08b), `residents/api.ts` hooks about 25 each. P5-03b ~300 (route, page, list, hooks, legacy
  removal), P5-03c ~320 (form with unit picker, recipient, carrier, photo, idempotency), P5-03d ~300 (two
  dialogs and their hooks).
