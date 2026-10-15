# Human Inbox

The one page James checks. Agents build and merge on their own
([ADR-0014](./adr/0014-autonomous-agent-workflow.md)) and write here only when they need James, or when they
decided something James may want to overturn. Agents update it through PRs; James edits it directly.

**Run state: running**

<!-- Set to `paused` to stop agents at the next step 0 of the loop (docs/AI_AGENT_PLAYBOOK.md). -->

## Blocked — needs James

The agent stopped on a [stop rule](./AI_AGENT_PLAYBOOK.md#stop-rules). Write your answer under the item.
The next `/build-next` unblocks the ticket and moves the item to "Resolved".

| # | Date | Ticket | What's needed | Options (agent's recommendation first) | Blocks |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

## Prerequisites coming up

Human-only setup the plan will need soon. Agents add these ahead of time so nothing waits on them.

| # | Needed by | What | Status |
|---|---|---|---|
| PRE-1 | the first autonomous merge (P0-01) | `gh auth login` in the environment where agents run, with a token that can merge PRs and edit branch protection (P0-04). Without it, agents can open PRs but not merge them | open |
| PRE-2 | P0-02 (Tier 1 reviews start at P1-02) | Codex CLI installed and logged in for the `codex-review` skill. Without it, Tier 1 falls back to a second Claude reviewer | open |
| PRE-3 | milestone D (start ~week 8) | AWS account with MFA and budget alerts, a domain, SES domain verification ([D-01](./tickets/D-01-terraform-base.md)) | not yet |

## Decisions to audit

Made by agents under the [decision rules](./AI_AGENT_PLAYBOOK.md#decision-rules), without you. Skim weekly.
To overturn one, write a superseding ADR or a ticket; agents build it like any other.

| Date | Ticket | Decision | Where recorded | Reversible? |
|---|---|---|---|---|
| — | — | — | — | — |

## Resolved

| # | Ticket | Answer | Date |
|---|---|---|---|
