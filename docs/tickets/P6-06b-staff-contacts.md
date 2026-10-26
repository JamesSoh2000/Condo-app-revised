# P6-06b — Staff contacts directory

| Field | Value |
|---|---|
| Phase / lane | P6 / B |
| Risk tier | 2 |
| Depends on | P6-06a, P2-04 |
| Replaces old | M9-T02 (contacts part) |
| Status | todo |

Split from the P6-06 stub ([P6-P7-backlog.md](./P6-P7-backlog.md)); after
[P6-06a](./P6-06a-minimal-profile.md).

## Goal

Every active member of a building opens "Contacts" and sees the building's staff: name, role and work phone.
Residents are not listed. The legacy `Contacts` page is gone.

## Why

Residents need to reach the desk and management without a resident directory: the legacy page listed every
profile with phones, plates and emergency contacts, which the product defaults rule out ("Residents see only their
own records", `docs/PRODUCT_SCOPE.md`). The endpoint returns a fixed, minimal set of staff fields, so the directory
can never become a way to enumerate residents or read a staff member's personal phone.

## Scope

- In:
  - **`GET /api/buildings/{b}/contacts`** (building router, any active member, no feature: contacts is core):
    the building's **active** memberships holding `security`, `property_management` or (as framing decides)
    `council`, each `{full_name, roles (staff roles only), work_phone}`; ordered by role then name;
    one page (a building has ~20 staff) or cursor pages, as framing decides
  - **where the work phone lives** (see "Open decisions"): default a nullable `building_memberships.work_phone`
    varchar(32), so a staff member's number is per building and never their personal `users.phone` (P6-06a); one
    migration (expand only)
  - **setting it**: the staff member edits their own work phone for the current building on the profile page
    (P6-06a's page gains a "Work phone in <building>" field for a staff membership), through
    `PATCH /api/buildings/{b}/memberships/me` or the path framing picks, staff roles only; audit
    `membership.work_phone_updated` with no value; or a manager sets it on the members screen, as framing decides
  - **contacts page** (`frontend/src/features/contacts/`), `PAGE_ACCESS.Contacts` gains a `path` (default
    `/contacts`): grouped by role, phone as a `tel:` link, empty and failed states
  - delete `src/pages/Contacts.jsx`; `/Contacts` handled by the route or `LegacyRedirect`; lower the ratchet
  - `make gen-api`
- Out: listing residents (the stub's "not listed by default"; a resident opt-in is a follow-up), the building's
  emergency phone (P6-03b owns it; the page may show it if P6-03b exposes it on the building, as framing decides),
  email addresses, search

## Interfaces

```text
GET /api/buildings/{building_id}/contacts           any active member
200 ContactsOut { contacts: [ { full_name: str, roles: Role[], work_phone: str | null } ] }
401 · 404 building_not_found (another building, pending, suspended)

PATCH /api/buildings/{building_id}/memberships/me   (path decided in framing)   a staff role in the building
body { work_phone: str | null }  → 200 { work_phone }
401 · 403 forbidden_role (resident only) · 404 building_not_found · 422
```

## Acceptance criteria

1. **Who is listed.** **Given** the world, **then** A's contacts list `a_manager`, `a_security` (and `a_council`
   as decided) once each with only their staff roles; no resident-only member, no pending, suspended, denied or
   deactivated membership, nobody from B; `multi` (security in B only) is not in A's list and is in B's.
2. **Fields.** Each entry has exactly the documented fields: no email, no `users.phone`, no unit, no user id (a
   schema test on the response keys).
3. **Access (10-case rows 1–3, 6).** Every active member of A (each role) gets 200; signed out 401; `b_manager`
   404 `building_not_found`; `a_pending` and `a_suspended` 404.
4. **Work phone.** A staff member sets and clears their work phone for A; it shows in A's contacts and not in B's;
   a resident-only member gets 403 `forbidden_role`; input validated as P6-06a's phone (NUL, length by Postgres,
   format); one audit row with no value; the user's personal `phone` is untouched.
5. **The page.** Contacts grouped by role, each phone a `tel:` link with an accessible name ("Call Sam Okafor,
   security"); "No staff listed yet" when empty; a failed load with "Try again"; switching building shows only B's
   contacts (keyed by building); `building_not_found` marks the building denied.
6. **375 px in Chromium** with a 200-character name and a 32-character phone, the page stays inside the viewport.
7. `Contacts.jsx` is deleted, `/Contacts` reaches the page, and the ratchet is lowered.

## Test plan

- `backend/tests/contacts/test_api.py`: criteria 1–3
- `backend/tests/memberships/test_work_phone.py`: criterion 4 (and the migration round-trip)
- `frontend/src/features/contacts/contacts.test.tsx`: criteria 5, 7; the profile page's work-phone field in
  `features/profile/profile.test.tsx`
- Chromium check at 375 px (criterion 6), output in the PR
- Commands: `make check DB_PORT=55432`; `uv run pytest tests/contacts tests/memberships -q`; `make gen-api`

## Likely files

`backend/app/contacts/{__init__,schemas,service,router}.py` (or in `app/memberships/`), `backend/app/memberships/
{models,schemas,service,router}.py`, `backend/migrations/versions/*_membership_work_phone_p6_06b.py`,
`backend/app/audit/actions.py`, `backend/app/main.py`, `frontend/src/features/contacts/{ContactsPage.tsx,api.ts}`,
`frontend/src/features/profile/ProfilePage.tsx`, `frontend/src/app/{pages.ts,routes.tsx}`,
`frontend/src/pages/Contacts.jsx` (deleted), `frontend/base44-baseline.txt`, `frontend/src/api/schema.d.ts`.

Estimate: ~250 non-test lines (contacts schemas, service and router ~70, work phone column, migration, schema,
service and route ~70, contacts page ~80, profile field ~20, routes ~10).

## Must explain (learning checkpoint)

1. Why can't the contacts endpoint list a resident, and which line keeps it so?
2. Why is the work phone on the membership and not the user?
3. Who can change a work phone, and what does the audit row hold?

## Open decisions (resolve while framing)

Left open by the stub:
- **The work phone's home**: `building_memberships.work_phone` (default, per building, set by the staff member),
  the user's `phone` shown for staff only (simpler, but publishes a personal number to ~600 residents), or the
  building's office phone for every staff entry
- **Who sets it**: the staff member on their profile (default), a manager on the members screen, or both
- **Council in the directory**: listed (elected owners residents may contact) or not (default: listed, as staff
  roles; the building may change it)
- one page or cursor pages (default one list, bounded by the staff count; a `limit` cap of 200)

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
