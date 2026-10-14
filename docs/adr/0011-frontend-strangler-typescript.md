# ADR-0011: Strangler migration of the Base44 frontend to a typed API client and TypeScript

- Status: Accepted
- Date: 2026-10-13

## Context

`frontend/` is a Base44 export:
- 124 `.jsx` files, 30 pages
- about 350 `base44.*` call sites across 33 entities
- lint advisory with 68 errors
- heavy, partly unused dependencies
- routes generated from `pages.config.js`

A full rewrite would stall the project. Migrating without guardrails would leave a half-Base44 app forever.

## Decision

- **Strangler fig, one slice at a time.** When a slice starts (packages, notices, …), its pages move to
  `src/features/<domain>/pages/*.tsx` and call only the new API. Legacy pages keep working, or are hidden,
  until their slice arrives.
- **Out-of-scope pages are hidden from routing** in P0-03. They are not deleted, and stay in git and in the
  scope map.
- **Typed API:** `openapi-typescript` generates `src/api/schema.d.ts` from FastAPI's OpenAPI, and
  `openapi-fetch` provides the client. CI regenerates the file and fails on any diff.
- **TypeScript** for new and migrated files (`tsconfig` with `allowJs`), so legacy JSX still builds.
- **Guardrails:**
  - ESLint `no-restricted-imports` bans `@base44/*` and `@/api/base44Client` under `src/features/`
  - the CI ratchet (`scripts/base44-count.sh`) fails if the count of `base44.` references increases
  - lint becomes blocking after the auto-fix of unused imports
- **Data layer:** React Query hooks per feature with building-scoped keys (see [02 §13](../ARCHITECTURE.md#13-frontend-architecture-adr-0011)).
- **Per-page judgement:** if an exported page is tangled, rewrite it using the existing shadcn/Radix
  components instead of untangling it. Decide when the slice starts.
- **At pilot readiness:** remove `@base44/sdk` and `@base44/vite-plugin`, and generate routes manually.

## Consequences

- The app always builds, and progress is measurable as a falling ratchet number.
- For a while the codebase has two styles (legacy JSX and typed features). This is acceptable, visible and
  shrinking.
- **The Base44 vite plugin** stays until all imports are gone. Check whether it injects runtime behaviour (the
  visual edit agent, `NavigationTracker`) and disable it in production builds early.

## Alternatives considered

- **Big-bang rewrite (Next.js or a fresh Vite TS app):** clean, but weeks without a working app.
- **A Base44-compatible backend API:** preserves frontend code, but bakes Base44's data model into the
  backend. Rejected by the old plan too.

## Revisit when

More than about 70% of pages are migrated. Then do a final sweep: remove the legacy folders, the plugin and
the unused dependencies.
