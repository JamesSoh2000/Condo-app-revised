# ADR-0015: Lint TypeScript with typescript-eslint's recommended rules

- Status: Accepted (updated 2026-10-17 in P2-06a: type-aware rules and `exhaustive-deps` are on)
- Date: 2026-10-14
- Deciders: agent (autonomous) in P0-03a; update: agent (autonomous) in P2-06a

## Context

ADR-0011 moves the Base44 frontend to TypeScript file by file, and fences Base44 out of new code with ESLint
`no-restricted-imports` under `src/features/` and `src/app/`. ESLint's default parser cannot read TypeScript
syntax, so without a TypeScript parser the fence cannot run on `.ts`/`.tsx` files, which is where most new
code will live. `tsc --noEmit` checks types, not lint rules such as import restrictions or unused variables.

## Decision

- Add the `typescript-eslint` dev dependency.
- `.ts`/`.tsx` files under `src/` are linted with `typescript-eslint`'s `recommended` config (its parser plus
  its non-type-aware rules) and `react-hooks/rules-of-hooks`, as legacy JSX is.
- `src/features/**` and `src/app/**` (JS or TS) get the Base44 fence. That block also names the
  `typescript-eslint` parser, which only matters for `.js`/`.jsx` there (TS files already get it above):
  - `no-restricted-imports`, with one regex covering `@base44/*`, the legacy `api/base44Client`, `entities` and
    `integrations` modules (any prefix, any extension)
  - `no-restricted-syntax` for `import()` and `require()`
  - `scripts/check-eslint-fence.sh` self-tests the fence in CI, because `eslint .` passes vacuously while those
    folders are empty
- Legacy JSX keeps its existing config. Type-aware rules (`recommendedTypeChecked`) are not enabled yet.

## Consequences

- Positive:
  - The Base44 fence covers TypeScript.
  - New TypeScript code gets the standard rule set from its first file, so there is no backlog to clean up
    later.
- Negative / accepted risks: one more dev dependency (with two `@eslint-community` helpers bumped as its
  peers), and lint is slightly slower. There are no runtime or bundle effects.
- Follow-up work: consider `recommendedTypeChecked` (see "Revisit when").

## Alternatives considered

- **Parser only, no rules:** the import fence works, but new TypeScript gets weaker linting than the legacy JSX.
- **Rely on `tsc` alone:** it can't enforce import restrictions.
- **Type-aware rules now:** slower, and there's nothing to type-check yet.

## Revisit when

When the typed API client (`src/api`, P1-07) or the first `src/features/` slice (P2-06) merges, whichever
comes first: decide on type-aware rules (`recommendedTypeChecked`) and `react-hooks/exhaustive-deps`.

## Update 2026-10-17 (P2-06a): the revisit

The "Revisit when" above fired: P1-07 merged `src/api`, and P2-06a adds the first `src/app` and
`src/features` code (the auth shell). Decision:

- `.ts`/`.tsx` files under `src/` are linted with `recommendedTypeChecked` (it replaces `recommended`), with
  `parserOptions.projectService` reading `tsconfig.json`.
- `react-hooks/exhaustive-deps` is an **error** on the same files (legacy JSX keeps its config).
- `projectService.allowDefaultProject` lists only the virtual files `scripts/check-eslint-fence.sh` pipes
  through `eslint --stdin` (`src/features/*.ts(x)`, `src/api/fence-probe.ts`). Without it every stdin case
  fails with "was not found by the project service". A real file at those paths would be "found in both"
  and fail lint, so the exception can't hide real code; real code lives in `src/features/<domain>/`.
- The self-test now also proves that `exhaustive-deps` and `no-floating-promises` fire as errors, and covers
  `src/api` (the sibling-barrel fence that PR #52 D6 had only probed by hand).

Evidence (P2-06a branch): on the shell's TypeScript code the switch found 3 errors (`no-misused-promises` on
a form's async `onSubmit`, `require-await` and `unbound-method` in tests), all fixed in the same PR; a full
`eslint .` took about 4 s.

Why now: the shell is the first code with async event handlers and effects that read changing values (the
router location, the query client). A floating promise there is a silently swallowed error, and a missing
effect dependency is a stale read, both of which these rules catch and `tsc` does not.

Alternatives: keep `recommended` and only add `exhaustive-deps` (rejected: the async-handler rules are the
ones that matter for TanStack Query code, and the cost measured above is small); a separate lint run for
type-aware rules (rejected: two configs to keep in step).

Consequences: lint needs type information, so it is slower and a file outside `tsconfig.json`'s `include`
fails to lint (which is what we want for `src/`). Tests are linted with the same rules.
