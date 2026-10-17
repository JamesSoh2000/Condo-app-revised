// @vitest-environment jsdom
/**
 * P2-06b: the building context (one building per tab, in sessionStorage) and the membership, role and
 * feature guards. Each `describe` names the criterion it proves (docs/tickets/P2-06b-…md).
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { components } from '@/api/schema';
import { BuildingProvider, useBuildingContext } from '@/app/BuildingProvider';
import { RequireAuth } from '@/app/guards';
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

const KEY = 'condo.buildingId';
const CEDAR = { id: '01929a4e-0000-7000-8000-00000000c001', name: 'Cedar House', slug: 'cedar' };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
const location = () => screen.getByTestId('location').textContent;
const main = () => screen.getByRole('main');
/** Waits for the shell's main area, then for `text` in it (the header names the building too). */
const findInMain = async (text: string) => within(await screen.findByRole('main')).findByText(text);
const buildingCalls = (fetchMock: ReturnType<typeof stubApi>) =>
  calls(fetchMock).filter((call) => call.includes('/api/buildings'));
const meWith = (...memberships: Me['memberships']): Me => ({ ...RESIDENT_ME, memberships });

/** Resident in Maple (packages, notices, maintenance), security in Birch (packages only). */
const MULTI_ME: Me = {
  user: { ...RESIDENT_ME.user, id: 'multi-user', email: 'multi@example.test', full_name: 'Kim Laurent' },
  memberships: [membership(MAPLE, { roles: ['resident'] }), membership(BIRCH, { roles: ['security'] })],
};
const MULTI_ROUTES: Record<string, Handler> = {
  'GET /api/auth/me': () => json(MULTI_ME),
  [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, ['resident'])),
  [`GET /api/buildings/${BIRCH.id}`]: () => json(buildingOut(BIRCH, ['security'], ['packages'])),
};

async function pick(name: string) {
  fireEvent.click(await screen.findByRole('button', { name }));
}

describe('membership screens, no building calls (criterion 1)', () => {
  it.each([
    ['pending', [membership(MAPLE, { status: 'pending' })], /waiting for approval/i],
    ['suspended', [membership(MAPLE, { status: 'suspended' })], /access is suspended/i],
    ['denied', [membership(MAPLE, { status: 'denied' })], /not approved/i],
    ['no membership', [], /not a member of a building/i],
  ] as const)('shows the %s screen with Log out, and calls no building API', async (_label, memberships, heading) => {
    const fetchMock = stubApi({ 'GET /api/auth/me': () => json(meWith(...memberships)) });

    renderApp(['/Packages']);

    expect(await screen.findByRole('heading', { name: heading })).toBeTruthy();
    openAccountMenu();
    expect(screen.getByRole('button', { name: /log out/i })).toBeTruthy();
    await settle();
    expect(buildingCalls(fetchMock)).toEqual([]);
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('names every building still waiting for approval', async () => {
    stubApi({
      'GET /api/auth/me': () =>
        json(meWith(membership(MAPLE, { status: 'pending' }), membership(BIRCH, { status: 'pending' }))),
    });

    renderApp(['/']);

    await screen.findByRole('heading', { name: /waiting for approval/i });
    expect(main().textContent).toContain('Maple Tower');
    expect(main().textContent).toContain('Birch Court');
  });

  it.each([
    ['pending over suspended and denied', ['denied', 'suspended', 'pending'], /waiting for approval/i],
    ['suspended over denied', ['denied', 'suspended'], /access is suspended/i],
  ] as const)('prefers %s', async (_label, statuses, heading) => {
    const buildings = [MAPLE, BIRCH, CEDAR];
    stubApi({
      'GET /api/auth/me': () => json(meWith(...statuses.map((status, i) => membership(buildings[i], { status })))),
    });

    renderApp(['/']);

    expect(await screen.findByRole('heading', { name: heading })).toBeTruthy();
  });

  it('lets an active membership win over a pending one', async () => {
    stubApi({
      'GET /api/auth/me': () => json(meWith(membership(BIRCH, { status: 'pending' }), membership(MAPLE))),
    });

    renderApp(['/']);

    expect(await findInMain('Maple Tower')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /waiting for approval/i })).toBeNull();
  });
});

