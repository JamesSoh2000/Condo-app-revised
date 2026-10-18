# Explanation — P3-04b File downloads and `claim_file`

> **PR:** #77 · **Source revision:** `a093fab`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (1) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 77 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read `git diff origin/main...HEAD` for `backend/app/files/{purposes,service,storage,router,schemas}.py`
> and `backend/.env.dev`, the assertions of `backend/tests/files/test_download.py`, `test_claim.py` and
> `test_content_disposition.py`, the PR body (Plan, decisions, review round 1) and the Codex findings file, at
> `a093fab`; ran `make test DB_PORT=55432 PYTEST_ADDOPTS="tests/files/test_download.py tests/files/test_claim.py tests/files/test_content_disposition.py"`:
> `38 passed`. Differences from the plan: three small, deliberate ones, see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 1. Walkthrough variant: A.

## 1. What was built and why

P3-04a let users upload a file and pinned the S3 version it checked. This ticket adds the two other halves of
[ADR-0007](../adr/0007-private-s3-presigned-uploads.md):

- **`claim_file`**: a helper that domain code (packages first, P5-01) calls to attach a `ready` file to one of
  its records. One conditional `UPDATE` makes sure it is the caller's file (or a fellow staff uploader's), in
  this building, of the right purpose and not attached yet.
- **`GET /files/{id}/download-url`**: returns a 60-second presigned GET for the pinned version. Until a file is
  attached, only its uploader may get one. After that, the owning domain's **`can_view` hook** decides.

The decision that matters most: the files module never decides on its own who may see an attached file. It
asks the domain that owns the record (D1). A purpose with no hook registered fails closed.

## 2. Decisions

### D1. Download authorization is delegated to a per-purpose `can_view` hook

- **Problem or constraint:** a package photo should be exactly as visible as its package, and visibility rules
  (occupancy windows, roles) live in each domain (CLAUDE.md rule 3). The files module can't know them, and no
  domain exists yet.
- **Chosen:** a registry in `backend/app/files/purposes.py::register_can_view`, keyed by purpose. The hook is
  only called for a file already loaded with `building_id = ctx.building_id` and `status = ready`, and only
  when the file is attached (`backend/app/files/service.py::_may_view`). Registering a second hook for one
  purpose raises `ValueError`.
- **Alternatives rejected:** a `can_view` field on `PurposeRule`: the files module would have to import every
  domain, an import cycle once packages import `claim_file`. Calling the hook for unattached files too: there
  is no owning record to ask about. (PR decision D1.)
- **Tradeoffs and accepted limitations:** a hook only works once its module is imported. Until P5-01
  registers one, an attached file is visible to nobody, even its uploader.
