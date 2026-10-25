// @vitest-environment jsdom
/**
 * P2-06c: the navigation built from `PAGE_ACCESS`, the header's account menu and council "view as".
 * Each `describe` names the criterion it proves (docs/tickets/P2-06c-…md). Expected nav items are written
 * out per persona, not computed with the helpers the nav uses.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { components } from '@/api/schema';
import { createQueryClient } from '@/app/queryClient';
import { AppRoutes } from '@/app/routes';
import {
  BIRCH,
  MAPLE,
  RESIDENT_ME,
  buildingOut,
  calls,
  json,
  membership,
  noContent,
  openAccountMenu,
  problem,
  renderApp,
  stubApi,
  type Handler,
} from '@/test/renderApp';

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, ...actual.createApiClient({ baseUrl: 'http://app.test' }) };
});

type Me = components['schemas']['MeOut'];
type Role = components['schemas']['Role'];

const BUILDING_KEY = 'condo.buildingId';
const VIEW_KEY = 'condo.viewAs';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
const location = () => screen.getByTestId('location').textContent;
const nav = () => screen.queryByRole('navigation', { name: 'Main' });
const navItems = () =>
  within(screen.getByRole('navigation', { name: 'Main' }))
    .getAllByRole('link')
    .map((link) => link.textContent);
const findNavItems = async () => {
  await screen.findByRole('navigation', { name: 'Main' });
  return navItems();
};

/** One active membership in Maple with `roles`, and Maple's building answer with the same roles. */
function persona(roles: Role[], features?: components['schemas']['Feature'][]): Record<string, Handler> {
  const me: Me = { ...RESIDENT_ME, memberships: [membership(MAPLE, { roles })] };
  return {
    'GET /api/auth/me': () => json(me),
    [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, roles, features)),
  };
}

const RESIDENT_ITEMS = ['Dashboard', 'My profile', 'Contacts', 'My packages', 'Notices', 'Maintenance requests'];
/** The resident's "My packages" item asks for its waiting count when it shows (P5-04); nothing else in the nav asks. */
const PACKAGES_SUMMARY = `GET /api/buildings/${MAPLE.id}/packages/summary`;
/** The requests made since `before`, other than that count. */
const otherCallsSince = (fetchMock: ReturnType<typeof stubApi>, before: string[]) =>
  calls(fetchMock)
    .slice(before.length)
    .filter((call) => call !== PACKAGES_SUMMARY);
const COMMON_ITEMS = ['Dashboard', 'My profile', 'Contacts'];