describe('default selection (criterion 4)', () => {
  it('selects the only active membership without a picker, and stores it', async () => {
    const fetchMock = stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME) });

    renderApp(['/']);

    expect(await findInMain('Maple Tower')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /choose a building/i })).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBe(MAPLE.id);
    expect(buildingCalls(fetchMock)).toEqual([`GET /api/buildings/${MAPLE.id}`]);
  });

  it('offers only the active memberships and requests nothing building-scoped until one is picked', async () => {
    const fetchMock = stubApi({
      ...MULTI_ROUTES,
      'GET /api/auth/me': () =>
        json({ ...MULTI_ME, memberships: [...MULTI_ME.memberships, membership(CEDAR, { status: 'pending' })] }),
    });

    renderApp(['/']);

    await screen.findByRole('heading', { name: /choose a building/i });
    const options = within(main())
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(options).toEqual(['Birch Court', 'Maple Tower']);
    await settle();
    expect(buildingCalls(fetchMock)).toEqual([]);

    await pick('Maple Tower');

    expect(await findInMain('Maple Tower')).toBeTruthy();
    expect(sessionStorage.getItem(KEY)).toBe(MAPLE.id);
    expect(buildingCalls(fetchMock)).toEqual([`GET /api/buildings/${MAPLE.id}`]);
  });

  it('keeps the page the user opened when they pick their first building', async () => {
    stubApi(MULTI_ROUTES);

    renderApp(['/Maintenance']);
    await pick('Maple Tower');

    expect(await screen.findByText(/being migrated/i)).toBeTruthy();
    expect(location()).toBe('/Maintenance');
  });
});

describe('a stored selection is checked against /me (criterion 5; tenant rows 3 and 6)', () => {
  it.each([
    ['another building', BIRCH.id],
    ['a building where the user is now pending', CEDAR.id],
    ['a value that is not an ID', '../auth/me'],
  ])('discards %s and selects the only active membership', async (_label, stored) => {
    sessionStorage.setItem(KEY, stored);
    const fetchMock = stubApi({
      'GET /api/auth/me': () => json(meWith(membership(MAPLE), membership(CEDAR, { status: 'pending' }))),
    });

    renderApp(['/']);

    expect(await findInMain('Maple Tower')).toBeTruthy();
    expect(sessionStorage.getItem(KEY)).toBe(MAPLE.id);
    expect(buildingCalls(fetchMock)).toEqual([`GET /api/buildings/${MAPLE.id}`]);
  });

  it('removes an unknown stored ID and shows the picker when several memberships are active', async () => {
    sessionStorage.setItem(KEY, CEDAR.id);
    const fetchMock = stubApi(MULTI_ROUTES);

    renderApp(['/']);

    await screen.findByRole('heading', { name: /choose a building/i });
    await waitFor(() => expect(sessionStorage.getItem(KEY)).toBeNull());
    expect(buildingCalls(fetchMock)).toEqual([]);
  });
});

describe('one building per tab (criterion 2)', () => {
  it('restores each tab’s own selection after a reload', async () => {
    // jsdom has one sessionStorage; each "tab" is a snapshot of it, restored before its reload.
    stubApi(MULTI_ROUTES);
    renderApp(['/']);
    await pick('Maple Tower');
    await findInMain('Maple Tower');
    const tab1 = sessionStorage.getItem(KEY);
    cleanup();
    sessionStorage.clear();

    renderApp(['/']);
    await pick('Birch Court');
    await findInMain('Birch Court');
    const tab2 = sessionStorage.getItem(KEY);
    cleanup();
    expect([tab1, tab2]).toEqual([MAPLE.id, BIRCH.id]);

    for (const [stored, name, id] of [
      [tab1, 'Maple Tower', MAPLE.id],
      [tab2, 'Birch Court', BIRCH.id],
    ] as const) {
      sessionStorage.setItem(KEY, stored!);
      const fetchMock = stubApi(MULTI_ROUTES);
      renderApp(['/']);
      expect(await findInMain(name)).toBeTruthy();
      expect(screen.queryByRole('heading', { name: /choose a building/i })).toBeNull();
      expect(buildingCalls(fetchMock)).toEqual([`GET /api/buildings/${id}`]);
      cleanup();
    }
  });
});

