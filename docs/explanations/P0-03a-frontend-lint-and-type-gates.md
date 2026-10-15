# Explanation — P0-03a Frontend lint and type gates

> Code at the head of PR #6 (2026-10-14), built autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it. Snapshot: if the code changes later, write a new explanation. Form: short (Tier 3). Walkthrough variant: C (process: the CI frontend job on a PR).

**1. What changed and why.** The frontend CI job used to build and then run lint as a non-blocking "baseline" (68 unused-import errors). Now it runs five blocking steps: lint, an ESLint fence self-test, `tsc` type check, a Base44 ratchet and the Vite build. The 68 unused imports were removed so lint passes. New code under `src/features` and `src/app` can't import Base44 ([ADR-0011](../adr/0011-frontend-strangler-typescript.md)), and that fence also covers TypeScript files ([ADR-0015](../adr/0015-typescript-eslint-for-new-code.md)).

**2. Decisions** (*autonomous* = no written rule)
- Split P0-03 into a (gates), b (proxy and route scope) and c (whitespace): one PR would be ≈860 whitespace lines plus behaviour changes. Basis: playbook split rule; reasons in `docs/tickets/P0-03-frontend-quality-gates.md`.
- Add the `typescript-eslint` dev dependency and its `recommended` rules for `src/**/*.{ts,tsx}`. Rejected: parser only (new TS gets weaker linting than legacy JSX); `tsc` alone (it can't ban imports). *Autonomous, lasting* → ADR-0015.
- The fence is one regex, `frontend/eslint.config.js::BASE44_SOURCE`, covering `@base44/` and the legacy `api/base44Client`, `api/entities` and `api/integrations` modules with any prefix (`@/`, `../`) and any extension. Rejected: `paths` + `patterns` (reported `@/api/base44Client` twice). The PR's decision table still describes the earlier three-glob list; the regex replaced it in review round 1. Also, `no-restricted-imports` only sees static `import`/`export`, so `frontend/eslint.config.js::noBase44DynamicImports` adds `no-restricted-syntax` selectors for `import()`, `require()` and template-literal `import()`. *Autonomous* (review round 1–2).
- `scripts/check-eslint-fence.sh` runs in CI because `src/features` and `src/app` are empty today, so `eslint .` passes even with a broken or crashing fence. It requires severity 2 ("error"): CI runs `eslint --quiet`, which hides warnings. *Autonomous* (review rounds 1–2).
- `tsconfig.json` with `allowJs: true`, `checkJs: false`, `strict: true`; `jsconfig.json` deleted (nothing referenced it). Basis: ticket.
- The ratchet counts occurrences (`grep -o`), not lines; the baseline must match `^(0|[1-9][0-9]*)$` because bash arithmetic reads `08` as invalid octal and skipped both checks. *Autonomous* (review round 2).
- An unused `eslint-disable-next-line react-hooks/exhaustive-deps` comment was dropped (the rule isn't enabled); the CI job was renamed "Frontend lint, types, ratchet and build". *Autonomous, ticket-local.*

**3. Files changed.** `.github/workflows/ci.yml::frontend-checks:` (steps Lint, ESLint fence self-test, Type check, Base44 ratchet, Build; `continue-on-error` and the summary step removed) · `frontend/eslint.config.js` (TS config and fence) · `frontend/tsconfig.json` (new) · frontend/jsconfig.json (deleted) · `frontend/package.json::"typecheck"` and `typescript-eslint` (plus `frontend/package-lock.json`) · `scripts/base44-count.sh` and `frontend/base44-baseline.txt` (361) · `scripts/check-eslint-fence.sh` (18 cases) · 23 legacy files under `frontend/src/components` and `frontend/src/pages` (unused imports removed only) · ADR-0015 and the P0-03, P0-03a/b/c ticket files · `.pre-commit-config.yaml` (comment now points at P0-03c).

**Walkthrough (C).** *On a push or PR*, job `frontend-checks` runs `npm ci`, then in order (the first failure skips the rest): (1) **Lint** `eslint . --quiet`: legacy rules on `src/components`, `src/pages`, `frontend/src/Layout.jsx`; `typescript-eslint` recommended plus `rules-of-hooks` on any `.ts/.tsx`; the Base44 fence on `src/features/**` and `src/app/**`. Catches unused imports, hooks called conditionally, Base44 imports in new code. (2) **ESLint fence self-test** pipes 18 snippets through `eslint --stdin` (nothing is written) and checks that each one triggers the fence, the hooks rule, or nothing; a misconfigured, crashing or downgraded-to-`warn` fence prints `FAIL expected fence, got none` and `::error::N ESLint fence check(s) failed`. (3) **Type check** `tsc --noEmit -p tsconfig.json`: type-checks `.ts/.tsx` (today only `frontend/src/utils/index.ts`); `.js/.jsx` are parsed but not type-checked. A type error prints `error TS2322 …` and exits 2. (4) **Base44 ratchet** counts `base44.` and `@base44/` under `frontend/src`; higher than the baseline prints `::error::Base44 references went up from 361 to 362` and exits 1 (the AC4 demo run failed exactly here). (5) **Build** `vite build`. To re-run locally: `cd frontend && npm run lint && bash ../scripts/check-eslint-fence.sh && npm run typecheck && bash ../scripts/base44-count.sh && npm run build`.

**4. The code.** The fence, `frontend/eslint.config.js::noBase44DynamicImports` and the config block that applies it:

```js
const BASE44_SOURCE = "^(@base44/|(.*/)?api/(base44Client|entities|integrations)(\\.[cm]?[jt]sx?)?$)";
// ...
const esqueryBase44 = `/${BASE44_SOURCE.replaceAll("/", "\\x2F")}/`;
const noBase44DynamicImports = [
  "error",
  { selector: `ImportExpression[source.value=${esqueryBase44}]`, message: BASE44_MESSAGE },
  // ...
];
// ...
  {
    files: ["src/features/**/*.{js,jsx,ts,tsx}", "src/app/**/*.{js,jsx,ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "no-restricted-imports": noBase44Imports,
      "no-restricted-syntax": noBase44DynamicImports,
    },
  },
```

The selectors are esquery (ESLint's AST query language) and its regex literals can't contain `/`, so it is rewritten as `\x2F`. Without `no-restricted-syntax`, `import('@/api/base44Client')` and `require(…)` pass lint (the PR's mutant run: 3 FAILs in the self-test). `parserOptions` with `jsx: true` is what lets `.js/.jsx` files here parse JSX. The `parser: tseslint.parser` line is close to redundant: checked for this explanation, `.ts/.tsx` already get that parser from the `recommended` block, and with the line removed the fence still fires on `.ts`, `.js` and `.jsx`; its only effect is that a `.js` file in these folders may contain TypeScript syntax.

**5. How to verify it.** Re-run for this explanation on the PR head: `npm run lint` exit 0 (no output); fence self-test `ESLint fence: all checks passed.`; `npm run typecheck` exit 0; ratchet `Base44 references under frontend/src: 361 (baseline: 361)` exit 0. The lint fix is mechanical (AC8): `git diff -U0 origin/main...HEAD -- frontend/src` shows only removed import specifiers or lines, plus the one disable comment. AC1 and AC4 rest on CI runs 38671639647 and 38671547176 (in the PR); AC5–AC7 rest on transcripts in the PR plus the committed fence self-test (which covers AC5). No automated test covers the ratchet itself (AC6, the leading-zero rule, missing `src`); only transcripts do.

**6. Review.** Three fresh Claude rounds, all MERGE. Round 1 fixed fence bypasses (`.js` extension, `entities`/`integrations` barrels, `import()`, `require()`), added `rules-of-hooks` for TS, a strict baseline format and `grep -R`. Round 2 fixed the octal baseline hole, the severity check in the self-test, a missing `src` and template-literal `import()`. **Not fixed / not verified:** inline `eslint-disable` comments or an `eslint-suppressions.json` can switch the fence off for a real file; obfuscated paths (`@/api/./base44Client`, `@/api//base44Client`, `?import` suffixes, string concatenation in `import()`, `import.meta.glob`) pass the fence; a file with a NUL byte isn't counted by the ratchet, and `|| true` hides grep exit 2 (unreadable files); `.mts/.cts` aren't linted; JS files in `src/features` get only the fence, no other rules; the regex also flags any `…/api/entities` from an npm package. `react-hooks/exhaustive-deps` is off everywhere. The PR says ADR-0015 is in the inbox, but `docs/HUMAN_INBOX.md` has no P0-03a line on this branch.

**7. How to change it safely.** When a PR removes Base44 references, lower `frontend/base44-baseline.txt` to the printed count in that PR; never raise it. To widen the fence (a new folder or module), edit `BASE44_SOURCE` or the `files:` list and add a `check fence …` line to `scripts/check-eslint-fence.sh`; the self-test then proves it fires.

**Must explain.** (1) A *ratchet* is a check that only lets a number move one way: here Base44 references may go down, never up. Fixing all 361 references first would block every other ticket for weeks; the ratchet allows the legacy code to stay but stops it from growing, and each migration PR locks in its progress by lowering the baseline (`scripts/base44-count.sh`). (2) `strict: true` turns on all strict type checks (null checks, no implicit `any`), but `checkJs: false` applies them only to `.ts/.tsx`. With `allowJs`, JS files are still part of the program, so a TS file can import them, but their type errors aren't reported: today `tsc` checks one file (`frontend/src/utils/index.ts`). Each file renamed to `.ts/.tsx` is then checked strictly with no opt-in step. (3) `no-restricted-imports` stops new code from depending on Base44 (the SDK, `api/base44Client` or its `entities`/`integrations` re-exports), so migrated features go through the typed `src/api` client. It applies only to `src/features` and `src/app` because the legacy pages are Base44 by design (ADR-0011's strangler plan); banning it there would mean rewriting them all first. The ratchet covers the legacy side.

**Quiz.** 1. Why is lint not enough to prove the fence works today? 2. Why must the self-test require `"severity":2`? 3. A PR adds `base44.entities.Foo` and removes one other reference. Does the ratchet fail? 4. What breaks if we remove the `no-restricted-syntax` rule from the features/app block? 5. How would you extend the fence to forbid Base44 in a new `src/widgets` folder?

<details><summary>Answers</summary>

1. No file exists under `src/features` or `src/app`, so the fence rules never run; a broken selector crashed ESLint only on those files, and `eslint .` still passed. 2. CI runs `eslint --quiet`, which drops warnings, so a fence downgraded to `warn` would silently stop blocking. 3. No: the count stays 361, so it passes. The ratchet measures the total, not each addition; the ESLint fence is what stops new imports in new code. 4. Static imports are still fenced, but `import('@/api/base44Client')`, `require(…)` and template-literal `import()` pass lint; the self-test catches it (`FAIL expected fence, got none`, exit 1), so CI fails at that step. 5. Add `"src/widgets/**/*.{js,jsx,ts,tsx}"` to that block's `files:` list and add `check fence src/widgets/x.ts …` and `check none` lines to `scripts/check-eslint-fence.sh`.
</details>
