# Explanation — P1-07 OpenAPI → TypeScript types and API client

> **PR:** #52 · **Source revision:** `f76a219` (pre-merge), the PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (3, a fresh Claude reviewer) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 52 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs. The branch
> is rebased onto `origin/main` (`git merge-base --is-ancestor origin/main HEAD` succeeds).
> **Updated** (pre-merge, same code): after the bookkeeping commit `108d410` was also read. It changes docs and
> CLAUDE.md only (`git diff f76a219 108d410 --stat`), so the code described is still `f76a219`. The update adds
> D8 (recorded in the PR after this explanation asked for it) and points §7's follow-ups to where `108d410`
> now tracks them.
> This is a snapshot: if the code changes later, write a new explanation; do not update this one. Lasting
> decisions live in ADRs.
> Form: full. Tier: 2. Walkthrough variant: B (the dev footer loading the backend version), with a variant C
> walkthrough of the CI drift check in a collapsed block.

## 1. What was built and why

The frontend now talks to the backend through a typed client. `python -m app.export_openapi` prints the
backend's OpenAPI document (the machine-readable description of every route and its JSON shapes);
`openapi-typescript` turns it into `frontend/src/api/schema.d.ts`; `openapi-fetch` uses those types so
`api.get('/api/version')` autocompletes the path and returns a typed object. Every failure becomes one error
class, `ApiError`. A 401 notifies listeners (`onUnauthenticated`), and every request carries
`X-Requested-With: fetch`. The app's React Query client gets its defaults (30 s stale time, refetch on focus,
retry only network errors and 5xx, at most twice). CI regenerates the types and fails on any difference, so a
backend contract change cannot silently desync the UI ([ADR-0011](../adr/0011-frontend-strangler-typescript.md)).
A dev-only footer shows the backend's git SHA to prove the wiring end to end.

The decisions that matter most: the retry policy (D3), how non-JSON and non-problem responses still become
`ApiError` (D4, D7), and where the drift check runs and how it detects drift (D5).

## 2. Decisions

### D1. The 401 notification is a module-private `EventTarget` *(autonomous)*

- **Problem or constraint:** the ticket says a 401 "emits an `auth:unauthenticated` event (consumed in P2-06)"
  without saying where the event lives.
- **Chosen:** `frontend/src/api/client.ts::onUnauthenticated` subscribes to a module-level `EventTarget`
  and returns an unsubscribe function. The response middleware dispatches on **every** 401, before
  `unwrap` throws.
- **Alternatives rejected:** `window.dispatchEvent(new CustomEvent(...))`: global (any script can fake or
  listen to it) and Node tests have no `window`. A callback option on `createApiClient`: the default client
  is created at import time, before the auth shell exists.
- **Tradeoffs and accepted limitations:** it fires for every 401, including the login endpoint's.
  `docs/tickets/P2-01-sessions-login-logout-csrf.md` already specifies `POST /api/auth/login` returning
  401 `invalid_credentials`, and `docs/tickets/P2-06-frontend-auth-shell.md` says the listener does
  `queryClient.clear()` and redirects to login. So a wrong password *will* fire it; P2-06 must decide whether
  to ignore it on the login page. Listeners are shared by every `createApiClient` instance.
- **Basis:** autonomous. **Source:** recorded (PR D1, Frame notes).

### D2. `api.get/post` are explicit generic wrappers with one internal cast

- **Problem or constraint:** the throwing wrappers must keep openapi-fetch's per-path types (path
  autocompletion, typed `data`, required `params` when a path has them).
- **Chosen:** each wrapper declares its own generics (`P extends PathsWith<'get'>`,
  `I extends MaybeOptionalInit<paths[P], 'get'>`) and calls `client.GET` through a cast to a simpler
  signature (`frontend/src/api/client.ts::createApiClient`).
- **Alternatives rejected:** a higher-order `unwrapping(client.GET)` relying on TypeScript's generic inference:
  tried first, `tsc` rejected it (TS2345, `InitParam<Init>` not assignable). Typing via
  `Parameters<typeof client.GET>`: loses the generics entirely.
- **Tradeoffs and accepted limitations:** the cast is unchecked inside the two wrappers; the *public*
  signature is pinned by `expectTypeOf(...)` and a `@ts-expect-error` in
  `frontend/src/api/client.test.ts` (tsc type-checks test files because `tsconfig.json` includes `src`).
  `api.post` accepts no path today, since no POST route exists (`PathsWith<'post'>` is `never`); tests cast.
- **Basis:** experiment (the tsc error). **Source:** recorded (PR D2).

### D3. Retry: at most 2 retries, only `TypeError` (network) and `ApiError` with status ≥ 500

- **Problem or constraint:** Scope says "at most 2 attempts"; AC5 says "a 503 retries at most twice". They
  disagree (2 requests vs 3).
- **Chosen:** AC5's reading: 2 retries = 3 requests. `frontend/src/app/queryClient.ts::shouldRetry` returns
  false once `failureCount >= 2`; for an `ApiError`, retries only `status >= 500`; otherwise only a
  `TypeError`, which is what `fetch` rejects with on a network failure.