describe('navigation from the page table (criterion 1)', () => {
  it('shows a resident only the resident items, each linking to its page (1a)', async () => {
    stubApi(persona(['resident']));

    renderApp(['/']);

    expect(await findNavItems()).toEqual(RESIDENT_ITEMS);
    const links = within(nav()!).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/Dashboard',
      '/Profile',
      '/Contacts',
      '/packages',
      '/notices',
      '/Maintenance',
    ]);
    for (const staffItem of ['Residents', 'Package log', 'Daily notices', 'Maintenance']) {
      expect(within(nav()!).queryByRole('link', { name: staffItem })).toBeNull();
    }
  });

  it('marks the current page with aria-current, also for a differently cased URL', async () => {
    stubApi(persona(['resident']));

    // /packages until P5-04 migrated it: any unmigrated page.
    renderApp(['/maintenance']);

    await screen.findByText(/being migrated/i);
    const current = within(nav()!).getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current.map((link) => link.textContent)).toEqual(['Maintenance requests']);
  });

  it.each([
    ['security in a building with packages only', ['security'], ['packages'], ['Dashboard', 'My profile', 'Contacts', 'Package log']],
    [
      'property management',
      ['property_management'],
      undefined,
      ['Dashboard', 'My profile', 'Contacts', 'Residents', 'Package log', 'Notices', 'Daily notices', 'Maintenance'],
    ],
    ['a resident in a building without features', ['resident'], [], COMMON_ITEMS],
    ['council (Management view by default)', ['council'], undefined, [...COMMON_ITEMS, 'Notices', 'Daily notices', 'Maintenance']],
  ] as const)('shows %s only what roles and features allow (1b)', async (_label, roles, features, expected) => {
    stubApi(persona([...roles], features ? [...features] : undefined));

    renderApp(['/']);

    expect(await findNavItems()).toEqual(expected);
  });

  it('follows a building switch: Maple resident items, then Birch security items (1c)', async () => {
    const me: Me = {
      ...RESIDENT_ME,
      memberships: [membership(MAPLE, { roles: ['resident'] }), membership(BIRCH, { roles: ['security'] })],
    };
    stubApi({
      'GET /api/auth/me': () => json(me),
      [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, ['resident'])),
      [`GET /api/buildings/${BIRCH.id}`]: () => json(buildingOut(BIRCH, ['security'], ['packages'])),
    });
    sessionStorage.setItem(BUILDING_KEY, MAPLE.id);

    renderApp(['/']);
    expect(await findNavItems()).toEqual(RESIDENT_ITEMS);

    openAccountMenu();
    fireEvent.change(screen.getByLabelText(/building/i), { target: { value: BIRCH.id } });

    await waitFor(() => expect(navItems()).toEqual(['Dashboard', 'My profile', 'Contacts', 'Package log']));
  });

  it.each([
    ['a pending membership', [membership(MAPLE, { status: 'pending' })], /waiting for approval/i],
    ['the picker', [membership(MAPLE), membership(BIRCH)], /choose a building/i],
  ])('shows no nav on %s (1d)', async (_label, memberships, heading) => {
    stubApi({ 'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships }) });

    renderApp(['/']);

    await screen.findByRole('heading', { name: heading });
    await settle();
    expect(nav()).toBeNull();
  });

  it('hides the nav when a building refetch answers 404 over cached data (1d)', async () => {
    let fail = false;
    stubApi({
      ...persona(['resident']),
      [`GET /api/buildings/${MAPLE.id}`]: () => (fail ? problem(404, 'not_found') : json(buildingOut(MAPLE, ['resident']))),
    });
    const app = renderApp(['/']);
    await findNavItems();

    fail = true;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'building'] }));

    await waitFor(() => expect(nav()).toBeNull());
    expect(screen.getByRole('heading', { name: /no longer have access/i })).toBeTruthy();
  });

  it('hides the nav on a building refetch 401 by itself, before any redirect (1d)', async () => {
    let fail = false;
    stubApi({
      ...persona(['resident']),
      [`GET /api/buildings/${MAPLE.id}`]: () =>
        fail ? problem(401, 'not_authenticated') : json(buildingOut(MAPLE, ['resident'])),
    });
    // No AuthProvider: its 401 redirect would remove the whole shell and hide what the nav does by itself.
    const queryClient = createQueryClient({ retryDelay: 0 });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <AppRoutes />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await findNavItems();

    fail = true;
    await act(() => queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'building'] }));

    await waitFor(() => expect(nav()).toBeNull());
    expect(screen.getByRole('banner')).toBeTruthy();
  });

  it('makes no request of its own: the building is requested once, by the guards (1d)', async () => {
    const fetchMock = stubApi(persona(['resident']));

    renderApp(['/Maintenance']);
    await findNavItems();
    await settle();

    // The bell's summary is the only other request (P3-05); the nav adds only its "My packages" (P5-04) and "Notices"
    // (P6-02a) counts.
    expect(calls(fetchMock)).toEqual([
      'GET /api/auth/me',
      `GET /api/buildings/${MAPLE.id}`,
      `GET /api/buildings/${MAPLE.id}/notifications/summary`,
      PACKAGES_SUMMARY,
      `GET /api/buildings/${MAPLE.id}/notices/summary`,
    ]);
  });
});

