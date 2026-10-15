# Explanation — P0-03c Frontend whitespace normalisation and pre-commit scope

> Code at the head of PR #8 (`b8ca565`, 2026-10-15), built autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it. The branch contains the latest `origin/main`. Snapshot: if the code changes later, write a new explanation. Form: short (Tier 3). Walkthrough variant: C (a local commit runs the hooks).

**1. What changed and why.** P0-02 limited the pre-commit `end-of-file-fixer` (makes every file end in exactly one newline) and `trailing-whitespace` (deletes spaces at line ends) hooks to `backend/`, because the legacy frontend wasn't clean. This ticket adds `frontend/` to both hooks and commits one run of them over the frontend (97 files, whitespace only). After this, frontend diffs no longer carry whitespace noise.

**2. Decisions** (*autonomous* = no written rule; these are in the inbox)
- The 7 changed lines that sit *inside* a JS string or template literal are kept, and no file is excluded. `frontend/src/Layout.jsx::className={` is a Tailwind class list, which splits on any whitespace. `frontend/src/components/NotificationHelper.jsx::<a href=` is HTML email markup, and HTML collapses whitespace. `frontend/src/pages/Concierge.jsx::prompt:` is an LLM prompt, where trailing spaces before a newline mean nothing. Rejected: excluding those 3 files, which would leave permanent holes in the gate. *Autonomous.*
- The hooks cover all of `frontend/`, including legacy Base44 files and `frontend/base44/*.jsonc`. Rejected: only `frontend/src/features/`. Basis: ticket.
- No `--markdown-linebreak-ext=md` argument (this keeps two trailing spaces, which mark a Markdown hard line break). No Markdown under `frontend/` needs it today. Basis: default (smallest change).
- **Framing changes:** added AC4 (whitespace inside literals, which `git diff -w` can't see because it ignores *all* whitespace changes, including those inside strings) and AC5 (the config diff stays minimal). Nothing loosened.

**3. Files changed.** `.pre-commit-config.yaml::end-of-file-fixer` and `.pre-commit-config.yaml::trailing-whitespace` (their `files:` patterns gain `frontend/`) plus the header comment · 97 files under `frontend/` (88 JS/JSX/TS, 6 `.jsonc`, `frontend/components.json`, `frontend/src/index.css`, `frontend/src/assets/react.svg`), whitespace only, in the separate `style(frontend)` commit `b8ca565` · `docs/tickets/P0-03c-frontend-whitespace-and-pre-commit.md` (frame notes) · `docs/tickets/README.md` (status `in progress`).

**Walkthrough (C).** After `cd backend && uv run pre-commit install`, a `git commit` that stages any file under `backend/` or `frontend/` (or the config itself) runs both hooks on those files. If a hook rewrites a file, the commit aborts with exit 1 and the fixed file is left unstaged. You `git add` it and commit again. CI doesn't run pre-commit, so a machine without `install` can still push whitespace (see 6).

**4. The code.** `.pre-commit-config.yaml::trailing-whitespace`:

```yaml
      - id: end-of-file-fixer
        files: ^(backend/|frontend/|\.pre-commit-config\.yaml$)
      - id: trailing-whitespace
        files: ^(backend/|frontend/|\.pre-commit-config\.yaml$)
```

`files:` is a regular expression matched against each repo-relative path. Without `frontend/` here, the frontend cleanup would decay with the next commit. The top-level `exclude:` for the baseline migration still applies.

**5. How to verify it.** `cd backend && uv run pre-commit run --all-files` → all six hooks `Passed` (re-run for this explanation on `b8ca565`). `git diff -w --ignore-blank-lines origin/main...HEAD -- frontend | wc -l` → `0` (re-run: `0`). CI on the PR: backend, frontend (lint, typecheck, Base44 ratchet, build) and docs jobs pass. The 7 in-literal lines were spot-checked against `origin/main`. All 7 are trailing whitespace inside a template literal, as the PR says. The TypeScript-parser scan itself was not re-run here, so "exactly 7" rests on the PR transcript. No automated test covers AC2 or AC4. They are transcript evidence only.

**6. Review.** No review round has been recorded on the PR yet ("Independent review" is still a placeholder). **Not verified:** that the rendered sidebar, notification email and Concierge replies look the same (nobody ran the app); pre-commit only runs where someone ran `install`, and CI has no whitespace check.

**7. How to change it safely.** To add a directory, extend both `files:` patterns together and run `uv run pre-commit run --all-files` in its own commit. If a literal ever needs its trailing whitespace (a Markdown string with a hard line break, say), exclude that file by name in the hook rather than turning the hook off.

**Mismatches with the PR** (for the implementer): the PR body says 98 frontend files; the diff has 97 (100 in total with the config and two ticket docs). It says 4 hand-written config lines; the config diff changes 3 (the comment and two `files:` lines). The merge-gate checklist names the file as P0-03c.md, without the slug; the file is `docs/explanations/P0-03c-frontend-whitespace-and-pre-commit.md`, following the `<id>-<slug>` rule.

**Quiz.** 1. Why can't `git diff -w` prove that a whitespace-only change is safe? 2. Why is trailing whitespace in a Tailwind `className` template harmless? 3. What breaks if we remove `frontend/` from the `trailing-whitespace` pattern? 4. A hook rewrites a file during `git commit`: is the commit created? 5. How would you extend this to also run Prettier on `frontend/`?

<details><summary>Answers</summary>

1. `-w` ignores whitespace changes inside string literals too, so a change to a runtime string value looks empty; AC4's parser scan covers that gap. 2. Tailwind and the browser split `class` on any run of whitespace, so the set of classes is the same. 3. Nothing fails at once, but new trailing whitespace in frontend files is no longer caught, and diffs fill with noise again. 4. No: the hook exits 1, leaves the fix unstaged, and you re-add and commit. 5. Add a Prettier hook scoped to `^frontend/` in `.pre-commit-config.yaml` and a `prettier --check` step in the frontend CI job, and commit the first reformat on its own, checked for changes inside literals the same way (AC4).
</details>
