# P0-04b — GitHub workflow: branch protection, PR template, Dependabot, branches

| Field | Value |
|---|---|
| Phase / lane | P0 / B |
| Risk tier | 2 |
| Depends on | P0-02, P0-03a, P0-03b |
| Replaces old | M0-T07 (workflow) |
| Status | in progress |

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
3. (sharpened from AC1) The protection is read back from the API and matches the scope: required checks
   are the CI job names `Backend tests`, `Frontend lint, types, ratchet and build` and
   `Docs links and explanation references`, `strict` (up to date) is on, a PR is required with 0
   approvals, linear history is required, force pushes and deletion are off, and it applies to admins
   (otherwise the agent's own admin token could still push to `main`, and AC1 would only hold for others).
4. (new) A PR whose required check fails can't be merged: `gh pr merge` refuses it.
5. (new) `.github/dependabot.yml` is valid (GitHub reports no config error) and covers uv (`backend/`),
   npm (`frontend/`), github-actions and docker (`backend/Dockerfile`, `docker-compose.yml`), weekly; it
   doesn't propose LocalStack versions that need an account token (ADR-0007).

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: AC3 (read the protection back; check names are the CI jobs' display
  names, which is what GitHub matches; admins included). AC4 (missed case: a red check really blocks a
  merge). AC5 (Dependabot config valid, LocalStack pin respected).
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - **Branches:** this repo (`Condo-app-revised`) has only `main` (P0-05's branch was deleted at merge).
    `develop`, `staging`, `starting` and `starting-james` live in the archived `building-website` repo,
    which this ticket doesn't name; deleting there is an unnamed outward-facing action, so it is left to
    James (inbox) and AC2 holds for this repo.
  - **Order:** the protection is applied while this PR is open, so this PR is the first one merged under
    it; the template is checked on the next PR (the phase-gate bookkeeping), because GitHub reads it from
    the default branch.
  - **PR template:** `docs/templates/PULL_REQUEST.md` moves to `.github/pull_request_template.md` (one
    copy, so the two can't drift); references updated.
  - **Enforce for admins** (autonomous): agents use James's admin token. Without it, AC1 is false for the
    only account that pushes. Every change already goes through a PR, so nothing is lost; James can switch
    it off in the settings if he needs an emergency push.
- Split: part b of [P0-04](./P0-04-repo-workflow-and-local-stack.md).
