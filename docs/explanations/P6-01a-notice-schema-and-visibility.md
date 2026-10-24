# Explanation — P6-01a Notice schema, state machine and visibility

> **PR:** #124 · **Source revision:** `8f612e7`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (1, Codex `gpt-6-astra` medium) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 124 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `8f612e7` the diff (`git diff origin/main...HEAD`, 21 files), every file under
> `backend/app/notices/`, the `backend/app/files/purposes.py` and `service.py` patches, the migration
> `eb75c7d9b747_notices_p6_01a.py`, and the assertions of every test cited below; ran
> `uv run pytest tests/notices tests/files/test_create.py tests/test_world.py -q` against the compose Postgres:
> `151 passed`. Differences from the plan: one wording change, see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: C (schema and migration; no endpoint exists yet).

## 1. What was built and why

The first of three notice tickets, split from the P6-01 stub (PR #123). It adds the `notices` table, its state
machine (`backend/app/notices/state.py::ALLOWED`), the one query that decides who sees which notice
(`backend/app/notices/queries.py::visible_notices`), and the download rule for a notice's attachment
(`backend/app/notices/attachments.py::can_view_notice_attachment`). No endpoint exists yet: P6-01b adds the
manager's API and P6-01c reads, the unread count and the publish fan-out, on top of these pieces.

It also lets notice attachments be images as well as PDFs, which the stub asked for. ADR-0007 gives images and
PDFs different size limits, so a file purpose now holds a limit per content type
(`backend/app/files/purposes.py::PurposeRule`).

The two decisions that matter most: expiry is checked inside `visible_notices` against the database clock
(D5), and the size limit is per type, not per purpose (D6).

## 2. Decisions

### D5. Expiry hides a notice inside `visible_notices`, by the database clock

- **Problem or constraint:** a notice may carry an `expires_at`. Once it passes, the notice must vanish from
  every read, count and attachment download for members, all at once.
- **Chosen:** for every caller without `property_management`, `visible_notices` adds
  `expires_at IS NULL OR expires_at > now()`. The manager still sees expired notices. The status stays
  `published`; nothing rewrites the row.
- **Alternatives rejected:** an `expired` status set by a scheduled job (a new job, and a gap between the
  expiry and the job running); filtering only in the list endpoint (the summary and the attachment would then
  disagree with the list).
- **Tradeoffs and accepted limitations:** `now()` is the transaction's start time, so a notice that expires
  during a long request is still visible to that request. P6-01b and P6-02 have to show "expired" from
  `expires_at`, because the status won't say so.
- **Basis:** autonomous (decision rule 3); `docs/SLICE_RECIPE.md` step 4, "time limits … by the database
  clock".
- **Source:** recorded (ticket Frame notes D5; PR #124 D5).

### D6. File purposes get a size limit per content type

- **Problem or constraint:** the stub asks for "an optional PDF or image attachment". ADR-0007 "Limits" caps
  images at 10 MiB and PDFs at 20 MiB, but a `PurposeRule` had one `max_bytes` for the whole purpose.
- **Chosen:** `PurposeRule.limits: Mapping[str, int]` maps each allowed content type to its own cap, and
  `content_types` is derived from its keys. `create_file` checks `rule.limits[data.content_type]`.
  `notice_attachment` is `_PDF | _IMAGES`.
- **Alternatives rejected:** one 20 MiB cap for `notice_attachment` (breaks ADR-0007's 10 MiB image limit);
  a separate `notice_image` purpose (a second attachment shape on one notice, and more work for P6-02).
- **Tradeoffs and accepted limitations:** the change touches all three purposes' definitions. Their limits
  are unchanged, and the existing `backend/tests/files/test_create.py` limit cases still pass.
- **Basis:** ADR-0007; ticket criterion 8 (added by Codex's draft review, PR #123 round 1).
- **Source:** recorded (ticket Frame notes D6; PR #124 D6).

Smaller decisions, one row each:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| D1 Security can't author notices: `notice_attachment` uploaders stay `property_management` | let security upload | the stub's default | stub default | Frame notes |
| D2 Editing after publish is blocked: no `published → draft` move | versions | the stub's default ("archive and republish") | stub default | Frame notes |
| D3 `body` is varchar(10000) | `text`; 5,000 | CLAUDE.md wants a bound on every string; no basis for 5,000 | autonomous | Frame notes |
| D4 A draft may be archived; `archived` is final | only `published → archived` | there is no delete, so drafts would pile up | autonomous | Frame notes |
| D7 `UNIQUE (building_id, id)` added now | add it in P6-01c | P6-01c's `notice_reads` composite FK needs it; one migration on `notices` instead of two | ADR-0005 convention | Frame notes |
| D8 One index, `(building_id, status, id DESC)` | `published_at DESC` | `backend/app/core/pagination.py::paginate` orders by id; P6-01b decides the feed order | convention | Frame notes |

**Framing changes:** criteria 1a–10 were added in the frame commits `87cc477` and `01e53cb` (the second
corrected 1a, because `database_enum` makes checked varchars, not Postgres enum types). None were loosened.
One existing test row changed because the scope required it: in
`backend/tests/files/test_create.py::test_create_refuses_a_type_the_purpose_does_not_allow`,
`("notice_attachment", "image/png")` became `("notice_attachment", "image/gif")`, so it still checks a
refusal, now of a type the purpose still refuses.

**Plan versus final code:** compared with PR #124's Plan; the files, interfaces and tests match. One change
the Plan didn't name: `file_too_large`'s detail now names the content type ("A notice_attachment (image/png)
may be at most 10485760 bytes."), because the limit now depends on it (commit `8f612e7`). The other
`test_create.py` cases check the code, not the detail text.

## 3. How it is implemented

### Overview

- `backend/app/notices/models.py::Notice`: the row, with composite FKs and one check constraint per status.
- `backend/app/notices/state.py`: `ALLOWED`, `assert_transition`, `sources`, the moves P6-01b's actions use.
- `backend/app/notices/queries.py::visible_notices`: who sees which row.
- `backend/app/notices/attachments.py::can_view_notice_attachment`: download rights, built on
  `visible_notices`, registered when `app.main` imports the module.
- `backend/app/files/purposes.py::PurposeRule`: per-type limits.

### Walkthrough (variant C: a row hitting the schema, then a download)

1. **Trigger.** `alembic upgrade head` runs `eb75c7d9b747`, which creates `notices`, its 4 composite FKs,
   9 named check constraints, `uq_notices_building_id_id` and `ix_notices_building_id_status_id`.
2. **A write.** Later tickets will insert and update rows. An insert of a `published` row without
   `published_by_membership_id` fails on `ck_notices_published_state`; a `published_by_membership_id` from
   building B fails on `fk_notices_building_id_published_by_membership_id`. Both fail inside Postgres, whatever
   the service code does (`backend/tests/notices/test_schema.py`).
3. **A read.** A service builds `visible_notices(ctx)` and narrows it. For a resident it is
   `SELECT … FROM notices WHERE building_id = :b AND status = 'published' AND (expires_at IS NULL OR
   expires_at > now())`; for the manager just `WHERE building_id = :b AND true`.
4. **A download.** `GET /files/{id}/download-url` (P3-04b) finds the file's purpose hook. For a
   `notice_attachment` that is `can_view_notice_attachment`, which runs `SELECT EXISTS (visible_notices(ctx)
   WHERE id = file.attached_id AND attachment_file_id = file.id)`. False gives `file_not_found`, the same
   body as for a random id (`backend/tests/notices/test_attachments.py::test_download_url_follows_the_notice`).
5. **Recover.** `alembic downgrade -1` drops the table (run once on the dev database; see the PR's evidence).

### Data model changes

Table `notices` (uuid7 `id`, `created_at`, `updated_at`):

| Constraint | Refuses | Why |
|---|---|---|
| `fk_notices_building_id_{attachment_file_id,author_,published_by_,archived_by_membership_id}` | a file or membership of another building | ADR-0005: a row can't point across buildings |
| `ck_notices_draft_state` | a draft with any publish or archive column | a draft was never published |
| `ck_notices_published_state` | `published` without `published_at` + publisher, or with archive columns | each status's columns belong to it |
| `ck_notices_archived_state` | `archived` without `archived_at` + archiver, or with only one of the two publish columns | an archived draft has neither; an archived notice that was published has both |
| `ck_notices_expires_after_published` | `expires_at <= published_at` | an expiry before publish is nonsense; NULL on either side passes |
| `ck_notices_archived_after_published` | archived before published | time order |
| `ck_notices_title_not_blank`, `ck_notices_body_not_blank` | `''` or whitespace | stripped API input would pass a bare NOT NULL (the P5-01 carry) |
| `ck_notices_notice_priority`, `ck_notices_notice_status` | unknown enum values | `database_enum` stores varchars |
| `uq_notices_building_id_id` | — | the composite FK target for P6-01c (D7) |

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/notices/models.py` | table, FKs, checks, index | +100 |
| `backend/migrations/versions/eb75c7d9b747_notices_p6_01a.py` | the migration, hand-edited | +150 |
| `backend/app/notices/{enums,state,queries,attachments}.py` | enums, state machine, visibility, hook | +110 |
| `backend/app/files/purposes.py`, `service.py` | per-type limits | +23/−7 |
| `backend/app/main.py`, `backend/app/models/registry.py` | hook import, model registration | +2 |
| `backend/tests/notices/*`, `backend/tests/files/test_create.py`, `backend/tests/test_world.py` | tests | +721/−1 |
| `docs/tickets/*` | framing | +75/−9 |

`backend/app/notices/queries.py::visible_notices`

```python
def visible_notices(ctx: TenantContext) -> Select[Notice]:
    # ...
    return select(Notice).where(Notice.building_id == ctx.building_id, _grant(ctx))


def _grant(ctx: TenantContext) -> ColumnElement[bool]:
    if ctx.has_any(Role.PROPERTY_MANAGEMENT):
        return true()
    # `now()` is the transaction's start, so one request's reads agree with each other.
    return and_(
        Notice.status == NoticeStatus.PUBLISHED,
        or_(Notice.expires_at.is_(None), Notice.expires_at > func.now()),
    )
```

- It is the only place the visibility rule lives (CLAUDE.md rule 3). The building filter is outside
  `_grant`, so no grant can widen past the context's building.
- Unlike `visible_packages`, it has no occupancy window: a notice is for the whole building, not a unit
  (ticket "Visibility"). A resident who moved in after a notice was published sees it.
- Without the `or_(…)` line, expired notices reach residents: mutation probe m1 makes
  `test_visibility_by_persona` and the attachment tests fail.

`backend/app/notices/attachments.py::can_view_notice_attachment`

```python
async def can_view_notice_attachment(ctx: TenantContext, file: File, db: AsyncSession) -> bool:
    """The file is attached to a notice the caller may see, and is that notice's attachment."""
    if file.attached_type != NOTICE_ATTACHED_TYPE:
        return False
    shown = visible_notices(ctx).where(
        Notice.id == file.attached_id, Notice.attachment_file_id == file.id
    )
    return bool(await db.scalar(select(shown.exists())))
```

- Both sides must agree: the file's `attached_id` names the notice, and the notice's `attachment_file_id`
  names the file. That copies `backend/app/packages/photos.py::can_view_package_photo`.
- A draft's attachment is refused for residents because the draft isn't in their `visible_notices`.
- Without `attachment_file_id == file.id`, a stray file attached to a published notice would be downloadable
  (mutation m2; `test_a_file_attached_to_a_notice_that_names_another_file_is_refused`).

`backend/app/files/purposes.py::PurposeRule`

```python
@dataclass(frozen=True, slots=True)
class PurposeRule:
    # Each content type the purpose accepts, with its own size limit (ADR-0007 "Limits": an image
    # stays at 10 MiB in a purpose that also takes 20 MiB PDFs).
    limits: Mapping[str, int]
    # The roles, in the URL's building, that may upload a file for this purpose.
    uploader_roles: frozenset[Role]

    @property
    def content_types(self) -> frozenset[str]:
        return frozenset(self.limits)


_IMAGES = dict.fromkeys(IMAGE_TYPES, MAX_IMAGE_BYTES)
_PDF = {"application/pdf": MAX_PDF_BYTES}
# ...
    FilePurpose.NOTICE_ATTACHMENT: PurposeRule(
        _PDF | _IMAGES, frozenset({Role.PROPERTY_MANAGEMENT})
    ),
```

- `create_file` reads `rule.limits[data.content_type]` after the type check, so the key always exists.
- With the purpose's largest limit instead (mutation m3), an 11 MiB PNG would pass;
  `test_a_notice_image_over_the_image_limit_is_refused_though_under_the_pdf_one` fails.

`backend/app/notices/models.py::Notice` (the state checks)

```python
        CheckConstraint(
            f"status <> 'draft' OR ({_all(_PUBLISH_COLUMNS + _ARCHIVE_COLUMNS, 'IS NULL')})",
            name="draft_state",
        ),
        CheckConstraint(
            f"status <> 'published' OR ({_all(_PUBLISH_COLUMNS, 'IS NOT NULL')}"
            f" AND {_all(_ARCHIVE_COLUMNS, 'IS NULL')})",
            name="published_state",
        ),
        CheckConstraint(
            f"status <> 'archived' OR ({_all(_ARCHIVE_COLUMNS, 'IS NOT NULL')}"
            " AND (published_at IS NULL) = (published_by_membership_id IS NULL))",
            name="archived_state",
        ),
```

- `status <> X OR (…)` applies a check only to rows in status X. The migration carries the same text,
  expanded; `alembic check` reports no drift.
- Weakening the draft check in the migration (mutation m6) makes
  `test_state_checks_reject_a_row_that_breaks_its_state` fail.

`backend/app/notices/state.py::ALLOWED`

```python
ALLOWED: Mapping[NoticeStatus, frozenset[NoticeStatus]] = {
    NoticeStatus.DRAFT: frozenset({NoticeStatus.PUBLISHED, NoticeStatus.ARCHIVED}),
    NoticeStatus.PUBLISHED: frozenset({NoticeStatus.ARCHIVED}),
}
```

- No `published → draft` (D2) and nothing out of `archived` (D4). Mutation m4 (`published → draft` added)
  fails `test_allowed_is_exactly_the_tickets_moves` and the pair test.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| A notice references another building's file or member | composite FK refuses it | `backend/tests/notices/test_schema.py::test_a_reference_to_another_building_is_rejected` (4 columns) |
| A row's columns disagree with its status | check constraint refuses it | `backend/tests/notices/test_schema.py::test_state_checks_reject_a_row_that_breaks_its_state` (18 cases) |
| Unknown enum value | `ck_notices_notice_priority` / `_status` | `backend/tests/notices/test_schema.py::test_unknown_enum_values_are_refused` |
| An expired notice reaches a resident | hidden by `now()` | `backend/tests/notices/test_visibility.py::test_visibility_by_persona`, `::test_a_notice_expiring_exactly_now_is_hidden` |
| A resident who moved in later misses old notices | no occupancy window | `test_visibility_by_persona` (`a_resident1` moved in after `LONG_AGO`) |
| A context pointed at B sees A's notices | building filter outside the grant | `backend/tests/notices/test_visibility.py::test_the_query_never_leaves_the_contexts_building` |
| A draft's or archived notice's attachment reaches a resident | hook goes through `visible_notices` | `backend/tests/notices/test_attachments.py::test_the_attachment_follows_the_notices_visibility`, `::test_download_url_follows_the_notice` |
| Pending, suspended, another building, signed out | 404 `building_not_found` / 401 before the hook | `backend/tests/notices/test_attachments.py::test_download_url_is_404_building_not_found_for_non_members`, `::test_download_url_signed_out_is_401` |
| The hook isn't registered in the server | `app.main` imports it | `backend/tests/notices/test_attachments.py::test_importing_the_app_alone_registers_the_notice_attachment_hook` |
| An image uses the PDF limit | per-type limit | `backend/tests/files/test_create.py::test_a_notice_image_over_the_image_limit_is_refused_though_under_the_pdf_one` |
| Security uploads a notice attachment | 403 `forbidden_role` | `backend/tests/files/test_create.py::test_wrong_role_is_403` (`a_security` rows) |
| A title of only a tab | **passes the database check** (`btrim(title)` trims spaces only) | No test; P6-01b's schema must refuse control characters (see §7) |

Acceptance criteria → tests: 1/1a `test_unknown_enum_values_are_refused` plus the downgrade/upgrade run in the
PR; 2/2a the reference tests; 3–4a the state-check test; 5/5a `backend/tests/notices/test_state.py`; 6, 6a, 7
`test_visibility.py`; 6b, 9, 9a `test_attachments.py`; 8/8a `backend/tests/files/test_create.py`; 10 the import test.
Every one of m1–m6 was run with `scripts/mutation-probe.sh` and answered `PROBE OK` (PR #124 evidence).

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6-astra`, medium effort (James's instruction for this run) | `8f612e7` | MERGE | none | — |

Codex also ran the whole backend suite (2,528 passed), its own 5 proof tests (migration round trip, HTTP
personas; all passed), ruff and mypy. No finding changed the code. (The draft PR #123 had two findings, fixed
there: image support was required, and the download route is `/download-url`.)

## 7. Not verified, accepted risks and follow-ups

- **A whitespace-only title other than spaces** (a tab, a newline) passes `ck_notices_title_not_blank`, and
  no test covers it. Nothing writes notices yet; P6-01b's `NoticeCreate` must refuse control characters as
  `backend/app/packages/schemas.py` does (`printable_before_strip`). Tracked only here and in PR #124's follow-ups.
- **Only by a test inside one transaction:** expiry uses `now()`, the transaction start. A notice expiring
  mid-request stays visible to that request (accepted, D5).
- **Not exercised with S3:** the hook tests use file rows without objects; the download-url test checks
  the authorization answer and the presign, not a real download. The S3 path is P3-04b's.
- **Follow-ups (PR #124):** P6-01b adds a `published_at` index if the feed orders by it (D8), and decides
  whether a draft's attachment can be replaced (`claim_file` has no release). Both are already open
  decisions in `docs/tickets/P6-01b-notice-authoring-api.md`.

## 8. How to change this safely

- New status or move: add it to `NoticeStatus`, `ALLOWED`, and a check constraint in the model *and* a new
  migration; `backend/tests/notices/test_state.py` and `test_schema.py` will tell you what disagrees.
- A different visibility (say, council sees drafts): change `_grant` only, then update
  `backend/tests/notices/test_visibility.py::EXPECTED` and `backend/tests/notices/test_attachments.py::EXPECTED`. Never filter notices anywhere else.
- A new file type for a purpose: add it to that purpose's `limits` with its ADR-0007 cap.

## 9. Must explain, then quiz

1. **Which rows does each check constraint refuse, and why constraints rather than service checks?** See
   the §3 table. They hold whatever code writes the row: a later ticket's bug, a script, or a concurrent write
   all hit the same check inside Postgres (`backend/app/notices/models.py::Notice`). A service check holds
   only on the paths that call it.
2. **Why no occupancy window, when `visible_packages` has one?** A package is addressed to a unit, so it
   belongs to whoever lived there when it arrived (ADR-0016). A notice is addressed to the building, so every
   current member may read it, whenever they joined (`backend/app/notices/queries.py::visible_notices`).
3. **How does the hook keep a draft's attachment from a resident?** It asks `visible_notices(ctx)` for the
   notice, and for a resident that query contains only published, unexpired notices
   (`backend/app/notices/attachments.py::can_view_notice_attachment`).
4. **Why must both sides agree?** `attached_id` alone would grant any file someone attached to a published
   notice, a stale or stray one too; `attachment_file_id` alone would trust a column without the claim
   `claim_file` made. Together, only the notice's current, claimed attachment is granted.

Quiz:

1. A manager archives a draft. Which columns must be set, and which must stay null?
2. Why does `test_a_notice_expiring_exactly_now_is_hidden` work, given `now()` is the transaction start?
3. Why did `backend/tests/files/test_create.py` change a `png` refusal row to `gif`, and why isn't that a weaker test?
4. What breaks if `backend/app/main.py` stops importing `app.notices.attachments`?
5. How would you let council see drafts without letting them download draft attachments?

<details><summary>Answers</summary>

1. `status = 'archived'`, `archived_at` and `archived_by_membership_id` set; `published_at` and
   `published_by_membership_id` both null (`ck_notices_archived_state` allows both null or both set).
2. Each test runs in one transaction, so `now()` is the same value in the fixture and the query; the
   comparison is `expires_at > now()`, so equality hides the notice.
3. The ticket now allows PNG for notices, so the old refusal would be wrong. The row still asserts a
   refusal, of GIF, which the purpose still refuses, and new rows assert the PNG acceptance and its 10 MiB cap.
4. The server has no hook for `notice_attachment`, so `register_can_view`'s registry is empty for it and every
   attached notice file is visible to nobody. `test_importing_the_app_alone_registers_the_notice_attachment_hook`
   fails (mutation m5).
5. You can't with a `_grant` change alone, because the hook reuses `visible_notices`. Either keep council's
   grant and add a second filter in the hook (`status = 'published'` for non-managers), or give council its own
   grant and test both `EXPECTED` tables.

</details>