describe('switching buildings (criteria 3 and 11)', () => {
  it('aborts A’s request, drops its queries and shows B even when A answers late', async () => {
    let mapleRequest: Request | undefined;
    let answerMaple!: (response: Response) => void;
    stubApi({
      ...MULTI_ROUTES,
      [`GET /api/buildings/${MAPLE.id}`]: (request) => {
        mapleRequest = request;
        return new Promise<Response>((resolve) => (answerMaple = resolve));
      },
    });
    sessionStorage.setItem(KEY, MAPLE.id);
    const app = renderApp(['/']);
    await waitFor(() => expect(mapleRequest).toBeDefined());
    expect(app.queryClient.getQueryCache().findAll({ queryKey: ['b', MAPLE.id] })).toHaveLength(1);

    openAccountMenu();
    fireEvent.change(screen.getByLabelText(/building/i), { target: { value: BIRCH.id } });

    expect(await findInMain('Birch Court')).toBeTruthy();
    expect(mapleRequest!.signal.aborted).toBe(true);
    expect(app.queryClient.getQueryCache().findAll({ queryKey: ['b', MAPLE.id] })).toEqual([]);

    await act(() => Promise.resolve(answerMaple(json(buildingOut(MAPLE, ['resident'])))));
    await settle();
    expect(within(main()).getByText('Birch Court')).toBeTruthy();
    expect(within(main()).queryByText('Maple Tower')).toBeNull();
    expect(app.queryClient.getQueryCache().findAll({ queryKey: ['b', MAPLE.id] })).toEqual([]);
    expect(sessionStorage.getItem(KEY)).toBe(BIRCH.id);
  });

  it('goes home on a switch, dropping the old building’s cached data', async () => {
    stubApi(MULTI_ROUTES);
    sessionStorage.setItem(KEY, MAPLE.id);
    const app = renderApp(['/Maintenance']);
    await screen.findByText(/being migrated/i);
    app.queryClient.setQueryData(['b', MAPLE.id, 'packages'], ['a Maple package']);

    openAccountMenu();
    fireEvent.change(screen.getByLabelText(/building/i), { target: { value: BIRCH.id } });

    await waitFor(() => expect(location()).toBe('/'));
    expect(await findInMain('Birch Court')).toBeTruthy();
    expect(app.queryClient.getQueryCache().findAll({ queryKey: ['b', MAPLE.id] })).toEqual([]);
  });

  it('shows no switcher with one active membership', async () => {
    stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME) });

    renderApp(['/']);

    await findInMain('Maple Tower');
    openAccountMenu();
    expect(screen.queryByLabelText(/building/i)).toBeNull();
    expect(screen.getByRole('banner').textContent).toContain('Maple Tower');
  });

  it('passes React Query’s signal to the building request, under a [b, id] key', async () => {
    let request: Request | undefined;
    stubApi({
      'GET /api/auth/me': () => json(RESIDENT_ME),
      [`GET /api/buildings/${MAPLE.id}`]: (r) => {
        request = r;
        return new Promise<Response>(() => {});
      },
    });

    const app = renderApp(['/']);
    await waitFor(() => expect(request).toBeDefined());

    expect(request!.signal.aborted).toBe(false);
    await act(() => app.queryClient.cancelQueries({ queryKey: ['b', MAPLE.id, 'building'] }));
    expect(request!.signal.aborted).toBe(true);
  });
});

