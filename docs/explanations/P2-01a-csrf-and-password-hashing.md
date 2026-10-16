# Explanation — P2-01a CSRF protection and password hashing

> **PR:** #56 · **Source revision:** `9a70e97` (pre-merge), the PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (3) reviewed `def1f79`; the two commits after it,
> `4772511` (a docstring and three tests) and `9a70e97` (the CSRF module docstring's account of `SameSite=Lax`,
> corrected during this reality pass), change no behaviour (see §6).
> **Merge commit:** not known when written; after the merge, `gh pr view 56 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs. The branch
> contains `origin/main` (`4970a2a`).
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `4772511` (and `9a70e97`, comment only) the diff (`git diff origin/main...HEAD`), `backend/app/core/csrf.py`,
> `backend/app/core/security.py`, the diffs of `errors.py`, `config.py`, `seed.py`, `cli.py`, `main.py`,
> `logging_config.py`, and the assertions of `backend/tests/test_csrf.py` and `backend/tests/test_security.py`; ran
> `make test DB_PORT=55432`: **515 passed**, and the five cited test files: **259 passed**. Mutation results
> are quoted from the PR (run at `0598c0b`, `def1f79`), not re-run for this text. Differences from the plan:
> see §2 "Plan versus final code".
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 1. Walkthrough variant: A (one real unsafe request, `POST /api/health`, through the new
> middleware; the ticket adds no endpoint).

## 1. What was built and why

P2-01 (sessions, login, logout, CSRF) estimated at ~540 non-test lines, so framing split it: this part,
P2-01a, puts in the defences and building blocks; P2-01b adds the session table and the login/logout
endpoints. Built here:

- a **CSRF middleware** that rejects every request whose method isn't `GET`/`HEAD`/`OPTIONS`, on every path,
  unless it carries `X-Requested-With: fetch` and a trusted `Origin` (or, with no `Origin`,
  `Sec-Fetch-Site: same-origin`). It runs before routing and answers 403 problem+json `csrf_failed`;
- **`backend/app/core/security.py`**: argon2id password hashing, a `DUMMY_HASH`, session-token generation and
  hashing, and the password policy (12–128 characters, not one of 1,000 common passwords);
- **seed passwords**: the public `DevPassword!2026` in dev and test, a secret `SEED_PASSWORD` in staging;
- two fixes carried from P1-04: keyword-only `DomainError` subclass arguments with a snake_case `code`
  check, and no explicit default ports in `TRUSTED_ORIGINS`.

The two decisions that matter most: CSRF goes in before any cookie-authenticated endpoint exists (the split
order), and staging's demo accounts never use the password published in the README (D2).

## 2. Decisions

### D1. The common-password list: the 1,000 most common passwords that meet the length rule

- **Problem or constraint:** the ticket said "rejects the 1,000 most common passwords" with a 12-character
  minimum. In the usual top-1,000 list no entry has 12 or more characters, so the check could never fire.
- **Chosen:** the 1,000 most frequent entries of 12–128 printable-ASCII characters from SecLists'
  `xato-net-10-million-passwords-1000000.txt` (commit `21537be…`, MIT), lower-cased then de-duplicated in
  frequency order, stored as `backend/app/core/common_passwords.txt`, compared with `password.lower()`.
- **Alternatives rejected:** the literal top-1,000 (vacuous under the length rule); a larger list such as
  10,000 (more data for little gain; the ticket named 1,000).
- **Tradeoffs and accepted limitations:** ASCII only, one 2015-era corpus, no breach-corpus (HIBP) lookup,
  no Unicode normalisation (a full-width variant of a listed password passes; review round 3 L2).
- **Basis:** autonomous, sharpening the ticket. **Source:** recorded (ticket Frame notes; PR D1).

### D2. Staging seed users get `SEED_PASSWORD`, not the public dev password

- **Problem or constraint:** the original scope gave staging seed users `DevPassword!2026`, which the README
  publishes, and staging is reachable (P1-06 review L3, carried to this ticket).
- **Chosen:** `backend/app/seed.py::seed_password_for` returns `DEV_SEED_PASSWORD` outside staging; in staging
  it returns the `SEED_PASSWORD` setting, and raises `SeedRefusedError` if that is unset, equal to the dev
  password, or fails the policy. The message names the reason, never the value. Both `seed()` and the CLI
  call it before anything is written (the CLI before it opens a session).
- **Alternatives rejected:** keep the dev password in staging (anyone reading the repo logs in as the demo
  manager); no password in staging (D-06 must log in there to check the `__Host-` cookie).
- **Tradeoffs and accepted limitations:** staging needs a secret before `make seed` (D-02/D-06). A
  `SEED_PASSWORD` set in dev is ignored, so the README stays true.
- **Basis:** autonomous (the ticket left it to framing); lasting, so it is in the inbox. **Source:** recorded
  (Frame notes; PR D2).

### D3. CSRF covers every method except GET/HEAD/OPTIONS, on every path

- **Problem or constraint:** the ticket listed `POST/PUT/PATCH/DELETE` under `/api/`.
- **Chosen:** `backend/app/core/csrf.py::SAFE_METHODS` is the allowlist; anything else is checked, on any
  path. Exactly one `X-Requested-With` equal to `fetch`; exactly one `Origin` equal to a trusted origin, or no
  `Origin` and exactly `Sec-Fetch-Site: same-origin`.
- **Alternatives rejected:** the four named methods (a `PROPFIND` or other method a future route accepts
  would pass unchecked); `/api/` only (nothing else is served today, so it rejects nothing legitimate, while a
  router mounted elsewhere later would be unprotected).
- **Tradeoffs and accepted limitations:** a `POST` to a path with no route answers 403 instead of 405/404
  when the headers are missing. Non-browser clients (curl, scripts) must send the headers.
- **Basis:** autonomous, stricter than the ticket. **Source:** recorded (PR D3).

### D4. A pure ASGI middleware that returns the problem response itself

- **Problem or constraint:** a `DomainError` raised inside a middleware runs outside Starlette's exception
  middleware and becomes a 500 (P1-04 round 3 residual, carried here).
- **Chosen:** `backend/app/core/csrf.py::CSRFMiddleware` is a plain ASGI class. On failure it logs
  `csrf_rejected` with a `reason` and sends `problem_response(...)`; it never reads the body. It is added
  before `RequestLoggingMiddleware` in `backend/app/main.py::create_app`, so it runs inside it and the
  rejection is logged with its request id.
- **Alternatives rejected:** `BaseHTTPMiddleware` (it wraps the response stream; not needed for a header
  check); a per-router dependency (a route that forgets it is unprotected; ADR-0003 says middleware).
- **Basis:** ticket + P1-04 residual. **Source:** recorded (PR D4).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| `argon2-cffi`, default parameters (t=3, m=64 MiB, p=4) | `pwdlib[argon2]` | it wraps `argon2-cffi`; one dependency fewer; `check_needs_rehash` built in | autonomous | PR table |
| `verify_password` returns False for a mismatch, an unparsable hash and a non-ASCII hash | let the parse error propagate | a corrupt row must be a failed login, not a 500 | autonomous; review round 1 M1 | PR table, §6 |
| `needs_rehash` returns True for unreadable parameters or a non-base64 salt/digest, and is documented as "call after a successful verify" | decode salt and digest canonically | found in round 3, the last round; no behaviour change after it (§6, §7) | review rounds 1–3 | PR review section |
| The policy rejects a password that can't be UTF-8 encoded (`invalid_characters`) | none recorded | `hash_password` would raise on a lone surrogate | review round 2 M1 | PR review section |
| Test clients send `Origin` as well as `X-Requested-With` | `X-Requested-With` only | the ticket's own rule rejects a request with neither `Origin` nor `Sec-Fetch-Site` | follows from the ticket | PR table |
| Seed hashes once per run; keeps a hash that verifies and needs no rehash | hash per user per run | re-runs would rewrite every row | autonomous | PR table |
| Base `DomainError(code, status, title, …)` stays positional | keyword-only everywhere | the carry names the subclasses; an existing test builds the base positionally | ticket | PR table |
| `WeakPasswordError(ValueError)` with a `reason`, not a `DomainError` | a 422 `DomainError` | no endpoint uses it yet; P4-02/P4-04 map it | autonomous | PR table |
| Length counts characters (`len`) | bytes | NIST SP 800-63B counts characters | autonomous | PR table |

**Framing changes:** P2-01 split into P2-01a and P2-01b (index, critical path, P2-02 and P2-05 dependencies
updated). The original AC7 (CSRF) became AC1–AC5 here (all non-safe methods, all paths, exact value,
duplicates, `null` and near-miss origins, the `Sec-Fetch-Site` values, no 500); AC8 became AC6 (malformed
hashes, `DUMMY_HASH`, `needs_rehash`); AC7–AC11 are new (tokens, policy, seed passwords, two P1-04 carries).
Missed case added: default ports in `TRUSTED_ORIGINS`. Nothing loosened.

**Plan versus final code:** the Plan's file list and interfaces match. Differences, all from review rounds:
`verify_password` also catches `UnicodeEncodeError`; `needs_rehash` gained a salt/digest alphabet check and a
documented precondition; the policy gained the `invalid_characters` reason (not in the ticket's three
reasons); `docs/ARCHITECTURE.md` §6 was updated (not in the Plan's file list).

## 3. How it is implemented

### Overview

- `backend/app/core/csrf.py::CSRFMiddleware` sits between request logging and FastAPI's own stack; it reads
  only headers and either passes the request on or answers 403.
- `backend/app/core/security.py` holds stateless helpers: one module-level `PasswordHasher`, `DUMMY_HASH`
  computed at import, and the common-password set loaded once (`functools.cache`).
- `backend/app/seed.py::seed_password_for` decides the seeded password per environment; `seed()` hashes it
  once and applies it to every seeded user whose hash doesn't already verify.
- `backend/tests/conftest.py::CSRF_HEADERS` makes the shared test clients behave like the SPA.

### Walkthrough (variant A): `POST /api/health` without the headers

1. **HTTP.** `curl -X POST localhost:8011/api/health` (from the PR's stack run). The ASGI server calls the
   app; the outermost middleware is `RequestLoggingMiddleware` (added last in
   `backend/app/main.py::create_app`). It sets `request.state.request_id` and the logging context variable.
2. **CSRF.** `CSRFMiddleware.__call__` sees `scope["type"] == "http"` and method `POST`, not in
   `SAFE_METHODS`, so it calls `_failure(Headers(scope=scope))`. `getlist("x-requested-with")` is `[]`, not
   `["fetch"]`, so the reason is `x_requested_with`. With the header present, an `Origin` decides alone (one
   value, in `settings.trusted_origins`); with no `Origin`, only `Sec-Fetch-Site: same-origin` passes.
3. **Rejection.** It logs `csrf_rejected` (WARNING, `reason`, `path`; `reason` was added to the JSON log
   fields in `backend/app/logging_config.py::JsonFormatter`), builds `problem_response(Request(scope), …)`
   and sends it. The inner app, routing and handler never run, and `receive` is never called, so the body is
   not read.
4. **Response.** Back in `RequestLoggingMiddleware`: `X-Request-ID` is set and `request_completed` is logged
   with status 403. The client gets:

   ```
   HTTP/1.1 403 Forbidden
   content-type: application/problem+json
   {"type":"/problems/csrf-failed","title":"Forbidden","status":403,"code":"csrf_failed",
    "detail":"The request did not pass the CSRF check.","request_id":"f703585d-…"}
   ```
5. **Passing request.** With `Origin: http://localhost:5173` and `X-Requested-With: fetch`, `_failure`
   returns None and the request reaches routing: `/api/health` has no POST route, so 405. That 403-vs-405 pair
   is the evidence that the check runs before routing (`test_check_runs_before_routing`).

