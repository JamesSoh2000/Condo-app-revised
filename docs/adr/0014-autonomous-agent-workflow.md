# ADR-0014: Agents build, review and merge tickets autonomously; humans audit asynchronously

- Status: Accepted
- Date: 2026-10-14
- Deciders: James
- Amends: the loop in [AI_AGENT_PLAYBOOK.md](../AI_AGENT_PLAYBOOK.md) as first written on 2026-10-13 (human
  frame, plan approval, human review with an explain-back gate, learning before the phase gate)

## Context

The 2026-10-13 plan put a human on the merge path of every ticket: framing the acceptance criteria, approving
the plan, reviewing the PR, and passing an explain-back gate. It assumed two developers reviewing each other.
Since 2026-10-13 James works alone. Every Tier 1 ticket on the serial critical path (P1-02 → … → P5-05) would
wait for one person's review, and the plan already named review latency as the main schedule risk. James
decided to let agents build without a per-ticket human check, while still getting a written explanation of
every ticket: the decisions, how it is implemented, and the code.

## Decision

- An agent runs every ticket end to end: frame → plan → implement → verify → independent review → explain →
  merge. No step waits for a human.
- **Machines and independent agents replace the human gates.** CI and the fitness tests are the hard gate. A
  fresh-session reviewer (plus Codex or a second reviewer for Tier 1) must return `MERGE` with no open
  Critical or High finding. The implementing session never reviews its own work.
- **The agent merges its own PR** (squash) once the merge gate in the playbook passes. Branch protection
  requires the status checks, not an approval.
- **Every merged ticket has an explanation** in `docs/explanations/`, written by a fresh session: decisions
  and alternatives, how it works, annotated excerpts of the code, the review log, and what was not verified.
- **Decisions without a human** follow fixed rules: follow the ticket/ADRs/scope; take the stub's default;
  otherwise choose the simplest reversible option and record it. Lasting decisions become ADRs marked
  "decided autonomously". Everything decided this way is listed in [HUMAN_INBOX.md](../HUMAN_INBOX.md) for
  James to audit when convenient.
- **The agent stops and escalates** (status `blocked`, entry in the inbox) only for the triggers listed in the
  playbook: human-only resources, contradictions with an accepted ADR or the product scope, weakening a gate,
  or a review that does not converge.
- **Learning is decoupled from delivery.** Quizzes, explain-back notes and the "Learned" column stay as
  James's own tools; they never block a merge or a phase gate.

## Consequences

- Positive: no review latency on the critical path; the two lanes can run as two parallel agent tracks again;
  every ticket still leaves an explanation and an audit trail (review log, decisions, inbox).
- Negative / accepted risks:
  - Bugs that CI, the fitness tests and the AI reviewers all miss reach `main` unseen. Reviewers from one
    model family share blind spots; Codex on Tier 1 reduces but does not remove this.
  - An agent could weaken the gates it is judged by. Mitigated by the protected-gate rule (loosening any gate
    is an escalation) and a review check for it, not by a technical control.
  - Autonomous decisions may drift from what James would choose. Mitigated by the inbox audit list and by
    ADRs being cheap to supersede.
  - James's understanding lags the code unless the explanations get read.
- Follow-up work: P0-04 sets branch protection to required checks with no required approval; `gh` must be
  authenticated where agents run (inbox prerequisite).

## Alternatives considered

- **Keep the human review gate, solo.** Safest, but one person becomes the bottleneck on every critical-path
  ticket; this is what James chose to drop.
- **Human review for Tier 1 only.** Most of the critical path is Tier 1, so it keeps most of the latency.
- **Agents open PRs, the human merges in batches.** A rubber-stamp merge adds latency without adding a check.

## Revisit when

- A bug reaches `main` that a human review would plausibly have caught, twice; or
- the pilot is scheduled (real residents' data raises the bar: reconsider human review for Tier 1 then; see
  [PILOT_READINESS.md](../PILOT_READINESS.md)).
