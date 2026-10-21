# Explanation — P4-07a Password reset screens and password field

> **PR:** #95 · **Source revision:** `bbd4037e8186fdf6a9bc9b19705001d58bcefbbf`, the pre-merge PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (3) reviewed this
> commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 95 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `bbd4037` the whole of `ResetPasswordPage.tsx` (`ResetPasswordPage`,
> `ResetPasswordScreen`), `ForgotPasswordPage.tsx`, `formErrors.ts`, `PasswordField.tsx`, `PageHeading.tsx`,
> `Field.tsx`, the diffs of `LoginPage.tsx`, `routes.tsx`, `deploy/Caddyfile`, `scripts/smoke.sh` and
> `frontend/src/test/renderApp.tsx`, the assertions of the tests named below, and PR #95's description (plan,
> D1–D5, three review rounds). Ran `npx vitest run src/features/auth`: 93 passed (`npx vitest run`: 424 passed).
> The stack evidence in §5 (prod-like smoke, browser journey) is from the PR, run on `edc80b3`; the files
> it exercises changed later only in the review fixes listed in §6, which are covered by unit tests, not by a
> second stack run. Differences from the plan: see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: B.

## 1. What was built and why

Two public screens complete demo journey 7 in the browser: `/forgot-password` asks the API to email a reset
link, and `/reset-password/:token` (the page that link opens) sets a new password. A reusable password input
(show/hide toggle, a length hint counted as the server counts) and a mapper from the API's 422 `errors[]` to
form fields are built here for P4-07b's invite screen to reuse. The login page gains a "Forgot password?" link
and a "password updated" banner. Caddy sends `Referrer-Policy: same-origin` on the pages whose URL can hold a
secret token. The two decisions that matter most: `same-origin` rather than `no-referrer`, because the latter
would break the CSRF check (D1), and one reset screen per browser history entry, so an answer for an
abandoned page can't act on the current one (D5). P4-07 was split while framing; the invite screen is P4-07b.

## 2. Decisions

### D1. `Referrer-Policy: same-origin`, set by Caddy on the token pages

- **Problem or constraint:** reset and invitation URLs carry a secret token; the ticket asks for
  `no-referrer` or `same-origin` there so it never leaves in a `Referer` header.
- **Chosen:** `deploy/Caddyfile::@token_pages` (`/login /login/ /reset-password/* /invite/*`) sets
  `Referrer-Policy "same-origin"`. `/login` is included because P4-07b will send `next=/invite/<token>` there.
- **Alternatives rejected:** `no-referrer`: the Fetch standard sends `Origin: null` on a same-origin POST under
  it, and `backend/app/core/csrf.py` only accepts a trusted `Origin`, so the login and reset POSTs from these
  pages would be refused. A `<meta name="referrer">` added by React: it applies only after the script runs,
  while the header covers the first load from the email. A site-wide change: broader than the ticket.
- **Tradeoffs and accepted limitations:** our own `/api` still receives the full URL as `Referer` (the API logs
  none). Under `make up` (Vite) there is no header; the browser default `strict-origin-when-cross-origin`
  already strips the path cross-origin.
- **Basis:** ticket (P4-02b and P4-04 carries; either value allowed), CSRF middleware. **Source:** recorded
  (Frame notes, PR D1). The browser journey confirmed `Origin: http://localhost:8080` on the confirm POST.

### D2. The "password updated" banner travels in router state

- **Problem or constraint:** the login page must show a success banner after a reset, and only then.
- **Chosen:** the reset page navigates with `state: { passwordUpdated: true }`; `LoginPage` copies it into
  component state once and replaces the history entry's state with `null`.
- **Alternatives rejected:** a query parameter (`/login?reset=done`): anyone could link to it and show a
  false "your password was updated".
- **Tradeoffs and accepted limitations:** the banner is gone after a reload (intended, criterion 4).
- **Basis:** autonomous. **Source:** recorded (PR D2).

### D3. The snippet's `Referrer-Policy` became a default (`?`)

- **Problem or constraint:** the first prod-like smoke run failed: the token pages still answered
  `strict-origin-when-cross-origin`. The `security_headers` block deletes `Server`, which makes Caddy defer
  the whole block until the response is written, so it overwrote the per-path value.
