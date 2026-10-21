# Explanation — P4-08a Join flow and pending/denied screens

> **PR:** #98 · **Source revision:** `3832d1b08651f966d218a2187e991db249f9b4b8`, the pre-merge PR head this explanation
> was written from and checked against. **Reviewed:** the final review round (3) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 98 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read `git diff origin/main...HEAD` (24 paths), `JoinPage.tsx`, `JoinRequestForm.tsx`,
> `JoinCodeForm.tsx`, `onboarding/api.ts`, `MembershipScreens.tsx`, `routes.tsx`, `pages.ts`, `accountSchema.ts`, and
> the assertions of the tests cited below at `3832d1b`; ran `npx vitest run` on the onboarding, membership, auth, nav
> and building test files: 317 passed (7 files); the whole frontend suite: 560 passed (16 files). Differences from
> the plan: see §2 "Plan versus final code".
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: B.

## 1. What was built and why

A resident can now open `/join/<code>`, create an account on the way (or log in), search for their unit, say how
they relate to it (owner, tenant, household member) and send a join request. Afterwards the app's status screens
show what they asked for while they wait, or the manager's reason after a denial, with a form to ask again. This is
the resident half of demo journey 3; it replaces the legacy `Onboarding`, `ResidentSetup` and `PendingApprovalBlock`
Base44 code (the ratchet went 327 → 316). P4-08 was split three ways while framing; the manager screens are P4-08b
and P4-08c.

The two decisions that shape it: the join page **never calls `/api/auth/me`** (a 401 there would hijack the visitor
to the login page), and the denied screen **asks for the join code again** because no endpoint gives it to a denied
member.

## 2. Decisions

### D1. The join page never calls `/api/auth/me`

- **Problem or constraint:** a logged-out visitor must see the sign-up form, but every 401 makes
  `frontend/src/app/AuthProvider.tsx::AuthProvider` clear the cache and navigate to the login page.
- **Chosen:** the page counts the tab as signed in when router state says `signedIn` (set by the login page when it
  sends the user back, and by the in-app code form) or a `['me']` query is cached
  (`frontend/src/features/onboarding/JoinPage.tsx::JoinScreen`). Otherwise it shows the sign-up form plus "Already
  have an account? Log in" with `next=/join/<code>`.
- **Alternatives rejected:** probing `/me` and exempting `/join` from AuthProvider's navigation (changes a global 401
  rule, and the cache clear would refetch the page's own queries in a loop); probing with the units endpoint (same
  401).
- **Tradeoffs and accepted limitations:** someone signed in who opens a join link in a fresh tab sees the sign-up form
  first; "Log in" returns at once because the login page itself probes `/me`
  (`frontend/src/features/auth/pages/LoginPage.tsx::LoginPage`).
