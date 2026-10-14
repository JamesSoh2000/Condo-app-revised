# ADR-0013: Build and test locally first; deployment is a separate milestone

- Status: Accepted
- Date: 2026-10-13
- Amends: [ADR-0008](./0008-single-ec2-compose-caddy.md) (when staging is built) and
  [ADR-0009](./0009-backups-staged.md) (where demo backups run). The topology and the backup design are
  unchanged.

## Context

The first version of this plan built AWS staging in weeks 1–2 (Terraform, host bootstrap, CI/CD, logs and
uptime), and several phase gates required staging. That chain needed human work with real waiting time:
- an AWS account
- a domain and DNS
- SES verification
- certificates and cloud-init on a real host

The roadmap named it the biggest schedule risk. It also competed for attention with the core the team is
learning in the first weeks: the data model, auth and tenancy.

The team wants to build and test the application locally first, with no AWS account, domain or deployed
application required.

## Decision

- **Weeks 1–8 run locally and in GitHub Actions CI only.** No AWS account, domain or server is needed. CI
  checks start in week 1 as before.
- **A local walking skeleton in week 2** replaces the deployed one ([P1-08](../tickets/P1-08-production-like-local-stack.md)).
  `make prodlike` runs the production image and the built SPA behind the same `deploy/Caddyfile` that staging
  will use. CI runs the same smoke test on every PR, and staging's deploy will reuse that smoke script.
- **Phase gates are checked locally and in CI.** The week-8 demo-ready bar is a local bar, and the demo is
  run on the prod-like stack and recorded.
- **Milestone D (D-01…D-06, about 2 weeks; by default weeks 9–10)** builds staging exactly as ADR-0008
  describes, then re-verifies the journeys there and runs the checks that only real infrastructure can
  prove. It must finish before pilot readiness starts.
- **Rules that protect future deployments apply from day one:**
  - expand/contract migrations
  - never edit a merged migration
  - every setting in `.env.example`, with secrets marked
  - no secrets in committed files
  - one image for every environment

## Consequences

- **Faster start.** The first weeks go to the product and the core concepts. There are no cloud costs and
  no waiting on accounts or DNS until milestone D.
- **Some risks surface later.** Each one has a named check in [D-06](../tickets/D-06-staging-verification-gate.md):
  - `__Host-`/`Secure` cookies over HTTPS
  - the real client IP behind the proxy
  - real S3 CORS and presigned URLs
  - the SES sandbox
  - memory and CPU on a `t3a.small`
  - cloud-init and certificates
- **No hosted demo URL at week 8.** A link arrives with milestone D.
- **Risk of a big-bang "deployment phase" at the end.** It stays small because:
  - D deploys artifacts that CI has built and smoke-tested on every merge since week 2.
  - The Caddyfile, the migrations-in-image and the smoke script already exist.
  - ADR-0008 fixes D's scope.

## Alternatives considered

- **Staging in weeks 1–2 (the original plan):** the earliest feedback from real infrastructure, but it needs
  AWS, a domain and SES from day 1, and it was the plan's top schedule risk.
- **Deploy only when a pilot is scheduled:** leaves too much unverified for too long, and squeezes the IaC,
  OIDC and CD learning into pilot preparation.
- **A PaaS (Render, Fly.io) for a quick hosted demo:** contradicts ADR-0008 and adds a second deploy target to
  learn.

## Revisit when

- A hosted demo is needed before week 8 (for example, for a prospective pilot building). Pull milestone D
  forward; it can start once P1-08 and P3-01 (the worker) are merged.
- A pilot date is set. Milestone D must be done before the pilot-readiness phase starts.
