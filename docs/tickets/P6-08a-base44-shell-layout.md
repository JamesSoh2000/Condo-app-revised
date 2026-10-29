# P6-08a — Base44 look: typed UI primitives and the shell layout

| Field | Value |
|---|---|
| Phase / lane | P6 / B |
| Risk tier | 2 |
| Depends on | P2-06c, P4-08h |
| Replaces old | — |
| Status | todo |

Added 2026-10-29 by James's decision to keep the Base44 app's appearance on the new frontend, by the
lowest-change route: restyle the frame and the pages, change no behaviour, add no backend work and no Base44
dependency. The landing page's cards are [P6-05b](./P6-05b-role-landing-pages.md); the existing feature pages are
[P6-08b](./P6-08b-base44-look-feature-pages.md) and [P6-08c](./P6-08c-base44-look-signed-out-screens.md).

## Goal

The signed-in frame looks like the Base44 app's: a white left sidebar with icon nav items and a dark active pill on
desktop, a top bar with a slide-in drawer on phones, and the zinc page background, while the header, nav, account
menu, bell and banner keep every behaviour they have today.

## Why

The plan rebuilt the frame in P2-06c for correctness (guards, `PAGE_ACCESS`, view-as, denial) and left it plain:
a text header and a wrapped row of underlined links. The Base44 layout it replaced
(`git show a16039d^:frontend/src/Layout.jsx`, markup at lines 543–776) is the look James wants to keep, but that file
also fetched Base44 profiles and counts, so it is the **visual reference only**; nothing of its data code returns.
Doing the frame first means every page restyled after it (P6-05b, P6-08b) sits in the right frame. ADR-0011 already
allows reusing the shadcn/Radix components; this ticket makes the three it needs type-check under `strict`.

## Scope