describe('role guard (criterion 6; tenant rows 1 and 4)', () => {
  it('sends a resident on a security page to /403', async () => {
    stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME) });

    renderApp(['/', '/SecurityPackages']);

    await waitFor(() => expect(location()).toBe('/403'));
    expect(screen.getByRole('heading', { name: /can’t open this page/i })).toBeTruthy();
    expect(screen.queryByText(/being migrated/i)).toBeNull();
  });

  it('renders the page for a role that may open it', async () => {
    stubApi({
      'GET /api/auth/me': () => json(meWith(membership(MAPLE, { roles: ['security'] }))),
      [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, ['security'])),
    });

    renderApp(['/SecurityPackages']);

    expect(await screen.findByText(/being migrated/i)).toBeTruthy();
    expect(location()).toBe('/SecurityPackages');
  });

  it('does not count a role the user holds in another building', async () => {
    sessionStorage.setItem(KEY, MAPLE.id);
    stubApi(MULTI_ROUTES);

    renderApp(['/SecurityPackages']);

    await waitFor(() => expect(location()).toBe('/403'));
  });

  it('takes roles from the building endpoint, not from /me', async () => {
    // /me still says security; the server's building answer (fresher) says resident only.
    stubApi({
      'GET /api/auth/me': () => json(meWith(membership(MAPLE, { roles: ['security'] }))),
      [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, ['resident'])),
    });

    renderApp(['/SecurityPackages']);

    await waitFor(() => expect(location()).toBe('/403'));
  });
});

describe('feature guard (criterion 7)', () => {
  it('sends the user to /403 when the building has the feature off', async () => {
    sessionStorage.setItem(KEY, BIRCH.id);
    stubApi(MULTI_ROUTES);

    renderApp(['/ManagementMaintenance']);

    await waitFor(() => expect(location()).toBe('/403'));
  });

  it('renders the page in a building with the feature on', async () => {
    sessionStorage.setItem(KEY, MAPLE.id);
    stubApi(MULTI_ROUTES);

    renderApp(['/Maintenance']);

    expect(await screen.findByText(/being migrated/i)).toBeTruthy();
    expect(location()).toBe('/Maintenance');
  });
});

