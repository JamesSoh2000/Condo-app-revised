# ADR-0012: Polling with React Query for freshness; no WebSockets or Redis in the MVP

- Status: Accepted
- Date: 2026-10-13

## Context

Residents should see new packages, notices and notification badges without refreshing. Base44 used entity
subscriptions. Real-time infrastructure (WebSockets, Redis pub/sub) adds stateful connections, deploy
complexity and new failure modes.

## Decision

- **Badge and summary** endpoints are cheap (indexed counts) and polled every **30 s** while the tab is
  visible:
  - React Query `refetchInterval: 30_000`
  - `refetchIntervalInBackground: false`
  - a refetch on window focus
- **Lists refetch** on focus and after mutations (targeted `invalidateQueries`). They do not poll.
- **Urgent notices** use the same 30 s summary poll. The product promise is "visible within about a minute
  while the app is open", not emergency alerting ([01](../PRODUCT_SCOPE.md)).
- No WebSockets, SSE or Redis in the demo or pilot.

## Consequences

- Planning load is 100 sessions × 1 request per 30 s ≈ 3.3 requests/s of cheap queries. That is trivial.
- Up to 30 s staleness, which is acceptable for packages, notices and maintenance.
- Deploys and restarts never drop "connections".

## Alternatives considered

- **WebSockets + Redis:** needed for chat, overkill for badges.
- **Server-Sent Events:** simpler than WebSockets, but still long-lived connections through Caddy. A good next
  step if freshness requirements tighten.
- **Postgres `LISTEN/NOTIFY` + SSE:** an elegant path with one API process. Revisit with SSE.

## Revisit when

Live chat is selected (post-MVP), staleness under 5 s is required, or measured polling load becomes
significant.
