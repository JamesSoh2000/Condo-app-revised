# P4-08g — Staff invitations screen (from P4-09)

| Field | Value |
|---|---|
| Phase / lane | P4 / B |
| Risk tier | 2 |
| Depends on | P4-02a, P4-08b, P4-09 |
| Replaces old | — |
| Status | todo |

Created by [P4-09](./P4-09-playwright-harness-onboarding-e2e.md) (PR #102): no screen creates invitations, so J2's
invite step goes through the API (P4-09 Frame notes, PR #102 D1). Not framed yet: frame it when it is picked.

## Goal

A property manager invites staff (and pre-approved residents) from the new typed frontend, and sees, resends and
revokes pending invitations.

## Scope

- In:
  - An invitations screen under `/manage/residents` (or its own tab): the invite form for `invitations_create`
    (email, roles; a unit and relationship for a resident, both or neither), the pending list, resend and revoke
    (`invitations_resend`, `invitations_revoke`), with the API's error codes shown as clear messages.
  - **E2E:** move J2's invite step (`e2e/tests/j2-staff-invite.spec.ts`) from the API call to this screen, and
    re-measure the rate-limit budget in `e2e/README.md`.
- Out: bulk invitations; CSV import of people.

## Acceptance criteria

To be written when framed. Start from P4-02a's API criteria and the residents screens' (P4-08b, P4-08c) mobile
and accessibility criteria.