describe('lost access mid-session (criterion 8; tenant rows 2 and 3)', () => {
  it('shows the lost-access screen on a 404, and Choose again reloads /me', async () => {
    let me: Me = RESIDENT_ME;
    const fetchMock = stubApi({
      'GET /api/auth/me': () => json(me),
      [`GET /api/buildings/${MAPLE.id}`]: () => problem(404, 'building_not_found'),
    });

    renderApp(['/Packages']);

    expect(await screen.findByRole('heading', { name: /no longer have access/i })).toBeTruthy();
    expect(screen.queryByText(/being migrated/i)).toBeNull();
    const meCalls = calls(fetchMock).filter((c) => c === 'GET /api/auth/me').length;

    me = meWith();
    fireEvent.click(screen.getByRole('button', { name: /choose again/i }));

    expect(await screen.findByRole('heading', { name: /not a member of a building/i })).toBeTruthy();
    expect(calls(fetchMock).filter((c) => c === 'GET /api/auth/me').length).toBe(meCalls + 1);
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('goes to the login page when the building call answers 401', async () => {
    let signedIn = true;
    stubApi({
      'GET /api/auth/me': () => (signedIn ? json(RESIDENT_ME) : problem(401, 'not_authenticated')),
      [`GET /api/buildings/${MAPLE.id}`]: () => {
        signedIn = false;
        return problem(401, 'not_authenticated');
      },
    });

    renderApp(['/Packages']);

    await waitFor(() => expect(location()).toBe('/login?next=%2FPackages'));
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('offers Try again on a server error, not the lost-access screen', async () => {
    let fail = true;
    stubApi({
      'GET /api/auth/me': () => json(RESIDENT_ME),
      [`GET /api/buildings/${MAPLE.id}`]: () =>
        fail ? problem(500, 'internal_error') : json(buildingOut(MAPLE, ['resident'])),
    });

    renderApp(['/']);

    const retry = await screen.findByRole('button', { name: /try again/i });
    expect(screen.queryByRole('heading', { name: /no longer have access/i })).toBeNull();
    fail = false;
    fireEvent.click(retry);
    expect(await findInMain('Maple Tower')).toBeTruthy();
  });
});

describe('lost access after the building loaded (review round 1, Claude H1 and Codex High)', () => {
  /** Signed in on `path` with Maple loaded; `answer` then decides every later building request. */
  async function loadedThen(path: string, answer: () => Response) {
    let later: (() => Response) | null = null;
    const fetchMock = stubApi({
      'GET /api/auth/me': () => json(RESIDENT_ME),
      [`GET /api/buildings/${MAPLE.id}`]: () => (later ? later() : json(buildingOut(MAPLE, ['resident']))),
    });
    const app = renderApp([path]);
    await screen.findByText(/being migrated|coming soon/i);
    later = answer;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id] }));
    return { app, fetchMock };
  }

  it('hides the page when a background refetch answers 404', async () => {
    await loadedThen('/Packages', () => problem(404, 'building_not_found'));

    expect(await screen.findByRole('heading', { name: /no longer have access/i })).toBeTruthy();
    expect(screen.queryByText(/being migrated/i)).toBeNull();
  });

  // Review round 2 (Claude M1): with /me unchanged the click used to change no state, so nothing was asked.
  it.each([
    ['on the first load', false],
    ['after the building loaded', true],
  ])('asks the building again on Choose again with /me unchanged (404 %s)', async (_label, loadedFirst) => {
    let answer = loadedFirst ? 'ok' : 'gone';
    const fetchMock = stubApi({
      'GET /api/auth/me': () => json(RESIDENT_ME),
      [`GET /api/buildings/${MAPLE.id}`]: () =>
        answer === 'ok' ? json(buildingOut(MAPLE, ['resident'])) : problem(404, 'building_not_found'),
    });
    const app = renderApp(['/Packages']);
    if (loadedFirst) {
      await screen.findByText(/being migrated/i);
      answer = 'gone';
      await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id] }));
    }
    await screen.findByRole('heading', { name: /no longer have access/i });
    const asked = buildingCalls(fetchMock).length;

    // Still a 404: asked again, the same screen (no loop: one request per click).
    fireEvent.click(screen.getByRole('button', { name: /choose again/i }));
    await waitFor(() => expect(buildingCalls(fetchMock)).toHaveLength(asked + 1));
    expect(await screen.findByRole('heading', { name: /no longer have access/i })).toBeTruthy();
    await settle();
    expect(buildingCalls(fetchMock)).toHaveLength(asked + 1);

    // Access back (a transient 404): the next click shows the page.
    answer = 'ok';
    fireEvent.click(screen.getByRole('button', { name: /choose again/i }));
    expect(await screen.findByText(/being migrated/i)).toBeTruthy();
    expect(sessionStorage.getItem(KEY)).toBe(MAPLE.id);
  });

  it('keeps showing the page when a background refetch fails with a server error', async () => {
    const { app } = await loadedThen('/Packages', () => problem(500, 'internal_error'));
    // The refetch really failed (after its retries), with the old data kept.
    await waitFor(() => expect(app.queryClient.getQueryState(['b', MAPLE.id, 'building'])?.status).toBe('error'));
    await settle();

    expect(screen.getByText(/being migrated/i)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /no longer have access/i })).toBeNull();
  });

  it('goes to the login page when a background refetch answers 401', async () => {
    await loadedThen('/Packages', () => problem(401, 'not_authenticated'));

    await waitFor(() => expect(location()).toMatch(/^\/login/));
    expect(screen.queryByText(/being migrated/i)).toBeNull();
  });

  it('shows the status screen when a /me refetch says the membership is no longer active', async () => {
    let me: Me = RESIDENT_ME;
    const fetchMock = stubApi({ 'GET /api/auth/me': () => json(me) });
    const app = renderApp(['/Packages']);
    await screen.findByText(/being migrated/i);
    const before = buildingCalls(fetchMock).length;

    me = meWith(membership(MAPLE, { status: 'suspended' }));
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['me'] }));

    expect(await screen.findByRole('heading', { name: /access is suspended/i })).toBeTruthy();
    expect(screen.queryByText(/being migrated/i)).toBeNull();
    await settle();
    expect(buildingCalls(fetchMock)).toHaveLength(before);
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });
});

