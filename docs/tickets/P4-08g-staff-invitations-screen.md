# P4-08g — Staff invitations screen (from P4-09)

| Field | Value |
|---|---|
| Phase / lane | P4 / B |
| Risk tier | 2 |
| Depends on | P4-02a, P4-08b, P4-09 |
| Replaces old | — |
| Status | in progress |

Created by [P4-09](./P4-09-playwright-harness-onboarding-e2e.md) (PR #102): no screen creates invitations, so J2's
invite step goes through the API (P4-09 Frame notes, PR #102 D1). Framed 2026-10-22; resend, revoke and the
pre-approved resident's unit split to [P4-08i](./P4-08i-invitation-resend-revoke-and-residents.md) (Frame notes).

## Goal

A property manager invites staff from the new typed frontend and sees the pending invitations.

## Scope

- In:
  - An "Invitations" tab on `/manage/residents`: the invite form for `invitations_create` (email and staff roles),
    and the pending list (`invitations_list?status=pending`), with the API's error codes shown as clear messages.
  - **E2E:** move J2's invite step (`e2e/tests/j2-staff-invite.spec.ts`) from the API call to this screen, and
    re-measure the rate-limit budget in `e2e/README.md`.
  - The two first follow-ups below.
- Out: bulk invitations; CSV import of people; resend, revoke and inviting a resident with a unit
  ([P4-08i](./P4-08i-invitation-resend-revoke-and-residents.md)).

## First follow-ups (playbook step 8, from P4-08f)

- **PR #108 round 3 R3-F1 (Medium, open at merge; fix test-first):** `frontend/src/test/queryFreshness.test.ts::inspect`
  matches React Query hooks by their identifier name only. `import { useQuery as useBuildingQuery }` or
  `RQ.useInfiniteQuery({...})` with a building key and no freshness option gives `inspect() → []`, so the guard passes.
  Proposed: record the file's imports from `@tanstack/react-query` (named aliases, namespace imports) and match those.
- Pattern "regex for a code pattern" reached 2 (P4-09 F4 no-sleep lint, PR #108 R1-F1 freshness guard): a check over
  code written as text matching missed forms the language allows. Promote it: a `CLAUDE.md` lesson ("check code with a
  parser, not a regex: generics, multi-line calls, comments, nested objects"), or a test, keeping `CLAUDE.md` within
  150 lines.

## Acceptance criteria

(Written while framing, from P4-02a's API and the residents screens' criteria, P4-08b/c/e.)

1. **Tab.** `/manage/residents` has a third tab, "Invitations" (`?tab=invitations`), after "Members", with the same
   tablist behaviour as the other two (arrows, Home and End move and select; Back and Forward switch; the panel is
   keyed by history entry and building). An unknown `tab` value still shows "Pending requests".
2. **Pending list.** The tab lists the building's pending invitations (`GET …/invitations?status=pending`), newest
   first, each with its email, its roles as labels in `Role` order ("Security, Property manager") and "Expires
   <date>" (the building's locale and time zone). States: "Loading invitations…"; "No pending invitations."; a
   failed first load "Could not load the invitations." and a failed refresh "Could not refresh the invitations.",
   each with "Try again" (the 429's wait when it has one). "Show more" loads the next page (`next_cursor`); it is
   disabled while any fetch of the list is out and hidden after a failed refresh; a failed next page shows "Could
   not load more invitations.".
3. **Fresh list.** The list's query is keyed `['b', buildingId, 'invitations', …]` and stale at once
   (`staleTime: 0`): coming back to the tab or the window asks again (the `queryFreshness` guard passes without an
   exemption). It is asked for again after every create, whatever the outcome.
4. **Invite form.** Above the list: "Email" and a "Roles" group of three checkboxes, Security, Property manager and
   Council (no Resident: P4-08i), with a "Send invitation" button. The email is trimmed before it is checked and
   sent. Empty or not shaped `x@y` → "Enter one email address."; over 254 bytes → "Use at most 254 characters.";
   no role → "Choose at least one role."; nothing is sent while any of these shows. Send posts `invitations_create`
   with `{email, roles}` (roles in `Role` order, no `unit_id` or `relationship`).
5. **Sent.** On 201: "Invitation sent to <email>." (the email from the response, which the server lowercases)
   shows in a status message that takes focus, the form is cleared, and the list is asked for again, so the new
   invitation appears in it.
6. **Refusals** (the form keeps what was typed and works again; the message is an alert that takes focus):
   409 `invitation_pending` → "<email> already has a pending invitation." (the list is asked for again, so it
   shows); a 422 the form can place (`email_address`, `string_too_long`, `missing` on `email`) → the email
   field's message as criterion 4; 403 `forbidden_role` → "You can no longer invite people to this building.";
   any other failure (another 422, 429, 500, a network error) → "Could not send the invitation. Try again." (the
   429's wait when it has one). A `building_not_found` marks the building denied (the mutation is keyed by
   building, as P4-08c's).
7. **One request.** A double-click on "Send invitation" sends exactly one request; while it is out the fields
   can't be changed and the button is disabled, and focus stays in the form.
8. **Leaving and switching.** **Given** the page is left, or another building chosen, while a create is out,
   **then** nothing of it shows on the new screen, and the first building's invitations are still asked for again
   when it settles (from the mutation, not the form).
9. **Access.** A member without `property_management` gets P4-08b's `/403` on `/manage/residents?tab=invitations`
   and no invitations request is sent.
10. **Labels.** Each field has a label; a field's error is linked to it (`aria-describedby`) and marks it
    `aria-invalid`; the roles group is a `fieldset` with a legend and its error linked to it. The list is a list
    named "Pending invitations". Focus after Send and after a refusal is checked in Chromium on the stack.
11. **Mobile.** At 375 px the tabs, the form and a row with a 254-character email fit without horizontal
    scrolling (checked in Chromium on the stack).
12. **E2E J2.** The manager invites security through this screen: opens `/manage/residents?tab=invitations`, types
    the email, ticks Security, sends, sees "Invitation sent to …" and the row in the list; the rest of J2 is
    unchanged. `e2e/README.md` no longer says J2 uses the API, and its budget table is re-measured from
    `rate_limits` after one `make e2e` run. `make e2e` passes three times in a row.
13. **Freshness guard follows imports (R3-F1).** `queryFreshness.test.ts::inspect` lists, as query hooks, calls
    through a renamed import from `@tanstack/react-query` (`import { useQuery as useRows }`) and calls through a
    namespace import (`import * as RQ …; RQ.useInfiniteQuery(…)`), classified as before. Neighbours: a default or
    `require` form is out of the codebase's style and not covered (recorded); a local function named `useQuery`
    with no import is still listed (fail-closed, as today); an alias whose name doesn't look like a hook
    (`import { useQuery as q }`) is listed too.
14. **Lesson "parser, not a regex"** (follow-up from P4-08f): `CLAUDE.md` "Lessons learned" says to check code
    with a parser, not text matching (generics, multi-line calls, comments, nested objects, aliased imports),
    citing P4-09 F4 and PR #108 R1-F1, with `CLAUDE.md` staying ≤ 150 lines.

Tenant table (`ENGINEERING_PRACTICES.md` §7): no new endpoint. Rows 1–4, 6, 8 and 10 for `invitations_create` and
`invitations_list` are P4-02a's backend tests. The UI's part: row 3/4 as criterion 8 (another building's
invitations are never shown or sent under its key), row 5 (a non-manager) as criterion 9, row 10 (two managers
inviting one email) as criterion 6's `invitation_pending`.

Cases the ticket missed: a colleague's invitation for the same email sent after this list loaded (criterion 6,
`invitation_pending`, the list refreshed so the row shows); a manager demoted while the form is open (criterion 6,
403); a padded or upper-case email (criteria 4–5).

## Test plan

- Vitest (`frontend/src/features/residents/invitations.test.tsx`): criteria 1–10. `queryFreshness.test.ts`: 3, 13.
- Playwright (`e2e/tests/j2-staff-invite.spec.ts`): 12. Manual on the stack: 10's focus and 11 in Chromium.
- Commands: `make check`, `make e2e`.

## Must explain (learning checkpoint)

1. Why does the list's refresh after a create come from the mutation and not the form?
2. How does the freshness guard now tell a React Query hook from a function of the same name?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: the stub had none; 1–14 written from P4-02a's API (`InvitationCreate`, the create's
  409/404/422 codes, the list's `status` filter) and the residents screens' patterns (P4-08b's list states and
  "Show more" guards, P4-08e's one-request and leaving rules, the 375 px and Chromium checks). 13 and 14 are the
  P4-08f follow-ups.
- Criteria loosened (with reason; also listed in the inbox): the stub's scope is divided, not dropped. Resend,
  revoke and the pre-approved resident (a unit and relationship) moved to the new
  [P4-08i](./P4-08i-invitation-resend-revoke-and-residents.md) with their criteria.
- Decisions taken (with basis):
  - **Split (playbook step 1.4).** Costing from the residents screens: the whole stub ~470 non-test lines (hooks
    ~70, the invite form with roles ~140 and with a unit search and relationship ~+90 even reusing
    `TransferDialog`'s parts, the list ~110, a resend/revoke confirmation ~60). Without resend, revoke and the unit:
    hooks ~45, form ~140, list ~110, tab and lesson ~10: ~305.
  - **A tab, not its own page (ticket scope offers either; convention P4-08b/c):** the residents page already has
    the tablist, guard and keyed panel.
  - **Form on the tab, not in a dialog (autonomous, simplest):** it is the tab's main action and has no row it acts
    on.
  - **Only pending invitations listed (ticket: "the pending list"):** an expired one needs no action here (a new
    invitation for the email is allowed); P4-08i decides whether to show expired ones beside resend.
  - **Staff roles only (split):** a resident without a unit is allowed by the API but is P4-08i's form.
  - **The email trimmed client-side (convention: the join form, P4-08a):** the server refuses a padded address
    rather than changing it.
- Split: P4-08i (resend, revoke, the pre-approved resident).
