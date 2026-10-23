# Slice recipe

How to build a vertical slice (a table, its API, its pages, its journey), with **packages** (P5-01 to P5-05) as the
worked example. Follow the steps in order; each names the helper to reuse and the packages file to copy from. The
rules themselves are in [CLAUDE.md](../CLAUDE.md); this is the order and the parts. Split it into tickets as P5
did: schema → create/read API → action API → desk UI → resident UI → E2E, each ≤ ~400 non-test lines.

## 1. Schema with composite FKs (`backend/app/<domain>/models.py`, one migration)

- Columns from `app/models/mixins.py` (uuid7 `id`, timestamps); enums with `app/models/types.py::database_enum`
  (values lowercase). Register the module in `backend/app/models/registry.py`.
- `building_id` on every row, and each reference to a building-owned row as a **composite FK**
  `(building_id, x_id) → x(building_id, id)`, so a row can never point into another building (ADR-0005). Copy
  `backend/app/packages/models.py::_composite_fk`; the target needs a `UNIQUE (building_id, id)`.
- Check constraints that tie columns to the status (a `picked_up` row has `picked_up_at`; `*_at >= received_at`),
  and an index per list the UI asks for, leading with `building_id` (`(building_id, status, received_at DESC)`).
  Use a partial index where only some rows need it.
- `make revision m="…"`, then read and fix it: server defaults, enum types, partial indexes (CLAUDE.md rule 11).
  Test the constraints directly (`backend/tests/packages/test_schema.py`).

## 2. State module (`<domain>/state.py`)

- One map of allowed moves, `ALLOWED`, and `assert_transition(from_, to)` raising a `Conflict` with code
  `invalid_transition` (409). `sources(to)` gives the `status IN (…)` of the conditional UPDATE. Copy
  `backend/app/packages/state.py`; test every pair (`test_state.py`).

## 3. The `visible_*` query (`<domain>/queries.py`)

- `visible_<domain>(ctx) -> Select[Model]` is the **only** place that says who sees which row (CLAUDE.md rule 3):
  staff roles see the building's rows; a resident sees rows naming them plus unit-addressed rows created during
  their occupancy, through `app/memberships/occupancy.py::occupancy_window_clause` (ADR-0016). Copy
  `backend/app/packages/queries.py::visible_packages`; for P6 maintenance, internal comments are a second filter
  on top, never a looser grant.
- Every read, count, action and file hook narrows this query (`.where`, `.exists()`, a subquery); none writes its
  own filter. Test it per role and per occupancy case (`test_visibility.py`).

## 4. Service with a single commit (`<domain>/service.py`)

- One function per use-case: create, get, list, each action. Only these call `await db.commit()`, once, at the end
  (rule 5). Helpers never commit: `app/audit/service.py::record_audit`, `app/notifications/service.py::notify`,
  `app/jobs/service.py::enqueue`, `app/files/service.py::claim_file`.
- Every ID in the body is loaded with `building_id = ctx.building_id` (404 otherwise, rule 2); a related row that
  must stay valid until commit is read `FOR KEY SHARE` (`create_package`).
- Actions: `_for_transition` (404 / 409 early answer from `visible_*`), then `_transition`, a conditional
  `UPDATE … WHERE status IN (sources(to)) RETURNING` (rule 7); zero rows re-reads for the right error. Of two at
  once exactly one wins (`backend/tests/packages/test_concurrency.py`, two sessions).
- Create that a double-click could duplicate: an `Idempotency-Key` header plus a request hash, unique per building
  (`check_idempotency_key`, `request_hash`; `test_idempotency.py`). Errors are domain errors from
  `app/core/errors.py` with a stable `code` (rule 8).

## 5. Router on the building router (`<domain>/router.py`)

- `router = building_router(tags=[…])`: the path is `/api/buildings/{building_id}/…` and `get_tenant_context`
  runs first (ADR-0004: another building is 404). Include it in `app/main.py` with the others.
- Guards as dependencies: `require_feature(Feature.X)` on every route; `require_roles(...)` on writes. Reads stay
  open to members and let `visible_*` decide (`backend/app/packages/router.py::_DESK`).
- Action endpoints `POST …/{id}/<verb>`, never `PATCH status`. The operation id is `<first tag>_<function name>`
  (`packages_pickup`), so name the functions by verb; `problem_responses(...)` lists each route's error statuses
  for the OpenAPI types.

## 6. Notify, audit and the email template

- Add the notification kind to `app/notifications/kinds.py` (`<domain>.<event>`, with its email template or
  `None`). `notify(...)` writes one row per recipient and, for an email kind, an `email.send` job each; the worker
  sends it (rule 6). Pass `link=` an app path (`/packages/<id>`) and a fixed title: staff text goes in
  `email_context`, length-bounded.
