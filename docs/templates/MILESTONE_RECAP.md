# Milestone Recap — <phase id and name>

Date: · Tickets: <IDs> · Drafted by the agent at the phase gate
([playbook](../AI_AGENT_PLAYBOOK.md#phase-gates-automated)); sections 7–9 are James's, optional.

## 0. Gate result

The phase's exit gate from the [roadmap](../ROADMAP.md), one line per item: pass / fail and the evidence
(CI run, command output, Playwright report). If any item failed: the fix tickets created, and the next phase
does not start until they merge.

## 1. What now works (demo script)

Steps someone can follow to see the phase's journey working: on the local prod-like stack (`make prodlike`)
until milestone D, then on staging.

## 2. Architecture delta

A mermaid diagram or a short list: new tables, endpoints, processes, infrastructure. Link the explanations.

## 3. Decisions made this phase

ADRs written and autonomous decisions (from [HUMAN_INBOX](../HUMAN_INBOX.md)), one line each. Flag any that
later tickets now depend on, since those get harder to overturn.

## 4. Agent performance

- Review rounds per ticket (median, max) and tickets that needed round 3:
- Findings caught by reviewers, by severity (link `AGENT_MISTAKES_LOG.md` entries):
- New `CLAUDE.md` rules or fitness tests added:
- Tickets blocked, and why:
- Where the agent was strongest / weakest:

## 5. Open risks and debt

Unfixed Medium/Low findings, "Not verified" items from the explanations, follow-ups.

| Risk / debt | Impact | Plan |
|---|---|---|

## 6. Suggested reading order

The phase's explanations in the order that builds understanding, with the 3 that matter most first.

## 7. What I learned (James, own words, optional)

## 8. Interview story (STAR, James, optional)

- Situation:
- Task:
- Action (what *I* decided, including the trade-offs, and how I directed the agents):
- Result (numbers if possible):

## 9. Three interview questions (agent proposes; James answers in their own words)

1. Q: … A:
2. Q: … A:
3. Q: … A:
