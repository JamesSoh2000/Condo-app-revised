# Explanation — P0-04b GitHub workflow: branch protection, PR template, Dependabot, branches

> Code at the head of PR #11 (2026-10-15), built autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it. The branch is rebased onto the latest `main` (checked with `git merge-base --is-ancestor origin/main HEAD`). Snapshot: if the code or settings change later, write a new explanation; lasting decisions live in ADRs. Form: full (Tier 2). Walkthrough variant: C (process: a change trying to reach `main`).

## Findings for the implementer (read first)

These are gaps between the PR's plan or decisions and what is on the branch or in the repository. None of them is in the protection itself, which matches the plan exactly.

1. **The inbox is not updated.** The ticket's Frame notes and the PR's decisions say the old `develop`/`staging`/`starting*` branches are "left to James (inbox)", and three decisions are marked autonomous. But `docs/HUMAN_INBOX.md` is not in the diff. Its PRE-1 row still says "Note: `main` has no branch protection today", which is now false. The merge gate box "inbox updated with any decisions to audit" is unticked, so this may still be planned, but it has not been done.
2. **There is no review record.** The PR's "Independent review" section is still the `<!-- filled after review -->` placeholder, and the PR has no review comments. The only trace of a review is the subject line of commit `9687a93`, "(review round 1)". §6 cannot list the findings or the verdict.
3. **The ticket index is stale.** The ticket says `in progress`, but its row in `docs/tickets/README.md` still says `todo`.

## 1. What was built and why

`main` on GitHub is now protected. Every change needs a pull request, the three CI jobs must pass, and the branch must be up to date with `main`. The rule applies to admins too, so the agents' admin token is bound by it. The PR template moved to `.github/` so GitHub fills it in on every new PR, and Dependabot (GitHub's bot that opens dependency-update PRs) now proposes updates weekly. Together these turn the playbook's merge gate from a convention into something GitHub enforces.

## 2. Decisions

| Decision | Alternative rejected | Why | Basis |
|---|---|---|---|
| Required checks are the CI jobs' display names (`Backend tests`, `Frontend lint, types, ratchet and build`, `Docs links and explanation references`) | The job ids (`backend-tests`, `frontend-checks`, `docs`), which the ticket's shorthand suggests | GitHub matches a required check by the name the job reports, which is its `name:`. An id would never report, so every PR would wait forever | default (GitHub behaviour) |
| `strict: true` (the branch must be up to date before merging) | Allow merging a branch that is behind `main` | Without it, CI can pass on a stale base and the merged result is never tested | ticket |
| A PR is required, with 0 approvals | Require 1 approval | Agents merge their own PRs. GitHub doesn't let an author approve their own PR, so requiring an approval would block every merge | ticket, ADR-0014 |
| `enforce_admins: true` | Leave admins exempt | Agents push with James's admin token. If admins were exempt, the only account that pushes could still push to `main`, and AC1 would be false. James can switch it off in Settings for an emergency push | **autonomous** |
| Linear history, no force push, no deletion of `main` | GitHub's defaults (all allowed) | A force push or deletion could rewrite or lose merged work. Linear history fits the squash-only workflow | ticket |
| Protection applied while this PR is still open | Apply it after merging | This PR becomes the first one merged under the rules, so its own merge is evidence. The template can't be checked here, because GitHub reads it from the default branch | **autonomous** |
| Move the PR template with `git mv`, no copy left in `docs/templates/` | Keep both files | Two copies drift | default |
| Dependabot ignores `localstack/localstack` | Let it propose upgrades | Newer LocalStack images need an account token. 4.14.0 is pinned on purpose ([ADR-0007](../adr/0007-private-s3-presigned-uploads.md), P0-04a) | **autonomous** |
| Separate `docker` (`/backend`) and `docker-compose` (`/`) entries | One `docker` entry, as the ticket lists it | The `docker` ecosystem reads Dockerfiles. Compose files need the `docker-compose` ecosystem | default (implied by ticket AC5) |
| `open-pull-requests-limit: 5` for uv and npm only | GitHub's default (also 5) everywhere | Effectively the same as the default. It documents the cap for the two noisy ecosystems | default |
| Old `develop`/`staging`/`starting`/`starting-james` branches are not touched | Delete them as the ticket's scope says | They are in the archived `building-website` repo, not this one. Deleting there is an outward-facing action the ticket doesn't name, so it stops at the boundary. (The inbox entry is missing, see Findings.) | stop rule |
| No `CODEOWNERS` file (it names who must review each path) | Add one | With one human and no approval gate it would only send notifications | ticket |