- **Alternatives rejected:** 2 attempts total: contradicts AC5. Retrying every non-`ApiError`: would retry
  programming errors.
- **Tradeoffs and accepted limitations:** a `TypeError` thrown by a *bug* inside a `queryFn` (for example
  reading a property of `undefined`) is also retried twice: by type it is indistinguishable from a network
  failure. Mutations keep React Query's default of no retry.
- **Basis:** ticket (AC5, Frame notes). **Source:** recorded (PR D3).

### D4. Error bodies that aren't problem+json become `ApiError` with `code: "http_error"` *(autonomous)*

- **Problem or constraint:** some errors never pass through FastAPI: a Vite proxy or Caddy 502 is HTML, a
  crash may give an empty body. Callers (and `shouldRetry`) still need an `ApiError`.
- **Chosen:** `frontend/src/api/errors.ts::toApiError` treats a body as a problem only if it is an object
  with string `code` and `title`. Otherwise `code` is `http_error`, `title` is the status text or
  `HTTP <status>`, and `requestId` comes from the `X-Request-ID` response header (also the fallback when a
  problem body lacks `request_id`).
- **Alternatives rejected:** rethrowing the raw body: breaks "every failure is an `ApiError`", and a 502
  would then not be retried.
- **Tradeoffs and accepted limitations:** `http_error` is a client-only code the backend never sends; UI code
  must not present it as a domain error.
- **Basis:** autonomous. **Source:** recorded (PR D4).

### D5. The drift check lives in the frontend CI job and uses `git status --porcelain`

- **Problem or constraint:** AC2 says the *frontend* job fails on stale types, but the export needs the
  backend's Python dependencies. The ticket's Scope wrote the check as `git diff --exit-code`.
- **Chosen:** the frontend job gains `setup-python` and `setup-uv` (same pins as the backend job), runs
  `uv sync --locked`, the export, `npm run gen:api`, then fails if `git status --porcelain` reports
  anything for `schema.d.ts` (`.github/workflows/ci.yml::Generated API types are up to date`).
- **Alternatives rejected:** the check in the backend job (would need Node there; AC2 names the frontend
  job); a separate job (a new required check in branch protection). `git diff --exit-code`: if the committed
  file were deleted and then regenerated as untracked, `git diff` sees nothing and passes. This deviates from
  the ticket's Scope wording, with that reason recorded.
- **Tradeoffs and accepted limitations:** the frontend job is slower (Python + cached `uv sync`).
- **Basis:** ticket (AC2). **Source:** recorded (PR D5); the mutation runs in the PR body.

### D6. The Base44 import fence now covers `src/api/**/*.{ts,tsx}` *(autonomous, stricter gate)*

- **Problem or constraint:** the typed client sits next to the legacy Base44 barrels (`base44Client.js`,
  `entities.js`, `integrations.js` in the same folder). The existing fence regex expects an `api/` path
  segment, so a sibling import `./base44Client` slipped through.
- **Chosen:** `frontend/eslint.config.js::base44Fence` builds both rules (`no-restricted-imports` for static
  imports, `no-restricted-syntax` for `import()`/`require`) from one regex. `src/features` and `src/app` use
  it unchanged; `src/api/**/*.{ts,tsx}` adds `BASE44_SIBLING`.
- **Alternatives rejected:** reusing `BASE44_SOURCE` alone: a probe file importing `./base44Client` linted
  clean.