- **Chosen:** `?Referrer-Policy "strict-origin-when-cross-origin"` in the snippet (set only if nothing set one).
- **Alternatives rejected:** a deferred `>Referrer-Policy` on the per-path line (depends on how Caddy nests two
  deferred handlers); a `route` block (the snippet is deferred either way).
- **Tradeoffs and accepted limitations:** a response that sets its own policy keeps it; the API sets none.
- **Basis:** stack run. **Source:** recorded (PR D3, with the failing and passing smoke output).

### D4. A screen that replaces a form takes focus itself

- **Problem or constraint:** the browser journey showed focus on `BODY` on the invalid-link screen: both of the
  reset page's branches render `<main><PageHeading>`, so React reused the heading and its mount effect didn't
  run again, while the focused button was removed. jsdom had passed because `fireEvent.click` doesn't move focus.
- **Chosen:** `key="invalid"` on the invalid screen's `<main>`; the forgot page focuses its confirmation. The
  tests' click helper focuses the button first, as a browser does.
- **Alternatives rejected:** a `key` prop passed to `PageHeading` by every caller (a rule each caller must remember).
- **Basis:** test result (journey). **Source:** recorded (PR D4).

### D5. One reset screen per history entry (`key={location.key}`)

- **Problem or constraint:** review round 1, F1 (see §6): React kept the page's state when only the URL changed.
- **Chosen:** `ResetPasswordPage` reads the token and `useLocation().key` and renders
  `<ResetPasswordScreen key={key} token={token} />`.
- **Alternatives rejected:** `key={token}`: misses Back between two entries of the same link. Resetting state in
  an effect and tagging requests by token: more code, and the same-token gap again.
- **Basis:** review finding (round 1). **Source:** recorded (PR D5).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Show the 202's `detail` as is | a fixed client text | the ticket says so; it is identical for every email | ticket (P4-04 carry) | recorded |
| Lengths in code points (`codePoints`) | `.length` | the server's `len()` counts code points; 6 emoji are 12 UTF-16 units | convention (LoginPage) | recorded |
| Clear the cache and tab choices after a reset even if the page was left | only when mounted | the server ended every session either way | autonomous | recorded |
| An in-flight ref as well as the disabled button, checked before react-hook-form | the button alone | a `submit` event still reaches the form; checking inside `handleSubmit` re-enabled the button (round 2, F5) | autonomous, review | recorded |
| Any 422 on `["body","token"]` shows the invalid-link screen | a generic alert | a token the schema refuses is as unusable as a 400 one (round 2, F4) | review | recorded |
| Move `Field` and the wait wording out of `LoginPage` | copy them | three pages use them | convention | recorded |
| Size ~424 non-test lines (excluding comments and blank lines; +522 raw) | split again | the field only makes sense with the page that uses it | default ("~400") | recorded |

**Framing changes:** the first commit split P4-07 into P4-07a/P4-07b (index rows; P4-09 now depends on
P4-07b). P4-07a's criteria 1–8 sharpen the original 4 and 5 (exact requests, every status, the 422 mapping,
client checks); 4 (forged banner) and 8 (late navigation) are new cases; 9 and 11 make the password field and
the original criterion 6 testable; 12 makes the Referrer-Policy carry testable. Nothing loosened; the original
criteria 1–3 (and 6 for the invite screen) moved to P4-07b unchanged.

**Plan versus final code:** compared with the PR's Plan. (1) The password field's tests live in
`PasswordReset.test.tsx`, not a separate `PasswordField.test.tsx`. (2) The Caddy snippet changed (D3). (3) The
forgot page's focus and the keyed invalid screen (D4) were added after the journey. (4) The review rounds added
`ResetPasswordScreen` keyed per entry (D5), the forgot page's in-flight guard, the form-level duplicate check,
the 422-on-token rule and `PageHeading` on the login page. All are noted in the PR below the Plan or in its
review log.

## 3. How it is implemented

### Overview

- `frontend/src/app/routes.tsx::AppRoutes` adds `/forgot-password` and `/reset-password/:token` beside
  `/login`, outside `RequireAuth`: neither page needs a session or calls `/me`.
