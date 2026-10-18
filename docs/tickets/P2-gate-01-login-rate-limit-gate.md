# P2-gate-01 — Reconcile the login rate-limit exit gate

| Field | Value |
|---|---|
| Phase / lane | P2 / B |
| Risk tier | 3 (documentation only) |
| Depends on | P2-05, P2-07 |
| Status | done |

## Goal

Resolve the P2 exit-gate disagreement using James's explicit decision to keep P2-05's current behavior.

## Scope

Update the roadmap, preserve and publish the existing local P2 recap with a dated resolution, record
James's decision in the inbox, and leave an explanation and verification evidence. No application,
configuration, test, CI, or branch-protection changes. No P3 implementation in this PR.

## Acceptance criteria

1. The roadmap requires 429 on the ninth login attempt per normalized email in the same fixed 15-minute
   window after eight counted attempts, even with the correct password. Successful attempts count too;
   the independent per-IP limit remains 30 attempts per fixed 10-minute window.
2. The recap preserves the original failed gate and its recorded stack/CI evidence as history, adds the
   authorized resolution and fresh verification evidence, and closes only this gate-wording risk.
3. The inbox records James's 2026-10-17 decision and the rejected option of reducing the email limit to
   five. The record distinguishes a human decision from autonomous agent decisions.
4. Run the existing rate-limit tests, `make check`, docs link and explanation-reference checks; record
   actual results. Required CI and a fresh Tier 3 Claude review pass before squash merge.
5. Only documentation files change. Preserve the accepted risks, including successful attempts consuming
   quota and targeted email lockout. Leave James's optional recap sections untouched.

## Frame notes

- Basis (recorded, James in this session, 2026-10-17): "I choose to keep P2-05's current rate-limiting
  behavior. I explicitly authorize changing the roadmap's P2 exit criterion from blocking the sixth
  failed login to blocking the ninth attempt per normalized email in the same fixed 15-minute window."
- Criterion loosened with explicit human authorization: the roadmap's old sixth-failed-login threshold
  becomes the implemented ninth-attempt threshold. This reconciles the roadmap with P2-05; it is not an
  autonomous relaxation and does not change runtime behavior.
- Alternative rejected by James's choice: add `P2-fix-01` to lower the email quota to five.
- Adjacent cases to verify with existing tests: correct password after quota exhaustion, successful
  attempts, normalized-email variants, fixed-window reset, and the independent IP quota.
- Tier 3: documentation only; no tenant endpoint, API, settings, or migration changes.
- The P2 recap is an untracked user-provided draft in the original checkout; copy it into the isolated
  worktree and preserve its original gate report rather than replacing that report with a new claim.
