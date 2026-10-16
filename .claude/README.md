# Claude Code project commands for the autonomous build loop

The files in `.claude/commands/` (added in P0-01) let every session run the loop in
[docs/AI_AGENT_PLAYBOOK.md](../docs/AI_AGENT_PLAYBOOK.md) the same way. Each file becomes a slash command named
after the file (`/build-ticket P2-03`). `$ARGUMENTS` is replaced with what you type after the command.
Agents run the loop without stopping for a human ([ADR-0014](../docs/adr/0014-autonomous-agent-workflow.md)).

| Command | Loop step | Who runs it |
|---|---|---|
| [/build-next](./commands/build-next.md) `[A\|B]` | 0 Pick, then `/build-ticket` | You start it (or `/loop /build-next`); the agent picks |
| [/build-ticket](./commands/build-ticket.md) `<ID>` | 1–8, end to end, including merge | Implementer; it spawns the fresh reviewers and writes the explanation itself |
| [/frame-ticket](./commands/frame-ticket.md) `<ID>` | 1 Frame | Implementer (called by `/build-ticket`) |
| [/implement-ticket](./commands/implement-ticket.md) `<ID>` | 2 Plan + 3 Implement + 4 Verify | Implementer (called by `/build-ticket`) |
| [/review-ticket](./commands/review-ticket.md) `<ID> [round N]` | 5 Independent review; verdict `MERGE`/`BLOCK` | A **fresh** subagent or session |
| [/explain-ticket](./commands/explain-ticket.md) `<ID>` | 6 Explain; also re-run to update it | The **implementer** (parent session), after a reality pass |
| [/draft-ticket](./commands/draft-ticket.md) `<ID>` | Rolling wave: backlog stub → full ticket | Agent; a fresh reviewer checks the draft |
| [/milestone-recap](./commands/milestone-recap.md) `<phase>` | Automated phase gate + recap | Agent, after a phase's last merge |
| [/quiz-me](./commands/quiz-me.md) `<ID or topic>` | James's learning, any time | You answer; the agent grades |

Tips:
- The reviewer must have no memory of the implementation conversation; `/build-ticket` gets that by spawning
  subagents. They may still read any file in the repo. The explanation is written by the implementer, so it
  starts with a reality pass (re-read the code and tests, separate behaviour, rationale and limitations)
  ([ADR-0017](../docs/adr/0017-implementer-writes-the-explanation.md)).
- To stop the agents, set `Run state: paused` in [docs/HUMAN_INBOX.md](../docs/HUMAN_INBOX.md).
- Keep commands short. Long rules belong in `CLAUDE.md` and the docs they link to.
- If a command keeps needing the same correction, edit the command file (the agent does this in step 8).