describe('council "view as" (criterion 3)', () => {
  const COUNCIL_RESIDENT = persona(['council', 'resident']);
  const viewAs = (name: 'Management' | 'Resident') => fireEvent.click(screen.getByRole('radio', { name }));

  it('offers the toggle to council only, defaulting to Management (3a)', async () => {
    stubApi(COUNCIL_RESIDENT);
    renderApp(['/']);
    await findNavItems();

    openAccountMenu();

    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Management' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Resident' }).checked).toBe(false);
  });

  it('shows no toggle to a member without council, and ignores a stored view for them (3a)', async () => {
    stubApi(persona(['resident']));
    sessionStorage.setItem(VIEW_KEY, 'management');
    renderApp(['/']);

    expect(await findNavItems()).toEqual(RESIDENT_ITEMS);
    openAccountMenu();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('changes only the nav, making no request (3b, 3c)', async () => {
    const fetchMock = stubApi(COUNCIL_RESIDENT);
    renderApp(['/']);
    expect(await findNavItems()).toEqual([...COMMON_ITEMS, 'Notices', 'Daily notices', 'Maintenance']);
    await settle();
    const before = calls(fetchMock);

    openAccountMenu();
    viewAs('Resident');
    expect(navItems()).toEqual(RESIDENT_ITEMS);
    viewAs('Management');
    expect(navItems()).toEqual([...COMMON_ITEMS, 'Notices', 'Daily notices', 'Maintenance']);
    viewAs('Resident');
    await settle();

    // Only the resident view's "My packages" count, asked as its item shows (P5-04).
    expect(otherCallsSince(fetchMock, before)).toEqual([]);
  });

  it('never shows a council-only member an item their roles do not allow (3c)', async () => {
    stubApi(persona(['council']));
    renderApp(['/']);
    await findNavItems();

    openAccountMenu();
    viewAs('Resident');

    // No resident item: My packages and Maintenance requests need the resident role. Notices is for every member.
    expect(navItems()).toEqual([...COMMON_ITEMS, 'Notices']);
  });

  it('keeps the guards: a page the real roles allow opens by URL in either view (3d)', async () => {
    stubApi(COUNCIL_RESIDENT);
    sessionStorage.setItem(VIEW_KEY, 'management');
    const app = renderApp(['/']);
    await findNavItems();

    // /Packages until P5-04 migrated it: any unmigrated resident page.
    act(() => app.navigate()('/Maintenance'));
    expect(await screen.findByText(/being migrated/i)).toBeTruthy();
    expect(location()).toBe('/Maintenance');

    openAccountMenu();
    viewAs('Resident');
    act(() => app.navigate()('/ManagementNotices'));
    expect(await screen.findByRole('heading', { name: /management notices/i })).toBeTruthy();
    expect(location()).toBe('/ManagementNotices');
  });

  it('stores the view per tab and keeps it across a reload (3e)', async () => {
    stubApi(COUNCIL_RESIDENT);
    renderApp(['/']);
    await findNavItems();
    openAccountMenu();
    viewAs('Resident');
    expect(sessionStorage.getItem(VIEW_KEY)).toBe('resident');
    cleanup();

    renderApp(['/']);

    expect(await findNavItems()).toEqual(RESIDENT_ITEMS);
  });

  it('forgets the view at logout (3e)', async () => {
    let signedIn = true;
    // After logout /me is held, so the login page's session check can't be what clears the view.
    let releaseCheck: ((response: Response) => void) | undefined;
    const fetchMock = stubApi({
      ...COUNCIL_RESIDENT,
      'GET /api/auth/me': (request) =>
        signedIn
          ? COUNCIL_RESIDENT['GET /api/auth/me'](request)
          : new Promise<Response>((resolve) => (releaseCheck = resolve)),
      'POST /api/auth/logout': () => {
        signedIn = false;
        return noContent();
      },
    });
    renderApp(['/']);
    await findNavItems();
    openAccountMenu();
    viewAs('Resident');

    fireEvent.click(screen.getByRole('button', { name: /log out/i }));

    await waitFor(() => expect(location()).toBe('/login'));
    await waitFor(() => expect(releaseCheck).toBeDefined());
    expect(sessionStorage.getItem(VIEW_KEY)).toBeNull();
    expect(calls(fetchMock).filter((c) => c === 'GET /api/auth/me')).toHaveLength(2);
    // Free the auth queue (module state) for the next test.
    await act(() => Promise.resolve(releaseCheck!(problem(401, 'not_authenticated'))));
  });

  it('forgets the view when /me answers for another user (3e)', async () => {
    let me: Me = { ...RESIDENT_ME, memberships: [membership(MAPLE, { roles: ['council', 'resident'] })] };
    stubApi({ ...COUNCIL_RESIDENT, 'GET /api/auth/me': () => json(me) });
    const app = renderApp(['/']);
    await findNavItems();
    openAccountMenu();
    viewAs('Resident');

    me = { ...me, user: { ...me.user, id: 'someone-else' } };
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['me'] }));

    await waitFor(() => expect(sessionStorage.getItem(VIEW_KEY)).toBeNull());
  });

  it('drops the toggle and shows the full nav when a refetch removes council (3f)', async () => {
    let roles: Role[] = ['council', 'resident'];
    stubApi({
      'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles })] }),
      [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, roles)),
    });
    const app = renderApp(['/']);
    await findNavItems();
    openAccountMenu();
    viewAs('Management');
    expect(navItems()).not.toContain('My packages');

    roles = ['resident'];
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'building'] }));

    await waitFor(() => expect(navItems()).toEqual(RESIDENT_ITEMS));
    openAccountMenu();
    expect(screen.queryByRole('radio')).toBeNull();
  });
});

