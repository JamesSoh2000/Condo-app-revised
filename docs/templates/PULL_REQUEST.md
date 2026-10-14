<!-- Copy to .github/pull_request_template.md in P0-04 -->
## <ticket-id>: <title>

Ticket: docs/tickets/<file>.md · Risk tier: 1 / 2 / 3 · Non-test lines changed: <N> (limit ~400)

### What and why
<!-- 2–4 lines. What changes for the user or system, and why this approach. -->

### Decisions and alternatives
<!-- Each non-obvious choice, the alternative considered, and why it lost. The explainer runs in a fresh
     session and gets the "why" only from here, so write it for someone who wasn't in the conversation. -->
| Decision | Alternative | Why not |
|---|---|---|

### Acceptance criteria → evidence
| # | Criterion | Evidence (test name / command output / screenshot) |
|---|---|---|
| 1 | | |

### Interfaces changed
<!-- Endpoints, schemas, tables, env vars, CLI. "None" is a valid answer. -->

### Migration
<!-- Revision id + one-line summary. Expand/contract safe with the previous release? Reviewed by a human? -->

### ADR candidates
<!-- Decisions made here that are not covered by the ticket or an ADR. The reviewer accepts them, or asks for an ADR. -->

### Independent AI review
<!-- Link or paste the summary. Findings fixed / dismissed (with reason). -->

### Human checklist
- [ ] CI green (backend, frontend, prodlike, e2e when applicable)
- [ ] Rebased onto the latest `main` (the explanation assumes the merged tree equals this PR's head)
- [ ] Tenant test table applied where relevant (docs/ENGINEERING_PRACTICES.md §7)
- [ ] Reviewer: I ran it locally and tried one thing the tests don't cover
- [ ] Reviewer: I can explain every changed file (explain-back gate)
- [ ] Explanation written in a fresh session: docs/explanations/<ticket>.md (full form, or short form for Tier 3); reference check passes
- [ ] `.env.example` updated, with secrets marked (if settings changed)
- [ ] OpenAPI types regenerated (if the API changed)

<!-- Learning (quiz, explain-back note, hand-written change, bug hunt) happens after merge, within 2 working
     days, and is tracked in the ticket index "Learned" column. It does not block this PR. -->
