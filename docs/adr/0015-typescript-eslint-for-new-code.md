# ADR-0015: Lint TypeScript with typescript-eslint's recommended rules

- Status: Accepted
- Date: 2026-10-14
- Deciders: agent (autonomous) in P0-03a

## Context

ADR-0011 moves the Base44 frontend to TypeScript file by file, and fences Base44 out of new code with ESLint
`no-restricted-imports` under `src/features/` and `src/app/`. ESLint's default parser cannot read TypeScript
syntax, so without a TypeScript parser the fence cannot run on `.ts`/`.tsx` files, which is where most new
code will live. `tsc --noEmit` checks types, not lint rules such as import restrictions or unused variables.

## Decision

- Add the `typescript-eslint` dev dependency.
- `.ts`/`.tsx` files under `src/` are linted with `typescript-eslint`'s `recommended` config (its parser plus
  its non-type-aware rules).
- `src/features/**` and `src/app/**` (JS or TS) use its parser and the Base44 `no-restricted-imports` rule.
- Legacy JSX keeps its existing config. Type-aware rules (`recommendedTypeChecked`) are not enabled yet.

## Consequences

- Positive:
  - The Base44 fence covers TypeScript.
  - New TypeScript code gets the standard rule set from its first file, so there is no backlog to clean up
    later.
- Negative / accepted risks: one more dev dependency (with two `@eslint-community` helpers bumped as its
  peers), and lint is slightly slower. There are no runtime or bundle effects.
- Follow-up work: consider `recommendedTypeChecked` once `src/api` and the first features exist (P1-07).

## Alternatives considered

- **Parser only, no rules:** the import fence works, but new TypeScript gets weaker linting than the legacy JSX.
- **Rely on `tsc` alone:** it can't enforce import restrictions.
- **Type-aware rules now:** slower, and there's nothing to type-check yet.

## Revisit when

The first `src/features/` slice merges (P2-06 or P4-07): decide on type-aware rules then.