No database access happens on this path; no SQL to show.

### Data model changes

None. `users.password_hash` (P1-02) is now filled by the seed.

## 4. The code

**Files changed** (from `git diff --stat origin/main...HEAD`)

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/core/csrf.py` | new: the middleware | +64 |
| `backend/app/core/security.py` | new: hashing, tokens, policy | +107 |
| `backend/app/core/common_passwords.txt` | new: 1,000-entry data file | +1000 |
| `backend/app/core/errors.py` | keyword-only subclasses, snake_case check | +18 −3 |
| `backend/app/core/config.py` | `seed_password`, default-port rejection | +17 −1 |
| `backend/app/seed.py`, `backend/app/cli.py` | seed passwords | +44 −3, +5 −2 |
| `backend/app/main.py`, `backend/app/logging_config.py` | wire the middleware; log `reason` | +4 −1, +1 |
| `backend/pyproject.toml`, `backend/uv.lock` | `argon2-cffi` | +1, +90 |
| `README.md`, `backend/.env.example`, `docs/ARCHITECTURE.md`, `backend/tests/README.md` | docs | small |
| `backend/tests/*` | `conftest.py` headers; `test_csrf.py`, `test_security.py` new; seed, errors, config tests | +700 |
| `docs/tickets/*` | the split | +350 |

`backend/app/core/csrf.py::_failure`

```python
def _failure(headers: Headers) -> str | None:
    """Why the request fails the check, or None if it passes. Duplicated headers fail."""
    if headers.getlist("x-requested-with") != ["fetch"]:
        return "x_requested_with"
    origins = headers.getlist("origin")
    if origins:
        return None if len(origins) == 1 and origins[0] in settings.trusted_origins else "origin"
    if headers.getlist("sec-fetch-site") != ["same-origin"]:
        return "no_origin"
    return None
```

- `getlist(...) != ["fetch"]` rejects a missing header, any other value, a padded or upper-case value, two
  headers, and the comma-joined `fetch, fetch`.
- An `Origin`, when present, decides alone: `Sec-Fetch-Site: same-origin` can't rescue an untrusted one, and
  a trusted one passes whatever `Sec-Fetch-Site` says.
- Remove the `len(origins) == 1` and a request with a trusted and an evil `Origin` passes (mutation M3, 2
  tests failed).

`backend/app/core/csrf.py::CSRFMiddleware`

```python
    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # ...
        if scope["type"] != "http" or scope["method"] in SAFE_METHODS:
            await self.app(scope, receive, send)
            return
        reason = _failure(Headers(scope=scope))
        if reason is None:
            await self.app(scope, receive, send)
            return
        logger.warning("csrf_rejected", extra={"reason": reason, "path": scope["path"]})
        # A response, not a raised DomainError: an exception raised in a middleware never reaches
        # the app's exception handlers and would become a 500.
        response = problem_response(
            Request(scope),
            status=403,
            code="csrf_failed",
            title="Forbidden",
            detail="The request did not pass the CSRF check.",
        )
        await response(scope, receive, send)
```

- Raising `Forbidden` here instead of sending the response makes the 403 a 500 (mutation M5:
  `test_rejection_is_a_logged_403_not_a_500` failed).
- WebSocket scopes skip the check; there are no WebSocket routes (comment in the code; §7).

`backend/app/core/security.py::verify_password` and `needs_rehash`

```python
def verify_password(password: str, password_hash: str) -> bool:
    """True only if `password` matches; False for a mismatch or a hash that can't be parsed."""
    try:
        return _hasher.verify(password_hash, password)
    # UnicodeEncodeError: argon2 encodes the hash as ASCII before parsing it (review round 1 M1).
    except VerificationError, InvalidHashError, UnicodeEncodeError:
        return False


def needs_rehash(password_hash: str) -> bool:
    # ...docstring: call it only on a hash `verify_password` accepted
    salt_and_digest = "$" + "$".join(password_hash.split("$")[-2:])
    if not _PHC_SALT_AND_DIGEST.fullmatch(salt_and_digest):
        return True
    try:
        return _hasher.check_needs_rehash(password_hash)
    except InvalidHashError, UnicodeEncodeError:
        return True
```

- `except A, B, C:` without parentheses is Python 3.14 syntax (PEP 758); it catches all three.
- Without `UnicodeEncodeError`, a non-ASCII stored hash raises out of `verify_password`; P2-01b's login would
  answer 500 instead of 401 (review round 1 M1).
- `needs_rehash` doesn't decode the salt and digest, so a non-canonical last character passes (round 3 Low).
  That is why its contract is "after a successful verify", which the seed's condition
  `current is None or not verify_password(...) or needs_rehash(current)` respects.

`backend/app/core/security.py::check_password_policy`

```python
def check_password_policy(password: str) -> None:
    # ...
    try:
        password.encode()
    except UnicodeEncodeError:
        # A lone surrogate (JSON can carry one): it can't be hashed (review round 2 M1).
        raise WeakPasswordError("invalid_characters") from None
    if len(password) < PASSWORD_MIN_LENGTH:
        raise WeakPasswordError("too_short")
    if len(password) > PASSWORD_MAX_LENGTH:
        raise WeakPasswordError("too_long")
    if password.lower() in _common_passwords():
        raise WeakPasswordError("too_common")
```

- Drop `.lower()` and `QWERTYQWERTY` passes (mutation M7, 2 tests failed).

`backend/app/seed.py::seed_password_for`

```python
def seed_password_for(app_env: AppEnv, seed_password: str | None) -> str:
    # ...
    if app_env != "staging":
        return DEV_SEED_PASSWORD
    if not seed_password:
        raise SeedRefusedError("seed in staging needs SEED_PASSWORD (a secret), which is not set")
    if seed_password == DEV_SEED_PASSWORD:
        raise SeedRefusedError("SEED_PASSWORD must not be the public dev password in staging")
    try:
        check_password_policy(seed_password)
    except WeakPasswordError as exc:
        # The reason only, never the value.
        raise SeedRefusedError(f"SEED_PASSWORD fails the password policy: {exc.reason}") from None
    return seed_password
```

- `from None` keeps the policy exception (whose message holds no value either) out of the chain.
- Make the first test `if True:` and staging seeds the public password (mutation M9, 8 tests failed).

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Cross-site form POST (no custom header) | 403 `csrf_failed`, handler not run | `test_unsafe_request_without_exactly_fetch_header_is_rejected[missing-*]` |
| `X-Requested-With` duplicated, padded, upper-case, comma-joined | 403 | same test, other ids |
| `Origin: null`, empty, trailing slash, upper case, other port, two values | 403 | `test_unsafe_request_from_an_untrusted_origin_is_rejected` |
| Untrusted `Origin` plus `Sec-Fetch-Site: same-origin` | 403 (Origin decides) | `test_same_origin_fetch_site_does_not_rescue_an_untrusted_origin` |
| No `Origin`, `Sec-Fetch-Site` absent/same-site/cross-site/none | 403 | `test_unsafe_request_without_origin_needs_same_origin_fetch_site` |
| `PROPFIND` or another method | checked like POST | `test_unsafe_request_without_exactly_fetch_header_is_rejected[*-PROPFIND]` |
| A route outside `/api` | checked | `test_check_covers_paths_outside_api` |
| Middleware error path | 403 problem, logged with request id, not 500 | `test_rejection_is_a_logged_403_not_a_500`, `test_rejection_is_logged_with_its_reason_and_no_header_values` |
| Large or slow body on a rejected request | body never read | `test_rejection_does_not_read_the_request_body` |
| Corrupt or foreign stored hash (text, bcrypt, non-ASCII) | `verify_password` False, `needs_rehash` True | `test_verify_returns_false_for_a_hash_it_cannot_parse` |
| Current parameters, garbage salt/digest | `needs_rehash` True | `test_hash_with_current_parameters_but_a_garbage_payload_needs_replacing` |
| Non-canonical last base64 character | `needs_rehash` False (documented) | **No test** (§7) |
| Lone surrogate password | policy rejects `invalid_characters` | `test_policy_rejects_a_password_that_is_not_valid_unicode` |
| Staging seed with no, weak or dev password | refused before any write | `test_seed_in_staging_refuses_a_missing_or_weak_password`, `test_cli_seed_in_staging_without_a_valid_seed_password_opens_no_session` |
| Seed re-run | no hash rewritten; a weak-parameter hash upgraded | `test_seed_twice_keeps_every_password_hash`, `test_seed_replaces_a_hash_made_with_weaker_parameters` |

Acceptance criteria → tests:
1. `test_unsafe_request_without_exactly_fetch_header_is_rejected`
2. `test_unsafe_request_from_an_untrusted_origin_is_rejected`
3. `test_unsafe_request_without_origin_needs_same_origin_fetch_site`, `…_but_same_origin_fetch_site_passes`
4. `test_unsafe_request_with_trusted_origin_and_fetch_header_reaches_the_handler`,
   `test_check_covers_paths_outside_api`, `test_safe_methods_need_no_csrf_headers`
5. `test_rejection_is_a_logged_403_not_a_500`
6. `test_hash_is_argon2id_and_verifies_only_the_right_password`,
   `test_verify_returns_false_for_a_hash_it_cannot_parse`,
   `test_weaker_parameters_need_a_rehash_and_current_ones_do_not`, `test_dummy_hash_costs_what_a_real_hash_costs`
7. `test_tokens_are_long_url_safe_and_unique`, `test_token_hash_is_lowercase_hex_sha256`
8. `test_policy_rejects_passwords_outside_12_to_128_characters`, `test_policy_rejects_common_passwords_in_any_case`,
   `test_common_list_has_1000_unique_lowercase_entries_that_meet_the_length_rule`
9. `test_seeded_users_use_example_test_and_the_dev_password`, `test_seed_twice_keeps_every_password_hash`,
   `test_seed_in_staging_refuses_a_missing_or_weak_password`, `test_seed_in_staging_uses_the_seed_password`
10. `test_domain_error_subclasses_take_no_positional_arguments`, `test_domain_error_code_must_be_snake_case`
11. `test_trusted_origins_reject_an_explicit_default_port`

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6-astra` (medium) | `0598c0b` | MERGE | M1: `verify_password` raises on a non-ASCII hash | fixed in `4636e02` |
| 1 | Claude (Sonnet 5.5, high), security pass | `0598c0b` | MERGE | M1 (same); L1 `needs_rehash` raises on garbage; L2 CLI staging success untested; L3 seed rehash branch untested; L4 WebSocket skips check; L5 notes for P2-01b | M1, L1 fixed; L2, L3 tests added; L4 comment; L5 to P2-01b — `4636e02` |
| 2 | Codex `gpt-6-astra` (medium) | `4636e02` | MERGE | Low: garbage salt/digest with current parameters → `needs_rehash` False | fixed in `def1f79` |
| 2 | Claude (Sonnet 5.5, high), security pass | `4636e02` | MERGE | M1: lone-surrogate password passes the policy, then hashing raises; M2: `csrf_rejected` log untested; L1: ARCHITECTURE drift; L2/L3 P2-01b notes; L4 log noise | M1 fixed, M2 test, L1 doc — `def1f79`; L2/L3 to P2-01b; L4 accepted |
| 3 | Codex `gpt-6-astra` (medium) | `def1f79` | MERGE | Low: non-canonical last base64 character → `needs_rehash` False | contract documented in `4772511`; decode fix to P2-01b |
| 3 | Claude (Sonnet 5.5, high), security pass | `def1f79` | MERGE | L1 (same as Codex); L2 no Unicode normalisation (accepted, D1); L3 NUL-suffixed stored hash verifies (DB-only input, informational); suggested tests | tests added in `4772511` |

The Claude round 2 reviewer read the PR body before the round 1 record was published (a `gh pr edit` failed
on a GitHub GraphQL deprecation; the body was then updated through the REST API), so it reviewed the whole
diff without the round 1 answers.

Fixes and the failures behind them:
- **Round 1 M1.** Input: stored hash `"not-a-hash-é"`. Outcome: `UnicodeEncodeError` out of
  `verify_password`, against AC6. Evidence: Codex's proof failed 2/2; the non-ASCII cases were added to
  `test_verify_returns_false_for_a_hash_it_cannot_parse` (6 failed before the fix, including L1's new
  `needs_rehash` assertion on the four earlier cases; all pass after).
- **Round 2 Low.** Input: `DUMMY_HASH` with its digest replaced by `!`/`é`/`=` of the same length. Outcome:
  `needs_rehash` False (argon2-cffi checks parameters and lengths only). Evidence:
  `test_hash_with_current_parameters_but_a_garbage_payload_needs_replacing` failed 3/3 before, passes after;
  removing the check fails it again.
- **Round 2 M1.** Input: `"\ud800" * 12`. Outcome: the policy passes, `hash_password` raises. Evidence:
  `test_policy_rejects_a_password_that_is_not_valid_unicode` failed 2/2 before, passes after.
- **Round 2 M2.** No code change; the new test fails when the warning is demoted to `debug` (3 failed).
- **Round 3 Low.** Not fixed in code: it came in the last round the playbook allows, and it is not reachable
  (every caller verifies first). `4772511` only states the contract in the docstring and adds tests; it was
  not reviewed by a fresh reviewer.

## 7. Not verified, accepted risks and follow-ups

Not verified:
- **`needs_rehash` on a non-canonical salt/digest returns False.** No test pins either behaviour; the fix (a
  canonical decode/re-encode) goes to P2-01b.
- **`4772511` and `9a70e97` were not reviewed** by a fresh reviewer (docstrings and three tests, after round 3).
- **Real browsers.** The CSRF rules were tested with httpx and curl, not with a browser's own `Origin` and
  `Sec-Fetch-Site` behaviour; the SPA's real requests are first exercised when P2-06 logs in.
- **Timing.** That `DUMMY_HASH` makes the unknown-email path cost the same as a wrong password is argued from
  its parameters (`test_dummy_hash_costs_what_a_real_hash_costs` checks them), not measured. P2-01b uses it.
- **The common-password list's provenance** was not re-checked by a reviewer against the pinned commit (the
  round 2 reviewer had no network).

Accepted risks:
- WebSocket scopes skip the CSRF check; there are no WebSocket routes (rule 13). Tracked: comment in
  `CSRFMiddleware.__call__`.
- Each rejection logs a WARNING line; P2-05 rate limiting bounds the volume. Tracked only here.
- No Unicode normalisation of passwords, no breached-password lookup (D1). Tracked only here.
- A stored hash with a NUL suffix verifies (argon2 reads a C string); hashes come only from the database.
  Tracked only here.

Follow-ups (added to their tickets in this PR's bookkeeping commit):
- P2-01b: verify against `DUMMY_HASH` for a NULL **or unparsable** hash; cap the login password length in the
  schema before hashing; run argon2 off the event loop; make `needs_rehash` decode the salt and digest.
- D-02: set `SEED_PASSWORD` in the staging environment before seeding.

## 8. How to change this safely

- **A new unsafe endpoint** needs nothing: the middleware covers it. Its tests use `client`/`app_client`,
  which already send `CSRF_HEADERS`. Don't exempt a route without an ADR (CLAUDE.md rule 4).
- **Add a trusted origin** through `TRUSTED_ORIGINS`: lowercase `scheme://host[:port]`, no default port, or
  settings fail to load (`backend/tests/test_config.py`).
- **Change the CSRF rule:** edit `_failure`; `backend/tests/test_csrf.py` covers every branch, and the PR's mutation
  table shows which tests catch which loosening.
- **Change argon2 parameters:** change `_hasher`. Existing hashes then report `needs_rehash`; P2-01b's login
  upgrades them after a successful verify, and the seed rewrites seeded users. `DUMMY_HASH` follows
  automatically.
- **Use the policy in an endpoint** (P4-02, P4-04): call `check_password_policy` and map
  `WeakPasswordError.reason` to a 422; never echo the password.

## 9. Must explain, then quiz

**1. Why argon2id for passwords but plain sha256 for session tokens?** A password is chosen by a person, so
the space an attacker searches is small; a stolen hash must be slow and memory-hard to guess, which is
argon2id's job (`backend/app/core/security.py::hash_password`; the default parameters use 64 MiB per hash). A session
token is 32 random bytes from `secrets.token_urlsafe` (`generate_token`): no one can guess it, so the stored
value only has to be useless if the database leaks, and one fast sha256 (`hash_token`) does that. Argon2 on
tokens would cost that time on **every** request that resolves the cookie, for no gain.

**2. What does `DUMMY_HASH` prevent?** User enumeration by timing. If login skipped the hash check when the
email is unknown (or the user has no password), that answer would come back measurably faster than a
wrong password, telling an attacker which emails have accounts. `DUMMY_HASH` is a real argon2id hash with the
current parameters (`test_dummy_hash_costs_what_a_real_hash_costs`), so P2-01b can verify the submitted
password against it on those paths and spend the same time. Inferred: it must be computed with the same
parameters, which is why it is made by `hash_password` at import instead of being a hard-coded string.

**3. A CSRF attack from `evil.example` against `POST /api/auth/logout` (P2-01b).**
- The victim, logged in, visits `evil.example`. A hidden `<form method=POST action=https://app/api/auth/logout>`
  auto-submits. Defence 1 (P2-01b): the cookie is `SameSite=Lax`, so a modern browser doesn't attach it to
  a cross-site POST. That is not enough on its own: it doesn't cover another origin on the same site (a
  sibling subdomain), and it depends on the browser (the module docstring of `backend/app/core/csrf.py` says
  so). Defence 2, this ticket: a form can't set `X-Requested-With`, so `_failure` returns
  `x_requested_with` → 403, whether or not the cookie came along.
- The page tries `fetch(url, {method: "POST", credentials: "include", headers: {"X-Requested-With": "fetch"}})`.
  A custom header makes it a non-simple request, so the browser first sends an `OPTIONS` preflight. No CORS
  middleware is installed, so the preflight gets no `Access-Control-Allow-*` headers and the browser never
  sends the POST.
- Even if a browser sent it, its `Origin: https://evil.example` isn't in `settings.trusted_origins` →
  `reason == "origin"` → 403. The page's script can't change `Origin` or `Sec-Fetch-Site`.

Quiz:
1. Why does the check accept a request with no `Origin` only when `Sec-Fetch-Site` is `same-origin`, instead
   of accepting any request with no `Origin`?
2. A test client posts with `Origin: http://localhost:5173` but the test settings trust only
   `http://127.0.0.1:5173`. What happens, and why is that correct?
3. What would break if `CSRFMiddleware` raised `Forbidden(code="csrf_failed")` instead of sending the response?
4. What would break if `_failure` used `headers.get("origin")` instead of `getlist`?
5. How would you extend this to a future WebSocket route that reads the session cookie?

<details><summary>Answers</summary>

1. Old or privacy-stripped requests can lack `Origin`; accepting them all would let any client that drops the
   header through. `Sec-Fetch-Site` is set by the browser (scripts can't forge it), so `same-origin` is
   positive proof the request came from our pages; anything else, or nothing, fails
   (`test_unsafe_request_without_origin_needs_same_origin_fetch_site`).
2. 403 `origin`: the comparison is exact against the configured list. That is correct because a browser sends
   the exact origin the page was loaded from; the SPA served from `localhost` and from `127.0.0.1` are two
   different origins, and each must be listed.
3. The exception would be raised outside FastAPI's exception middleware, so the 403 problem would become a 500
   `internal_error` (mutation M5 failed `test_rejection_is_a_logged_403_not_a_500`).
4. `get` returns only the first value, so `Origin: http://localhost:5173` followed by a second, evil `Origin`
   would pass. `getlist` plus `len(origins) == 1` rejects it (`trusted-and-evil` case; mutation M3).
5. Add the check in the WebSocket handler (or a middleware branch for `scope["type"] == "websocket"`): require
   exactly one `Origin` in `settings.trusted_origins` before accepting. A browser can't add custom headers to a
   WebSocket handshake, so the `X-Requested-With` part doesn't apply; `Origin` does. It also needs an ADR
   (CLAUDE.md rule 13).

</details>
