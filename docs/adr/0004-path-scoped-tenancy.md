# ADR-0004: Path-scoped tenancy with a server-validated TenantContext

- Status: Accepted
- Date: 2026-10-13

## Context

A user can belong to several buildings with different roles. Different browser tabs may look at different
buildings. The server must never act on a building the user is not an active member of.

The old plan used tab-specific membership-bound access tokens for this.

## Decision

- All building-scoped endpoints live under **`/api/buildings/{building_id}/…`** and use one router with the
  router-level dependency `get_tenant_context`.
- `get_tenant_context` loads the **active** membership for `(current user, building_id)` with its roles and the
  building's enabled features, then returns a frozen `TenantContext(user_id, building_id, membership_id,
  roles, features)`.
- **No active membership → 404** (`building_not_found`). The response never reveals that the building or record
  exists.
- **Wrong role → 403** (`forbidden_role`). **Disabled feature → 403** (`feature_disabled`).
- **Services filter every query by `ctx.building_id`.** A record ID from another building is a 404.
  Record-level visibility (own vs all) is a service function per domain.
- **Pending onboarding** endpoints use a separate, narrower dependency (`get_own_membership`) that permits
  `pending` but exposes only onboarding operations.
- **Fitness tests** make this structural (see [02 §7](../ARCHITECTURE.md#7-tenancy-and-authorization-adr-0004)):
  - every `/api/buildings/{building_id}` route carries the tenant dependency
  - every `/api/*` route requires auth unless allowlisted
  - a building-B member gets 404 on all building-A routes
- **The frontend** keeps the selected building per tab (`sessionStorage`) and includes it in every path and
  React Query key.

## Consequences

- Per-tab context needs no special tokens. Each request states its building, and the server checks it.
- URLs are explicit and debuggable, logs show the building, and OpenAPI documents the scoping.
- The "never trust a client `building_id`" rule becomes precise: the client *selects* the building, and the
  server *authorizes* it on every request.
- A new endpoint cannot accidentally skip tenancy without failing CI.

## Alternatives considered

- **Building in a header (`X-Building-Id`):** works, but is invisible in URLs and OpenAPI, and easier to forget
  in tests.
- **Building in the session (one "active building"):** breaks multi-tab use, which the old plan rightly flagged.
- **Subdomain per building:** nice branding, but multiplies TLS and cookie complexity. Revisit for
  white-labelling.

## Revisit when

There are cross-building features (platform admin, a council over several buildings) or white-label subdomains.
