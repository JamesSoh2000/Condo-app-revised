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

const RESIDENT_ITEMS = ['Dashboard', 'My profile', 'Contacts', 'My packages', 'Maintenance requests'];
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
      '/Packages',
      '/Maintenance',
    ]);
    for (const staffItem of ['Residents', 'Package log', 'Daily notices', 'Maintenance']) {
      expect(within(nav()!).queryByRole('link', { name: staffItem })).toBeNull();
    }
  });

  it('marks the current page with aria-current, also for a differently cased URL', async () => {
    stubApi(persona(['resident']));

    renderApp(['/packages']);

    await screen.findByText(/being migrated/i);
    const current = within(nav()!).getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current.map((link) => link.textContent)).toEqual(['My packages']);
  });

  it.each([
    ['security in a building with packages only', ['security'], ['packages'], ['Dashboard', 'My profile', 'Contacts', 'Package log']],
    [
      'property management',
      ['property_management'],
      undefined,
      ['Dashboard', 'My profile', 'Contacts', 'Residents', 'Package log', 'Daily notices', 'Maintenance'],
    ],
    ['a resident in a building without features', ['resident'], [], COMMON_ITEMS],
    ['council (Management view by default)', ['council'], undefined, [...COMMON_ITEMS, 'Daily notices', 'Maintenance']],
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

    renderApp(['/Packages']);
    await findNavItems();
    await settle();

    expect(calls(fetchMock)).toEqual(['GET /api/auth/me', `GET /api/buildings/${MAPLE.id}`]);
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
    expect(await findNavItems()).toEqual([...COMMON_ITEMS, 'Daily notices', 'Maintenance']);
    await settle();
    const before = calls(fetchMock);

    openAccountMenu();
    viewAs('Resident');
    expect(navItems()).toEqual(RESIDENT_ITEMS);
    viewAs('Management');
    expect(navItems()).toEqual([...COMMON_ITEMS, 'Daily notices', 'Maintenance']);
    viewAs('Resident');
    await settle();

    expect(calls(fetchMock)).toEqual(before);
  });

  it('never shows a council-only member an item their roles do not allow (3c)', async () => {
    stubApi(persona(['council']));
    renderApp(['/']);
    await findNavItems();

    openAccountMenu();
    viewAs('Resident');

    // No resident item: My packages and Maintenance requests need the resident role.
    expect(navItems()).toEqual(COMMON_ITEMS);
  });

  it('keeps the guards: a page the real roles allow opens by URL in either view (3d)', async () => {
    stubApi(COUNCIL_RESIDENT);
    sessionStorage.setItem(VIEW_KEY, 'management');
    const app = renderApp(['/']);
    await findNavItems();

    act(() => app.navigate()('/Packages'));
    expect(await screen.findByText(/being migrated/i)).toBeTruthy();
    expect(location()).toBe('/Packages');

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
    stubApi({ ...COUNCIL_RESIDENT, 'POST /api/auth/logout': () => noContent() });
    renderApp(['/']);
    await findNavItems();
    openAccountMenu();
    viewAs('Resident');

    fireEvent.click(screen.getByRole('button', { name: /log out/i }));

    await waitFor(() => expect(location()).toBe('/login'));
    expect(sessionStorage.getItem(VIEW_KEY)).toBeNull();
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

describe('header account menu (criterion 4)', () => {
  const button = () => screen.getByRole('button', { name: /account menu/i });

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
    fireEvent.mouseDown(screen.getByRole('main'));
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
