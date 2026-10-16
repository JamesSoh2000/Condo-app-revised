# ADR-0017: The implementer session writes and edits the explanation, after a reality pass

- Status: Accepted
- Date: 2026-10-16
- Deciders: James (instruction in session)
- Amends: [ADR-0014](./0014-autonomous-agent-workflow.md), the bullet "Every merged ticket has an explanation
  ... written by a fresh session". Reviews are unchanged: they still run in fresh sessions.

## Context

[ADR-0014](./0014-autonomous-agent-workflow.md) had a fresh subagent write each explanation, so that it
described the code that exists and not what the implementer intended. That subagent started cold each time,
and every later change to the code needed another fresh one. James asked for the parent agent, the
implementer session that runs `/build-ticket`, to write and edit the explanation instead.

The risk that came with the fresh session was the reason for it: a builder explains what it meant to write,
not what is in the code after three review rounds of fixes.

## Decision

- **The implementer (parent) session writes the explanation in step 6 and edits it** whenever a later commit
  touches what it describes: a review round, a CI fix, a rebase that conflicted in the ticket's files, a
  mismatch found while writing. No subagent writes or updates it.
- **Review is not affected.** The implementer still never reviews its own work; every reviewer is a fresh
  session.
- **The risk is reduced by a reality pass**, defined in the
  [playbook](../AI_AGENT_PLAYBOOK.md#the-reality-pass) and the [template](../templates/EXPLANATION.md):
  1. Re-read, don't recall. Before writing and before every edit, re-read the diff, the files and symbols to
     be cited, and the tests from disk at the source revision, and run the tests to be cited. Memory of the
     conversation is a hypothesis to check, not a source.
  2. Keep three kinds of statement apart: **implemented behaviour** (what the code does now), **design
     rationale** (why, labelled recorded or inferred) and **limitations** (what it does not do, what is not
     verified, accepted risks).
  3. Compare the final code with the PR's plan and decisions. Describe the final state; earlier approaches
     appear only in the review log. A deviation is recorded in the PR, and a deviation that is a defect is a
     finding (fix test-first, new review round).
  4. Audit the finished text against the code before committing. The header records what was re-read and run.
- **Remembered intent is not a source.** A rationale that exists only in the conversation is first written
  into the PR's "Decisions and alternatives" (only what the implementer actually knew), then cited from there.
  Otherwise the explanation says "Rationale not recorded".

## Consequences

- Positive: no cold start per ticket; a later edit is made by the session that holds the whole record, and
  the explanation can follow the code through review rounds without a new subagent each time.
- Negative / accepted risks:
  - The independent cross-check is gone. Through P1-07 the fresh explainer is named as the catcher in six
    [AGENT_MISTAKES_LOG](../AGENT_MISTAKES_LOG.md) entries (claims made before the evidence existed, a property
    generalised from one persona to both, a plan the code contradicted). The writer now has to catch these by
    re-reading, and a writer that wrote the code shares its blind spots.
  - `scripts/check-explanation-refs.py` checks that anchors exist, not that a claim is true.
  - The reality pass is a procedure, and nothing but its recorded evidence (the header line, the PR) shows
    it was done.
- Follow-up work: none needed in code. The playbook, the explanation template, `/explain-ticket`,
  `/build-ticket`, the PR template, `CLAUDE.md` and the READMEs were updated with this ADR.

## Alternatives considered

- **Keep the fresh explainer.** Gives an independent check on the explanation; it was dropped on James's
  instruction.
- **Parent writes, a fresh session checks the finished explanation.** Restores independence at a smaller cost
  than writing it, but it is another step per ticket. Not chosen now; it is the first thing to restore (see
  below).

## Revisit when

- A reviewer or James finds, twice, an explanation statement the code at its source revision contradicts. Then
  restore a fresh check of the explanation for Tier 1 tickets, or the fresh explainer.