describe('a /me refresh changes the selection (review round 2, Codex M1)', () => {
  it('removes the old building’s queries when /me leaves another building as the only active one', async () => {
    let me = meWith(membership(MAPLE), membership(BIRCH));
    stubApi({
      ...MULTI_ROUTES,
      'GET /api/auth/me': () => json(me),
      [`GET /api/buildings/${BIRCH.id}`]: () => json(buildingOut(BIRCH, ['resident'])),
    });
    sessionStorage.setItem(KEY, MAPLE.id);
    const app = renderApp(['/']);
    await findInMain('Maple Tower');
    app.queryClient.setQueryData(['b', MAPLE.id, 'packages'], ['a Maple package']);

    me = meWith(membership(MAPLE, { status: 'suspended' }), membership(BIRCH));
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['me'] }));

    expect(await findInMain('Birch Court')).toBeTruthy();
    expect(sessionStorage.getItem(KEY)).toBe(BIRCH.id);
    expect(app.queryClient.getQueryCache().findAll({ queryKey: ['b', MAPLE.id] })).toEqual([]);
  });

  it('removes the old building’s queries when /me leaves no active membership', async () => {
    let me: Me = RESIDENT_ME;
    stubApi({ 'GET /api/auth/me': () => json(me) });
    const app = renderApp(['/']);
    await findInMain('Maple Tower');
    app.queryClient.setQueryData(['b', MAPLE.id, 'packages'], ['a Maple package']);

    me = meWith(membership(MAPLE, { status: 'suspended' }));
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['me'] }));

    await screen.findByRole('heading', { name: /access is suspended/i });
    expect(app.queryClient.getQueryCache().findAll({ queryKey: ['b', MAPLE.id] })).toEqual([]);
  });
});

describe('another user in /me (review round 1, Claude M1)', () => {
  it('drops the previous user’s building data and selection when /me answers for someone else', async () => {
    // Tab 1 works as Alex in Maple; another tab logs in as Kim (one cookie jar), so /me now answers Kim.
    let me: Me = RESIDENT_ME;
    let mapleCalls = 0;
    stubApi({
      ...MULTI_ROUTES,
      'GET /api/auth/me': () => json(me),
      [`GET /api/buildings/${MAPLE.id}`]: () => {
        mapleCalls += 1;
        return json(buildingOut(MAPLE, mapleCalls === 1 ? ['resident', 'security'] : ['resident']));
      },
    });
    const app = renderApp(['/SecurityPackages']);
    await screen.findByText(/being migrated/i);
    expect(sessionStorage.getItem(KEY)).toBe(MAPLE.id);

    me = MULTI_ME;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['me'] }));

    // Kim has two active buildings: the picker, not Alex's Maple, and nothing of Alex's building cached.
    expect(await screen.findByRole('heading', { name: /choose a building/i })).toBeTruthy();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(app.queryClient.getQueryCache().findAll({ queryKey: ['b'] })).toEqual([]);
    expect(screen.getByRole('banner').textContent).toContain('Kim Laurent');
  });
});