- **Basis:** ticket (the hook and "registered by the owning domain"); the shape is autonomous.
- **Source:** recorded (PR #77, D1; ticket Frame notes).

### D2. "Staff for staff purposes" means: an uploader role of an all-staff purpose

- **Problem or constraint:** the ticket lets "staff" claim another person's file "for staff purposes" without
  defining either.
- **Chosen:** `backend/app/files/purposes.py::is_staff_purpose` is true when every uploader role is in
  `STAFF_ROLES` (today `package_photo` and `notice_attachment`). The caller must also hold one of that
  purpose's uploader roles (`ctx.has_any(*rule.uploader_roles)`).
- **Alternatives rejected:** any staff role (`ctx.is_staff`): council could attach a package photo it could
  never upload. A per-purpose flag: more state for the same answer today.
- **Tradeoffs and accepted limitations:** if a resident role is ever added to a purpose's uploaders, that
  purpose stops being a staff purpose, and staff can then only attach their own files of it.
- **Basis:** ticket, read in the tighter way; autonomous.
- **Source:** recorded (PR #77, D2; Frame notes).

### D3. `Content-Disposition` carries an ASCII fallback and a `filename*`

- **Problem or constraint:** `original_name` is user input and ends up in a header that S3 sends back.
  Control characters are already refused at create (P3-04a, `backend/app/files/schemas.py::FileCreate`).
- **Chosen:** `inline` for image types and `attachment` for everything else, then
  `filename="<fallback>"; filename*=UTF-8''<percent-encoded>`. The fallback keeps printable ASCII except `"`
  and `\`, and replaces those and every non-ASCII character with `_`.
- **Alternatives rejected:** `filename*` only: some clients ignore it. Backslash escapes inside the quoted
  string: browsers handle them inconsistently.
- **Tradeoffs and accepted limitations:** a client that ignores `filename*` shows underscores.
- **Basis:** RFC 6266 §4.3 / RFC 5987; autonomous.
- **Source:** recorded (PR #77, D3).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Once attached, the uploader's own access ends unless the hook grants it | keep the uploader's access | the ticket grants the uploader only an "unattached `ready` file" | ticket | PR table |
| Every refusal of `download-url` is 404 `file_not_found` | 403 for "exists, not yours" | CLAUDE.md rule 1, tenant row 5 | convention | PR table |
| `claim_file` returns the attached `File` | return nothing | the caller may need the file's type or name | autonomous | PR table |
| `claim_file` returns 404 for another building or an unknown id, 422 `invalid_file` for anything else | one code for everything | the ticket names both | ticket | Frame notes |
| Dummy `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY=test` in `backend/.env.dev` and `.env.example` | run the journey on the host, as P3-04a did | the compose API had no credentials, so `POST /files` returned 500 on `make up` | test result | PR table |

**Framing changes:** criteria 5–7 sharpened (the exact codes, what "the original bytes" and "no attachment"
mean). Criteria 17–24 added: tenant rows 1, 2, 3, 6, 7 and 10, the four cases the ticket asked framing to cover,
and the missed cases (the hook is never asked about another building's or a pending file, attaching hands
visibility to the domain, which staff may claim). None were loosened.

**Plan versus final code:** compared with the PR's Plan. There are three deliberate differences, and the PR
notes them below its Plan: there is no `disposition_type` helper (the choice is the first line of
`backend/app/files/service.py::content_disposition`); the claim-refusal and disposition tests are split
differently from the planned names; and the env credentials were added while verifying.

## 3. How it is implemented

### Overview

- `purposes.py`: the `CanView` type, the `_CAN_VIEW` registry and `is_staff_purpose`.
- `backend/app/files/storage.py::presign_get`: signs a GET URL for `(key, VersionId)` with `ResponseContentDisposition`, using
  the presigning client (the browser-facing endpoint locally).
- `backend/app/files/service.py::download_url` → `_may_view` → `content_disposition` → `storage.presign_get`.
- `backend/app/files/service.py::claim_file`: one conditional `UPDATE … RETURNING`, then a single lookup to tell 404 from 422.
- `backend/app/files/router.py::download_url`: `GET /api/buildings/{building_id}/files/{file_id}/download-url`, operation id
  `files_download_url`, on the building router.

### Walkthrough (variant A): `GET /files/{id}/download-url`

1. **HTTP:** `GET /api/buildings/{b}/files/{id}/download-url` → `backend/app/files/router.py::download_url`.
   No role guard: authorization is per file.
2. **Dependencies:** the building router's session and tenant context. A logged-out caller gets 401. A
   caller with no active membership in `b` (another building's member, a pending or suspended one) gets
   404 `building_not_found` before the service runs.
3. **Service:** `backend/app/files/service.py::download_url` loads the row:
   `SELECT … FROM files WHERE id = :id AND building_id = :ctx_building AND status = 'ready'`. A pending file,
   another building's file and an unknown id all come back empty, and all get the same 404 `file_not_found`.
4. **Authorization:** `_may_view`. If the file is unattached, the caller must be its uploader. If it is
   attached, the purpose's hook decides, and no hook means no.
5. **Signing:** `expires_at` is computed before signing (so the URL never expires before the time reported),
   then `storage.presign_get(s3_key, s3_version_id, content_disposition(...), expires_in=60)`. No S3 call is
   made: signing is local.
6. **Response:** `FileDownloadOut {url, expires_at}`, 200. Nothing is written, so there is no commit.

`claim_file` has no request of its own (it is called inside a domain's write use case). The SQL is:

```sql
UPDATE files SET attached_type = :t, attached_id = :rid
WHERE id = :id AND building_id = :b AND status = 'ready' AND purpose = :p
  AND attached_id IS NULL
  [AND uploaded_by_user_id = :caller]   -- left out for an uploader role of a staff purpose
RETURNING files.*
```

Under Postgres's default READ COMMITTED isolation, a second concurrent `UPDATE` on the same row waits for the
first transaction. Once that commits, the second re-checks its `WHERE` against the new row version, finds
`attached_id` set, and updates nothing.

### Data model changes

None. P3-04a's `attached_type`/`attached_id` columns and their check constraints (`attachment_complete`,
`attached_only_when_ready`) are used as they are.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/files/service.py` | `claim_file`, `download_url`, `_may_view`, `content_disposition`, `InvalidFile` | +100/−4 |
| `backend/app/files/purposes.py` | `CanView`, registry, `is_staff_purpose` | +32/−5 |
| `backend/app/files/storage.py` | `presign_get` | +20/−1 |
| `backend/app/files/router.py`, `schemas.py` | the route, `FileDownloadOut` | +14/−1 |
| `backend/.env.dev`, `backend/.env.example` | dummy emulator credentials | +6 |
| `frontend/src/api/schema.d.ts` | regenerated | +81 |
| `frontend/src/api/client.test.ts` | the new GET path in the typed-paths list | +1 |
| `backend/tests/files/*` | `test_download.py`, `test_claim.py`, `test_content_disposition.py`, `backend/tests/files/conftest.py::upload_ready` | +603 |
| `docs/tickets/*` | framing, status | +65/−14 |

**Key excerpts**

`backend/app/files/service.py::claim_file`

```python
    rule = PURPOSES[purpose]
    conditions = [
        File.id == file_id,
        File.building_id == ctx.building_id,
        File.status == FileStatus.READY,
        File.purpose == purpose,
        File.attached_id.is_(None),
    ]
    if not (is_staff_purpose(rule) and ctx.has_any(*rule.uploader_roles)):
        conditions.append(File.uploaded_by_user_id == ctx.user_id)
    # Conditional: a concurrent claim waits for this row's lock, then finds it attached.
    claimed = await db.scalar(
        update(File)
        .where(*conditions)
        .values(attached_type=attached_type, attached_id=attached_id)
        .returning(File)
        .execution_options(populate_existing=True)
    )
    if claimed is not None:
        return claimed
    exists = await db.scalar(
        select(File.id).where(File.id == file_id, File.building_id == ctx.building_id)
    )
    if exists is None:
        raise FileNotFound(detail="File not found.")
    raise InvalidFile(detail="This file can't be attached here.")
```

- All the rules are in one statement, so no check can be made on a row that changes before the write (no
  select-then-update race).
- Without `File.attached_id.is_(None)`, a second claim would silently re-point the file to another record.
  Mutation M1 (PR) shows `test_an_attached_file_cannot_be_claimed_again` and
  `test_two_concurrent_claims_have_one_winner` fail then.
- The follow-up `select` is filtered by building, so another building's file looks exactly like a missing one.
- There is no `commit`: the domain's use case commits once (CLAUDE.md rule 5).

`backend/app/files/service.py::download_url` and `_may_view`

```python
    file = await db.scalar(
        select(File).where(
            File.id == file_id,
            File.building_id == ctx.building_id,
            File.status == FileStatus.READY,
        )
    )
    # `ready` always has a version (check constraint); the test only narrows the type.
    if file is None or file.s3_version_id is None or not await _may_view(db, ctx, file):
        # Pending, someone else's, or not there: one answer (CLAUDE.md rule 1).
        raise FileNotFound(detail="File not found.")
    # ...
async def _may_view(db: AsyncSession, ctx: TenantContext, file: File) -> bool:
    if file.attached_id is None:
        return file.uploaded_by_user_id == ctx.user_id
    # Attached: a file is only as visible as its record (ADR-0007), which only its domain knows.
    hook = can_view_hook(file.purpose)
    return hook is not None and await hook(ctx, file, db)
```

- The building and status filters run before any hook, so a careless hook (one that ignores
  `ctx.building_id`) can't leak another building's file. Mutation M3 (no building filter) fails
  `test_another_buildings_file_is_404_even_if_the_hook_grants`.
- `hook is not None and …` is the fail-closed default (D1).

`backend/app/files/storage.py::presign_get`

```python
    def sign() -> str:
        return _presigning_client().generate_presigned_url(
            "get_object",
            Params={
                "Bucket": settings.s3_bucket_name,
                "Key": key,
                "VersionId": version_id,
                "ResponseContentDisposition": disposition,
            },
            ExpiresIn=expires_in,
        )
```

- `VersionId` is what makes ADR-0007's "re-using an upload URL cannot change what an accepted `file_id`
  serves" true for downloads. Without it the URL serves the latest version, which a re-POST of the still-valid
  form can replace. Mutation M2 fails `test_download_after_a_reposted_form_returns_the_original_bytes`.

`backend/app/files/service.py::content_disposition`

```python
    kind = "inline" if content_type in IMAGE_TYPES else "attachment"
    fallback = "".join(c if " " <= c <= "~" and c not in '"\\' else "_" for c in filename)
    return f"{kind}; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename, safe='')}"
```

- `quote(..., safe='')` leaves only unreserved characters, so the extended form contains no `;`, `"` or
  space that a header parser could split on (asserted in `test_fallback_replaces_quotes_backslashes_and_non_ascii`).

`backend/app/files/purposes.py::register_can_view`

```python
def register_can_view(purpose: FilePurpose, hook: CanView) -> None:
    """Called once by the domain that owns `purpose` files. Without a hook, an attached file of
    that purpose is visible to nobody."""
    if purpose in _CAN_VIEW:
        raise ValueError(f"a can_view hook for {purpose} is already registered")
    _CAN_VIEW[purpose] = hook
```

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Re-POST with the still-valid form swaps the bytes | URL pinned to the checked `versionId` | `backend/tests/files/test_download.py::test_download_after_a_reposted_form_returns_the_original_bytes` |
| Another resident or the manager asks for a resident's unattached file | 404 `file_not_found`, same body as a random id | `::test_another_resident_gets_the_same_404_as_a_random_id`, `::test_the_manager_cannot_download_a_residents_unattached_file` |
| Logged out; B member; pending or suspended member | 401; 404 `building_not_found` | `::test_unauthenticated_is_401`, `::test_cross_building_and_inactive_members_get_404` |
| `multi`'s B file through A, with an all-granting hook | 404, hook never called; 200 through B | `::test_another_buildings_file_is_404_even_if_the_hook_grants` |
| Pending file (bytes uploaded, not completed) | 404, hook not called | `::test_pending_file_is_404_and_the_hook_is_not_asked` |
| Attached file: hook grants some, refuses others | 200 for the granted, 404 for the rest, uploader included; calls recorded with ctx and file | `::test_hook_grants_and_refuses_an_attached_file` |
| Attached file, no hook for its purpose | 404 even for the uploader | `::test_attached_file_without_a_hook_is_hidden_from_its_uploader` |
| A second hook for one purpose | `ValueError`, the first stays | `::test_registering_a_second_hook_is_an_error` |
| URL lifetime, version, disposition | `X-Amz-Expires=60`, `versionId` = stored, `inline` / `attachment` | `::test_uploader_downloads_an_unattached_file`, `::test_pdf_downloads_as_an_attachment` |
| Quotes, backslash, non-ASCII in the name | `_` fallback, exact `filename*`, through real S3 | `backend/tests/files/test_content_disposition.py::test_fallback_replaces_quotes_backslashes_and_non_ascii`, `backend/tests/files/test_download.py::test_quoted_and_non_ascii_filename_round_trips_through_s3` |
| Claim: B file / unknown id | 404 `FileNotFound`, row unattached | `backend/tests/files/test_claim.py::test_another_buildings_file_is_404_and_stays_unattached`, `::test_claim_of_an_unknown_id_is_404` |
| Claim: pending, wrong purpose, someone else's | 422 `invalid_file`, row unattached | `::test_claim_refusals_raise_invalid_file_and_attach_nothing` |
| Claim twice | 422, first attachment kept | `::test_an_attached_file_cannot_be_claimed_again` |
| Two concurrent claims | the second waits on the row lock (`pg_stat_activity` = `Lock`), then 422; the winner's attachment stays | `::test_two_concurrent_claims_have_one_winner` |
| Staff claims | manager takes security's package photo; council, staff on a resident file, security on a notice, resident on a staff file → 422 | `::test_staff_may_claim_another_staff_members_file`, `::test_staff_claim_refusals` |
| `claim_file` commits | every claim test replaces `db.commit` with a function that raises | the `no_commit` fixture in `test_claim.py` |

Acceptance criteria → tests: 5 → `test_download_after_a_reposted_form_returns_the_original_bytes`; 6 → the
two 404 tests and `[b_manager]`; 7 → the five claim-refusal tests; 17 → `test_uploader_downloads_an_unattached_file`,
`test_pdf_downloads_as_an_attachment`; 18 → the three hook tests; 19 → `test_unauthenticated_is_401`,
`test_cross_building_and_inactive_members_get_404`; 20 → `test_another_buildings_file_is_404_even_if_the_hook_grants`;
21 → `test_pending_file_is_404_and_the_hook_is_not_asked`; 22 → the disposition tests; 23 →
`test_two_concurrent_claims_have_one_winner`; 24 → the two staff tests. The PR also has a `make up` stack
transcript.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol`, effort high (the session's instruction; it replaced the usual `gpt-6-astra`, and no Claude reviewer ran) | `a093fab` | `MERGE` | none | — |

Codex ran the full backend suite (1315 passed), lint and types, the frontend checks (260 tests), `alembic
check` and the API type drift check, and three scratch boundary probes of its own (passed, then deleted). No
finding changed the code.

## 7. Not verified, accepted risks and follow-ups

- **Real AWS:** only LocalStack 4.14.0 was exercised. Production IAM permissions for `GetObject` on a version,
  and AWS's handling of `response-content-disposition`, are D-06's to check.
- **Expiry:** the 60 s lifetime is shown by `X-Amz-Expires=60` in the URL. No test waited for S3 to refuse
  an expired URL.
- **Bearer link:** for its 60 s, a download URL works for anyone who holds it, and `download-url` has no rate
  limit of its own (Codex round 1, residual). Accepted for the demo (ADR-0007's design). Tracked only here
  and in the PR.
- **No domain hook yet:** until P5-01 registers a `package_photo` hook, attached files are invisible. The
  follow-up is in P5-01's ticket (added by this PR's bookkeeping commit).
- **Existence signal:** `claim_file` answers 422 for someone else's file and 404 for an unknown id, which
  reveals to domain code (and, through its endpoint, to a caller who supplies the id) that the id exists in
  the building. Ids are UUIDv7 with 74 random bits, and the ticket specifies these codes. Accepted.
- **Hook import order:** nothing checks at startup that a hook was registered for every purpose. A missing one
  fails closed.

## 8. How to change this safely

- **A new domain owning files** (P5-01 packages, maintenance): call `register_can_view(FilePurpose.X, hook)`
  at import of the domain's module that `backend/app/main.py` loads. Call `claim_file` in the write use case before its
  single `commit`. The hook gets a file already filtered by building and `ready`, but it must still check the
  record's own visibility with the domain's `visible_*` helper (CLAUDE.md rule 3). Add the domain's tenant
  table for its record; `test_download.py` shows the hook contract.
- **A new purpose:** add it to `PURPOSES`. If its uploaders are all staff, D2's rule applies automatically.
  If it is not an image, it downloads as `attachment`.
- **Changing the URL lifetime:** `DOWNLOAD_EXPIRES` in `service.py`;
  `test_uploader_downloads_an_unattached_file` asserts 60.

## 9. Must explain, then quiz

**4. Why is download authorization delegated to the owning domain (`can_view`)?**
A file has no visibility of its own: ADR-0007 says "a file is only as visible as its package or request".
Who may see a package depends on rules only the packages domain knows: the resident's occupancy window
(CLAUDE.md rule 3), staff roles, perhaps the package's state. If the files module copied those rules, the
two copies would drift, and a photo could outlive its package's visibility. So
`backend/app/files/service.py::_may_view` keeps only what the files module itself knows (the uploader of a
not-yet-attached file). For an attached file it calls the hook the domain registered with
`backend/app/files/purposes.py::register_can_view`. The files module still applies the tenant boundary and the
`ready` check first, so a hook can only narrow access within one building, never widen it across buildings.
A purpose with no hook grants nothing (fails closed).

Quiz:

1. Why does `download_url` filter by `status = 'ready'` before calling the hook, rather than leaving that to
   the hook?
2. Two security guards attach the same photo to two packages at the same moment. Walk through what Postgres
   does and what each guard's request returns.
3. Why is the uploader of an attached file refused when no hook is registered, even though they uploaded it?
4. What breaks if `"VersionId": version_id` is removed from `backend/app/files/storage.py::presign_get`?
5. How would you extend this so a maintenance request's photos are visible to the resident who filed it and
   to the manager?

<details><summary>Answers</summary>

1. A pending file has no pinned version (the `version_iff_ready` constraint), so there is nothing safe to
   serve, and the latest object could be anything uploaded with the form. Doing the check in one place also
   means no hook can forget it. `test_pending_file_is_404_and_the_hook_is_not_asked` proves the hook isn't
   even asked.
2. Both run the conditional `UPDATE`. The first takes the row lock. The second blocks until the first
   transaction commits, then re-evaluates its `WHERE` on the new row, finds `attached_id IS NOT NULL`, and
   updates nothing. Its follow-up lookup finds the file in the building, so it raises 422 `invalid_file`,
   and its use case should roll back. `test_two_concurrent_claims_have_one_winner` shows exactly this.
3. Attaching hands the file's visibility to its record. If the uploader kept access, a resident could attach
   a photo to a record and keep seeing it after losing access to the record (for example, after moving out).
   The ticket limits the uploader's access to unattached files, and fail-closed is the safe default.
4. The URL serves the latest version of the key. Anyone with the still-valid presigned POST form (5 minutes)
   could upload new bytes, and every download would serve them, defeating the pinning from P3-04a. The tests
   `test_download_after_a_reposted_form_returns_the_original_bytes` and
   `test_uploader_downloads_an_unattached_file` would fail (mutation M2).
5. In the maintenance domain, register a `MAINTENANCE_PHOTO` hook that loads the request by
   `(ctx.building_id, file.attached_id)` with the domain's `visible_*` helper (which already lets the
   resident see their own request) and returns true if it is found, or if the caller is property
   management. Call `claim_file(..., FilePurpose.MAINTENANCE_PHOTO, "maintenance_request", request.id)` in
   the create use case before its commit.

</details>
