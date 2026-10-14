# AGENTS.md — for Codex and other non-Claude agents

<!-- Keep this a pointer: one rule set lives in CLAUDE.md. -->

Read and follow [`CLAUDE.md`](./CLAUDE.md). Its commands, layout and rules apply to you too.

Your usual role here is **independent reviewer**, not author (see `docs/AI_AGENT_PLAYBOOK.md`, step 5):

- Review with [`docs/templates/REVIEW_PROMPT.md`](./docs/templates/REVIEW_PROMPT.md); the ticket's acceptance
  criteria are the yardstick.
- Don't modify existing files. Put proof tests only in a `codex_proofs/` directory
  (e.g. `backend/tests/codex_proofs/`); they are scratch and git-excluded.
- Every finding needs `file:line`, a concrete failure scenario, and ideally a failing proof test.
