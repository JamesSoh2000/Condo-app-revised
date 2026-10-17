// @vitest-environment jsdom
/**
 * P2-06b: the building context (one building per tab, in sessionStorage) and the membership, role and
 * feature guards. Each `describe` names the criterion it proves (docs/tickets/P2-06b-…md).
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { components } from '@/api/schema';
import {
  BIRCH,
  MAPLE,
  RESIDENT_ME,
  buildingOut,
  calls,
  json,
  membership,
  noContent,
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

    fireEvent.change(screen.getByLabelText(/building/i), { target: { value: BIRCH.id } });

    await waitFor(() => expect(location()).toBe('/'));
    expect(await findInMain('Birch Court')).toBeTruthy();
    expect(app.queryClient.getQueryCache().findAll({ queryKey: ['b', MAPLE.id] })).toEqual([]);
  });

  it('shows no switcher with one active membership', async () => {
    stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME) });

    renderApp(['/']);

    await findInMain('Maple Tower');
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

  it('hides the page when a background refetch answers 404, and Choose again recovers', async () => {
    await loadedThen('/Packages', () => problem(404, 'building_not_found'));

    expect(await screen.findByRole('heading', { name: /no longer have access/i })).toBeTruthy();
    expect(screen.queryByText(/being migrated/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /choose again/i }));
    await waitFor(() => expect(sessionStorage.getItem(KEY)).toBe(MAPLE.id));
    // /me still lists Maple, so it is selected again and asked again: the same 404, the same screen.
    expect(await screen.findByRole('heading', { name: /no longer have access/i })).toBeTruthy();
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
    // Left by an earlier user of this tab whose session ended without this tab seeing it.
    sessionStorage.setItem(KEY, BIRCH.id);
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
