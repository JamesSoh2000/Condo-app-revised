# P4-08e — Member roles editor and unit transfer (split from P4-08c)

| Field | Value |
|---|---|
| Phase / lane | P4 / B |
| Risk tier | 2 |
| Depends on | P4-08c |
| Replaces old | part of [P4-08](./P4-08-frontend-onboarding-approval-screens.md) (M4-T08) |
| Status | todo |

Split from [P4-08c](./P4-08c-members-administration.md) while framing it (2026-10-21): with these two actions
its estimate was ~585 non-test lines. Not framed yet: frame it when it is picked.

## Goal

Managers change a member's roles and move a resident to another unit from the members list.

## Scope

- In:
  - On the "Members" tab (P4-08c), for an `active` row: a roles editor (`members_roles_update`
    `{add, remove}`) and, for a member holding `resident`, "Transfer unit" (`members_transfer`
    `{unit_id, relationship}`), with a unit search over `GET /units?active=true&search=`.
  - 409 `last_manager`, `no_roles_left`, `resident_has_unit`, `membership_not_active`, `not_a_resident`,
    `unit_inactive`, `occupancy_changed`, and 404 `unit_not_found`, `member_not_found` shown as clear
    messages.
  - A change to the manager's own roles refreshes `/me` (the nav and page guards follow).
- Out: bulk actions.

## First follow-ups (playbook step 8, from P4-08d)

- Pattern "cached answer reused on remount" reached 2 (PR #98 R3 M1: `useMyOnboarding`; P4-08d R1 F2: the badge after
  "view as"): the client's 30 s `staleTime` serves a remounted component an answer from before it was hidden. Promote it
  (a `CLAUDE.md` lesson, keeping it within 150 lines, or a test): a query whose component can unmount and come back
  while its data changes elsewhere needs `refetchOnMount: 'always'` or `gcTime: 0`.
- Pattern "checked only in jsdom" reached 4 (focus: P2-06c, P4-07a, P4-08b; accessible name: P4-08d D4, Chromium spaced
  an `sr-only` part). Widen the focus lesson to accessible names when promoting, without growing `CLAUDE.md` past 150.
- This ticket changes roles: a manager removing their own `property_management` must lose the nav's Residents badge with
  the item (P4-08d's `ResidentsNavLabel` unmounts with it; `/me` refresh); add it to the criteria.

## Acceptance criteria (to sharpen when framing)

1. **Given** the last manager tries to remove their own role, **then** the `last_manager` message shows, and
   nothing changes (P4-08's criterion 1, moved here from P4-08c).
2. **Given** mobile width (375 px), **then** the roles editor and the transfer dialog are usable (P4-08's
   criterion 2, as P4-08c sharpened it).

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