- In:
  - **Typed primitives.** Convert `src/components/ui/{button,card,badge}.jsx` to `.tsx` in place (same paths, same
    exports, same classes and variants), typed with `React.forwardRef<HTMLElement, React.HTMLAttributes<…>>` and
    `VariantProps<typeof buttonVariants>` as shadcn's own TypeScript sources do. Legacy `.jsx` callers keep working
    unchanged. No other `ui/*` file is converted here.
  - **Shell layout** (`src/app/AppShell.tsx`), after the reference:
    - `≥ 1024 px`: the page is a row: a static sidebar (`w-56`, `bg-white`, `border-r border-zinc-100`) and the main
      column (`bg-zinc-50`, a `from-zinc-100` gradient behind the top, content in `max-w-5xl` with `p-4 lg:p-8`)
    - the sidebar's top block shows the **selected building's name** (in place of the EstWest logo) and, under it,
      the caption of the member's roles there (`text-xs uppercase tracking-widest text-zinc-400`); nothing when no
      building is selected
    - the bell and account menu stay in a slim top bar over the main column (their panels keep P4-08h's placement)
    - `< 1024 px`: a top bar (`bg-white/80 backdrop-blur-md border-b`) with a menu button, the building name, the bell
      and the account menu; the menu button opens the sidebar as a drawer (`w-[80%] max-w-[320px]`, slides from the
      left over a `bg-black/50` overlay)
  - **Nav items** (`src/app/MainNav.tsx`): the same `navPages(...)` list and `NavLabel` counts, now a vertical list;
    each item a `lucide-react` icon + label in `rounded-xl px-3 py-2.5`; active = `bg-zinc-900 text-white shadow-lg`,
    inactive = `text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900`; counts as the red round badge
    (`bg-red-500 text-white`, `99+` cap). Icons come from a `NAV_ICONS: Record<Page, LucideIcon>` map next to the nav
    (a page without an entry gets a neutral icon); `PAGE_ACCESS` is not changed.
  - **Drawer behaviour:** the menu button has `aria-expanded` and `aria-controls`; Escape, the overlay, the close
    button and following a link close it; Escape returns focus to the menu button; the body does not scroll behind it;
    the transition is off under `prefers-reduced-motion`. At `≥ 1024 px` the drawer state has no effect.
  - The urgent-banner slot, the logout error and the `DevVersionFooter` keep their place in the main column, above
    the page.
  - `index.css`: remove the commented-out Vite starter block if it is in the way; the body gets the zinc text colour.
- Out (do **not** do in this ticket):
  - any page's own content (P6-05b, P6-08b, P6-08c), the landing page's cards
  - the Base44 logo (it loads from a third-party Supabase URL), the background image, the page-transition blur
    animation, dark mode, `BottomTabs`, `RoleSwitcher` and `LanguageSwitcher` (view-as stays in the account menu)
  - restoring `Layout.jsx` or any file that imports `@/api/base44Client`; adding a dependency (`lucide-react`,
    `framer-motion`, `class-variance-authority` and `tailwind-merge` are installed)
  - changing `PAGE_ACCESS`, `navPages`, a guard, a query key, a request or an accessible name

## Interfaces

No API change. Component exports unchanged: `AppShell`, `MainNav`, `useCanViewAs`, `AccountMenu`, and the `ui`
primitives' names and props. New: `NAV_ICONS` (module-private is fine).

## Acceptance criteria

1. **Behaviour unchanged.** **Given** the existing suites (`nav.test.tsx`, `shell.test.tsx`, `building.test.tsx`,
   `shellImports.test.ts`, the notifications, banner and badge tests), **then** they pass with no change to what they
   assert; a selector may change only where the markup moved, and each such change is listed in the PR.
2. **Same items.** **Given** each Maple persona and council view-as, **then** the sidebar shows exactly the items and
   counts the old nav showed, in the same order, each with an icon; the active item is the current route's and has
   `aria-current="page"`.
3. **Desktop.** **Given** a 1280 px viewport, **then** the sidebar is visible without opening anything, the menu
   button is not rendered or is hidden from the accessibility tree, and the page content is to its right.
4. **Drawer.** **Given** a 375 px viewport, **when** the member opens the menu, **then** the drawer shows the nav with
   `aria-expanded="true"` on the button; Escape closes it and focuses the button; a nav link navigates and closes it;
   the overlay click closes it; the page behind does not scroll while it is open.
5. **No building.** **Given** a session-only page (`/403`, onboarding, the pending screen), **then** the frame shows no
   nav items and no building name, and sends no building request (the passive reads stay passive).
6. **Header panels.** **Given** 375 px and 1280 px, **then** the bell's panel and the account menu open, close and
   stay inside the viewport as P4-08h requires.
7. **Primitives typed.** `Button`, `Card` (and its parts) and `Badge` are `.tsx`, `tsc --noEmit` passes, and a `.tsx`
   file can use `<Button variant="outline" size="sm" asChild>`, `<Card className=…>` and `<Badge variant="secondary">`
   without a type error (a small type-level test or their use in the shell shows it).
8. **No Base44.** No new `base44.` reference (the ratchet does not rise), no request to a host other than the app's
   own, and no import from `src/pages/` or `src/Layout*`.
9. **Look.** Screenshots at 375 px (drawer closed and open) and 1280 px, as `resident1` and `manager`, are in the PR
   next to the reference's look; reduced motion shows no slide.

## Test plan

- `src/app/shell.test.tsx`: drawer open/close, Escape focus return, link closes, no-building frame (criteria 4, 5)
- `src/app/nav.test.tsx`: icons present, `aria-current`, same items per persona (criterion 2); existing cases kept
- `src/components/ui/primitives.test.tsx` (or the type check alone): criterion 7
- Chromium at 375 and 1280 px on `make up` (criteria 3, 6, 9), screenshots in the PR
- `make check DB_PORT=55432`; `make e2e` still green (P4-09, P5-05 journeys go through the frame)

## Likely files

`frontend/src/app/{AppShell.tsx,MainNav.tsx,AccountMenu.tsx,shell.test.tsx,nav.test.tsx}`,
`frontend/src/components/ui/{button,card,badge}.tsx` (renamed from `.jsx`), `frontend/src/index.css`,
`e2e/` selectors only if a journey clicks a nav link by a locator that moved.

Estimate: ~300 non-test lines (shell and drawer ~150, nav ~70, primitives ~60, CSS ~20).

## Must explain (learning checkpoint)

1. Which parts of the Base44 layout were kept, which were dropped, and why couldn't the old file simply be restored?
2. How does the drawer stay accessible (focus, Escape, `aria-expanded`), and why does it not matter at desktop width?
3. How does the restyled nav still guarantee it shows only the pages the guards allow?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