- **Tradeoffs and accepted limitations:** `scripts/check-eslint-fence.sh` (the fence's self-test) still only
  probes the original fence; the new block was probed by hand once (PR "Base44 fence probe").
- **Basis:** autonomous. **Source:** recorded (PR D6).

### D7. A 2xx body that isn't JSON throws `ApiError` from the middleware (review round 1 L1, round 2 L4)

- **Problem or constraint:** openapi-fetch parses a 2xx body itself, before `unwrap` sees it. A `200
  text/html` (an SPA fallback page) made `api.get` reject with a bare `SyntaxError`, which neither
  `instanceof ApiError` checks nor `shouldRetry` recognise.
- **Chosen:** `frontend/src/api/client.ts::assertJsonBody` runs from `onResponse` on every 2xx the caller
  parses as JSON (`options.parseAs` unset or `'json'`). It parses a clone; a non-empty body that
  `JSON.parse` rejects throws `ApiError {status, code: "http_error", title: "Response is not JSON"}`.
  Because it throws from middleware, the raw `client` and the `api` wrappers behave the same.
- **Alternatives rejected:** catching `SyntaxError` in the `api` wrappers: no access to status or request
  id there, and the raw client would still leak it. Checking only `Content-Type`: misses truncated JSON with
  a JSON content type. Documenting the exception: leaves P2-06's `instanceof ApiError` checks with a hole.
- **Tradeoffs and accepted limitations:** every JSON 2xx body is parsed twice (judged negligible for small
  JSON). An *empty* non-204 2xx passes the check and resolves `undefined` (round 3 L5, §7).
- **Basis:** review findings. **Source:** recorded (PR D7, review rounds 1–2).

### D8. `make check` fails while a regenerated `schema.d.ts` is uncommitted *(autonomous; rationale recorded after the explainer asked)*

- **Problem or constraint:** `make check` is meant to be "everything CI checks" (its help text in
  `Makefile::check:`), and CI compares the regenerated file against the commit (D5).
- **Chosen:** `make check` runs `gen-api`, then fails if `git status --porcelain --
  frontend/src/api/schema.d.ts` is non-empty, printing "was stale and has been regenerated; commit it". A
  correct but uncommitted regeneration also fails until it is committed.
- **Alternatives rejected:** comparing against the working tree (regenerate to a temp file and diff it with
  `schema.d.ts`): would pass locally with a regenerated but uncommitted file that then fails in CI, which is
  the case the check exists to catch. Not running the drift check in `make check`: it would pass on a branch
  whose CI fails.
- **Tradeoffs and accepted limitations:** the workflow is "`make gen-api`, commit, `make check`". The
  regeneration is left in the working tree, so the fix is one `git add`.
- **Basis:** autonomous; mirrors the CI step (D5). Listed in the inbox's "Decisions to audit" (row citing
  "PR #52 D5, D8"). **Source:** recorded (PR D8), but written after the first version of this explanation
  reported the rationale missing; the PR labels it "rationale added after the explainer asked" and says it is
  what the implementer chose at the time. The code matches it: the `Makefile::check:` recipe at `f76a219`
  does exactly this.

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| `/api/version` returns a `VersionOut` model (same JSON) | keep `dict[str, str]` | generates `Record<string, string>`; `useVersion()` would need casts | autonomous | PR table, Frame notes |
| `openapi.json` at repo root, gitignored | commit it | only `schema.d.ts` is drift-checked; a second generated file is noise | ticket | PR table |
| Export uses `json.dumps(indent=2, ensure_ascii=False)` | default `json.dumps` | readable; determinism proven by `test_export_is_byte_identical_between_runs` | autonomous | PR table |
| `createApiClient({ baseUrl })` factory; default instance `baseUrl: ""`; `fetch` looked up per call | test the singleton only | Node's `Request` rejects relative URLs; tests stub the global `fetch` | autonomous | PR table |
| Vitest 4.1.12, not 5 | Vitest 5 | 5 needs Vite ≥ 6.4; the lock has 6.3.6 and a Vite bump is out of scope | autonomous | PR table |
| Tests run in Node; jsdom only per component file | jsdom everywhere | openapi-fetch's `Request`/`AbortSignal` are Node's; jsdom globally risks realm mismatches | autonomous | PR table |
| Footer is a new `frontend/src/app/DevVersionFooter.tsx` rendered from `App.jsx` | extend legacy `Layout.jsx` | CLAUDE.md: don't extend legacy JSX | CLAUDE.md | PR table |
| `make check` also runs Vitest and the drift check (how it detects drift: D8) | leave them CI-only | `make check` is "everything CI checks" | CLAUDE.md | PR table |
| Version query key `['version']` | `['b', …]` | global data; the README lists `[name]` for global data | ticket convention | PR table |
| `@testing-library/dom` added explicitly | rely on a transitive copy | peer dependency of `@testing-library/react` 16 | npm peer deps | PR table |

**Framing changes:** AC1–AC6 sharpened (pure export + `VersionOut`; mutation proof for AC2; every `ApiError`
field including a 422; GET and POST through both paths; retry counts per status and for a network error;
component test + proxy transcript). AC7 (401 event), AC8 (non-problem errors), AC9 (no footer in production)
and AC10 (old query client removed, defaults, Vitest in CI) added. Nothing loosened. The Frame note's "no
browser" turned out wrong: a headless Chrome run was done (PR AC6 transcript), but the ticket file at the
source revision still says otherwise (corrected in bookkeeping commit `108d410`).

## 3. How it is implemented

### Overview

```mermaid
flowchart LR
  A[backend: create_app().openapi()] -->|python -m app.export_openapi| B[openapi.json]
  B -->|npm run gen:api| C[frontend/src/api/schema.d.ts]
  C --> D[client.ts: createClient&lt;paths&gt; + middleware]
  D --> E[api.get / api.post → unwrap → ApiError]
  E --> F[queryClient.ts: shouldRetry, defaults]
  F --> G[useVersion → DevVersionFooter]
```

- **Generation** (backend → types): `backend/app/export_openapi.py::main`, `Makefile::gen-api:`, the npm
  script `gen:api`.
- **Client** (`frontend/src/api/client.ts`): the openapi-fetch instance, one middleware (header, 401 event,
  2xx JSON check), `unwrap`, and the `api` wrappers.
- **Errors** (`frontend/src/api/errors.ts`): `ApiError` and `toApiError`.
- **Query layer** (`frontend/src/app/queryClient.ts`): retry policy and defaults; replaces the deleted legacy
  `query-client.js` in `src/lib`.
- **Gates:** CI's "Unit tests" and "Generated API types are up to date" steps, `make check`, the extended
  ESLint fence.

### Walkthrough (variant B: the dev footer loads the backend version)

1. **User action.** A developer opens the app under `npm run dev`. `App.jsx` renders `<DevVersionFooter />`
   inside `QueryClientProvider client={queryClient}`. `frontend/src/app/DevVersionFooter.tsx::DevVersionFooter`
   checks `import.meta.env.DEV`; in a production build Vite replaces that with `false`, so `VersionFooter`
   and its request are dropped from the bundle.