**What an interviewer would ask:** why a required check is matched by a display name and what happens when you rename a job (the check never reports, and every PR is blocked); why `enforce_admins` matters when the automation runs as an admin; how `strict` interacts with Dependabot (each of its PRs must be rebased after every merge to `main`, and Dependabot does this itself); why the template change can't be tested on the PR that adds it.

**Framing changes:** AC3 added (read the protection back from the API, the names are the jobs' display names, admins are included). AC4 added (a red check really blocks a merge). AC5 added (the Dependabot config is valid, covers the four ecosystems, and respects the LocalStack pin). Loosened: none. AC2 now covers this repository only (see the branches decision).

## 3. How it is implemented

### Overview

- **Branch protection on `main`**, set by a `PUT /repos/{owner}/{repo}/branches/main/protection` call. It is repository state, not a file in the diff, so it can only be checked through the API.
- `.github/workflows/ci.yml` (unchanged) provides the three jobs whose `name:` values are the required checks.
- `.github/pull_request_template.md` was moved from docs/templates/PULL_REQUEST.md (now gone), and its "copy me" comment removed.
- `.github/dependabot.yml` sets up five weekly update streams.
- Docs: `docs/AI_AGENT_PLAYBOOK.md` gains a paragraph on what GitHub now enforces. `docs/ENGINEERING_PRACTICES.md`, `docs/README.md` and `.claude/commands/implement-ticket.md` point at the template's new location.

### Walkthrough (Variant C: a change trying to reach `main`)

1. **Trigger, direct push.** Someone runs `git push origin HEAD:main`. GitHub runs the protection rules on the server. They require a PR, and `enforce_admins` means James's admin token gets no exemption. The PR quotes the rejection: `remote: - Changes must be made through a pull request.`, `! [remote rejected] HEAD -> main (protected branch hook declined)`, exit 1.
2. **Trigger, a PR.** An agent opens a PR. GitHub fills the body from `.github/pull_request_template.md`, which it reads from `main`, so only once this PR is merged.
3. **CI.** `.github/workflows/ci.yml::pull_request:` starts the three jobs. Each reports a status under its `name:`, for example `.github/workflows/ci.yml::name: Backend tests`. The protection's `contexts` list holds exactly those three strings, each tied to `app_id 15368` (GitHub Actions), so a status with the same name from another app doesn't count.
4. **Merge attempt.** `gh pr merge <N> --squash --delete-branch` asks GitHub to merge. GitHub refuses unless all three checks are green on the head commit and, because of `strict`, the head contains the current `main`. The PR's evidence for a red check is throwaway PR #12, an unused import that fails `Backend tests`: `Pull request #12 is not mergeable: the base branch policy prohibits the merge.` The API still shows #12 as `CLOSED` with `mergeStateStatus: BLOCKED`.
5. **End state.** A squash merge leaves one commit on `main`, which satisfies the linear-history rule. The repository still *allows* merge commits and rebase merges (`allow_merge_commit: true`), but a merge commit would break linear history, so GitHub blocks it. The playbook's squash habit stays a convention.
6. **Dependabot, weekly.** Dependabot reads `.github/dependabot.yml` from `main` and opens update PRs for uv, npm, actions, the Dockerfile and compose images, skipping LocalStack. Those PRs go through steps 3–4 like any other PR.
7. **Where it fails.** A renamed CI job means a required check that never reports. The PR then shows "Expected — Waiting for status to be reported", and nothing can merge until the protection's list is updated. The playbook paragraph `docs/AI_AGENT_PLAYBOOK.md::The required checks are matched by the CI jobs` warns about this.
8. **Recover.** Only an admin can change the protection: Settings → Branches, or the same `PUT` call. The playbook forbids an agent from doing it, or from using `gh pr merge --admin`, to get a merge through (`docs/AI_AGENT_PLAYBOOK.md::Never use`).

### Data model changes

None.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `.github/dependabot.yml` | New: five weekly update streams, LocalStack ignored | +33 |
| `.github/pull_request_template.md` | Moved from docs/templates/PULL_REQUEST.md (now gone); "copy me" comment removed | −1 |
| `docs/AI_AGENT_PLAYBOOK.md` | What GitHub enforces; never `--admin`; renaming a job needs the protection updated | +6 |
| `docs/ENGINEERING_PRACTICES.md` | Template link points at `.github/` | +1/−1 |
| `docs/README.md` | Templates row says where the PR template now lives | +1/−1 |
| `.claude/commands/implement-ticket.md` | Drops the "old path until P0-04" note | +1/−1 |
| `docs/tickets/P0-04b-github-workflow.md` | Framing: status, AC3–AC5, Frame notes | +27/−4 |
| Repository settings (not a file) | Branch protection on `main` | — |

**Key excerpts**

Branch protection, as read back on 2026-10-15 with `gh api repos/JamesSoh2000/Condo-app-revised/branches/main/protection` (trimmed; this is API output, not a repository file):

```json
"required_status_checks": {"strict": true,
  "contexts": ["Backend tests", "Frontend lint, types, ratchet and build",
               "Docs links and explanation references"],
  "checks": [{"context": "Backend tests", "app_id": 15368}, ...]},
"required_pull_request_reviews": {"required_approving_review_count": 0, ...},
"enforce_admins": {"enabled": true},
"required_linear_history": {"enabled": true},
"allow_force_pushes": {"enabled": false},
"allow_deletions": {"enabled": false},
"required_conversation_resolution": {"enabled": false},
"required_signatures": {"enabled": false}
```

- What it does: this is the ticket. It matches the PR's plan and AC3 setting by setting.
- Why: see §2. `app_id` 15368 binds each check to GitHub Actions.
- What breaks without a line: drop `enforce_admins` and the agents' token can push straight to `main`. Drop `strict` and a PR that is green on an old base merges untested. Drop a context and that job can be red at merge time.

`.github/workflows/ci.yml::name: Backend tests` (unchanged, but this is what the protection matches)

```yaml
jobs:
  backend-tests:
    name: Backend tests
  # ...
  frontend-checks:
    name: Frontend lint, types, ratchet and build
  # ...
  docs:
    name: Docs links and explanation references
```

- What it does: the `name:` is the status context each job reports.
- Why: the protection lists these strings and not the ids (§2, first row).
- What breaks: editing any `name:` without updating the protection leaves a check that never reports, and blocks every PR.

`.github/dependabot.yml::package-ecosystem: docker-compose`

```yaml
version: 2
updates:
  - package-ecosystem: uv
    directory: /backend
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
  # ... npm /frontend (same shape), github-actions /, docker /backend
  - package-ecosystem: docker-compose
    directory: /
    schedule:
      interval: weekly
    ignore:
      # Newer LocalStack images need an account token; 4.14.0 is pinned on purpose (ADR-0007).
      - dependency-name: localstack/localstack
```

- What it does: weekly update PRs for `backend/uv.lock`, `frontend/package-lock.json`, the actions in `ci.yml`, the `FROM` images in `backend/Dockerfile`, and the images in `docker-compose.yml`.
- Why: an `ignore` with no `versions` key skips every update for LocalStack. The only place that image appears is `docker-compose.yml`, so one ignore is enough.
- What breaks without the ignore: Dependabot would propose a LocalStack image that needs a token, and the S3 emulator would stop starting for anyone who merged it.

`docs/AI_AGENT_PLAYBOOK.md::GitHub enforces most of this`

```markdown
GitHub enforces most of this: `main` is protected (P0-04b). A PR is required, the three CI jobs must be
green and the branch up to date, history is linear, and the rules apply to admins. Never use
`gh pr merge --admin` or change the protection to get a merge through; that is loosening a protected gate.
The required checks are matched by the CI jobs' `name:`: renaming a job, or adding a job that must block
merges (P1-08 `prodlike`, P4-09 `e2e`), needs the protection's check list updated in the same PR.
```

- What it does: tells future agents the rules exist, and that they mustn't get around them.
- Why: the protection lives outside the repository, so a CI change can't update it. The coupling has to be written down where agents read it.
- What breaks without it: P1-08 adds a `prodlike` job, nobody adds it to the protection, and it is never required.

`.github/pull_request_template.md` (renamed; the only content change is the removed first line)

```diff
-<!-- Copy to .github/pull_request_template.md in P0-04 -->
 ## <ticket-id>: <title>
```

## 5. Edge cases and tests

There are no automated tests. This ticket is repository settings and config. All evidence is manual, recorded in the PR body, and partly re-checked for this explanation.

| What could go wrong | What the code does | Test or evidence |
|---|---|---|
| An admin token pushes straight to `main` | `enforce_admins: true` rejects it | PR AC1 transcript (the push was rejected, `origin/main` stayed `1055577`; re-checked: `main` is still `1055577…`) |
| A red check is merged anyway | Required contexts block the merge | PR #12 (re-checked: `CLOSED`, `BLOCKED`) |
| A check name doesn't match a job, so PRs are blocked forever | Names copied from `name:` | API read-back matches `ci.yml` (re-checked); PR #11's own checks report under those names |
| A stale branch merges green but broken | `strict: true` | Read-back only. No PR has been merged while behind `main` |
| `gh pr merge --admin` bypasses the rules | `enforce_admins` should refuse it | **Not tested** (the PR says so on purpose) |
| Dependabot proposes a LocalStack version that needs a token | `ignore` entry | YAML parse only. **No GitHub run yet** |
| The Dependabot config is invalid | — | **Not proven**: GitHub validates it only on the default branch |
| The template doesn't appear on new PRs | Moved to the path GitHub reads | **Not proven** until the next PR after merge |

Acceptance criteria → evidence:
- AC1: direct push rejected (PR transcript). The template part is deferred to the next PR.
- AC2: `git ls-remote --heads origin` shows only `main` and `p0-04b-github-workflow` (re-checked). This covers this repository only.
- AC3: API read-back (re-checked for this explanation; it matches field by field).
- AC4: PR #12 refused by `gh pr merge` (re-checked state).
- AC5: the local YAML parse lists the five ecosystems. GitHub's own validation and first run are deferred to the phase gate.

## 6. Review log

| Round | Reviewer | Verdict | Findings | Outcome |
|---|---|---|---|---|
| 1 | Not recorded | Not recorded | Not recorded in the PR. Commit `9687a93` ("playbook notes on the branch protection; README templates row (review round 1)") suggests two: the playbook didn't say what GitHub now enforces, and the `docs/README.md` templates row still listed the PR template | Fixed in `9687a93` (inferred from the commit) |

The PR's "Independent review" section is empty and no verdict is recorded anywhere (see Findings). The merge gate needs a `MERGE` verdict, and none is on record.

## 7. Not verified

- **`gh pr merge --admin` against `enforce_admins`**: not tried. GitHub's documented behaviour is that it is refused, but nobody has seen it.
- **The PR template on a real PR**: GitHub reads it from `main`, so it is unproven until the next PR.
- **Dependabot validity and its first run**: GitHub reports config errors only for the default branch. `uv` and `docker-compose` are newer ecosystems. Whether they parse `backend/uv.lock` and `docker-compose.yml` cleanly is unproven.
- **Dependabot will propose major image bumps that split CI from dev**: `postgres:16` in `docker-compose.yml` is covered, but the same `postgres:16` in the `ci.yml` `services:` block is not (the `github-actions` ecosystem updates `uses:` lines only). A merged compose bump to Postgres 17 or 18 would leave CI testing 16. The same applies to `python:3.12-slim` in the Dockerfile and `python-version` in CI. Nothing limits updates to minor or patch versions.
- **`strict` with Dependabot**: every merge to `main` makes the open Dependabot PRs out of date, and they must be rebased and re-run. This is expected, but untested.
- **The protection is not in the repository**: nothing in CI detects drift if someone edits it in Settings. The only record is this explanation and the PR body.
- **Settings that are off**: required conversation resolution, signed commits, `dismiss_stale_reviews`. These are reasonable with 0 approvals, but no decision was written for them.
- **Old branches in `building-website`**: not touched, and the inbox entry that was supposed to hand them to James is missing.

## 8. How to change this safely

- **Rename or add a CI job that must block merges** (P1-08 `prodlike`, P4-09 `e2e`): change `name:` in `.github/workflows/ci.yml` and, in the same PR, update `required_status_checks.contexts` with `gh api -X PATCH repos/{owner}/{repo}/branches/main/protection/required_status_checks`. Then read it back. A new required check that never reports blocks every PR, including the one that adds it. Add it to the protection only once the job has run on that PR.
- **Pin another image**: add an `ignore` under the matching ecosystem in `.github/dependabot.yml`. Use `versions` or `update-types` (for example, ignore `version-update:semver-major`) if you only want to block major bumps.
- **Emergency push**: James turns off "Do not allow bypassing the above settings" in Settings → Branches, pushes, then turns it back on and reads the protection back. Agents never do this.
- **Check after any change**: `GODEBUG=netdns=cgo gh api repos/JamesSoh2000/Condo-app-revised/branches/main/protection` and compare it with §4.

## 9. Must explain, then quiz

The ticket has no "Must explain" questions.

1. A CI job is renamed from `Backend tests` to `Backend tests and migrations` in a PR. What does GitHub show on that PR, and can it be merged?
2. Why is `enforce_admins` the setting that makes AC1 true in this repository, when it would be optional in a team where nobody uses an admin token day to day?
3. Why couldn't this PR prove that the PR template works or that the Dependabot config is valid, and when will those be proven?
4. What would break if we removed `strict: true` but kept the three required checks?
5. How would you extend this so that a Dependabot PR bumping Postgres can't leave CI on a different major version than the dev stack?

<details><summary>Answers</summary>

1. The new name reports, but the protection still waits for `Backend tests`. That check shows "Expected — Waiting for status to be reported", and the merge is refused. The only fix is to update the protection's contexts (`docs/AI_AGENT_PLAYBOOK.md::The required checks are matched by the CI jobs`).
2. Admins are exempt from protection unless `enforce_admins` is on. Here the agents push and merge with James's admin token, so without it the rules would bind no one who actually pushes.
3. GitHub reads `.github/pull_request_template.md` and `.github/dependabot.yml` from the default branch only. Both take effect after this PR merges. The next PR (the phase-gate bookkeeping) shows the template, and the first Dependabot run, or a config error in the repository's Insights → Dependency graph → Dependabot view, proves the config.
4. A PR that is green against an old `main` could merge after another PR changed `main`. The combined code would never have run through CI, so two individually green changes could break `main` together.
5. Two options. Make CI read the same image as compose (one variable or file both use). Or add an `ignore` with `update-types: ["version-update:semver-major"]` for `postgres` under `docker-compose`, and bump majors in a ticket that changes both files. Either way, extend `.github/dependabot.yml::package-ecosystem: docker-compose` and the `services:` block in `.github/workflows/ci.yml` together.

</details>