- `ForgotPasswordPage` posts the email and shows the server's answer; `ResetPasswordPage` posts the token and
  the new password and sends the user to the login page.
- `frontend/src/features/auth/formErrors.ts` holds the shared rules: code-point length, the policy limits, the
  429 wording, and `serverFieldErrors`.
- `PasswordField`, `Field` and `PageHeading` are the shared components.
- Caddy adds the per-path header; `scripts/smoke.sh` checks it.

### Walkthrough (variant B): submitting a new password

1. **The action.** The user opens the emailed link `/reset-password/<token>`. `ResetPasswordPage` takes
   `token` from the path and the history entry's `key`, and renders `ResetPasswordScreen` keyed by it. Its
   `PageHeading` ("Choose a new password") takes focus on mount.
2. **Form and validation.** react-hook-form with a zod schema: `new_password` must be 12–128 code points, and
   `confirm` must equal it ("The passwords don't match."). Not trimmed: spaces are part of a password. A
   client failure puts the message on the field and focuses it; nothing is sent. Only the server knows the
   common-password list.
3. **No hook, no cache key.** The call is a one-off mutation inside `onSubmit`, through the typed client
   (`api.post('/api/auth/password-reset/confirm', { body: { token, new_password } })`, operation
   `auth_password_reset_confirm`). No React Query hook: nothing is read or cached. Duplicate submits are
   dropped before react-hook-form while `inFlight` is set.
4. **Response handling.**
   - 204: `queryClient.clear()` and `clearTabChoices()` (every session of the account is gone), then, only if
     this screen is still mounted, `navigate('/login', { replace: true, state: { passwordUpdated: true } })`.
   - 400 `reset_token_invalid`, or a 422 with an error on `["body","token"]`: the keyed invalid screen
     ("This reset link is no longer valid", link to `/forgot-password`), whose heading takes focus.
   - 422 placeable by `serverFieldErrors` on `new_password`: the client's message for that `type` on the
     field, focused; the form stays, and the link still works.
   - 429: "Too many requests. Try again in N seconds/minutes" (or "later"); anything else: "Could not set the
     password. Try again." in a focused `role="alert"`.
5. **The login page.** `LoginPage` reads `passwordUpdated` from the router state into component state, shows the
   `role="status"` banner, and replaces the history entry's state with `null`. Its own `/me` check then runs as
   before (a 401 there clears the cache; the user stays on the login page).
6. **States and mobile.** The button is disabled while a request is out. All three pages use the login page's
   `max-w-sm px-4` column; at 375 px wide none scrolls horizontally (PR journey evidence).

The forgot page follows the same shape with one field: on 202 the form is replaced by the server's `detail` in a
focused `role="status"`; 429 and other failures show a focused alert and keep the form.

### Data model changes

None.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `frontend/src/features/auth/pages/ResetPasswordPage.tsx` | new: reset page | +185 |
| `frontend/src/features/auth/pages/ForgotPasswordPage.tsx` | new: forgot page | +128 |
| `frontend/src/features/auth/components/PasswordField.tsx` | new | +66 |
| `frontend/src/features/auth/formErrors.ts` | new: shared rules and 422 mapping | +57 |
| `frontend/src/features/auth/components/Field.tsx`, `PageHeading.tsx` | new (Field moved from LoginPage) | +18, +15 |
| `frontend/src/features/auth/pages/LoginPage.tsx` | link, banner, `PageHeading`, shared helpers | +28 / −24 |
| `frontend/src/app/routes.tsx` | two public routes | +5 / −1 |
| `deploy/Caddyfile`, `scripts/smoke.sh` | per-path header, default in snippet; checks | +9 / −1, +11 |
| `frontend/src/test/renderApp.tsx` | exposes the router location (with state); accepts object entries | +11 / −4 |
| `frontend/src/features/auth/pages/PasswordReset.test.tsx`, `LoginPage.test.tsx` | tests | +540, +50 |
| `docs/tickets/…` | split and frame | — |

`frontend/src/features/auth/pages/ResetPasswordPage.tsx::ResetPasswordPage`

```tsx
export function ResetPasswordPage() {
  const { token = '' } = useParams();
  const { key } = useLocation();
  return <ResetPasswordScreen key={key} token={token} />;
}
```

