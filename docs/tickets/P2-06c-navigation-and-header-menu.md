# P2-06c — Navigation, header menu and council "view as"

| Field | Value |
|---|---|
| Phase / lane | P2 / B |
| Risk tier | 1 |
| Depends on | P2-06b |
| Replaces old | M3-T10 (frontend part) |
| Status | todo |

Split from [P2-06b](./P2-06b-building-context-guards-nav.md) while framing it (2026-10-17; size, see its Frame
notes). The parent is [P2-06](./P2-06-frontend-auth-shell.md).

## Goal

The user navigates with a menu built from the page metadata P2-06b added, from a header menu that holds the
building switcher and "Log out". The Base44 `Layout.jsx` is gone.

## Scope

- In:
  - **Navigation** built from `src/app/pages.ts` (role, feature, scope allowlist from P0-03), replacing the
    Base44 nav logic in `Layout.jsx`. Delete `Layout.jsx` once nothing imports it (today only the unused
    `pages.config.js` does), and lower the Base44 baseline.
  - **Header menu** holding P2-06a's "Log out" and P2-06b's building switcher; keyboard accessible.
  - **Council "view as resident/management"**: a **presentation toggle only**, stored per tab; it never
    changes API calls or permissions, and never shows an item the user's real roles don't allow.
  - **P2-06a follow-ups** (carried, decide while framing):
    - The auth queue is per tab (`src/app/authQueue.ts::runAuthCall`): a slow logout in tab A can delete a
      session tab B just created. Decide whether to serialize across tabs with Web Locks
      (`navigator.locks`), with the in-module chain as the jsdom fallback (James chose the per-tab queue in
      inbox B-3).
    - No timeout on login/logout: one hung call holds the queue until the browser times it out. Consider a
      timeout signal on both, showing the generic error.
    - A late logout drops `next`: when it settles while the user is back on `/login?next=…`, it navigates to
      bare `/login`. Skip that navigate on a login path.
    - A signed-in user on `/login` sees the form; consider redirecting to `/`.
    - The Base44 Vite plugin's two dev-only injections and `main.jsx`'s `sandbox:*` `postMessage`s: remove
      when no legacy page needs them.
- Out: notification bell (P3-05), new pages (their slices).

## Acceptance criteria

To sharpen when framing.

1. **Given** seeded `resident1`, **when** logging in, **then** the nav shows only resident demo items
   (the parent's AC1, second half).
2. **Given** `npm run lint` and the ratchet, **then** the files this part adds contain no `base44`
   reference, and the baseline is lowered once `Layout.jsx` goes (the parent's AC7, continued).
3. **Given** a council member toggling "view as", **then** the requests the app makes are the same before and
   after, and no nav item appears that the member's roles and the building's features don't allow.

## Must explain (learning checkpoint)

1. Why does council "view as" never change API permissions?
2. How does one metadata table drive both the route guards and the navigation, and what would drift if they
   were separate?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
