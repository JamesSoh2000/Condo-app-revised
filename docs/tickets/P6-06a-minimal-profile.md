# P6-06a — Minimal profile: `PATCH /api/auth/me` and the profile page

| Field | Value |
|---|---|
| Phase / lane | P6 / B |
| Risk tier | 2 |
| Depends on | P2-01b, P2-06c |
| Replaces old | M9-T02 (profile part) |
| Status | todo |

Drafted from the P6-06 stub in [P6-P7-backlog.md](./P6-P7-backlog.md) and split in two: this ticket is the
profile; [P6-06b](./P6-06b-staff-contacts.md) the staff directory. Measured against what exists (the `/me`
route and `get_me` in `app/auth/`, `features/residents/InviteForm.tsx` 196 as a form of its kind), the stub is about
520 non-test lines: ~270 here, ~250 in P6-06b.

## Goal

A signed-in user edits their full name, phone and locale on a "My profile" page, through
`PATCH /api/auth/me`, and the app shell shows the new name at once. The legacy `Profile` page is gone.

## Why

Residents and staff need to correct the name managers and the desk see (packages, onboarding, members), and the
phone and locale the later slices read (P6-06b's directory, email templates under `app/email/templates/<locale>/`).
It is the first write to the `users` row outside sign-up and password reset, so it must keep the account
boundaries: the email, password, roles and memberships are not editable here (ADR-0003).

## Scope

- In:
  - **`PATCH /api/auth/me`** (session, CSRF like every unsafe route; not on the building router: the profile is
    the person's, not a building's) with `MeUpdateIn(InputModel)`: any of `full_name` (the existing `FullName`
    type from `app/auth/schemas.py`, `users.full_name` varchar(200)), `phone` (nullable; format decided in framing,
    `users.phone` varchar(32)), `locale` (one of the locales the app has templates for, `en` and `fr` today);
    unknown fields 422 (`InputModel`); → 200 `MeOut` (the same shape as `GET /me`)
  - one conditional `UPDATE users … WHERE id = :user AND is_active RETURNING`, one commit; audit `user.updated`
    with the changed field names only (rule 10)
  - **profile page** (`frontend/src/features/profile/`), `PAGE_ACCESS.Profile` gains a `path` (default
    `/profile`), any signed-in user with an active membership: the three fields, the email read-only, one save,
    422 per field, 429 and other failures as messages, focus to the outcome message after a save; afterwards
    `['me']` is invalidated (the shell's name in the account menu updates)
  - delete `src/pages/Profile.jsx`, `/Profile` handled by the route (`sameLegacyPath`) or `LegacyRedirect`; lower
    the ratchet
  - `make gen-api`
- Out: email change, password change (the reset flow exists, P4-04), avatar upload, account deletion, per-building
  profile data (the legacy `ResidentProfile`: vehicles, emergency contacts), the staff work phone (P6-06b), a
  French UI (pilot)

## Interfaces

```text
PATCH /api/auth/me                 signed in (session + CSRF)
body  MeUpdateIn { full_name?: FullName, phone?: str | null, locale?: "en" | "fr" }   at least one field
200   MeOut                        as GET /api/auth/me
401   signed out · 403 csrf · 422 validation (per field)
```

## Acceptance criteria

1. **Given** a signed-in user, **when** they PATCH `full_name`, **then** 200 with the new name in `MeOut`,
   `users.full_name` changed, `updated_at` moved, one `user.updated` audit row with `fields: ["full_name"]` and no
   value; the same for `phone` and `locale`; sending several changes them together.
2. **Boundaries.** A body with `email`, `password`, `is_active`, `roles` or any unknown field gives 422 and changes
   nothing; an empty body gives 422; another user's row is never reachable (the route takes no id).
3. **Input.** NUL, lone surrogates, over-long values (by what Postgres stores: 200 and 32 characters), a blank
   name, a phone outside the decided format, an unknown locale give 422 per field; `phone: null` clears it.
4. **Auth.** Signed out 401; without the CSRF token 403 (the middleware, not exempted); a deactivated user's
   session is already refused (P2-01b), so a PATCH from it is 401.
5. **Atomicity.** A forced failure after the `UPDATE` and before commit leaves the row and the audit unchanged.
6. **The page.** The form shows the current values from `/me`; saving sends one PATCH with only the changed
   fields (a double press sends one); the account menu's name updates without a reload; a 422 shows on its field
   and keeps the typed values; focus goes to the outcome message after a save.
7. **Another tab.** A second tab open on the page that saved earlier shows the server's values after its `/me`
   refetch (no stale form overwrites the newer save silently: the form resets to the fetched values while
   unchanged, and keeps the user's edits otherwise, as framing settles).
8. **Access.** Any active member opens the page; signed out goes to login; the nav shows "My profile".
9. **375 px in Chromium** with a 200-character name without spaces, the form stays inside the viewport.
10. `Profile.jsx` is deleted, `/Profile` reaches the page, and the ratchet is lowered.

## Test plan

- `backend/tests/auth/test_me_update.py`: criteria 1–5
- `frontend/src/features/profile/profile.test.tsx`: criteria 6–8, 10
- Chromium check at 375 px (criterion 9), output in the PR
- Commands: `make check DB_PORT=55432`; `uv run pytest tests/auth -q`; `make gen-api`

## Likely files

`backend/app/auth/{router,schemas,service}.py`, `backend/app/audit/actions.py`,
`frontend/src/features/profile/{ProfilePage.tsx,api.ts}`, `frontend/src/app/{pages.ts,routes.tsx}`,
`frontend/src/pages/Profile.jsx` (deleted), `frontend/base44-baseline.txt`, `frontend/src/api/schema.d.ts`.

Estimate: ~270 non-test lines (schema 35, service 35, router 15, actions 2, page ~140 against `InviteForm.tsx` 196
without its role list, hooks ~25, routes ~15).

## Must explain (learning checkpoint)

1. Why is the profile on `/api/auth/me` and not under a building, and which fields can it never change?
2. How does the shell's name update after a save, and what would show without the invalidation?
3. How is a phone validated, and why by what Postgres stores?

## Open decisions (resolve while framing)

Left open by the stub:
- **Phone format**: free text (printable, ≤ 32) or E.164-ish (`+` and digits, spaces and dashes allowed); default
  the looser one, as the building's staff type it
- **Locales**: `en` and `fr` (the template directories), or `en` only until the French UI (pilot); `fr` changes
  only the email language today
- **Audit action name**: `user.updated` (a new `user` domain in `app/audit/actions.py`) or `auth.profile_updated`
- whether `PATCH /me` is rate limited (default: no, it changes only the caller's row)

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