- A new component instance per history entry: its state, `mounted` and `inFlight` refs belong to that entry.
- Why: D5 (review round 1, F1). Without the key, Back from link B to link A kept B's instance: B's late 204
  navigated from A, and A's invalid screen showed on B.

`frontend/src/features/auth/pages/ResetPasswordPage.tsx::ResetPasswordScreen` (the submit handler)

```tsx
  const onSubmit = async ({ new_password }: ResetForm) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFailure(null);
    try {
      await api.post('/api/auth/password-reset/confirm', { body: { token, new_password } });
    } catch (error) {
      inFlight.current = false;
      if (error instanceof ApiError && error.status === 400 && error.code === 'reset_token_invalid') {
        setInvalid(true);
        return;
      }
      // ...
      if (error instanceof ApiError && error.status === 422 && error.errors?.some(({ loc }) => loc[0] === 'body' && loc[1] === 'token')) {
        setInvalid(true);
        return;
      }
      const placed = serverFieldErrors(error, ['new_password'] as const);
      if (placed) {
        placed.forEach(({ field, message }, index) => setError(field, { message }, { shouldFocus: index === 0 }));
        return;
      }
      setFailure({ message: rateLimitMessage(error) ?? 'Could not set the password. Try again.' });
      return;
    }
    // Every session of the account is gone, this tab's included: nothing cached may outlive it.
    queryClient.clear();
    clearTabChoices();
    if (mounted.current) navigate('/login', { replace: true, state: { passwordUpdated: true } satisfies LoginState });
  };
```

- The order of the checks matters: the token rules come before the field mapping, so a 422 with both a token
  and a password error shows the invalid screen.
- Without `mounted.current`, a reset answering after Back would navigate the user away from where they went.
- Without `clear()` / `clearTabChoices()`, a previous user's cached data and building choice outlive their
  ended session in this tab.

`frontend/src/features/auth/pages/ResetPasswordPage.tsx::ResetPasswordScreen` (the form's submit)

```tsx
        onSubmit={(event) => {
          // Before react-hook-form: a duplicate it handled would end its isSubmitting and re-enable the button
          // while the first request is still out (review round 2, F5).
          if (inFlight.current) event.preventDefault();
          else void handleSubmit(onSubmit)(event);
        }}
```

- `disabled={isSubmitting}` stops clicks; this stops every other `submit` event. The forgot page has the same.

`frontend/src/features/auth/formErrors.ts::serverFieldErrors`

```ts
export function serverFieldErrors<F extends string>(error: unknown, fields: readonly F[]): FieldError<F>[] | null {
  if (!(error instanceof ApiError) || error.status !== 422 || !error.errors?.length) return null;
  const placed: FieldError<F>[] = [];
  for (const { loc, type } of error.errors) {
    const field = loc.length === 2 && loc[0] === 'body' ? fields.find((name) => name === loc[1]) : undefined;
    const message = FIELD_MESSAGES[type];
    if (field === undefined || message === undefined) return null;
    placed.push({ field, message });
  }
  return placed;
}
```

- All or nothing: if any error can't be placed (another field, an unknown `type`), the caller shows a
  form-level alert instead, so nothing is silently dropped. The server's `msg` is never shown; the client words
  its own messages from `FIELD_MESSAGES` (the policy's `password_<reason>` and pydantic's `string_too_short`/
  `string_too_long`, which the confirm schema checks first).
- Mutation probes M6 and M6b in the PR show the tests fail if unknown types are placed or if mapping stops at
  the first unplaceable error.

`frontend/src/features/auth/pages/LoginPage.tsx::LoginPage` (the banner)

```tsx
  const [passwordUpdated] = useState(() => (location.state as LoginState | null)?.passwordUpdated === true);
  useEffect(() => {
    if ((location.state as LoginState | null)?.passwordUpdated)
      navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null });
  }, [location, navigate]);
```

- The banner is read once at mount; the entry's state is then emptied, so a reload (`BrowserRouter` keeps
  `history.state` across reloads) doesn't show it again. Without the replace, mutation M3 shows the test fails.

`deploy/Caddyfile::@token_pages`