- Templates in `app/email/templates/<locale>/<name>.subject.txt`, `.txt`, `.html`, extending `base`;
  `{{ app_base_url }}{{ link }}` is the email's link. Packages added `en` only (`package_arrived`).
- `record_audit(action=…)` in the same transaction; actions are `<domain>.<past_verb>` in `app/audit/actions.py`;
  metadata holds IDs and field names only (rule 10).
- Files (photos): a purpose rule in `app/files/purposes.py` (types, size, roles that upload), `claim_file` in the
  create, and a view hook registered with `register_can_view` that grants through `visible_*`
  (`backend/app/packages/photos.py`; import it in `app/main.py`). Never accept an S3 key (rule 9).

## 7. The 10-case tests (`backend/tests/<domain>/`)

- Apply the table in [ENGINEERING_PRACTICES.md §7](./ENGINEERING_PRACTICES.md#7-testing-standards) to every
  endpoint. Use the world (`tests/world.py::build_world`: two buildings, each role, units `a_101`…) and the tenant
  helpers: `tests/helpers/tenancy.py::assert_cross_building_404`, `::assert_forbidden_role`,
  `::assert_not_visible`, `::assert_problem`. A `make_<row>` factory in the domain's `conftest.py` that flushes,
  never commits (`backend/tests/packages/conftest.py::make_package`).
- Rows: 1 each allowed role · 2 signed out 401 · 3 other building 404 · 4 wrong role 403 · 5 another resident 404
  · 6 pending or suspended 404 · 7 related ID from another building 404/422, no row · 8 invalid transition 409 ·
  9 retry returns the original · 10 two at once, one winner.
- Timestamps a test writes next to a server default come from the database clock (`func.now()`), not the host's.
- Caller text is validated as Postgres stores it (NUL, lone surrogates, byte lengths), with `max_length` on every
  string (CLAUDE.md lessons).

## 8. Types regeneration

- `make gen-api` after any API change, and commit `frontend/src/api/schema.d.ts`; CI fails on drift.

## 9. Feature hooks and pages (`frontend/src/features/<domain>/`)

- `api.ts`: React Query hooks over `src/api/client.ts`, keys under `['b', buildingId, '<domain>', …]`
  (`frontend/src/features/packages/api.ts::packagesKey`). Lists are infinite queries over the cursor pages;
  queries that can remount while data changes elsewhere set `staleTime: 0` (the `queryFreshness` fitness test).
  Mutations cancel and then invalidate the domain key `onSettled`. Mutation keys are building-keyed, so a
  `building_not_found` closes the building (`app/buildingDenial.ts`).
- A page per role: `PAGE_ACCESS` row in `app/pages.ts` (roles, feature, label, path), a route in
  `app/routes.tsx` under `RequirePageAccess`, keyed by building. A component that reads `useBuilding({ passive:
  true })` also reads `useBuildingDenied()` (fitness test `src/test/buildingDenial.test.ts`).
- Reuse: `features/residents/Modal.tsx` (dialogs), `features/residents/UnitPicker.tsx`, `features/files/FileUpload.tsx`
  and `PrivateImage.tsx` (photos), the cursor-list pattern of `features/packages/WaitingList.tsx`. Action dialogs
  send once per confirm and turn 409 `invalid_transition` into a message (`PackageDialog.tsx::usePackageSubmit`).
- Tests with `src/test/renderApp.tsx` (`renderApp`, `stubApi`); check focus and 375 px layout in Chromium with the
  API's longest values, not only jsdom.

## 10. Remove the legacy pages, lower the ratchet

- Delete the Base44 page the slice replaces (`src/pages/<Name>.jsx`); its legacy `/<Name>` path redirects to the new
  one through `PAGE_ACCESS` (`app/routes.tsx::LegacyRedirect`). Then `bash scripts/base44-count.sh` and lower
  `frontend/base44-baseline.txt` to the new count in the same PR (ADR-0011).

## 11. E2E journey (`e2e/tests/j<N>-<domain>.spec.ts`)

- One journey through the real stack: the staff action in the UI → the other role's badge and bell → the deep link →
  the email in Mailpit (`e2e/helpers/mailpit.ts::waitForEmail`) → the next action → history; then the privacy
  404s (another resident, a pending member, another building) through the API (`e2e/tests/j4-packages.spec.ts`).
- Both projects run it at once against the seeded building: give each its own unit or account, or the counts move.
  Shared accounts log in once in `e2e/tests/auth.setup.ts`; count the new logins against the README's budget.
- Layout and race checks that aren't a journey go in their own spec (`e2e/tests/packages-desk.spec.ts`).
- Run it on both stacks: `make e2e` and `make e2e E2E_STACK=prodlike` (as CI). Prove each new check can fail once.

## 12. Explanation

- After the last review round says `MERGE`, the implementer writes `docs/explanations/<ticket>-<slug>.md` from
  `docs/templates/EXPLANATION.md`, after the reality pass (re-read, run, compare with the plan; ADR-0017).