describe('no selection outlives the user (criterion 9)', () => {
  it('clears the stored building on logout', async () => {
    let signedIn = true;
    stubApi({
      'GET /api/auth/me': () => (signedIn ? json(RESIDENT_ME) : problem(401, 'not_authenticated')),
      'POST /api/auth/logout': () => {
        signedIn = false;
        return noContent();
      },
    });
    renderApp(['/']);
    await findInMain('Maple Tower');
    expect(sessionStorage.getItem(KEY)).toBe(MAPLE.id);

    openAccountMenu();
    fireEvent.click(screen.getByRole('button', { name: /log out/i }));

    await waitFor(() => expect(location()).toBe('/login'));
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('clears the stored building when a 401 resets the session', async () => {
    let signedIn = true;
    stubApi({
      'GET /api/auth/me': () => (signedIn ? json(RESIDENT_ME) : problem(401, 'not_authenticated')),
    });
    const rendered = renderApp(['/']);
    await findInMain('Maple Tower');

    signedIn = false;
    await act(() => rendered.queryClient.invalidateQueries({ queryKey: ['me'] }));

    await waitFor(() => expect(location()).toMatch(/^\/login/));
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('does not hand the previous user’s building to the next user who logs in', async () => {
    let signedIn = false;
    const fetchMock = stubApi({
      ...MULTI_ROUTES,
      'GET /api/auth/me': () => (signedIn ? json(MULTI_ME) : problem(401, 'not_authenticated')),
      'POST /api/auth/login': () => {
        signedIn = true;
        return noContent();
      },
    });
    renderApp(['/login']);
    await screen.findByRole('heading', { name: /sign in/i });
    // The login page's own session check (P2-06c 7d) answers 401 and clears the tab; set the leftover after it.
    await waitFor(() => expect(calls(fetchMock)).toContain('GET /api/auth/me'));
    await settle();
    // Left by an earlier user of this tab whose session ended without this tab seeing it.
    sessionStorage.setItem(KEY, BIRCH.id);

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'multi@example.test' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'DevPassword!2026' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('heading', { name: /choose a building/i })).toBeTruthy();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(buildingCalls(fetchMock)).toEqual([]);
  });
});

describe('the 403 page', () => {
  it('renders inside the shell for a signed-in user, with a way home', async () => {
    stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME) });

    renderApp(['/403']);

    expect(await screen.findByRole('heading', { name: /can’t open this page/i })).toBeTruthy();
    expect(screen.getByRole('banner').textContent).toContain('Alex Chen');
    expect(screen.getByRole('link', { name: /home page/i }).getAttribute('href')).toBe('/');
  });
});

describe('a default selection is the tab’s choice (P2-06c criterion 5; P2-06b review round 3, Codex M)', () => {
  it('keeps the only active building when /me then adds another (5a)', async () => {
    let me = meWith(membership(MAPLE));
    stubApi({ ...MULTI_ROUTES, 'GET /api/auth/me': () => json(me) });
    const app = renderApp(['/']);
    expect(await findInMain('Maple Tower')).toBeTruthy();
    await settle();

    me = meWith(membership(MAPLE), membership(BIRCH, { roles: ['security'] }));
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['me'] }));
    await settle();

    expect(screen.queryByRole('heading', { name: /choose a building/i })).toBeNull();
    expect(within(main()).getByText('Maple Tower')).toBeTruthy();
    expect(sessionStorage.getItem(KEY)).toBe(MAPLE.id);
  });

  it('stays in the default building when the stored one comes back (5b)', async () => {
    sessionStorage.setItem(KEY, MAPLE.id);
    let me = meWith(membership(MAPLE, { status: 'suspended' }), membership(BIRCH, { roles: ['security'] }));
    stubApi({ ...MULTI_ROUTES, 'GET /api/auth/me': () => json(me) });
    const app = renderApp(['/']);
    expect(await findInMain('Birch Court')).toBeTruthy();
    await settle();
    expect(sessionStorage.getItem(KEY)).toBe(BIRCH.id);

    me = meWith(membership(MAPLE), membership(BIRCH, { roles: ['security'] }));
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['me'] }));
    await settle();

    expect(within(main()).getByText('Birch Court')).toBeTruthy();
    expect(within(main()).queryByText('Maple Tower')).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBe(BIRCH.id);
  });

  it('forgets a stored choice that went invalid, as a reload would (5c)', async () => {
    sessionStorage.setItem(KEY, MAPLE.id);
    let me = meWith(membership(MAPLE, { status: 'suspended' }), membership(BIRCH), membership(CEDAR));
    stubApi({ ...MULTI_ROUTES, 'GET /api/auth/me': () => json(me) });
    const app = renderApp(['/']);
    expect(await screen.findByRole('heading', { name: /choose a building/i })).toBeTruthy();
    await settle();
    expect(sessionStorage.getItem(KEY)).toBeNull();

    me = meWith(membership(MAPLE), membership(BIRCH), membership(CEDAR));
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['me'] }));
    await settle();

    expect(screen.getByRole('heading', { name: /choose a building/i })).toBeTruthy();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });
});

