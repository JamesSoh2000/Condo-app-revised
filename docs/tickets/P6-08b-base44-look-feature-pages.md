# P6-08b — Base44 look on the signed-in feature pages

| Field | Value |
|---|---|
| Phase / lane | P6 / B |
| Risk tier | 2 |
| Depends on | P6-08a |
| Replaces old | — |
| Status | todo |

Third step of the lowest-change Base44-look route (2026-10-29): [P6-08a](./P6-08a-base44-shell-layout.md) restored
the frame, [P6-05b](./P6-05b-role-landing-pages.md) builds the landing page in the old dashboard's card style; this
ticket brings the pages that already exist to the same look, without changing what they do.

## Goal

Every signed-in feature page that exists when this ticket starts uses the Base44 card, heading, button and badge
style, inside P6-08a's frame, with unchanged behaviour.

## Why

After P6-08a the frame looks like the Base44 app but the pages inside it are still plain Tailwind (`slate` text,
bare lists, default buttons). Restyling them through a few shared typed pieces, rather than page by page by hand,
keeps the look consistent and makes later pages (P6-04b–d, P6-06a–b) pick it up by using the same pieces. The
reference is the legacy JSX still in the repo (`src/pages/Dashboard.jsx`, `Maintenance.jsx`,
`ManagementMaintenance.jsx`) and P6-08a's primitives; nothing of their data code is used.

## Scope

- In:
  - **Shared pieces** (`src/components/app/`, TypeScript): `PageHeader` (title `text-3xl font-bold tracking-tight`,
    optional description and actions slot), `SectionLabel` (`text-xs font-semibold uppercase tracking-widest
    text-zinc-400`), `ListCard` (a `Card` with `border-zinc-200/60 bg-white`, hover shadow when it is a link or
    button), `StatusBadge` (a `Badge` with one colour per status tone: waiting/open, in progress, done, urgent),
    `EmptyState` and `ErrorState` (icon, text, the existing retry button). Each is presentation only: no hooks other
    than React's, no data.
  - **Pages restyled** to use them and P6-08a's `Button`/`Card`/`Badge`:
    - packages: resident list (`MyPackageList`), desk (`WaitingList`, `LogPackageForm`, the pickup/return/detail
      dialogs' buttons)
    - notices: feed (`NoticeList`, `NoticesPage`), detail dialog, manager list and actions, editor
    - maintenance: the resident list (`MyMaintenanceList`, `MyMaintenancePage`) and any maintenance page merged
      before this ticket starts
    - residents: pending requests, members, invitations and their dialogs (`Modal` keeps its focus logic)
    - membership screens (pending, denied, no building) and `app/screens.tsx` (loading, 403, 404, being migrated)
    - the notification panel and urgent banner (colours only)
  - one line added to [SLICE_RECIPE.md](../SLICE_RECIPE.md): a new page uses `src/components/app/` and the `ui`
    primitives for its look
- Out (do **not** do in this ticket):
  - any change to a hook, query key, request, guard, mutation, focus rule, accessible name, role, label text or
    test id; any change to what a page shows or in which order
  - the signed-out screens ([P6-08c](./P6-08c-base44-look-signed-out-screens.md)) and the landing page (P6-05b)
  - pages merged after this ticket starts (they use the shared pieces themselves, per the recipe line)
  - icons a page did not have a reason for, animations beyond `transition` on hover, dark mode

**Split rule:** this is several domains of markup. If the measured estimate passes ~400 non-test lines, split while
framing by domain (P6-08b shared pieces + packages + notices; P6-08d residents + membership + screens), each PR
leaving every page it touched finished.

## Interfaces

No API change. New presentation components in `frontend/src/components/app/` (names above); no existing export
changes.

## Acceptance criteria

1. **Behaviour unchanged.** **Given** every existing test under `src/features/`, `src/app/` and `e2e/`, **then** they
   pass with no change to what they assert; a selector may change only where the markup moved, each listed in the PR.
2. **Focus unchanged.** **Given** the focus tests (`expectFocusKept`, the P6-02e list focus, the dialogs'), **then**
   they pass in jsdom and the Chromium focus checks in `e2e/` still pass.
3. **Shared pieces used.** **Given** each page in scope, **then** its title is a `PageHeader`, its records are
   `ListCard`s (or a table for the members list if that is what it is today), its statuses `StatusBadge`s, and its
   empty and failed states `EmptyState`/`ErrorState`; no page in scope keeps its own copy of these styles.
4. **Contrast.** Each `StatusBadge` tone and the zinc secondary text meet WCAG AA (4.5:1) on their background (a unit
   test over the tone table, or the axe check in Chromium).
5. **375 px.** **Given** Chromium at 375 px with the longest values the API allows (a 200-character notice title, a
   255-character file name, the longest unit label), **then** no page in scope scrolls sideways and no badge or button
   leaves its card.
6. **No Base44.** The ratchet does not rise; nothing in scope imports from `src/pages/` or `@/api/base44Client`.
7. **Look.** Screenshots at 375 and 1280 px of each page in scope, as the persona that uses it, are in the PR.

## Test plan

- `src/components/app/app.test.tsx`: the pieces render their slots; the `StatusBadge` tone table and contrast
  (criteria 3, 4)
- every existing suite unchanged (criteria 1, 2): `make check DB_PORT=55432`, `make e2e`
- Chromium at 375 px with long values (criterion 5) and screenshots (criterion 7) on `make up`, in the PR

## Likely files

`frontend/src/components/app/*` (new), the page and list files under `frontend/src/features/{packages,notices,
maintenance,residents,membership,notifications}/`, `frontend/src/app/screens.tsx`, `docs/SLICE_RECIPE.md`.

Estimate: ~450 non-test lines (shared pieces ~120, about 20 files' markup at ~15 each); expect the split above.

## Must explain (learning checkpoint)

1. Which styles moved into shared pieces, and how does that keep later pages in the same look?
2. How did you show that no behaviour changed, when nearly every page's markup did?
3. Which places needed care so a restyle didn't break focus or an accessible name, and why?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
