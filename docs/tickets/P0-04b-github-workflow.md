# P0-04b — GitHub workflow: branch protection, PR template, Dependabot, branches

| Field | Value |
|---|---|
| Phase / lane | P0 / B |
| Risk tier | 2 |
| Depends on | P0-02, P0-03a, P0-03b |
| Replaces old | M0-T07 (workflow) |
| Status | todo |

Split from [P0-04](./P0-04-repo-workflow-and-local-stack.md) (see there why). The local stack is
[P0-04a](./P0-04a-local-stack-and-makefile.md).

## Goal

The GitHub repo enforces the PR workflow, and stale branches are gone.

## Scope

- In:
  - **Branch protection on `main`:** PR required, **no required approval** (agents merge their own PRs,
    [ADR-0014](../adr/0014-autonomous-agent-workflow.md)), required checks `backend` + `frontend` + `docs`
    (the CI job names), branches up to date before merging, linear history, no force push. Changing branch
    protection is this ticket's scope; it needs PRE-1 in [HUMAN_INBOX](../HUMAN_INBOX.md) (`gh` with admin
    rights).
  - No `CODEOWNERS`: with one human and no review gate it would only add a notification.
  - `.github/pull_request_template.md` (from [the template](../templates/PULL_REQUEST.md)).
  - `.github/dependabot.yml` (uv, npm, github-actions, docker; weekly).
  - **Branches:** list `git branch -r --no-merged origin/main` and decide each case; delete merged or stale
    remote branches, including `develop`, `staging`, `starting` and `starting-james`, after confirming
    nothing unmerged matters. The in-progress `M2-T03_Core-Tenant-Schema_James` work continues under P1-01
    instead.
- Out: the local stack (P0-04a).

## Acceptance criteria

1. (P0-04 AC3) **Given** GitHub, **when** someone pushes directly to `main`, **then** it is rejected. A PR
   shows the template, and the required checks are listed.
2. (P0-04 AC5) **Given** `git branch -r`, **then** only `main` and active ticket branches remain.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split: part b of [P0-04](./P0-04-repo-workflow-and-local-stack.md).
