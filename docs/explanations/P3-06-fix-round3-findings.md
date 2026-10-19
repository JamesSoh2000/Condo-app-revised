# Explanation — P3-06 fix: round 3 findings R3-F1, R3-F2

> **PR:** #82 · **Source revision:** `4bffc0a`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** verify-only (Codex gpt-6.1-sol high), by James's instruction. The verify run
> checked `4bffc0a` and said `VERDICT: VERIFIED`. This was not the playbook's full adversarial round.
> **Merge commit:** not known when written; after the merge, `gh pr view 82 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: once merged, write a new explanation for later changes and do not update this one.
> **Reality check:** re-read at `4bffc0a` the PR diff (`git diff origin/main...HEAD`, 4 paths), the three
> source patches and the assertions of the seven tests cited. Ran
> `npx vitest run src/features/files --reporter=verbose`: `Tests 49 passed (49)`, all seven cited tests ✓.
> `npm run test` (358 passed at `4735ccf`), lint, typecheck, build: exit 0. CI green on `4bffc0a`.
> Differences from the plan: two, both in tests (see 6).
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: short. Tier: 2. Walkthrough variant: none.

## 1. What changed and why

PR #81's last review round (round 3) said `MERGE` but left two findings accepted, not fixed
([P3-06 explanation](P3-06-frontend-upload-component.md) §7). This PR fixes both:

- **R3-F1 (Medium).** A `purpose` change kept the old upload attempt. Example: `useUpload('package_photo')`
  uploads, the S3 POST fails, the caller re-renders with `maintenance_photo`, and Retry reuses the
  `package_photo` form and `file_id`. The server won't attach that file to a maintenance record. Now a purpose
  change cancels the attempt, the same way a building switch does, and `FileUpload` starts with a fresh state.
- **R3-F2 (Low).** After an `<img>` error, a recovery answer identical to the last one (same `url` and
  `expires_at`) left `PrivateImage` on "Loading image". React Query's structural sharing kept the old data
  object, so no re-render happened. The component reads `dataUpdateCount` from the cache without subscribing
  to it. Now every answer is a new object.

## 2. Decisions

- **D1. A purpose change cancels the attempt; it doesn't recreate the form with the new purpose.** Simpler,
  and it matches the building-switch rule. The cost: the user chooses the file again for the new purpose.
  Basis: James's instruction. Source: recorded (PR #82, "Decisions" D1).
- **D2. `structuralSharing: false` instead of subscribing to `dataUpdatedAt`.** Two answers can share a
  millisecond, while a new object always notifies. The cost: a background refresh with an identical answer
  re-renders, but the `<img>` element and its `src` stay the same. Basis: James's instruction. Source:
  recorded (PR #82, D2).

## 3. Files changed

- `frontend/src/features/files/useUpload.ts::useUpload`: the cleanup effect also depends on `purpose`; doc
  comment updated.
- `frontend/src/features/files/FileUpload.tsx::FileUploadFor`: the former component, now module-private,
  rendered by the exported `FileUpload` with `key={props.purpose}`.
- `frontend/src/features/files/PrivateImage.tsx::PrivateImageFor`: `structuralSharing: false` on the
  download-URL query.
- `frontend/src/features/files/files.test.tsx`: six new tests (see 5).

## 4. The code

`frontend/src/features/files/useUpload.ts::useUpload`

```ts
  // On unmount, a building switch and a purpose change: a file of the old building or purpose must not reach a
  // form of the new one (review round 3, R3-F1).
  useEffect(() => cancel, [buildingId, purpose, cancel]);
```

`cancel` aborts the controller, clears the attempt ref and resets the mutation. With no attempt, `retry()`
(the `start` callback) returns without a request.

`frontend/src/features/files/FileUpload.tsx::FileUpload`

```tsx
export function FileUpload(props: FileUploadProps) {
  // Keyed, so a new purpose starts with no preview, error or progress (review round 3, R3-F1).
  return <FileUploadFor key={props.purpose} {...props} />;
}
```

The hook's effect alone resets the mutation, but the component's own `chosen` and `checkError` state would
keep the old preview. The key remounts the component, so that state starts empty.

`frontend/src/features/files/PrivateImage.tsx::PrivateImageFor`

```ts
    // A new data object for every answer, so an answer identical to the last one still re-renders: the recovery
    // check reads `dataUpdateCount`, which the hook doesn't subscribe to (review round 3, R3-F2).
    structuralSharing: false,
```

## 5. How to verify it

`cd frontend && npx vitest run src/features/files` gives `Tests 49 passed (49)`. Behaviour → test (all in
`frontend/src/features/files/files.test.tsx`):

| Behaviour | Test |
|---|---|
| R3-F1 a: in-flight abort, no `complete`, no `onUploaded`, `idle`, `retry()` sends nothing | `useUpload: a purpose change returns to idle and retry() sends nothing`; `useUpload: a purpose change aborts an upload in flight; no complete, no onUploaded`; `a purpose change aborts an upload in flight` |
| R3-F1 b: the same purpose cancels nothing | `a re-render with the same purpose does not cancel the upload` |
| R3-F1 c: `FileUpload` clears preview, error, progress | `a purpose change cancels a failed attempt; retry sends nothing`; `a purpose change aborts an upload in flight` (no progressbar) |
| R3-F1 d: a new file uses the new purpose | `a purpose change cancels a failed attempt; retry sends nothing` (second `POST /files` body) |
| R3-F2 a, b: new `<img>`, then "Image unavailable" | `an identical recovery answer still shows the image` |
| R3-F2 c: background refresh keeps the same `<img>` | `a background refresh with an identical answer keeps the same image and no skeleton` |

Mutation probes, each run alone (PR #82, "Evidence"):
- `purpose` removed from the deps: both `useUpload:` tests fail.
- No key wrapper: `a purpose change cancels a failed attempt…` fails.
- `structuralSharing: false` removed: `an identical recovery answer…` fails.

## 6. Review

- **Verify run 1** (Codex `gpt-6.1-sol` high, fresh session, on `4bffc0a`): `VERDICT: VERIFIED`.
  - R3-F1: FIXED, a–d.
  - R3-F2: FIXED, a–c.
  - Each letter is covered by a named test that fails when its fix line is reverted. Codex's own scratch
    tests of the original scenarios agreed.
- **Differences from the plan** (session prompt), both in tests:
  1. The background-refresh test advances 50.1 s, not 55 s. With a constant `expires_at`, the refresh time is
     already past after the first refresh, so the 1 s `refetchInterval` floor polls every second. On unchanged
     code that gave 7 calls by 55 s, not 2.
  2. The first probe (no `purpose` in the deps) at first failed only the hook test: the key remount's
     unmount cleanup also cancels inside `FileUpload`. A hook-level in-flight test was added (`4bffc0a`), so the
     deps line is proven for a direct `useUpload` caller too.

## 7. Not verified, accepted risks and follow-ups

- The review was verify-only: it checked these two findings and did not look for new bugs in the changed code.
- No stack run: no route renders these components yet, so jsdom tests are the only evidence.
- Inferred: a server answer with a near-expired `expires_at` makes `PrivateImage` refresh every second (seen
  in the first red run of test 5). Unchanged by this PR; a real server sends a new expiry with each answer.
  Tracked only here.

## 8. How to change it safely

Anything that makes an upload attempt depend on a new prop (another form field, an owner record) must also go
in the cleanup effect's deps and, for `FileUpload`, in the key. The criterion 7 tests show the pattern. Don't
put `structuralSharing` back on the download-URL query: `an identical recovery answer…` would fail.