- **Basis:** existing pattern (`AcceptInvitePage`, P4-07b D1); autonomous.
- **Source:** recorded (PR #98 D1).

### D2. "Submit again" asks for the join code or link

- **Problem or constraint:** `POST /api/join/{code}/requests` needs the building's code; neither `MeMembershipOut`
  nor `OnboardingMeOut` carries it.
- **Chosen:** the denied screen (and the no-membership screen) render
  `frontend/src/features/onboarding/JoinCodeForm.tsx::JoinCodeForm`, which opens `/join/<code>` with `signedIn`, so the
  resident lands directly on the unit picker.
- **Alternatives rejected:** a backend field giving denied members the code (backend scope in a frontend ticket, and it
  hands the code to someone management turned down); remembering it in browser storage (lost on another device; a
  building secret in storage).
- **Tradeoffs and accepted limitations:** the resident types or pastes the code again.
- **Basis:** autonomous; the ticket's scope line was changed at framing (Frame notes) and goes to the inbox's
  "Decisions to audit".
- **Source:** recorded (PR #98 D2, ticket Frame notes).

### D3. Where the user lands after submitting

- **Problem or constraint:** the guard (`frontend/src/app/guards.tsx::RequireActiveMembership`) shows the status
  screens only when the user has no active membership.
- **Chosen:** after the request, a fresh `/me`; no active membership → `/` (the guard's pending screen is the
  confirmation); otherwise the join page's own "Request sent" screen. If that `/me` fails, `/`.
- **Alternatives rejected:** always `/` (a user with another building would land on its home with no confirmation);
  always the join page's screen (a reload there shows the form again, not the guard's pending screen that criterion
  2 relies on).
- **Tradeoffs and accepted limitations:** two places show a pending request's unit.
- **Basis:** criteria 1, 2, 13; autonomous.
- **Source:** recorded (PR #98 D3 and the deviation note "Fresh `/me` after submit").

### D4. The post-submit `/me` goes through the shared `['me']` query (review round 1, M1)

- **Problem or constraint:** a side fetch written with `setQueryData` could land after a newer answer and put the
  cache back to an older state (Codex round 1, M1; failure in §6).
- **Chosen:** inside the auth queue, `cancelQueries(['me'])` (drops an older fetch still out), then
  `fetchQuery({ queryKey: ['me'], staleTime: 0 })`; a newer fetch with `cancelRefetch` cancels this one, and the auth
  queue's timeout cancels it too.
- **Alternatives rejected:** skipping the write when the page is gone (Codex's first suggestion): it fixes only the
  abandoned case, not an older fetch still in flight.
- **Tradeoffs and accepted limitations:** a shell that mounts while this fetch is out shares it, so it can briefly show
  an answer asked just before an approval; the next refetch corrects it. The cache never goes backwards.
- **Basis:** review finding (round 1).
- **Source:** recorded (PR #98 "Independent review", round 1).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Unit search: text field + native radio group of matches | ARIA combobox | custom key handling for the same result; line budget | autonomous | PR #98 |
| 300 ms debounce in a local `useDebounced` | a dependency | one `setTimeout` | autonomous | PR #98 |
| The chosen unit is derived from the list shown (`chosen`) | keep the clicked id | a unit clicked in stale results stayed selected (found on the stack) | stack screenshot; test | PR #98 deviation |
| `useMyOnboarding` keyed by the membership status too | invalidate from a `/me` listener | a status change asks again with no listener (round 2, M1) | review finding | PR #98 round 2 |
| `[overflow-wrap:anywhere]` on the status and join screens | truncating | a 500-character unbroken reason overflowed at 375 px (round 2, M2) | review finding | PR #98 round 2 |
| Sign-up guard taken before react-hook-form's async validation | inside the handler | two submits in one tick both passed (round 1, M2) | review finding | PR #98 round 1 |
| Client email check up to 254 octets; server `string_too_long` mapped | server only | the server's 422 showed the generic error (round 1, L1) | review finding | PR #98 round 1 |
| Shared `accountSchema` for the invitation's and sign-up's account fields | copy the rules | one place for the name/password rules | autonomous | PR #98 deviation |

**Framing changes:** P4-08 (~1,100 non-test lines) was split into P4-08a (this), P4-08b (manager pending requests)
and P4-08c (members). Criteria 1–3, 6, 7 sharpened; 4, 5, 8–17 added. No criterion loosened; the denied screen's
"submit again" scope line now asks for the code (D2).

**Plan versus final code:** compared against the PR's Plan. (1) Size: the plan estimated ~420 non-test lines; at the
source revision the branch adds 602 code lines (66 comment, 43 blank; 587 before the review fixes), noted in the PR as a deviation. (2) D3 reads a fresh `/me`, not
the cached one (a password login clears the cache). (3) `accountSchema.ts` was extracted. (4) The selected unit is
derived from the shown list. (5) Review rounds added D4, the status-keyed query, the wrap class, the early sign-up
guard and the email length check. All are in the PR below the Plan or in its review log.

## 3. How it is implemented

### Overview

- `frontend/src/features/onboarding/JoinPage.tsx::JoinPage` — public route `/join/:code`, keyed per history entry;
  `JoinScreen` holds the stage (`account` → `request` → `sent`, or `invalid` / `member` / `not-eligible`).
- `JoinPage.tsx::SignupForm` — sign-up through the auth queue, then the user-change sweep.
- `frontend/src/features/onboarding/JoinRequestForm.tsx::JoinRequestForm` — debounced unit search, relationship,
  submit, refusal mapping, fresh `/me`.
- `frontend/src/features/onboarding/api.ts::useMyOnboarding` — the caller's own `onboarding/me`, used by
  `frontend/src/features/membership/MembershipScreens.tsx::PendingScreen` and `::DeniedScreen`.
- `JoinCodeForm.tsx::parseJoinCode` / `::JoinCodeForm` — code-or-link → `/join/<CODE>`.

### Walkthrough (variant B): a fresh visitor joins as a tenant of 1003

1. **The user action.** They open `/join/MAPLE-2026`. `frontend/src/app/routes.tsx::AppRoutes` routes it outside
   `RequireAuth` to `JoinPage`, which renders `JoinScreen key={location.key}`. `JoinScreen` queries
   `['join', code]` → `GET /api/join/{join_code}` (`onboarding_lookup`, public). A 404 renders `JoinInvalid`;
   another error a retry screen with the 429 wait. No state and no cached `/me`, so the stage is `account`.
2. **Form and validation.** `SignupForm` uses `accountSchema({ email })`: the name as `FullName` (no control
   characters, 1–200 code points after trim), password 12–128 code points, confirm equal, email `x@y` and ≤ 254
   octets. The server is the authority; its 422s are placed under fields by `serverFieldErrors` with the page's own
   words.
3. **Sign-up.** `onSubmit` takes the `inFlight` guard before `handleSubmit` and releases it if validation refuses.
   `signUp` sends `POST /api/auth/signup` (`auth_signup`) inside `runAuthCall` (queued behind a logout in flight,
   which would otherwise delete the new cookie). On 201 it removes every query except the join lookups, calls
   `useNewSession()` and `clearTabChoices()` (even if the page is gone), then sets the stage to `request`. 409
   `email_in_use` shows an alert with "Log in instead"; 429 the wait.
4. **Unit and relationship.** `JoinRequestForm` debounces the search 300 ms and queries
   `['join', code, 'units', term]` → `GET /api/join/{join_code}/units?search=` (`onboarding_units`) with
   `keepPreviousData`. Matches render as radios; the relationship radios carry `RELATIONSHIPS` help text as their
   accessible description.
5. **Submit.** Missing unit or relationship → messages, nothing sent. Otherwise `POST /api/join/{join_code}/requests`
   (`onboarding_create_request`); 201 and 200 (an existing pending request) are handled the same.
   `refusalFor` maps 404 `join_code_invalid` / 409 `already_member` / 409 `membership_not_eligible` to stages; 404
   `unit_not_found` clears the choice, refetches the list and says so.
6. **Cache.** It removes `['b', building_id, 'onboarding', 'me']` (all statuses, by prefix), then refreshes `['me']`
   through the shared query (D4). No active membership → `navigate('/')`.
7. **States.** At `/`, `RequireActiveMembership` finds no active membership and renders `MembershipStatusScreen` →
   `PendingScreen`; each `PendingRequest` asks `useMyOnboarding(building.id, 'pending')` →
   `GET /api/buildings/{id}/onboarding/me` (`onboarding_my_status`) and shows "Unit 1003 · Tenant" and "The building
   manager will review your request." While that loads or if it fails, the building name and the wait still show.
   At 375 px everything is one column (`max-w-sm px-4`, long text wraps anywhere).

### Data model changes

None (frontend only; no API change).

## 4. The code

**Files changed** (non-test)

| File | Change | Lines (+/−) |
|---|---|---|
| `frontend/src/features/onboarding/JoinPage.tsx` | new: route, stages, sign-up | +275 |
| `frontend/src/features/onboarding/JoinRequestForm.tsx` | new: search, relationship, submit | +223 |
| `frontend/src/features/onboarding/JoinCodeForm.tsx` | new: code-or-link form | +55 |
| `frontend/src/features/onboarding/api.ts` | new: relationships, `useMyOnboarding` | +41 |
| `frontend/src/features/auth/accountSchema.ts` | new: shared account fields | +47 |
| `frontend/src/features/auth/pages/AcceptInvitePage.tsx` | uses `accountSchema` | +4/−39 |
| `frontend/src/features/membership/MembershipScreens.tsx` | pending/denied details, code forms | +56/−9 |
| `frontend/src/app/{routes,pages,routeScope,guards}.ts(x)` | `/join` routes; legacy pages out | +9/−17 |
| `frontend/src/pages/{Onboarding,ResidentSetup}.jsx`, `components/PendingApprovalBlock.jsx` | deleted | −643 |
| `frontend/base44-baseline.txt` | 327 → 316 | +1/−1 |

Tests: `JoinPage.test.tsx` (+573), `MembershipScreens.test.tsx` (+195), `nav.test.tsx` and `building.test.tsx`
adjusted (see §7, gate changes).

`frontend/src/features/onboarding/JoinPage.tsx::JoinScreen` (stage and lookup)

```tsx
  const [stage, setStage] = useState<Stage>(() =>
    (location.state as SignedInState | null)?.signedIn || queryClient.getQueryData(['me']) ? 'request' : 'account',
  );
  const [sent, setSent] = useState<JoinRequest | null>(null);
  const lookup = useQuery({
    queryKey: ['join', code],
    queryFn: ({ signal }) => api.get('/api/join/{join_code}', { params: { path: { join_code: code } }, signal }),
  });
  // ...
  const onSent = (request: JoinRequest, active: boolean | null) => {
    // Without an active membership the guard's pending screen is the confirmation (D3).
    if (active !== true) return navigate('/', { replace: true });
    setSent(request);
    setStage('sent');
  };
```

- Decides once, at mount, whether to show the sign-up form (D1), and where to go after submitting (D3).
- Remove the `getQueryData(['me'])` check and an in-app user without router state would be offered a sign-up form.

`frontend/src/features/onboarding/JoinPage.tsx::SignupForm` (guard and sweep)

```tsx
    if (!created) return;
    // A new user is signed in: nothing cached of a previous one may outlive it, and a shell the user went back to
    // meanwhile is rebuilt for the new one (P4-07b R3-1). The join links' public lookups stay.
    queryClient.removeQueries({ predicate: ({ queryKey }) => !(queryKey[0] === 'join' && queryKey.length === 2) });
    newSession();
    clearTabChoices();
    if (mounted.current) onSignedUp();
  };
  // ...
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    void form.handleSubmit(signUp, () => {
      inFlight.current = false;
    })(event);
  };
```

- The sweep runs even when the page is gone, so a shell the user returned to stops showing the previous user.
- The guard is taken before validation, which is asynchronous (round 1, M2); without it two submits in one tick send
  two sign-ups.

`frontend/src/features/onboarding/JoinRequestForm.tsx::JoinRequestForm` (chosen unit and the `/me` refresh)

```tsx
  const options = units.data ?? [];
  // Only a unit the list shows counts: one clicked in the previous results while a search was on its way may not
  // be among the new ones.
  const chosen = options.some((unit) => unit.id === unitId) ? unitId : null;
  // ...
    // The status screens ask again for this building's request.
    queryClient.removeQueries({ queryKey: ['b', sent.building_id, 'onboarding', 'me'] });
    if (!mounted.current) {
      void queryClient.invalidateQueries({ queryKey: ['me'], exact: true });
      return;
    }
    // ...
    let active: boolean | null = null;
    try {
      const me = await runAuthCall(async (signal) => {
        const cancel = () => void queryClient.cancelQueries({ queryKey: ['me'], exact: true });
        signal.addEventListener('abort', cancel, { once: true });
        await queryClient.cancelQueries({ queryKey: ['me'], exact: true });
        return queryClient.fetchQuery({
          queryKey: ['me'],
          queryFn: ({ signal: querySignal }) => api.get('/api/auth/me', { signal: querySignal }),
          staleTime: 0,
        });
      });
      active = me.memberships.some((m) => m.status === 'active');
    } catch {
      void queryClient.invalidateQueries({ queryKey: ['me'], exact: true });
    }
    if (mounted.current) onSent(sent, active);
```

- `chosen` is what is sent and what is checked; a unit no longer listed counts as none.
- The refresh shares `['me']` with the shell (D4): an older fetch is cancelled first, and a newer one cancels this.
  Replace `fetchQuery` by a side `api.get` + `setQueryData` and round 1's two proofs fail again.

`frontend/src/features/onboarding/api.ts::useMyOnboarding`

```ts
export function useMyOnboarding(buildingId: string, status: MembershipStatus) {
  return useQuery({
    queryKey: ['b', buildingId, 'onboarding', 'me', status],
    queryFn: ({ signal }) =>
      api.get('/api/buildings/{building_id}/onboarding/me', { params: { path: { building_id: buildingId } }, signal }),
  });
}
```

- The endpoint (`backend/app/onboarding/router.py::my_status`) depends on `get_own_membership`, not the tenant
  context, so a pending or denied member may read it. The status in the key makes a change seen on `/me` ask again
  (round 2, M1); returning to a status already cached within 30 s does not (round 3, §7).

`frontend/src/features/onboarding/JoinCodeForm.tsx::parseJoinCode`

```tsx
export function parseJoinCode(input: string): string | null {
  let value = input.trim();
  if (value.includes('/')) {
    const match = /\/join\/([^/?#]*)/i.exec(value);
    if (!match) return null;
    value = match[1];
  }
  value = value.toUpperCase();
  return CODE.test(value) ? value : null;
}
```

- Codes are generated in capitals and the server accepts only `[A-Za-z0-9-]{1,16}`
  (`backend/app/onboarding/service.py::_JOIN_CODE`). The regex finds `/join/<code>` anywhere in a link, which
  round 3 showed is too lenient (§7).

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Unusable code, or no code | `JoinInvalid`, no sign-up form, no request for `/join/` | "shows the invalid-link screen for a 404…", "…on %s without a request" |
| Lookup rate-limited | retry screen with the wait | "offers a retry after a 429, with the wait" |
| A session-bound call before signed in | none: only the lookup | criterion-1 test asserts `calls == [LOOKUP]` before sign-up |
| Email already has an account | alert + "Log in instead" with `next` | "says an account has the email…" |
| Server 422 / 429 on sign-up | under fields / the wait | "places the server's 422…", "shows the wait after a 429" |
| Double sign-up, incl. same tick | one POST | "sends one sign-up for a double submit (6)", "M2: two submits before validation…" |
| Guard stuck after refusal | released | "M2 neighbour: a submit refused by validation…", "M2 neighbour: a refused sign-up…" |
| Email over 254 | refused before sending; server type mapped | "L1: an email over 254…", "L1 neighbour…" |
| Previous user's data after sign-up | removed; tab choices cleared; shell rebuilt | "removes another user's cached data…", "a sign-up that lands after the user went back to the shell…" |
| Missing unit/relationship | messages, no POST | "says what is missing and sends nothing (10)" |
| Unit picked from stale results | not counted | "drops a unit picked from the previous results…" |
| Typing fast | only `search=100` after `''` | "requests only the last search, after the pause (12)" |
| Refusals | screens / refetch | "maps %s to its screen (9)" ×3, "says a unit is gone and refreshes the list (9)" |
| Double join request | one POST | "sends one request for a double submit (6)" |
| Active elsewhere | "Request sent" on the join page | "shows \"Request sent\" when the user has an active building elsewhere (13)" |
| Session expired | login with `next` | "sends a lost session to the login page and back here (14)" |
| Another entry while a request is out | old answer changes nothing | "keys the screen per history entry… (16)" |
| Abandoned page's `/me` vs a newer one | never goes back | "M1: an abandoned join page's /me never replaces a newer one", "M1 neighbour: an older /me still in flight…" |
| `/me` fails after the request | goes to `/` | "M1 neighbour: a /me that fails after the request still leads to the app" |
| Status changes pending ↔ denied | details asked again | "M1: a denial seen on a fresh /me…", "M1 neighbour: a pending request seen after a denial…" (MembershipScreens) |
| `onboarding/me` fails | building and wait still shown | "still names the building and the wait when onboarding/me fails" |
| Long unbroken text at 375 px | wraps | No automated test (jsdom has no layout); Chromium checks in the PR |

Acceptance criteria → tests:
1. "signs up, picks 1003 as a tenant and lands on the pending screen (1)"; "shows the unit and relationship submitted"; stack transcript.
2. "lands on the home once a reload finds the membership approved (2)"; stack transcript.
3. "shows the manager's reason, and Submit again opens the unit picker (3)"; stack transcript.
4. invalid-link tests above. 5. sign-up error tests. 6. double-submit tests.
7. Stack: all screens `scrollWidth 375`; round-2 Chromium checks.
8. `nav.test.tsx` "%s is \"Page not found\" since P4-08a"; ratchet 316/316.
9–16. as in the table. 17. `parseJoinCode` table and "refuses an empty or malformed value and stays (17)".

## 6. Review log

All rounds by Codex `gpt-6.1-sol` at high effort, the only reviewer (James's instruction for this run).

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex gpt-6.1-sol-high | `c0f6c6b` | MERGE | M1 Medium: stale `/me` overwrite; M2 Medium: double sign-up; L1 Low: email length | fixed in `b45d864`, neighbours `bfca5cd` |
| 2 | Codex gpt-6.1-sol-high (fresh) | `bfca5cd` | MERGE | M1 Medium: cached pending details hide a denial reason; M2 Medium: overflow at 375 px | fixed in `3832d1b` |
| 3 | Codex gpt-6.1-sol-high (fresh) | `3832d1b` | MERGE | M1 Medium: repeated denial within 30 s; L1 Low: lenient link parsing | not fixed (last round); §7 |

- **R1 M1.** Inputs: submit; the join page's `/me` (sent before an approval) is out; the user goes to `/`; a newer
  `/me` answers `active` → Home; the late answer then wrote `pending`. Also an older shell `/me` could overwrite the
  fresh one. Evidence: both M1 tests red on `c0f6c6b`, green on `b45d864`. Produced D4. Codex's own proof (expecting
  a second request on the shell's mount) was dismissed with reason in the PR; round 2 accepted it.
- **R1 M2.** Two `submit` events in one tick both passed the guard set inside the handler, after async validation:
  two `POST /api/auth/signup`. Evidence: "M2: two submits…" red then green.
- **R1 L1.** 255+ character email → server `string_too_long` → generic error. Evidence: L1 tests red then green.
- **R2 M1.** Pending details cached under `['b', id, 'onboarding', 'me']` (30 s) were reused when `/me` turned
  `denied`: "No reason was given." Evidence: the two R2 tests red then green.
- **R2 M2.** A 500-character reason with no spaces: `scrollWidth 5513` at 375 px (Codex's Chromium proof, reproduced
  on `vite preview`); after the fix `375`.
- Found on the stack before review: the stale unit selection (test "drops a unit picked…", red then green).

## 7. Not verified, accepted risks and follow-ups

- **Open, Medium (round 3):** denial A → resubmit in another tab → denial B within 30 s shows A's reason
  (`['b', id, 'onboarding', 'me', 'denied']` is still fresh). Proposed fix: `staleTime: 0` on `useMyOnboarding`.
  Tracked: PR #98 follow-ups; carried to P4-08b's ticket in the bookkeeping commit.
- **Open, Low (round 3):** `parseJoinCode` accepts `/join/<code>` anywhere in a link (`…/join/MAPLE-2026/garbage`,
  `…?next=/join/MAPLE-2026`). Proposed fix: match the whole pathname. Tracked as above.
- **Layout (criterion 7)** is verified only by Chromium runs recorded in the PR (the journey and the round-2 overflow
  checks), not by an automated test.
- **Debounce timing (12):** the test checks which searches were sent, not the 300 ms boundary.
- **Login return (14):** the test proves the redirect with `next`; the login page's return with `signedIn` is P4-07b's
  tested path, not re-tested here.
- **Local `make check`** could not run whole: Docker was unreachable from WSL. Its steps were run by hand against a
  scratch Postgres 16; backend failures there were environmental (S3 emulator; Postgres 18's `RETURNING old.*`).
  CI ran the full backend suite on Postgres 18 green on every pushed head. This branch changes no backend file.
- **Accepted (D1):** a signed-in user opening a join link in a fresh tab sees the sign-up form first.
- **Accepted (D2):** a denied resident re-enters the code; to the inbox's "Decisions to audit".
- **Size:** 602 code lines against ~400; recorded as a deviation; the low frame estimate goes to the mistakes log.
- **Gate changes:** ratchet 327 → 316; `nav.test.tsx` lost the two removed routes from a table (now asserted as "Page
  not found"); `building.test.tsx` allows exactly the caller's own `onboarding/me` on the pending and denied screens.
- P4-08b and P4-08c are stubs; the P4-07b account-menu Lows moved to P4-08b, the P4-06b backend test gap to P4-08c.

## 8. How to change this safely

- **A new refusal code** from the join request: add it to `JoinRequestForm.tsx::refusalFor` and a stage in
  `JoinPage.tsx::JoinScreen`; extend "maps %s to its screen (9)".
- **Anything that changes the user** (another sign-up path): sweep like `SignupForm` (remove queries, `newSession()`,
  `clearTabChoices()`) and copy the two criterion-15 tests.
- **Another call on the join page before sign-in:** it must not need a session (D1); the criterion-1 test's
  `calls == [LOOKUP]` will catch one.
- **Changing `useMyOnboarding`'s key:** keep the `['b', id, 'onboarding', 'me']` prefix, which the submit removes; the
  round-2 tests and `building.test.tsx`'s exact call list will tell you if you broke the status screens.

## 9. Must explain, then quiz

**1. How does the pending screen get its data without operational building access?** It calls
`GET /api/buildings/{id}/onboarding/me` (`api.ts::useMyOnboarding`). That route is on `own_router` in
`backend/app/onboarding/router.py::my_status`, which depends on `get_own_membership` (the caller's own membership in
any status) instead of `get_tenant_context` (which requires an active one). The building id comes from the user's own
`/me`. `building.test.tsx` asserts it is the only building request those screens make.

**2. Why does the join page never call `/api/auth/me`, and how does it know the tab is signed in?** Every 401 makes
`AuthProvider` clear the cache and go to the login page, so a probe would send a visitor away from the sign-up form
(D1). It reads router state `signedIn` (set by the login page when returning to `next`, and by `JoinCodeForm`) or a
cached `['me']`. If wrong (an expired session), the units request's 401 sends the user to login and back (criterion 14).

**3. How do you explain "owner vs tenant vs household" to a non-technical resident?** By who owns, who rents, and
who lives with them, as `api.ts::RELATIONSHIPS` words it: Owner, "You own this unit, whether you live in it or rent it
out."; Tenant, "You rent this unit from its owner."; Household member, "You live in this unit with its owner or
tenant, for example as family or a roommate." Each is the radio's accessible description.

Quiz:

1. A user signed in to Birch opens a Maple join link from an email in a new tab. What do they see first, and how many
   clicks to the unit picker?
2. Why is the sign-up's sweep done even when the page has unmounted, but the "go to `/`" step is not?
3. The manager approves while the resident's join page `/me` is still in flight. What can the resident see, and why
   can't the cache end up older than the server's latest answer?
4. What would break if `chosen` were replaced by `unitId` in `JoinRequestForm`?
5. How would you let a denied resident resubmit without typing the code, and what would you need to change?

<details><summary>Answers</summary>

1. The sign-up form (no state, nothing cached). "Log in" → the login page probes `/me`, finds the session and returns
   to `/join/<code>` with `signedIn`: one click to the unit picker.
2. The new session exists whatever the page does: a shell the user went back to must stop showing the previous user
   (P4-07b R3-1). Navigation belongs to a page the user is still on; after Back it would move them away.
3. A shell mounting meanwhile shares the in-flight fetch and may show `pending` until its next refetch. A newer fetch
   cancels the older one (`cancelRefetch`), and the submit cancels any older fetch before its own, so a late answer
   is never written over a newer one (D4).
4. A unit clicked in the previous results during the 300 ms debounce would stay selected after the new results drop
   it, and the request would go out for a unit the user can't see (test "drops a unit picked…").
5. The backend would have to give denied members the code (e.g. in `OnboardingMeOut`) or a resubmit endpoint by
   building id; a decision for James (D2 is in "Decisions to audit"). Then `DeniedScreen` links to `/join/<code>`.

</details>