describe('review round 1 (Claude F1–F3, Codex M1 and L1)', () => {
  // F1 / Codex M1: AC3f's "/me refetch" half. Ported from Codex's proof.
  it('drops the toggle and shows the full nav when only a /me refetch removes council (3f)', async () => {
    let roles: Role[] = ['council', 'resident'];
    const fetchMock = stubApi({
      'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles })] }),
      [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, roles)),
    });
    const app = renderApp(['/']);
    await findNavItems();
    openAccountMenu();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    // The building itself: the resident nav's "My packages" count is another request under it (P5-04).
    const buildingsBefore = calls(fetchMock).filter((c) => c === `GET /api/buildings/${MAPLE.id}`).length;

    roles = ['resident'];
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['me'] }));
    await waitFor(() =>
      expect(app.queryClient.getQueryData<Me>(['me'])?.memberships[0].roles).toEqual(['resident']),
    );

    // At once, from /me alone: no toggle.
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    // The building is asked again, so the nav's (and the guards') roles catch up with /me.
    await waitFor(() =>
      expect(calls(fetchMock).filter((c) => c === `GET /api/buildings/${MAPLE.id}`).length).toBe(buildingsBefore + 1),
    );
    await waitFor(() => expect(navItems()).toEqual(RESIDENT_ITEMS));
  });

  it('does not refetch the building on a /me refetch whose roles did not change', async () => {
    const fetchMock = stubApi(persona(['council', 'resident']));
    const app = renderApp(['/']);
    await findNavItems();
    await settle();
    const before = calls(fetchMock).filter((c) => c.startsWith('GET /api/buildings/')).length;

    await act(() => app.queryClient.invalidateQueries({ queryKey: ['me'] }));
    await settle();

    expect(calls(fetchMock).filter((c) => c.startsWith('GET /api/buildings/'))).toHaveLength(before);
  });

  // F2 / Codex L1: ported from Codex's proof.
  it('opening the menu on a stale building answer makes no request', async () => {
    const fetchMock = stubApi(persona(['council', 'resident']));
    const app = renderApp(['/']);
    await findNavItems();
    act(() => {
      app.queryClient.setQueryData(['b', MAPLE.id, 'building'], buildingOut(MAPLE, ['council', 'resident']), {
        updatedAt: Date.now() - 31_000,
      });
    });
    const before = calls(fetchMock);

    openAccountMenu();
    fireEvent.click(screen.getByRole('radio', { name: 'Resident' }));
    await settle();

    // Only the resident view's "My packages" count (P5-04); not the building.
    expect(otherCallsSince(fetchMock, before)).toEqual([]);
  });

  // F3: closing the panel unmounted the focused <select>.
  it('returns focus to the account button after switching building', async () => {
    stubApi({
      'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE), membership(BIRCH)] }),
      [`GET /api/buildings/${BIRCH.id}`]: () => json(buildingOut(BIRCH, ['resident'])),
    });
    sessionStorage.setItem(BUILDING_KEY, MAPLE.id);
    renderApp(['/']);
    await findNavItems();

    openAccountMenu();
    const select = screen.getByLabelText(/building/i);
    select.focus();
    fireEvent.change(select, { target: { value: BIRCH.id } });

    expect(document.activeElement).toBe(screen.getByRole('button', { name: /account menu/i }));
  });

  // 3e, the paths the round-1 review found untested for the view.
  it('forgets the view at login', async () => {
    let signedIn = false;
    stubApi({
      ...persona(['council', 'resident']),
      'GET /api/auth/me': () =>
        signedIn
          ? json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles: ['council', 'resident'] })] })
          : problem(401, 'not_authenticated'),
      'POST /api/auth/login': () => {
        signedIn = true;
        return noContent();
      },
    });
    renderApp(['/login']);
    await screen.findByRole('heading', { name: /sign in/i });
    await settle();
    // Left by an earlier user of this tab, after the login page's own check.
    sessionStorage.setItem(VIEW_KEY, 'resident');

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'council@example.test' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'DevPassword!2026' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await findNavItems()).toEqual([...COMMON_ITEMS, 'Notices', 'Daily notices', 'Maintenance']);
    expect(sessionStorage.getItem(VIEW_KEY)).toBeNull();
  });

  it('forgets the view on a 401 reset', async () => {
    let lost = false;
    stubApi({
      ...persona(['council', 'resident']),
      'GET /api/auth/me': () =>
        lost
          ? problem(401, 'not_authenticated')
          : json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles: ['council', 'resident'] })] }),
      'GET /api/auth/sessions': () => {
        lost = true;
        return problem(401, 'not_authenticated');
      },
    });
    renderApp(['/']);
    await findNavItems();
    openAccountMenu();
    fireEvent.click(screen.getByRole('radio', { name: 'Resident' }));
    expect(sessionStorage.getItem(VIEW_KEY)).toBe('resident');

    const { api } = await import('@/api/client');
    await act(() => api.get('/api/auth/sessions').catch(() => undefined));

    await waitFor(() => expect(location()).toMatch(/^\/login/));
    expect(sessionStorage.getItem(VIEW_KEY)).toBeNull();
  });
});