describe('regression tests carried from P2-06b review round 3 (P2-06c criterion 6)', () => {
  it('shows the picker when /me answers for user B after user A picked Maple (the key remount)', async () => {
    let me: Me = MULTI_ME;
    stubApi({ ...MULTI_ROUTES, 'GET /api/auth/me': () => json(me) });
    const app = renderApp(['/']);
    await pick('Maple Tower');
    expect(await findInMain('Maple Tower')).toBeTruthy();
    expect(sessionStorage.getItem(KEY)).toBe(MAPLE.id);

    me = {
      user: { ...MULTI_ME.user, id: 'user-b', email: 'b@example.test', full_name: 'Bea B' },
      memberships: [membership(MAPLE), membership(BIRCH)],
    };
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['me'] }));

    expect(await screen.findByRole('heading', { name: /choose a building/i })).toBeTruthy();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('shows only the loading screen on a building 401 when nothing redirects (BuildingLoaded’s own branch)', async () => {
    stubApi({
      'GET /api/auth/me': () => json(RESIDENT_ME),
      [`GET /api/buildings/${MAPLE.id}`]: () => problem(401, 'not_authenticated'),
    });
    // No AuthProvider: its 401 redirect would hide what BuildingLoaded renders by itself.
    render(
      <QueryClientProvider client={createQueryClient({ retryDelay: 0 })}>
        <MemoryRouter initialEntries={['/Packages']}>
          <AppRoutes />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getAllByRole('status').length).toBeGreaterThan(0));
    await settle();
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.queryByText(/being migrated/i)).toBeNull();
    expect(screen.queryByRole('heading', { name: /something went wrong/i })).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/loading/i);
  });

  it('ignores select() with an inactive building: no storage write, no navigation', async () => {
    stubApi({
      ...MULTI_ROUTES,
      'GET /api/auth/me': () => json({ ...MULTI_ME, memberships: [...MULTI_ME.memberships, membership(CEDAR, { status: 'suspended' })] }),
    });
    sessionStorage.setItem(KEY, MAPLE.id);
    let context: ReturnType<typeof useBuildingContext> | undefined;
    function Probe() {
      context = useBuildingContext();
      return null;
    }
    let path = '';
    function Where() {
      path = useLocation().pathname;
      return null;
    }
    render(
      <QueryClientProvider client={createQueryClient({ retryDelay: 0 })}>
        <MemoryRouter initialEntries={['/Maintenance']}>
          <RequireAuth>
            <BuildingProvider>
              <Probe />
            </BuildingProvider>
          </RequireAuth>
          <Where />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(context?.buildingId).toBe(MAPLE.id));
    const writes = vi.spyOn(Storage.prototype, 'setItem');

    act(() => context!.select(CEDAR.id));
    await settle();

    expect(context!.buildingId).toBe(MAPLE.id);
    expect(sessionStorage.getItem(KEY)).toBe(MAPLE.id);
    expect(writes).not.toHaveBeenCalled();
    expect(path).toBe('/Maintenance');
  });
});
