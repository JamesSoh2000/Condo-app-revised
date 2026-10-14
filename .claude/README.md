# Claude Code project commands for the build → review → explain loop

The files in `.claude/commands/` (added in P0-01) let every session run the loop the same way. Each file becomes a slash command named after the file (`/frame-ticket P2-03`). `$ARGUMENTS`
is replaced with what you type after the command.

| Command | Loop step | Who drives |
|---|---|---|
| [/draft-ticket](./commands/draft-ticket.md) `<ID>` | Before 1: turn a backlog stub into a full ticket | Agent drafts; human edits and accepts |
| [/frame-ticket](./commands/frame-ticket.md) `<ID>` | 1 Frame | Human decides; agent questions and drafts |
| [/implement-ticket](./commands/implement-ticket.md) `<ID>` | 2 Plan + 3 Implement | Agent; human approves the plan |
| [/review-ticket](./commands/review-ticket.md) `<ID>` | 5 Independent review | Agent in a **fresh** session |
| [/explain-ticket](./commands/explain-ticket.md) `<ID>` | 7 Explain | Agent in a **fresh** session drafts; human checks |
| [/quiz-me](./commands/quiz-me.md) `<ID or topic>` | 9 Learn (after merge) | Agent asks; the dev who drove the agent answers without looking |
| [/milestone-recap](./commands/milestone-recap.md) `<phase>` | Milestone gate | Agent drafts; humans fill in their own sections |

Tips:
- Run `/review-ticket` and `/explain-ticket` in a new terminal or session (or a new worktree). The point is
  that the reviewer and the explainer have no memory of the implementation conversation. They may still read
  any file in the repo.
- Keep commands short. Long rules belong in `CLAUDE.md` and the docs they link to.
- If a command keeps needing the same correction, edit the command file. That edit is a learning artifact too.