describe('review round 2 (Codex L1)', () => {
  // Ported from Codex's round-2 proof: these routes have no building guard, so nothing else loads the building.
  // `/Onboarding` and `/ResidentSetup` were here too until P4-08a removed them (now "Page not found", below).
  it.each(['/403'])(
    'the nav requests nothing on the session-only route %s (1d)',
    async (path) => {
      const fetchMock = stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME) });
      renderApp([path]);
      await screen.findByRole('button', { name: /account menu/i });
      openAccountMenu();
      await settle();

      expect(calls(fetchMock)).toEqual(['GET /api/auth/me']);
      expect(nav()).toBeNull();
    },
  );

  it.each(['/Onboarding', '/ResidentSetup', '/onboarding'])('%s is "Page not found" since P4-08a', async (path) => {
    const fetchMock = stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME) });
    renderApp([path]);
    await screen.findByRole('heading', { name: /page not found/i });
    expect(calls(fetchMock)).toEqual([]);
  });

  it('still shows the nav on /403 when the building is already loaded', async () => {
    const fetchMock = stubApi(persona(['resident']));
    const app = renderApp(['/']);
    await findNavItems();
    const before = calls(fetchMock);

    act(() => app.navigate()('/403'));
    await screen.findByRole('heading', { name: /can’t open this page/i });
    await settle();

    expect(navItems()).toEqual(RESIDENT_ITEMS);
    expect(calls(fetchMock)).toEqual(before);
  });
});