```caddy
		?Referrer-Policy "strict-origin-when-cross-origin"
# ...
	@token_pages path /login /login/ /reset-password/* /invite/*
	header @token_pages Referrer-Policy "same-origin"
```

- D1 and D3. Caddy's path matcher is case-insensitive: `/LOGIN` and `/Reset-Password/abc` got `same-origin`
  in the PR's curl check.

## 5. Edge cases and tests

All tests below are in `frontend/src/features/auth/pages/PasswordReset.test.tsx` unless marked `LoginPage`.

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| The page reveals whether an email has an account | shows the server's identical 202 `detail` | `shows the server's confirmation for any email` (two emails, same text) |
| Empty email is sent | zod refuses, focus on the field | `asks for an email and sends nothing when empty` |
| 429 / 5xx / network / HTML 502 on the forgot form | wait time or generic text; no codes | `shows the wait time on 429` ×4, `shows a generic message on other failures` ×4 |
| A forgot request sent twice (each revokes the last link) | in-flight guard before react-hook-form | `does not send a second forgot request while the first is pending (F2)`, `forgot: keeps the button disabled…` |
| Leading/trailing spaces stripped from a password | not trimmed | `sends a password with leading and trailing spaces unchanged` |
| Emoji counted as two | code points | `checks 6 emoji (12 UTF-16 units) before sending`, `accepts 12 emoji…` |
| Used, unknown, wrong-shape or over-long token | invalid-link screen, focused heading, link to `/forgot-password` | `shows the invalid-link screen for reset_token_invalid` ×2, `shows the invalid-link screen for a 422 on the token: …` ×4 |
| Policy refusal | message on the field, focused; link still usable | `puts the server's password error on the field and keeps the form` ×6 |
| An error the page can't place | generic alert | `shows a generic alert for an error it can't place` ×4 |
| Double click / duplicate submit | one request; button stays disabled | `sends once on a double click`, `reset: keeps the button disabled after ignoring a duplicate submit (F5)` |
| Answer after leaving the page, to another link or another entry of the same link | no navigation; tab choices still cleared | `does not navigate when the reset answers after the page was left`, `Back to another reset link…`, `Back to the same link in another history entry…` |
| Invalid screen or field errors following the user to another link | new instance per entry | `another reset link / the same link again does not inherit the invalid screen (F1)`, `a field error does not follow the user to another reset link` |
| A forged or replayed banner | router state only, cleared after showing | LoginPage `never shows the banner from the URL` ×3, `shows the banner from router state, then drops it from history so a reload does not show it` |
| Focus lost to the body after a screen swap | keyed screen; focused status; `PageHeading` on login | focus asserts in the invalid-link and confirmation tests; `the login page reached after a reset focuses its heading (F3)`; LoginPage `focuses its heading on load` |
| Token leaks in `Referer` | `same-origin` on token pages | `make prodlike-smoke` (PR evidence, failing once before D3) |
| A reset while another account is signed in skips the banner | **not handled** (login's `/me` check redirects to that account's home) | **No test** (round 3 F6; see §7) |
| `/reset-password`, `/reset-password/`, `/reset-password/a/b` | **404 page**, not the invalid-link screen | **No test** (round 3 F7; see §7) |

**Acceptance criteria → tests**
1. `shows the server's confirmation for any email`, `asks for an email and sends nothing when empty`.
2. `shows the wait time on 429` (forgot ×4), `shows a generic message on other failures` (forgot ×4).
3. `sets the new password and lands on login with the banner` (body, cache, tab choices, history replaced).
4. LoginPage `never shows the banner from the URL`, `shows the banner from router state, then drops it…`.
5. `shows the invalid-link screen for reset_token_invalid`, `… for a 422 on the token` (gaps: F7).
6. `puts the server's password error on the field and keeps the form`, `shows a generic alert for an error it can't place`.
7. `checks … before sending` ×4, `accepts 12 emoji`, `shows the wait time on 429` (reset ×2), `shows a generic message on other failures` (reset ×2).
8. `sends once on a double click`, `does not navigate when the reset answers after the page was left`, F1/F5 tests.
9. `shows and hides the password without submitting`, `counts code points in a hint tied to the input, outside any live region`.
10. LoginPage `links to forgot password`.
11. `focuses the heading on load and sends with Enter`, `… submits with Enter`, and the focus asserts above.
12. `make prodlike-smoke` and the curl and Chromium checks in the PR (on `edc80b3`).
13. The test ids are listed in the PR for P4-09.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol` (high) | `edc80b3` | MERGE | F1 Medium: reset state survives navigation between tokens; F2 Medium: overlapping forgot submissions; F3 Low: no heading focus on login after a reset | all fixed in `fab2160` (tests red in `f301f45`) |
| 2 | Codex `gpt-6.1-sol` (high), fresh | `fab2160` | MERGE | F4 Medium: an over-long token gets the generic error; F5 Low: a duplicate submit re-enables the button | both fixed in `bbd4037` (tests red in `de31630`) |
| 3 | Codex `gpt-6.1-sol` (high), fresh | `bbd4037` | MERGE | F6 Medium: reset while another account is signed in skips the banner; F7 Medium: reset URL without one token segment is a 404 | not fixed: last round (fixes would merge unreviewed); follow-ups for P4-07b |

James's instruction for this run replaced the fresh Claude reviewer with Codex `gpt-6.1-sol` at high effort, with
no Claude cross-check.

- **F1:** submit link B, press Back to link A, B's 204 replaced A with `/login`; A's 400 then showed the invalid
  screen on B unsubmitted. Fix: D5. Evidence: the F1 tests failed (8 failing in `f301f45`), pass now.
- **F2:** a second `submit` event while the first POST was out sent another request; each request emails a
  new link and revokes the previous one. Fix: an in-flight ref. Evidence: F2 test.
- **F3:** after a reset the login page left focus on `BODY` (criterion 11). Fix: `PageHeading` on the login page.
- **F4:** `/reset-password/<201 characters>`: the API's schema answers 422 `string_too_long` on `token`, and the
  page showed the generic alert with a form that could never work. Fix: any 422 on the token → invalid screen.
  An earlier test that used `["body","token"]` as its example of an unknown field now uses `["body","extra"]`.
- **F5:** the guard inside `handleSubmit` let react-hook-form end `isSubmitting` early. Fix: drop the event before
  `handleSubmit`. Evidence: F5 tests (6 failing in `de31630`, with F4's).
- Round 1 also noted a membership finding from code on Codex's stale local `main` (PRs #93/#94, not in this
  diff): dismissed for this PR; round 2 accepted the dismissal.

## 7. Not verified, accepted risks and follow-ups

- **F6 (open Medium):** resetting account A's password while B is signed in on the same browser ends only A's
  sessions; the login page's `/me` check then redirects to B's home and the banner is never seen. No test.
  Tracked: P4-07b's ticket (bookkeeping commit).
- **F7 (open Medium):** `/reset-password`, `/reset-password/` and `/reset-password/a/b` show "Page not found"
  instead of the invalid-link screen and its recovery link. No test. Tracked: P4-07b's ticket.
- **Stack runs predate the review fixes:** the prod-like smoke, curl checks and the Chromium journey ran on
  `edc80b3`. F1–F5's changes are frontend-only and covered by unit tests; round 2's and 3's Codex runs did
  their own Chromium checks of headers, keyboard reset/CSRF and focus on its stack, but not the full Mailpit
  journey on the final commit.
- Screen-reader announcements were not checked with a real screen reader; only roles, `aria-*` attributes and
  focus are tested. The login banner is a `role="status"` present at mount, which some screen readers don't
  announce on their own; the focused heading is what is announced.
- Our own `/api` still receives the token page's full URL as `Referer` (D1). Under `make up` there is no
  `Referrer-Policy` header on these pages. Tracked only here.
- The `AccountMenu` Lows carried from P2-06c are untouched (this PR doesn't change the menu); they are in
  P4-07b's ticket text.
- Size: ~424 non-test lines, a little over the ~400 guideline (PR smaller decisions).

## 8. How to change this safely

- **Another password form (P4-07b's invite screen):** reuse `PasswordField` and `serverFieldErrors` with that
  form's field names (`['password', 'full_name']`), and handle the screen-level codes (an invalid token) before
  calling it, as `ResetPasswordScreen` does. Copy the duplicate-submit check before `handleSubmit`.
- **A new error type from the policy:** add it to `frontend/src/features/auth/formErrors.ts::FIELD_MESSAGES`; until then it shows the
  generic alert (`shows a generic alert … (an unknown type on the field)` proves that path).
- **A new token page:** add its path to `deploy/Caddyfile::@token_pages` and a `fetch`/`check` pair to
  `scripts/smoke.sh`; the smoke fails if the header is missing or doubled.
- **A page that swaps screens:** key the new branch, or its heading won't take focus (D4). The tests' `click`
  helper focuses the button first; `fireEvent.click` alone hides that bug.

## 9. Must explain, then quiz

**1. Why does the forgot-password screen never say whether the email exists?** Otherwise anyone could type
addresses and learn who has an account (account enumeration), a first step for phishing or password guessing.
The server answers every request with the same 202 and the same `detail` (P4-04), and
`ForgotPasswordPage` shows that text as is, never anything of its own that depends on the email. The test
`shows the server's confirmation for any email` sends a known and an unknown address and asserts the same
text and one request each. Only a 429 differs, and it depends on the rate (IP or email), not on whether the account exists.