2. **Form and validation.** None; this is a read.
3. **Hook.** `frontend/src/app/useVersion.ts::useVersion` is `useQuery({ queryKey: ['version'], queryFn: () =>
   api.get('/api/version') })`.
4. **API call.** `api.get` (`frontend/src/api/client.ts::createApiClient`) calls openapi-fetch's `GET` with
   base URL `""`, so the browser requests `/api/version` on the page's own origin (ADR-0003); Vite's dev proxy
   forwards it to FastAPI. The middleware's `onRequest` sets `X-Requested-With: fetch`. The backend's
   `version` handler (operation id `version_version`) returns a `VersionOut`.
5. **Response handling.** `onResponse` fires the 401 event if needed, then (2xx, JSON expected) checks the
   body parses as JSON. openapi-fetch parses the body into `data` (2xx) or `error` (otherwise). `unwrap`
   returns `data` or throws `toApiError(response, error)`. 401/403/404 all surface as `ApiError`; only 401
   additionally notifies `onUnauthenticated` listeners (none exist yet; P2-06 adds one).
6. **Cache and retries.** On failure React Query asks `shouldRetry`: a 5xx or network error retries up to
   twice (React Query's default exponential backoff between attempts), a 4xx never. After 30 s the data is
   stale and refetches on the next window focus or mount.
7. **States.** While loading, `VersionFooter` renders nothing. On success: `API <git_sha> (<environment>)`;
   on error: `API unavailable`. It is a fixed 10 px label at the bottom right with `pointer-events-none`, so
   on a phone it overlays content without blocking taps.

<details><summary>Deeper: variant C, a backend change hitting the drift check</summary>

1. **Trigger:** a PR changes a response model (say adds a field to `VersionOut`) without running `make gen-api`.
2. **Backend job:** unaffected unless a test pins the schema (`backend/tests/test_export_openapi.py::test_version_response_is_a_typed_object` pins the *required* field set, so a rename or removal fails there too; an added optional field doesn't).
3. **Frontend job**, in order: lint, type check (passes: it checks the *committed*, now stale, types), "Unit tests", then "Generated API types are up to date": `uv sync --locked`; export into `openapi.json` one level above `frontend/`; `npm run gen:api` overwrites `schema.d.ts`; `git status --porcelain -- src/api/schema.d.ts` is non-empty, so the step prints the diff and `::error file=frontend/src/api/schema.d.ts::Stale API types: run \`make gen-api\` and commit the result.` and exits 1.
4. **Recovery:** run `make gen-api` locally, run `npm run typecheck` (now against the new types, it flags every call site using a renamed or removed field), fix them, commit both.
5. **Locally**, `make check` runs the same regeneration and status test. Note that it fails whenever `schema.d.ts` has *any* uncommitted change, even a correct freshly regenerated one (`Makefile::check:`); commit the file before running `make check`. This is deliberate (D8): a working-tree comparison would pass locally on a file CI then rejects.

</details>

### Data model changes

None. `/api/version`'s JSON body is unchanged; only its OpenAPI description became a named schema.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/export_openapi.py` | new: prints the OpenAPI document | +20 |
| `backend/app/routers/version.py` | `VersionOut` response model | +19/−9 |
| `backend/tests/test_export_openapi.py` | new: export purity, determinism, typed version | +55 |
| `frontend/src/api/client.ts` | new: client, middleware, `unwrap`, `api`, 401 event | +100 |
| `frontend/src/api/errors.ts` | new: `ApiError`, `toApiError` | +63 |
| `frontend/src/api/schema.d.ts` | new, generated | +191 |
| `frontend/src/api/README.md` | new: usage and query-key convention | +48 |
| `frontend/src/api/client.test.ts` | new: 26 tests (header, errors, 401, 2xx checks, types) | +292 |
| `frontend/src/app/queryClient.ts` | new: `shouldRetry`, `createQueryClient`, `queryClient` | +31 |
| `frontend/src/app/queryClient.test.ts` | new: retry counts through a real `QueryClient`, defaults | +86 |
| `frontend/src/app/useVersion.ts`, `frontend/src/app/DevVersionFooter.tsx` | new: sample hook and dev footer | +8, +17 |
| `frontend/src/app/DevVersionFooter.test.tsx` | new: dev render, error, production renders nothing | +80 |
| `frontend/src/App.jsx` | uses the new query client, renders the footer | +4/−2 |
| legacy `query-client.js` (in `src/lib`) | deleted | −11 |
| `frontend/eslint.config.js` | fence refactored into `base44Fence`, extended to `src/api` | +29/−21 |
| `frontend/vitest.config.ts`, `frontend/src/vite-env.d.ts` | new: Vitest config, Vite env types | +18, +1 |
| `frontend/package.json`, `frontend/package-lock.json` | scripts `test`, `gen:api`; 6 dependencies | +8/−2, lockfile |
| `.github/workflows/ci.yml` | "Unit tests" and drift-check steps in the frontend job | +33 |
| `Makefile` | real `gen-api`; `check` runs Vitest and drift check | +10/−3 |
| `.gitignore` | `/openapi.json` | +3 |
| `docs/tickets/P1-07-openapi-types-and-api-client.md` | Frame notes, sharpened criteria | +53 |

**Key excerpts**

`frontend/src/api/client.ts::middleware` ([permalink](https://github.com/JamesSoh2000/Condo-app-revised/blob/f76a219c769fd6be8bcefc021e55bab14005345e/frontend/src/api/client.ts#L20-L52))

```ts
const middleware: Middleware = {
  onRequest({ request }) {
    // Marks the request as the SPA's own fetch (ADR-0003); P2-01's CSRF check relies on it.
    request.headers.set('X-Requested-With', 'fetch');
    return request;
  },
  async onResponse({ response, options }) {
    if (response.status === 401) events.dispatchEvent(new Event(UNAUTHENTICATED));
    // Only when the caller expects JSON (openapi-fetch's default); `parseAs: 'text' | 'blob' | …` is theirs.
    if (response.ok && (options.parseAs ?? 'json') === 'json') await assertJsonBody(response);
    return response;
  },
};

async function assertJsonBody(response: Response): Promise<void> {
  const text = await response.clone().text();
  if (!text) return;
  try {
    JSON.parse(text);
  } catch {
    throw new ApiError({
      status: response.status,
      code: 'http_error',
      title: 'Response is not JSON',
      requestId: response.headers.get('X-Request-ID'),
    });
  }
}
```

- Runs on every request and response of every client instance (the raw `client` and the `api` wrappers).
- The header is the CSRF signal P2-01's backend will require (ADR-0003); the 401 dispatch is D1; the 2xx
  check is D7, limited to JSON parsing since round 2 L4.
- Remove the `set` line: three "X-Requested-With header" tests fail, and once P2-01 lands every POST would be
  rejected 403. Remove the `parseAs` condition: a CSV or PDF download via `parseAs` becomes an `ApiError`.
  `response.clone()` matters: reading the original would leave openapi-fetch an already-consumed body.

`frontend/src/api/client.ts::unwrap` and `createApiClient`

```ts
export function unwrap<T>(result: Result<T>): T {
  if (!result.response.ok) throw toApiError(result.response, result.error);
  return result.data as T;
}
// ...
export function createApiClient({ baseUrl = '' }: { baseUrl?: string } = {}) {
  const client = createClient<paths>({ baseUrl, fetch: (request) => globalThis.fetch(request) });
  client.use(middleware);
  const api = {
    async get<P extends PathsWith<'get'>, I extends MaybeOptionalInit<paths[P], 'get'>>(
      url: P,
      ...init: InitArg<I>
    ): Promise<Data<P, 'get', I>> {
      // openapi-fetch's own generics can't be re-expressed outside it; the signature above carries the types.
      const call = client.GET as (url: P, init?: I) => Promise<Result<Data<P, 'get', I>>>;
      return unwrap(await call(url, ...init));
    },
    // ... post: the same with 'post'
  };
  return { client, api };
}

export const { client, api } = createApiClient();
```

- `unwrap` decides success by `response.ok`, not by `data` being present: that is why an empty 2xx resolves
  `undefined` (`result.data as T` is unchecked; round 3 L5).
- The explicit generics are D2. `fetch: (request) => globalThis.fetch(request)` looks `fetch` up per call so
  tests can stub it; it drops openapi-fetch's second argument (round 1 residual risk, §7).
- Without `client.use(middleware)`, none of the header, 401 or 2xx guarantees hold.

`frontend/src/api/errors.ts::toApiError`

```ts
function isProblem(body: unknown): body is Problem {
  if (typeof body !== 'object' || body === null) return false;
  const { code, title } = body as Record<string, unknown>;
  return typeof code === 'string' && typeof title === 'string';
}

export function toApiError(response: Response, body: unknown): ApiError {
  const headerRequestId = response.headers.get('X-Request-ID');
  if (isProblem(body)) {
    return new ApiError({
      status: response.status,
      code: body.code,
      title: body.title,
      detail: body.detail,
      errors: body.errors,
      requestId: body.request_id || headerRequestId,
    });
  }
  return new ApiError({
    status: response.status,
    code: 'http_error',
    title: response.statusText || `HTTP ${response.status}`,
    requestId: headerRequestId,
  });
}
```

- Maps P1-04's problem+json body to `ApiError`, and anything else to `http_error` (D4).
- `isProblem` checks shape, not `Content-Type`: a JSON body `{code: 42}` is not a problem ("ignores a JSON
  error body that is not a problem").
- Remove the `|| headerRequestId` fallback and "takes requestId from X-Request-ID when a problem body has
  none" fails (added in round 1, L2, because nothing caught that mutation before).

`frontend/src/app/queryClient.ts::shouldRetry` ([permalink](https://github.com/JamesSoh2000/Condo-app-revised/blob/f76a219c769fd6be8bcefc021e55bab14005345e/frontend/src/app/queryClient.ts#L11-L29))

```ts
const MAX_RETRIES = 2;

export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES) return false;
  if (error instanceof ApiError) return error.status >= 500;
  return error instanceof TypeError;
}

export function createQueryClient(overrides: DefaultOptions['queries'] = {}): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        retry: shouldRetry,
        ...overrides,
      },
    },
  });
}
```

- React Query calls `retry(failureCount, error)` after each failure; `failureCount` is 0 after the first, so
  `>= 2` allows exactly two retries (D3).
- An `ApiError` with status 200 (D7's "Response is not JSON") is not retried.
- Change `MAX_RETRIES` to 3 and three retry tests fail; let 4xx through and six fail (PR mutation log).

`.github/workflows/ci.yml::Generated API types are up to date`

```yaml
      - name: Generated API types are up to date
        run: |
          (cd ../backend && uv sync --locked)
          (cd ../backend && uv run python -m app.export_openapi) > ../openapi.json
          npm run gen:api
          # status, not diff: a deleted-then-regenerated (untracked) file must fail too.
          if [ -n "$(git status --porcelain -- src/api/schema.d.ts)" ]; then
            git diff -- src/api/schema.d.ts
            echo "::error file=frontend/src/api/schema.d.ts::Stale API types: run \`make gen-api\` and commit the result."
            exit 1
          fi
```

- The gate that makes AC2 true (D5). The export needs no database: `create_app().openapi()` builds the
  document from route metadata only (proven by `test_export_prints_the_apps_openapi_document_without_a_database`,
  which points `DATABASE_URL` at port 1).
- Without the step, a backend change ships with stale types and `tsc` keeps passing against them.

`backend/tests/test_export_openapi.py::test_export_is_byte_identical_between_runs`

```python
def test_export_is_byte_identical_between_runs():
    # A second `make gen-api` must produce no diff, so the JSON text must not vary between runs.
    first, second = run_export(), run_export()

    assert first.returncode == second.returncode == 0
    assert '"/api/version"' in first.stdout
    assert first.stdout == second.stdout
```

- Runs the export twice in subprocesses and compares bytes. Without determinism the drift check would fail at
  random. The `/api/version` assertion was added after the test first passed vacuously on empty output (PR
  "Tests first").

## 5. Edge cases and tests

I ran `npx vitest run` (3 files, 40 tests passed), `npx tsc --noEmit -p tsconfig.json` (clean), and
`uv run pytest tests/test_export_openapi.py` (3 passed) at the source revision. I also regenerated
`schema.d.ts` from a fresh export into a scratch directory: byte-identical to the committed file.

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| 409 problem+json | `ApiError` with every field | `client.test.ts` "maps a 409 with every member" |
| 422 with field errors | `errors[]` kept | "keeps the field errors of a 422" |
| Problem body without `request_id` | header `X-Request-ID` used | "takes requestId from X-Request-ID when a problem body has none" |
| HTML 502 from a proxy | `http_error`, status text, header request id | "maps an HTML 502 to http_error with the X-Request-ID header" |
| Empty 500, no header | `http_error`, `requestId: null` | "uses a null requestId when there is neither body nor header" |
| JSON error body that isn't a problem | `http_error` | "ignores a JSON error body that is not a problem" |
| 200 HTML (SPA fallback) / truncated JSON | `ApiError` 200 `http_error` | "turns a 2xx that is not JSON…", "turns a 2xx with malformed JSON…", "throws the same ApiError from the raw client…" |
| Caller asked `parseAs: 'text'`/`'blob'` | body left alone | "leaves a 2xx alone when the caller asked for parseAs %s" |
| 204 empty | resolves `undefined` | "still accepts an empty 204" |
| Empty **non-204** 2xx | resolves `undefined` under a non-nullable type | **no test** (round 3 L5, accepted) |
| 401 | one event, then `ApiError` | "emits once per 401 and still throws"; "does not emit on %i"; "stops calling a listener after unsubscribe" |
| Unknown path | compile error | "rejects a path the backend does not have" (`@ts-expect-error`, checked by `tsc`) |
| 503 then 200 | 2 requests | `queryClient.test.ts` "stops retrying once a 503 turns into a success" |
| A bug's `TypeError` in a `queryFn` | retried twice like a network error | **no test**; accepted (D3) |
| Footer in production | renders nothing, no request | `DevVersionFooter.test.tsx` "renders nothing and makes no request in production builds" |
| Export without a database | succeeds | `test_export_prints_the_apps_openapi_document_without_a_database` |

Acceptance criteria → tests:

1. `test_export_prints_the_apps_openapi_document_without_a_database`, `test_export_is_byte_identical_between_runs`,
   `test_version_response_is_a_typed_object`; PR transcript of `make gen-api` twice.
2. PR mutation runs of the CI step (clean → 0; field added → 1; file deleted → 1). Evidence only, not a test.
3. "maps a 409 with every member", "keeps the field errors of a 422", "throws from unwrap for a raw client result too".
4. The three "X-Requested-With header (criterion 4)" tests.
5. `queryClient.test.ts` "does not retry a 404", "retries a 503 at most twice", "retries a network error at
   most twice", "does not retry a %i".
6. "shows the backend version from GET /api/version in dev builds"; PR proxy curl and headless Chrome DOM.
7. The three "401 emits auth:unauthenticated (criterion 7)" tests.
8. "maps an HTML 502…", "uses a null requestId…", "ignores a JSON error body…".
9. "renders nothing and makes no request in production builds"; PR bundle grep after `npm run build`.
10. "uses a 30 s stale time and refetches on window focus"; CI step "Unit tests".

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | fresh Claude (Sonnet 5.5, high) | `62afad3` | MERGE | L1: non-JSON 2xx rejects with `SyntaxError`; L2: header request-id fallback untested; L3: inbox/index not updated | L1 fixed in `4b7d38a` (D7); L2 test added in `4b7d38a`; L3 done in bookkeeping commit `108d410` |
| 2 | fresh Claude (Sonnet 5.5, high) | `4b7d38a` | MERGE | L4: the L1 fix broke `parseAs: 'text'/'blob'` | fixed in `f76a219` |
| 3 | fresh Claude (Sonnet 5.5, high) | `f76a219` | MERGE | L5: empty non-204 2xx resolves `undefined` | not fixed; follow-up (§7) |

- **L1.** Input: `200 text/html` for `api.get('/api/version')`. Wrong outcome: `SyntaxError: Unexpected token
  '<'`, so `instanceof ApiError` fails and `shouldRetry` sees a non-`ApiError`. Evidence: two new tests failed
  before (`Tests 2 failed | 20 passed`) and pass after; removing the check fails 2. Produced D7.
- **L2.** Mutation removing `|| headerRequestId` left all 32 tests green. Now "takes requestId from
  X-Request-ID when a problem body has none" catches it (1 failed under the same mutation).
- **L4.** Input: `client.GET(path, { parseAs: 'text' })` on a `200 text/csv`. Wrong outcome: `ApiError 200
  http_error`. Evidence: "leaves a 2xx alone when the caller asked for parseAs text/blob" failed before
  (`Tests 2 failed | 23 passed`), passes after; ignoring `parseAs` fails 2, checking only undefined `parseAs`
  fails 4. Narrowed D7.
- Round 3 also probed against a real Node HTTP server with undici `fetch` (8 MB JSON, chunked body, `200
  text/html` → `ApiError`), per the PR.

## 7. Not verified, accepted risks and follow-ups

Not verified:

- CI run 38941187108 on `f76a219` passed all three jobs, including "Unit tests" and the drift step (green
  path only). The red path of AC2 is proven by running the step's commands locally with mutations (PR
  transcript), never by a failing CI run.
- The new `src/api` fence block is not in `scripts/check-eslint-fence.sh`'s self-test; it was probed once by
  hand. A later edit to `BASE44_SIBLING` could weaken it without any gate noticing.
- No test for an empty non-204 2xx, or for a `TypeError` thrown by a bug being retried.
- `vitest.config.ts` sits outside `tsconfig.json`'s `include`, so `tsc` does not type-check it (Vitest still
  loads it).

Accepted risks and follow-ups. The PR body lists all of these. At the source revision none was in the repo;
the bookkeeping commit `108d410` now tracks most of them in the tickets that will act on them and in the
inbox. The rest are accepted risks recorded only in the PR and this explanation:

| Item | Where tracked (as of `108d410`) |
|---|---|
| `onUnauthenticated` fires on a login wrong-password 401 (P2-01 specifies 401 `invalid_credentials`); P2-06 must decide whether to ignore it on the login page (D1) | `docs/tickets/P2-06-frontend-auth-shell.md` "Carried from P1-07" (ignore it on the login page or call, and test it); cross-referenced from `docs/tickets/P2-01-sessions-login-logout-csrf.md` "Carried from P1-07"; inbox row for D1 |
| Empty non-204 2xx resolves `undefined` (round 3 L5); `unwrap` could throw `http_error` when `data` is `undefined` and status ≠ 204 | P2-06 "Carried from P1-07" |
| `api.get/post` don't forward React Query's `signal`, so superseded queries aren't aborted (round 2) | P2-06 "Carried from P1-07" (pass `{ signal }` with the first hook, document it in `frontend/src/api/README.md`) |
| Legacy Base44 queries lose `retry: 1` and now refetch on focus (round 1) | Accepted; inbox row for D3 states it |
| A `TypeError` thrown by a bug in a `queryFn` is retried like a network error (D3) | Accepted; PR and this explanation only (the inbox's D3 row doesn't mention it) |
| `fetch` wrapper drops openapi-fetch's `init` argument; matters only for streaming request bodies (round 1) | Accepted; PR and this explanation only |
| `api.post` has no typed paths until a POST route exists | PR and this explanation only (resolves itself with the first POST route) |
| Fence self-test doesn't cover `src/api` (D6) | P2-06 "Carried from P1-07", as optional hardening |
| P2-01 can rely on `X-Requested-With: fetch` from the typed client; legacy Base44 calls don't send it | P2-01 "Carried from P1-07" |
| ADR-0015's "Revisit when": P1-07's merge triggers the decision on type-aware ESLint rules and `react-hooks/exhaustive-deps` | P2-06 "Carried from P1-07" (decide as an ADR-0015 update or a new ADR) |
| Decisions to audit | `docs/HUMAN_INBOX.md` "Decisions to audit": five P1-07 rows covering D1, D3, D4/D7, D5/D8 and D6 |

## 8. How to change this safely

- **A new endpoint or changed model:** change the backend, run `make gen-api`, run `npm run typecheck` to find
  broken call sites, commit `schema.d.ts` with the change, then run `make check` (it fails on an *uncommitted*
  `schema.d.ts`, by design: D8). CI's drift step catches a forgotten regeneration.
- **A new domain hook:** put it in `src/features/<domain>/`, use `api.get/post`, key building data
  `['b', buildingId, domain, params]` (`frontend/src/api/README.md`), and pass React Query's `signal` through
  `init` (follow-up above, carried to P2-06).
- **Changing error mapping:** `frontend/src/api/errors.ts::toApiError`; the "criterion 3" and "criterion 8"
  blocks in `client.test.ts` will tell you what broke. Keep "every failure is an `ApiError`" true, or
  `shouldRetry` misclassifies it.
- **Changing retry:** `frontend/src/app/queryClient.ts::shouldRetry`; `queryClient.test.ts` counts real
  requests per status.
- **Touching the middleware:** never read `response` directly (clone it), and keep the `parseAs` guard; the
  "parseAs" tests cover it.
- **Fence:** edit `frontend/eslint.config.js::base44Fence`, then run `bash scripts/check-eslint-fence.sh`
  and probe `src/api` by hand (the script doesn't).

## 9. Must explain, then quiz

**1. A backend developer renames a response field: which check fails, and where?** Say `git_sha` becomes
`sha`. If they don't regenerate: in the backend job, `test_version_response_is_a_typed_object` fails (it
pins the required field set); in the frontend job, type check still passes (the committed types are stale)
but "Generated API types are up to date" (`.github/workflows/ci.yml::Generated API types are up to date`)
regenerates, sees `schema.d.ts` change, and exits 1. If they do regenerate: `VersionOut` in `schema.d.ts`
loses `git_sha`, and `npm run typecheck` fails in `frontend/src/app/DevVersionFooter.tsx::VersionFooter`
where it reads `data.git_sha`. Either way it fails in CI, not in production. Locally, `make check` runs both.

**2. Why should the client never retry 4xx responses?** A 4xx means the request itself is wrong or not
allowed (bad input, missing session, no permission, not found, conflict); sending it again gives the same
answer, wastes requests, delays the error the user needs to see, and for a 401 would fire the
unauthenticated event repeatedly. A 5xx or network error can be transient (a restart, a dropped
connection), so a retry may succeed. Mutations aren't retried at all, because repeating a non-idempotent
POST could apply it twice. Code: `frontend/src/app/queryClient.ts::shouldRetry` (D3).

**3. Why include `buildingId` in query keys? What bug happens without it?** React Query caches by key. With
`['packages', params]`, a user who switches from building A to building B gets A's cached packages shown
under B (instantly, as "fresh" for 30 s), which is a cross-tenant display bug, and a mutation's
invalidation can't target one building. With `['b', buildingId, …]`, each building has its own cache entry,
and `queryClient.removeQueries({ queryKey: ['b', oldId] })` drops a building's data in one call
(`frontend/src/api/README.md`). The server still enforces tenancy; the key prevents the client showing stale
data from the wrong building.

Quiz:

1. A Caddy 502 with an HTML body comes back for a query. Trace what the user's query does: which function
   classifies it, what `code` it gets, and how many requests are made in total?
2. Why does `assertJsonBody` call `response.clone()` instead of reading `response.text()` directly?
3. A `queryFn` contains `data.items.map(...)` and the response lacks `items`. How many times does React Query
   run it, and why?
4. What would break if we removed the `(options.parseAs ?? 'json') === 'json'` condition from `onResponse`?
5. How would you extend the client to support a `PATCH` wrapper with the same typing guarantees?

<details><summary>Answers</summary>

1. openapi-fetch puts the unparseable body in `error` (it isn't a 2xx, so `assertJsonBody` doesn't run);
   `unwrap` calls `toApiError`, `isProblem` fails, so `code: "http_error"`, `title: "Bad Gateway"`,
   `requestId` from `X-Request-ID` or `null`. `shouldRetry` sees status 502 ≥ 500 and retries twice: 3
   requests.
2. A `Response` body can be read once. Reading the original would consume it, and openapi-fetch's own
   parsing afterwards would fail ("body used already"). The clone gives an independent copy.
3. Three times. `data.items` is `undefined`, so `.map` throws a `TypeError`, which `shouldRetry` cannot tell
   apart from a network failure (D3, accepted limitation).
4. Any caller using `parseAs: 'text'`, `'blob'` or `'arrayBuffer'` on a non-JSON 2xx (a CSV export, a PDF)
   would get `ApiError 200 http_error` instead of the body. The two "leaves a 2xx alone…" tests fail (round 2
   L4).
5. Add `'patch'` to the `PathsWith` and `Data` method unions, add a `patch` method mirroring `post` that casts
   `client.PATCH`, and add `expectTypeOf` and `@ts-expect-error` assertions in `client.test.ts` once a PATCH
   route exists (until then `PathsWith<'patch'>` is `never`). The middleware needs no change: the header and
   error handling are method-independent.

</details>
