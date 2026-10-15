# P0-03c — Frontend whitespace normalisation and pre-commit scope

| Field | Value |
|---|---|
| Phase / lane | P0 / B |
| Risk tier | 3 |
| Depends on | P0-03a, P0-03b (it touches the same files; doing it last avoids conflicts) |
| Status | todo |

Split from [P0-03](./P0-03-frontend-quality-gates.md). The scope item came from P0-02's review (the
pre-commit whitespace/EOF hooks were scoped to `backend/` because the frontend wasn't clean).

## Scope

- Extend the `end-of-file-fixer` and `trailing-whitespace` hooks in `.pre-commit-config.yaml` to `frontend/`.
- Run them once and commit the result. Nothing else changes.

## Acceptance criteria

1. `pre-commit run --all-files` passes on the PR head with `frontend/` in scope.
2. The change is whitespace-only: `git diff -w --ignore-blank-lines origin/main...HEAD -- frontend` is empty
   (transcript).
3. `npm run lint`, `npm run typecheck` and `npm run build` still pass (CI).

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split: part c of [P0-03](./P0-03-frontend-quality-gates.md).
