# D-06 — Staging verification gate

| Field | Value |
|---|---|
| Phase / lane | D / both |
| Risk tier | 1 |
| Depends on | D-03, D-04, D-05, P5-05, P6-07c |
| Replaces old | M7-T10 (staging part), the staging parts of the first draft's P5-05 |
| Status | todo |

> **Milestone D ([ADR-0013](../adr/0013-local-first-deployment-milestone.md)).** Weeks 1–8 proved the journeys
> locally and in CI. This ticket proves them on real infrastructure, and runs the checks that the local
> stack cannot.

## Goal

The demo journeys work on staging, a smoke suite runs after every deploy, and every staging-only behaviour
has evidence. Passing this ticket meets the **deployed** bar in
[ENGINEERING_PRACTICES.md](../ENGINEERING_PRACTICES.md#deployed-milestone-d).

## Why

The local stack runs plain http, the S3 emulator and Mailpit, on a developer's laptop. A short list of
behaviours only shows up with HTTPS, real AWS services and a small server. Collecting them here keeps the
list explicit, instead of discovering it during the pilot.

## Scope

- In:
  - **Staging data:** run `seed` and the P7-05 demo dataset on staging through SSM Session Manager (P1-06
    allows `staging`).
  - **Staging smoke** (`e2e/tests/smoke-staging.spec.ts`, run with `E2E_BASE_URL=https://<domain>`, using
    the seeded staging accounts). There is no email reading.
    - J4: log in, log a package with a photo, the resident sees it, pickup
    - J5/J6/J8 (from P6-07a–c): publish a notice and see the badge, submit a maintenance request, and check the
      dashboard counts
    - a building-B user gets 404 on a building-A package URL
  - **`.github/workflows/staging-smoke.yml`:** runs after `deploy` succeeds, and on `workflow_dispatch`.
  - **Staging-only checks** (evidence in the PR: screenshot, curl output or a log excerpt). Each item names
    the ticket that built the behaviour locally:
    - [ ] P2-01: login on the real domain sets `__Host-session` with `Secure; HttpOnly; SameSite=Lax`, and
          the CSRF check accepts the real `Origin`.
    - [ ] P2-05: rate-limit keys use the real client IP behind host Caddy, not `127.0.0.1`.
    - [ ] P3-02: `email-test` to a verified address arrives via SES, and a non-allowlisted address is
          skipped.
    - [ ] P3-04/P3-06: a photo upload works from a desktop browser and from a real phone. The bucket CORS
          rejects another origin, and a download URL stops working after 60 s. An unsigned `GET` of an
          uploaded object's key is refused (403): LocalStack doesn't check auth, so the local stacks can't
          show the bucket is private ([P3 recap](../recaps/P3.md) §0).
    - [ ] P3-01/P5-05: the `package_arrived` email arrives via SES at a verified inbox, and restarting the
          worker mid-queue recovers.
    - [ ] P4-03: `bootstrap-building` runs through SSM Session Manager by following the runbook.
    - [ ] P7-02: the headers and CSP on the real domain (including Sentry), the TLS certificate, and a port
          scan that shows only 80/443.
    - [ ] P7-03: re-run the k6 baseline against staging (`t3a.small`) and record it next to the laptop
          baseline in `docs/perf/`.
  - **README:** add the hosted demo link (P7-05, P7-06).
  - The milestone recap for D (`/milestone-recap D`).
- Out:
  - new features
  - production (pilot)

## Interfaces

`e2e/tests/smoke-staging.spec.ts`, `.github/workflows/staging-smoke.yml`, `docs/recaps/D.md`.

## Acceptance criteria

1. **Given** the staging deploy of the merge commit, **then** the smoke spec passes against staging. Link
   the run in the PR.
2. **Given** a later merge, **then** `staging-smoke` runs automatically after `deploy`, and a failure is
   visible on the commit.
3. **Given** the staging-only checklist, **then** every item has evidence or a linked follow-up ticket with
   a reason.
4. **Given** the deployed bar in 04, **then** every box is ticked.
5. **Given** the D recap, **then** it contains a step-by-step account, with `path::anchor` references, of
   what happens between `git push` and the new version answering on staging.

## Test plan

Run the smoke suite, then work through the checklist on staging. Each developer also does one live demo of
J4 on staging by hand.

## Likely files

`e2e/tests/smoke-staging.spec.ts`, `.github/workflows/staging-smoke.yml`, `docs/perf/baseline-<date>.md`,
`docs/recaps/D.md`, `README.md`.

## Must explain (learning checkpoint)

1. Which item on the staging-only checklist surprised you, and why didn't the prod-like stack catch it?
2. Why does the staging smoke avoid reading email, while the local E2E reads Mailpit?
3. What would you add to P1-08's prod-like stack so the surprise from question 1 is caught locally next time?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
