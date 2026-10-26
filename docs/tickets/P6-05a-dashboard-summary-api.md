# P6-05a — Dashboard summary API

| Field | Value |
|---|---|
| Phase / lane | P6 / A |
| Risk tier | 2 |
| Depends on | P6-03b, P5-02a, P6-01c, P4-05b |
| Replaces old | M9-T01 (API part) |
| Status | todo |

Drafted from the P6-05 stub in [P6-P7-backlog.md](./P6-P7-backlog.md) and split in two: this ticket is the API;
[P6-05b](./P6-05b-role-landing-pages.md) the landing pages. Measured against what exists (`package_summary`,
`notice_summary` and `pending_summary` are 4–11 lines each; `MyPackagesPage.tsx` 83, `ManagerNoticesPage.tsx` 129),
the stub is about 470 non-test lines: ~170 here, ~300 in P6-05b.

## Goal

`GET /api/buildings/{b}/dashboard` returns, in one response, the counts the caller's roles may see in this
building: packages waiting, pending onboarding requests, open maintenance requests by status, unread and urgent
unread notices, each present only when its feature is enabled and the caller may see it.

## Why

Journey 8 ("each role's landing page shows correct counts", `docs/PRODUCT_SCOPE.md`) needs one answer per page
load instead of four polled summaries with four permission rules. Each count must equal what the matching list
shows the same caller (CLAUDE.md rule 3: counts narrow the `visible_*` query, `docs/SLICE_RECIPE.md` step 3), so
the endpoint **reuses** the existing summary functions instead of writing new queries.

## Scope

- In (`backend/app/dashboard/`, building router, any active member):
  - **`GET /dashboard`** → `DashboardOut`; one section per domain, `null` (or absent, as framing settles in the
    schema) when the building has the feature off or the caller's roles may not see it
  - sections, each from the existing function:
    - `packages`: `{waiting}` from `app/packages/service.py::package_summary` (visible packages, so a resident's
      own and staff's the building's)
    - `onboarding`: `{pending}` from `app/onboarding/service.py::pending_summary`, property management only (the
      route's own role, `app/onboarding/router.py::Manager`)
    - `notices`: `{unread, urgent_unread}` from `app/notices/service.py::notice_summary`
    - `maintenance`: `{submitted, in_progress, on_hold}` (open requests by status), a new
      `maintenance_summary(db, ctx)` in `app/maintenance/service.py` over `visible_maintenance(ctx)`, one grouped
      query, as `package_summary`
  - feature checks without a 403: a disabled feature's section is omitted (the stub's "show only enabled
    features"), read from the same source as `require_feature` (`app/tenancy/` feature lookup), not a second rule
  - operation id `dashboard_get`; `make gen-api`
- Out: the landing pages (P6-05b); deferred domains (amenities, moves, visitors, reports, financials: the stub's
  "no cards for deferred domains", so no section and no field); trends, history or charts; caching

## Interfaces

```text
GET /api/buildings/{building_id}/dashboard          any active member
200 DashboardOut {
  packages:    { waiting: int } | null
  onboarding:  { pending: int } | null
  notices:     { unread: int, urgent_unread: int } | null
  maintenance: { submitted: int, in_progress: int, on_hold: int } | null
}
401 signed out · 404 building_not_found (another building, pending, suspended)
```

A section is `null` when its feature is off for the building or the caller's roles may not see that domain
(onboarding: not property management; maintenance and packages: as their `visible_*` grants no rows to the
caller's roles, see "Open decisions"). `0` means "may see, none".

## Acceptance criteria

1. **Counts equal the lists.** **Given** the world with packages, onboarding requests, notices and maintenance
   requests in A and B, **then** for each persona (`a_resident1`, `a_resident2`, `a_former`, `multi_in_a`,
   `a_security`, `a_manager`, `a_council`) each count equals the length of the matching list endpoint's full
   answer for the same caller (`packages?status=received`, `onboarding-requests?status=pending`,
   `notices?live=true&unread=true`, `maintenance-requests?status=…`), one parametrized test per persona and section.
2. **Reuse.** The packages, onboarding and notices numbers come from the existing summary functions (a test or the
   review checks the call; no second query writes its own filter), and `maintenance_summary` narrows
   `visible_maintenance(ctx)`.
3. **Roles.** `onboarding` is null for every role but property management; a council-only member gets the sections
   framing settles (see "Open decisions"), never a count of rows its `visible_*` gives it none of unless an
   aggregate is explicitly decided and recorded.
4. **Features.** **Given** `maintenance` off for A, **then** `maintenance` is null for everyone in A and the other
   sections are unchanged; likewise for each feature; no response contains a field for a deferred domain.
5. **10-case rows.** Signed out 401; `b_manager` 404 `building_not_found` on A's URL; `a_pending` and
   `a_suspended` 404 `building_not_found`; no other building's row is counted (B's packages, notices and requests
   are excluded for every A persona).
6. **One round trip.** The endpoint runs a bounded number of queries independent of row counts (a statement
   counter test: at most one per section plus the tenant context).
7. **Rate.** The endpoint is safe to poll at the 30 s cadence (ADR-0012): no write, no audit row, no
   notification-read side effect.

## Test plan

- `backend/tests/dashboard/test_api.py`: criteria 1, 3–5, 7 (world personas, parametrized)
- `backend/tests/dashboard/test_queries.py`: criteria 2, 6 (`before_cursor_execute` counter)
- `backend/tests/maintenance/test_summary.py`: `maintenance_summary` per persona and occupancy window (as
  P6-03a criterion 8)
- Commands: `make check DB_PORT=55432`; `uv run pytest tests/dashboard tests/maintenance -q`; `make gen-api`

## Likely files

`backend/app/dashboard/{__init__,schemas,service,router}.py`, `backend/app/maintenance/{service,schemas}.py`,
`backend/app/main.py`, `frontend/src/api/schema.d.ts`, `backend/tests/dashboard/*`. Read first:
`app/packages/service.py::package_summary`, `app/notices/service.py::notice_summary`,
`app/onboarding/service.py::pending_summary`, `app/tenancy/deps.py::require_feature`.

Estimate: ~170 non-test lines (schemas 40, service 60, router 25, maintenance summary 30, main 2, types).

## Must explain (learning checkpoint)

1. Why does each count come from the domain's own summary or `visible_*` query, and what would go wrong with one
   handwritten query per count?
2. What does `null` mean in a section, as against `0`, and who sees which?
3. How does the endpoint know a feature is off without answering 403?

## Open decisions (resolve while framing)

Left open by the stub:
- **Council's maintenance summary.** `PRODUCT_SCOPE.md` gives council "maintenance summaries", and P6-03a defers
  council's rows ("P6-05's counts give the summary"). Default: counts follow `visible_maintenance`, so if council
  alone sees no rows its section is null. A building-wide aggregate for council (counts without rows) is a new
  grant: if framing takes it, it is one explicitly named query in `app/maintenance/queries.py`, tested, and
  recorded as a decision to audit, never a filter-less count.
- **Which open statuses** count (default `submitted`, `in_progress`, `on_hold`; `resolved` within the reopen
  window is not open).
- **A section the caller's roles can't see**: `null` (default, so the page shows no card) or absent from the JSON.
- **Whether the existing nav badges move to this endpoint** (default: no; they keep their own summaries, and the
  landing page reads this one).

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
