# P4-08i — Invitation resend, revoke and pre-approved residents (split from P4-08g)

| Field | Value |
|---|---|
| Phase / lane | P4 / B |
| Risk tier | 2 |
| Depends on | P4-08g |
| Replaces old | — |
| Status | todo |

Split from [P4-08g](./P4-08g-staff-invitations-screen.md) while framing it (2026-10-22): with these its estimate was
~470 non-test lines. Not framed yet: frame it when it is picked.

## Goal

A property manager resends and revokes pending invitations, and invites a pre-approved resident to a unit, from the
"Invitations" tab.

## Scope

- In:
  - On each row of P4-08g's pending list: "Resend" (`invitations_resend`) and "Revoke" (`invitations_revoke`),
    with a confirmation, and 404 `invitation_not_found`, 409 `invalid_transition` and `invitation_pending` shown
    as clear messages.
  - Decide while framing whether expired invitations are listed too (resend works on them).
  - The invite form gains "Resident", with a unit (searched as `TransferDialog` does) and a relationship, both or
    neither; 404 `unit_not_found` and 409 `unit_inactive` keep the form open.
- Out: bulk actions.

## First follow-ups (playbook step 8, from P4-08g)

- Pattern "list refresh defeated by another fetch" reached 5 (PR #110 R1 F1: `useInvite` invalidated without
  cancelling a first load still out), **after** its `CLAUDE.md` lesson. Promote it to code: one shared helper for a
  mutation's list refresh (cancel the key's queries, then invalidate, not returned) used by every residents mutation,
  or a fitness test that finds `invalidateQueries` in an `onSettled` without a `cancelQueries` before it. Resend and
  revoke will need it.

## Acceptance criteria

To be written when framed. Start from P4-02a's API criteria (resend replaces the link and expiry; revoke ends the
link) and P4-08e's transfer dialog criteria for the unit search.