**2. How are server validation errors mapped onto form fields?** The API answers 422 `validation_error` with
`errors[]`, each `{loc, msg, type}`; `loc` is `["body", <field>]` (`backend/app/core/errors.py::field_errors`
gives the service's own checks the same shape as pydantic's). `frontend/src/features/auth/formErrors.ts::serverFieldErrors` takes the
error and the form's field names, and for each entry finds the field from `loc[1]` and a client message from
`type`. If every entry can be placed, the page calls react-hook-form's `setError` on each and focuses the first;
if any can't, it returns `null` and the page shows a generic alert. The server's `msg` text is never displayed.

**3. Why is the "password updated" banner in router state and not in the URL?** A URL can be written by anyone:
`/login?passwordUpdated=true` in a phishing email would show a reassuring false message. Router state is set
only by the app's own `navigate` call after a real 204. `LoginPage` also empties the state after reading it,
so a reload doesn't show it again (`BrowserRouter` keeps `history.state` across reloads).

**Quiz**

1. A user submits a reset, presses Back to another reset link before the answer arrives, and the answer is a
   204. What does the user see, and why?
2. Why does the reset page check a 422 for an error on `token` before calling `serverFieldErrors`?
3. Why did the real browser lose focus on the invalid-link screen while the jsdom test passed?
4. What would break if `deploy/Caddyfile`'s snippet went back to a plain `Referrer-Policy` (without `?`)?
5. How would you extend this to P4-07b's accept-invite form, which has `full_name`, `password` and `confirm`?

