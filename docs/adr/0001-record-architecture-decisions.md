# ADR-0001: Record decisions as ADRs; adopt defaults now and revisit at pilot

- Status: Accepted
- Date: 2026-10-13

## Context

The old plan put product and policy decisions behind gates (M0-T09, M0-T10) that needed named building
owners, budget owners and UAT acceptors, and none of them exist yet. Schema and auth tickets depended on
those gates, so in practice no work could proceed.

The same rules were also restated across six documents and drifted apart.

## Decision

- Every significant technical or product decision is a short ADR in `docs/adr/`.
- Where a decision belongs to a future stakeholder (the pilot building), we **adopt a reasonable default now**,
  record it (ADR or [PRODUCT_SCOPE.md](../PRODUCT_SCOPE.md)), and give it a **"Revisit when"** trigger.
- Documents link to ADRs instead of restating them.

## Consequences

- Work is never blocked on a person who does not exist yet.
- Some defaults will change at pilot time. The schema is designed so that these are additive migrations.
- ADRs become portfolio evidence of engineering judgement.

## Alternatives considered

- **Decision gates with sign-offs:** correct for a funded launch with stakeholders, but blocking for a
  pre-pilot learning project.
- **Decide nothing until needed:** leads to implicit decisions buried in code that no one can explain.

## Revisit when

A pilot building signs on. Review every ADR that has a "Revisit when: pilot" trigger.