describe('header account menu (criterion 4)', () => {
  const button = () => screen.getByRole('button', { name: /account menu/i });

  it('closes when the route changes, as when a nav link is followed (review round 2, Claude L4)', async () => {
    stubApi(persona(['resident']));
    renderApp(['/']);
    await findNavItems();

    fireEvent.click(button());
    expect(button().getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(within(nav()!).getByRole('link', { name: 'My packages' }));

    await waitFor(() => expect(location()).toBe('/packages'));
    expect(button().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /log out/i })).toBeNull();
  });

  it('opens a panel with the email, the building and Log out, and closes on Escape with focus back', async () => {
    stubApi(persona(['resident']));
    renderApp(['/']);
    await findNavItems();

    expect(button().textContent).toContain('Alex Chen');
    expect(button().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /log out/i })).toBeNull();

    fireEvent.click(button());

    expect(button().getAttribute('aria-expanded')).toBe('true');
    const panel = document.getElementById(button().getAttribute('aria-controls')!)!;
    expect(panel.textContent).toContain('resident1@example.test');
    expect(panel.textContent).toContain('Maple Tower');
    expect(within(panel).getByRole('button', { name: /log out/i })).toBeTruthy();

    within(panel).getByRole('button', { name: /log out/i }).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

    expect(button().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /log out/i })).toBeNull();
    expect(document.activeElement).toBe(button());
  });

  it('closes on a click outside, and toggles with the button', async () => {
    stubApi(persona(['resident']));
    renderApp(['/']);
    await findNavItems();

    fireEvent.click(button());
    fireEvent.pointerDown(screen.getByRole('main'));
    expect(button().getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(button());
    expect(button().getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(button());
    expect(button().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes after switching building', async () => {
    stubApi({
      'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE), membership(BIRCH)] }),
      [`GET /api/buildings/${BIRCH.id}`]: () => json(buildingOut(BIRCH, ['resident'])),
    });
    sessionStorage.setItem(BUILDING_KEY, MAPLE.id);
    renderApp(['/']);
    await findNavItems();

    openAccountMenu();
    fireEvent.change(screen.getByLabelText(/building/i), { target: { value: BIRCH.id } });

    expect(button().getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => expect(sessionStorage.getItem(BUILDING_KEY)).toBe(BIRCH.id));
  });

  it('keeps a failed logout’s error visible with the menu closed', async () => {
    stubApi({ ...persona(['resident']), 'POST /api/auth/logout': () => problem(500, 'internal_error') });
    renderApp(['/']);
    await findNavItems();

    openAccountMenu();
    fireEvent.click(screen.getByRole('button', { name: /log out/i }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not log out');
    fireEvent.click(button());

    expect(button().getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('alert').textContent).toContain('Could not log out');
  });

  it('is there with Log out on the membership screens', async () => {
    stubApi({ 'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { status: 'pending' })] }) });
    renderApp(['/']);
    await screen.findByRole('heading', { name: /waiting for approval/i });

    openAccountMenu();

    expect(screen.getByRole('button', { name: /log out/i })).toBeTruthy();
  });
});

describe('P4-08f: account menu follow-ups (criteria 1–4)', () => {
  const button = () => screen.getByRole('button', { name: /account menu/i });
  const expanded = () => button().getAttribute('aria-expanded');

  it('criterion 1: Back to where it was opened, and Forward then Back, leave it closed', async () => {
    stubApi(persona(['resident']));
    const app = renderApp(['/']);
    await findNavItems();

    openAccountMenu();
    fireEvent.click(within(nav()!).getByRole('link', { name: 'My packages' }));
    await waitFor(() => expect(location()).toBe('/packages'));
    expect(expanded()).toBe('false');

    act(() => app.navigate()(-1));
    await waitFor(() => expect(location()).toBe('/'));
    expect(expanded()).toBe('false');
    expect(screen.queryByRole('button', { name: /log out/i })).toBeNull();

    act(() => app.navigate()(1));
    await waitFor(() => expect(location()).toBe('/packages'));
    act(() => app.navigate()(-1));
    await waitFor(() => expect(location()).toBe('/'));
    expect(expanded()).toBe('false');
  });

  it('criterion 2: closes when a /me refresh moves the tab to another building, at the same location', async () => {
    let me: Me = { ...RESIDENT_ME, memberships: [membership(MAPLE), membership(BIRCH)] };
    stubApi({
      'GET /api/auth/me': () => json(me),
      [`GET /api/buildings/${BIRCH.id}`]: () => json(buildingOut(BIRCH, ['resident'])),
    });
    sessionStorage.setItem(BUILDING_KEY, MAPLE.id);
    const app = renderApp(['/']);
    await findNavItems();
    openAccountMenu();
    expect(expanded()).toBe('true');

    me = { ...RESIDENT_ME, memberships: [membership(MAPLE, { status: 'suspended' }), membership(BIRCH)] };
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['me'] }));

    await waitFor(() => expect(sessionStorage.getItem(BUILDING_KEY)).toBe(BIRCH.id));
    expect(location()).toBe('/');
    expect(expanded()).toBe('false');
    expect(screen.queryByRole('button', { name: /log out/i })).toBeNull();
  });

  it('criterion 3: offers no "View as" while the building is denied, and offers it again once it answers', async () => {
    let status = 200;
    const me: Me = { ...RESIDENT_ME, memberships: [membership(MAPLE, { roles: ['council', 'resident'] })] };
    stubApi({
      'GET /api/auth/me': () => json(me),
      [`GET /api/buildings/${MAPLE.id}`]: () =>
        status === 200 ? json(buildingOut(MAPLE, ['council', 'resident'])) : problem(404, 'building_not_found'),
    });
    const app = renderApp(['/']);
    await findNavItems();
    openAccountMenu();
    expect(screen.getByRole('radio', { name: 'Management' })).toBeTruthy();

    status = 404;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'building'] }));
    const chooseAgain = await screen.findByRole('button', { name: /choose again/i });
    expect(nav()).toBeNull();
    openAccountMenu();
    expect(screen.getByRole('button', { name: /log out/i })).toBeTruthy();
    expect(screen.queryAllByRole('radio')).toEqual([]);

    status = 200;
    fireEvent.click(chooseAgain);
    await findNavItems();
    openAccountMenu();
    expect(screen.getByRole('radio', { name: 'Management' })).toBeTruthy();
  });

  it('criterion 3: a building_not_found from another of its requests hides "View as" too', async () => {
    const me: Me = { ...RESIDENT_ME, memberships: [membership(MAPLE, { roles: ['council', 'resident'] })] };
    let summary = 200;
    stubApi({
      'GET /api/auth/me': () => json(me),
      [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, ['council', 'resident'])),
      [`GET /api/buildings/${MAPLE.id}/notifications/summary`]: () =>
        summary === 200 ? json({ unread_count: 0 }) : problem(404, 'building_not_found'),
    });
    const app = renderApp(['/']);
    await findNavItems();
    openAccountMenu();
    expect(screen.getByRole('radio', { name: 'Management' })).toBeTruthy();

    summary = 404;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'notifications'] }));

    await waitFor(() => expect(nav()).toBeNull());
    openAccountMenu();
    expect(screen.queryAllByRole('radio')).toEqual([]);
  });

  it('criterion 4: a touch outside (pointerdown, no mousedown) closes it; one inside does not', async () => {
    stubApi(persona(['resident']));
    renderApp(['/']);
    await findNavItems();

    openAccountMenu();
    const panel = document.getElementById(button().getAttribute('aria-controls')!)!;
    fireEvent.pointerDown(within(panel).getByRole('button', { name: /log out/i }), { pointerType: 'touch' });
    expect(expanded()).toBe('true');

    fireEvent.pointerDown(screen.getByRole('main'), { pointerType: 'touch' });
    expect(expanded()).toBe('false');
  });
});