<details><summary>Answers</summary>

1. They stay on the link they went back to, with its form. `ResetPasswordPage` keys `ResetPasswordScreen` by the
   history entry, so the submitting instance unmounted on Back; its `mounted` ref is false, so it doesn't
   navigate. It still clears the cache and tab choices, since the server ended every session
   (`Back to another reset link: the abandoned reset does not navigate (F1)`).
2. A token the schema refuses (over 200 characters) comes back as a 422 on `token`; `serverFieldErrors` would
   find no `token` field in the form and return `null`, so the user would get a generic alert on a form that can
   never work (round 2, F4). Checking first also makes the invalid screen win when the 422 has both errors.
3. Both branches rendered `<main><PageHeading>` at the same position, so React reused the heading and its
   mount-only focus effect didn't run; the focused submit button was removed, leaving focus on the body.
   `fireEvent.click` doesn't move focus in jsdom, so focus was still on the heading from page load (D4).
4. The snippet's block is deferred (it deletes `Server`), so its plain set would overwrite the per-path
   `same-origin` on the token pages; `make prodlike-smoke` would fail its `Referrer-Policy same-origin` checks,
   as it did before D3.
5. Put the invalid-token screen first (404 `invitation_invalid`, keyed like the reset page), then call
   `serverFieldErrors(error, ['full_name', 'password'] as const)` (the accept answers `missing` and
   `password_<reason>`), use `PasswordField` for the password and confirmation, the same zod code-point
   rules, and the duplicate-submit check before `handleSubmit`. The 409 and 403 codes need screen-level
   messages of their own.

</details>