describe('review round 1 (Codex gpt-6.1-sol): criterion 3 coverage', () => {
  const councilWith = (building: () => Response) => {
    const me: Me = { ...RESIDENT_ME, memberships: [membership(MAPLE, { roles: ['council', 'resident'] })] };
    return { 'GET /api/auth/me': () => json(me), [`GET /api/buildings/${MAPLE.id}`]: building };
  };

  it('a building refetch that succeeds after a 404 brings "View as" back (no Choose again)', async () => {
    let status = 200;
    stubApi(councilWith(() => (status === 200 ? json(buildingOut(MAPLE, ['council', 'resident'])) : problem(404, 'building_not_found'))));
    const app = renderApp(['/']);
    await findNavItems();

    status = 404;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'building'] }));
    await screen.findByRole('button', { name: /choose again/i });
    openAccountMenu();
    expect(screen.queryAllByRole('radio')).toEqual([]);

    status = 200;
    await act(() => app.queryClient.refetchQueries({ queryKey: ['b', MAPLE.id, 'building'] }));
    await findNavItems();
    openAccountMenu();
    expect(screen.getByRole('radio', { name: 'Management' })).toBeTruthy();
  });

  it('a building 401 leaves no "View as" anywhere (the session is gone)', async () => {
    let status = 200;
    const routes = councilWith(() => (status === 200 ? json(buildingOut(MAPLE, ['council', 'resident'])) : problem(401, 'not_authenticated')));
    const me = routes['GET /api/auth/me'];
    // A real 401 means the session is gone, so /me answers 401 too.
    stubApi({ ...routes, 'GET /api/auth/me': () => (status === 200 ? me() : problem(401, 'not_authenticated')) });
    const app = renderApp(['/']);
    await findNavItems();
    openAccountMenu();
    expect(screen.getByRole('radio', { name: 'Management' })).toBeTruthy();

    status = 401;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'building'] }));

    await waitFor(() => expect(location()).toMatch(/^\/login/));
    expect(screen.queryAllByRole('radio')).toEqual([]);
    expect(nav()).toBeNull();
  });
});
