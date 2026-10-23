// @vitest-environment jsdom
/**
 * P5-03b: the package desk page `/security/packages` and its "Waiting" list: the rows, the unit search and carrier
 * filter, the list's states, freshness, the route and its access. Each `describe` names the criteria it proves
 * (docs/tickets/P5-03b-package-desk-page-and-waiting-list.md).
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { components } from '@/api/schema';
import { packageAge } from '@/features/packages/time';
import {
  BIRCH,
  MAPLE,
  RESIDENT_ME,
  buildingOut,
  calls,
  json,
  membership,
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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

type Package = components['schemas']['PackageOut'];
type Unit = components['schemas']['UnitOut'];
type Role = components['schemas']['Role'];

const PAGE = '/security/packages';
const list = (building = MAPLE) => `GET /api/buildings/${building.id}/packages`;
const units = `GET /api/buildings/${MAPLE.id}/units`;
const HOUR = 3_600_000;

function unit(n: number, label: string, tower: string | null = null): Unit {
  return { id: `01929a4e-0000-7000-8000-0000000c000${n}`, tower, label, floor: 1, is_active: true, current_occupant_count: 1 };
}
const U101 = unit(1, '101', 'A');
const U102 = unit(2, '102');

function pkg(n: number, fields: Partial<Package> = {}): Package {
  return {
    id: `01929a4e-0000-7000-8000-0000000e000${n}`,
    unit_id: U101.id,
    recipient_membership_id: `01929a4e-0000-7000-8000-0000000d000${n}`,
    carrier: 'UPS',
    description: null,
    tracking_last4: null,
    photo_file_id: null,
    status: 'received',
    received_at: new Date(Date.now() - 2 * HOUR - 60_000).toISOString(),
    received_by_membership_id: '01929a4e-0000-7000-8000-0000000d0009',
    picked_up_at: null,
    returned_at: null,
    unit_tower: 'A',
    unit_label: '101',
    recipient_name: 'Robin Park',
    ...fields,
  };
}

const page = (items: Package[], next_cursor: string | null = null) => json({ items, next_cursor });

function desk(routes: Record<string, Handler> = {}, roles: Role[] = ['security'], features?: components['schemas']['Feature'][]) {
  return {
    'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles })] }),
    [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, roles, features)),
    [list()]: () => page([pkg(1)]),
    [units]: () => json({ items: [U101, U102], next_cursor: null }),
    ...routes,
  };
}

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
const waiting = () => screen.findByRole('list', { name: 'Waiting packages' });
const rows = () => within(screen.getByRole('list', { name: 'Waiting packages' })).getAllByRole('listitem');
const listQueries = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls
    .map(([request]) => new URL(request.url))
    .filter((url) => url.pathname === `/api/buildings/${MAPLE.id}/packages`)
    .map((url) => Object.fromEntries(url.searchParams));
const location = () => screen.getByTestId('location').textContent;

describe('the route and its access (criterion 2; tenant rows 1, 2 and 4)', () => {
  it.each([['security'], ['property_management']] as const)('opens /security/packages for %s', async (role) => {
    stubApi(desk({}, [role]));
    renderApp([PAGE]);

    expect(await screen.findByRole('heading', { name: 'Package desk', level: 1 })).toBeTruthy();
    await waiting();
    expect(location()).toBe(PAGE);
  });

  it('sends a resident to /403', async () => {
    const fetchMock = stubApi(desk({}, ['resident']));
    renderApp([PAGE]);

    await waitFor(() => expect(location()).toBe('/403'));
    expect(calls(fetchMock)).not.toContain(list());
  });

  it('sends the user to /403 when the building has packages off', async () => {
    const fetchMock = stubApi(desk({}, ['security'], ['notices']));
    renderApp([PAGE]);

    await waitFor(() => expect(location()).toBe('/403'));
    expect(calls(fetchMock)).not.toContain(list());
  });

  it('sends a signed-out user to the login page with the way back', async () => {
    stubApi({ 'GET /api/auth/me': () => problem(401, 'not_authenticated') });
    renderApp([PAGE]);

    await waitFor(() => expect(location()).toBe(`/login?next=${encodeURIComponent(PAGE)}`));
  });

  it('redirects the legacy /SecurityPackages path, keeping its query', async () => {
    stubApi(desk());
    renderApp(['/SecurityPackages?from=bookmark']);

    await waiting();
    expect(location()).toBe(`${PAGE}?from=bookmark`);
  });

  it('still sends a resident on the legacy path to /403', async () => {
    stubApi(desk({}, ['resident']));
    renderApp(['/SecurityPackages']);

    await waitFor(() => expect(location()).toBe('/403'));
  });

  it('links "Package log" in the navigation to the page', async () => {
    stubApi(desk());
    renderApp(['/']);

    const link = await screen.findByRole('link', { name: 'Package log' });
    expect(link.getAttribute('href')).toBe(PAGE);
  });
});

describe('the waiting list (criterion 3)', () => {
  it('asks for received packages and shows each with photo, unit, recipient, carrier and age, in the API order', async () => {
    const fetchMock = stubApi(
      desk({
        [list()]: () =>
          page([
            pkg(1, { photo_file_id: '01929a4e-0000-7000-8000-0000000f0001', description: 'Small box', carrier: 'Amazon' }),
            pkg(2, { unit_tower: null, unit_label: '102', unit_id: U102.id, recipient_name: 'Sam Lee', received_at: new Date(Date.now() - 3 * 24 * HOUR - 60_000).toISOString() }),
          ]),
        [`GET /api/buildings/${MAPLE.id}/files/01929a4e-0000-7000-8000-0000000f0001/download-url`]: () =>
          json({ url: 'http://s3.test/photo.jpg', expires_at: new Date(Date.now() + HOUR).toISOString() }),
      }),
    );
    renderApp([PAGE]);

    await waiting();
    expect(listQueries(fetchMock)[0]).toEqual({ status: 'received' });
    const [first, second] = rows();
    expect(within(first).getByRole('heading', { name: 'Unit A-101' })).toBeTruthy();
    expect(first.textContent).toContain('Robin Park');
    expect(first.textContent).toContain('Amazon · Small box');
    expect(first.textContent).toContain('2 h ago');
    expect((await within(first).findByRole('img', { name: 'Package photo for unit A-101' })).getAttribute('src')).toBe('http://s3.test/photo.jpg');
    expect(within(second).getByRole('heading', { name: 'Unit 102' })).toBeTruthy();
    expect(second.textContent).toContain('Sam Lee');
    expect(second.textContent).toContain('UPS');
    expect(second.textContent).toContain('3 d ago');
  });

  it('shows "Anyone in the unit" for a package addressed to the unit', async () => {
    stubApi(desk({ [list()]: () => page([pkg(1, { recipient_membership_id: null, recipient_name: null })]) }));
    renderApp([PAGE]);

    await waiting();
    expect(rows()[0].textContent).toContain('Anyone in the unit');
  });

  it('shows a "No photo" box for a package without a photo, and asks for no download URL', async () => {
    const fetchMock = stubApi(desk());
    renderApp([PAGE]);

    await waiting();
    expect(within(rows()[0]).getByText('No photo')).toBeTruthy();
    expect(calls(fetchMock).some((c) => c.includes('/files/'))).toBe(false);
  });

  it.each([
    [0, 'just now'],
    [59_999, 'just now'],
    [60_000, '1 min ago'],
    [HOUR - 1, '59 min ago'],
    [HOUR, '1 h ago'],
    [24 * HOUR - 1, '23 h ago'],
    [24 * HOUR, '1 d ago'],
    [-5 * 60_000, 'just now'],
  ])('reads an age of %i ms as "%s"', (ms, text) => {
    const now = Date.parse('2026-10-23T12:00:00Z');
    expect(packageAge(new Date(now - ms).toISOString(), now)).toBe(text);
  });
});

describe('building time (criterion 4)', () => {
  it('formats the received time in the building’s timezone and locale, not the device’s', async () => {
    stubApi(
      desk({
        [`GET /api/buildings/${MAPLE.id}`]: () => json({ ...buildingOut(MAPLE, ['security']), timezone: 'Asia/Tokyo', locale: 'en' }),
        [list()]: () => page([pkg(1, { received_at: '2026-10-23T23:30:00Z' })]),
      }),
    );
    renderApp([PAGE]);

    await waiting();
    const time = within(rows()[0]).getByText(/Oct 24, 2026/);
    expect(time.textContent).toContain('8:30');
    expect(time.closest('time')?.getAttribute('datetime')).toBe('2026-10-23T23:30:00Z');
  });

  it('moves the age on while the page stays open, without asking again', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(Date.parse('2026-10-23T12:00:00Z'));
    const fetchMock = stubApi(desk({ [list()]: () => page([pkg(1, { received_at: '2026-10-23T11:58:30Z' })]) }));
    renderApp([PAGE]);

    await waiting();
    expect(rows()[0].textContent).toContain('1 min ago');
    const asked = listQueries(fetchMock).length;

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(rows()[0].textContent).toContain('2 min ago');
    expect(listQueries(fetchMock).length).toBe(asked);
  });
});

describe('search by unit (criterion 5)', () => {
  it('asks the list again with the chosen unit, and "All units" clears it', async () => {
    const fetchMock = stubApi(desk());
    renderApp([PAGE]);
    await waiting();

    fireEvent.change(screen.getByLabelText('Unit number'), { target: { value: '10' } });
    fireEvent.click(await screen.findByRole('radio', { name: 'A-101' }));

    await waitFor(() => expect(listQueries(fetchMock).at(-1)).toEqual({ status: 'received', unit_id: U101.id }));
    fireEvent.click(screen.getByRole('button', { name: 'All units' }));
    await waitFor(() => expect(listQueries(fetchMock).at(-1)).toEqual({ status: 'received' }));
    expect((screen.getByLabelText('Unit number') as HTMLInputElement).value).toBe('');
  });

  it('searches the building’s active units by the typed text', async () => {
    const fetchMock = stubApi(desk());
    renderApp([PAGE]);
    await waiting();

    fireEvent.change(screen.getByLabelText('Unit number'), { target: { value: '10' } });
    await screen.findByRole('radio', { name: 'A-101' });

    await waitFor(() => {
      const searched = fetchMock.mock.calls.map(([request]) => new URL(request.url)).filter((url) => url.pathname.endsWith('/units'));
      expect(Object.fromEntries(searched.at(-1)!.searchParams)).toEqual({ active: 'true', search: '10' });
    });
  });

  it('drops the chosen unit when a new search is typed', async () => {
    const fetchMock = stubApi(desk());
    renderApp([PAGE]);
    await waiting();
    fireEvent.click(await screen.findByRole('radio', { name: 'A-101' }));
    await waitFor(() => expect(listQueries(fetchMock).at(-1)).toEqual({ status: 'received', unit_id: U101.id }));

    fireEvent.change(screen.getByLabelText('Unit number'), { target: { value: '2' } });

    await waitFor(() => expect(listQueries(fetchMock).at(-1)).toEqual({ status: 'received' }));
  });

  it('refuses control characters without asking for units', async () => {
    const fetchMock = stubApi(desk());
    renderApp([PAGE]);
    await waiting();
    await settle();
    const before = calls(fetchMock).filter((c) => c === units).length;

    fireEvent.change(screen.getByLabelText('Unit number'), { target: { value: '1\t' } });
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 400)));

    expect(screen.getByText('Search with visible characters only.')).toBeTruthy();
    expect(calls(fetchMock).filter((c) => c === units).length).toBe(before);
  });
});

describe('filter by carrier (criterion 6)', () => {
  it('offers the common carriers and asks with the chosen one', async () => {
    const fetchMock = stubApi(desk());
    renderApp([PAGE]);
    await waiting();

    const select = screen.getByLabelText('Carrier') as HTMLSelectElement;
    expect([...select.options].map((option) => option.text)).toEqual(['All carriers', 'Amazon', 'Canada Post', 'DHL', 'FedEx', 'Purolator', 'UPS']);
    fireEvent.change(select, { target: { value: 'Canada Post' } });

    await waitFor(() => expect(listQueries(fetchMock).at(-1)).toEqual({ status: 'received', carrier: 'Canada Post' }));
  });

  it('combines the carrier with the unit', async () => {
    const fetchMock = stubApi(desk());
    renderApp([PAGE]);
    await waiting();

    fireEvent.change(screen.getByLabelText('Carrier'), { target: { value: 'FedEx' } });
    fireEvent.click(await screen.findByRole('radio', { name: '102' }));

    await waitFor(() => expect(listQueries(fetchMock).at(-1)).toEqual({ status: 'received', carrier: 'FedEx', unit_id: U102.id }));
  });

  it('starts a filter combination seen before from its first page', async () => {
    const fetchMock = stubApi(
      desk({
        [list()]: (request) => {
          const url = new URL(request.url);
          if (url.searchParams.get('cursor')) return page([pkg(2)]);
          return page([pkg(1)], url.searchParams.get('carrier') ? null : 'next');
        },
      }),
    );
    renderApp([PAGE]);
    await waiting();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(rows()).toHaveLength(2));

    const select = screen.getByLabelText('Carrier');
    fireEvent.change(select, { target: { value: 'UPS' } });
    await waitFor(() => expect(listQueries(fetchMock).at(-1)).toEqual({ status: 'received', carrier: 'UPS' }));
    const before = listQueries(fetchMock).length;
    fireEvent.change(select, { target: { value: '' } });

    await waitFor(() => expect(rows()).toHaveLength(1));
    await settle();
    expect(listQueries(fetchMock).slice(before)).toEqual([{ status: 'received' }]);
  });
});

describe('the list’s states (criterion 7)', () => {
  it('shows loading, then the rows', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    stubApi(desk({ [list()]: () => gate.then(() => page([pkg(1)])) }));
    renderApp([PAGE]);

    expect(await screen.findByText('Loading packages…')).toBeTruthy();
    release();
    await waiting();
    expect(screen.queryByText('Loading packages…')).toBeNull();
  });

  it('says nothing is waiting when the list is empty without filters', async () => {
    stubApi(desk({ [list()]: () => page([]) }));
    renderApp([PAGE]);

    expect(await screen.findByText('No packages are waiting.')).toBeTruthy();
  });

  it('says nothing matches when the list is empty with a filter', async () => {
    stubApi(desk({ [list()]: (request) => page(new URL(request.url).searchParams.get('carrier') ? [] : [pkg(1)]) }));
    renderApp([PAGE]);
    await waiting();

    fireEvent.change(screen.getByLabelText('Carrier'), { target: { value: 'DHL' } });

    expect(await screen.findByText('No waiting packages match.')).toBeTruthy();
    expect(screen.queryByText('No packages are waiting.')).toBeNull();
  });

  it('shows a failed first load with Try again, which asks again', async () => {
    let fail = true;
    stubApi(desk({ [list()]: () => (fail ? problem(500, 'internal_error') : page([pkg(1)])) }));
    renderApp([PAGE]);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load the packages.');
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));

    await waiting();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the rows when a refresh fails', async () => {
    let fail = false;
    stubApi(desk({ [list()]: () => (fail ? problem(500, 'internal_error') : page([pkg(1)])) }));
    renderApp([PAGE]);
    await waiting();

    fail = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Could not refresh the packages.');
    expect(rows()).toHaveLength(1);
  });

  it('shows the rate-limit message on a 429', async () => {
    stubApi(desk({ [list()]: () => problem(429, 'rate_limited', { 'Retry-After': '30' }) }));
    renderApp([PAGE]);

    expect((await screen.findByRole('alert')).textContent).toContain('Too many requests. Try again in 30 seconds.');
  });

  it('shows more with the next cursor, and keeps the rows when the next page fails', async () => {
    let failNext = false;
    const fetchMock = stubApi(
      desk({
        [list()]: (request) => {
          const cursor = new URL(request.url).searchParams.get('cursor');
          if (!cursor) return page([pkg(1)], 'c1');
          if (failNext) return problem(500, 'internal_error');
          return page([pkg(2)], 'c2');
        },
      }),
    );
    renderApp([PAGE]);
    await waiting();

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(listQueries(fetchMock).at(-1)).toEqual({ status: 'received', cursor: 'c1' });

    failNext = true;
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Could not load more packages.');
    expect(rows()).toHaveLength(2);
  });

  it('wraps long names, descriptions and carriers instead of widening the row', async () => {
    stubApi(desk({ [list()]: () => page([pkg(1, { recipient_name: 'N'.repeat(120), description: 'D'.repeat(200) })]) }));
    renderApp([PAGE]);
    await waiting();

    expect(rows()[0].className).toContain('[overflow-wrap:anywhere]');
  });
});

describe('freshness (criterion 8; ADR-0012)', () => {
  it('asks again when the page mounts again, and on Refresh', async () => {
    const fetchMock = stubApi(desk());
    const app = renderApp(['/', PAGE]);
    await waiting();
    expect(listQueries(fetchMock)).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(listQueries(fetchMock)).toHaveLength(2));

    act(() => app.navigate()(-1));
    await screen.findByRole('heading', { name: /home/i });
    act(() => app.navigate()(1));
    await waiting();
    await waitFor(() => expect(listQueries(fetchMock)).toHaveLength(3));
  });

  it('asks again when the window regains focus', async () => {
    const fetchMock = stubApi(desk());
    renderApp([PAGE]);
    await waiting();
    await settle();

    act(() => {
      window.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(listQueries(fetchMock)).toHaveLength(2));
  });

  it('does not poll', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const fetchMock = stubApi(desk());
    renderApp([PAGE]);
    await waiting();

    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(listQueries(fetchMock)).toHaveLength(1);
  });

  it('keys the list under the building’s packages, so a package mutation’s invalidation reaches it', async () => {
    const fetchMock = stubApi(desk());
    const app = renderApp([PAGE]);
    await waiting();

    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'packages'] }));

    await waitFor(() => expect(listQueries(fetchMock)).toHaveLength(2));
  });
});

describe('another building (criterion 9; tenant row 3)', () => {
  it('closes the building when the list answers building_not_found', async () => {
    stubApi(desk({ [list()]: () => problem(404, 'building_not_found') }));
    renderApp([PAGE]);

    expect(await screen.findByRole('heading', { name: /no longer have access/i })).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Waiting packages' })).toBeNull();
  });

  it('shows nothing of one building’s list after switching to another', async () => {
    sessionStorage.setItem('condo.buildingId', MAPLE.id);
    let birchGate = () => {};
    const birchAnswer = new Promise<void>((resolve) => (birchGate = resolve));
    stubApi(
      desk({
        'GET /api/auth/me': () =>
          json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles: ['security'] }), membership(BIRCH, { roles: ['security'] })] }),
        [`GET /api/buildings/${BIRCH.id}`]: () => json(buildingOut(BIRCH, ['security'])),
        [`GET /api/buildings/${BIRCH.id}/notifications/summary`]: () => json({ unread_count: 0 }),
        [list(BIRCH)]: () => birchAnswer.then(() => page([pkg(5, { unit_label: '900', unit_tower: null, recipient_name: 'Birch Person' })])),
      }),
    );
    const app = renderApp([PAGE]);
    await waiting();
    expect(rows()[0].textContent).toContain('Robin Park');

    // A switch goes home (P2-06a); the desk is opened again in Birch while its list is still out.
    openAccountMenu();
    fireEvent.change(screen.getByLabelText('Building'), { target: { value: BIRCH.id } });
    await waitFor(() => expect(location()).toBe('/'));
    act(() => app.navigate()(PAGE));

    expect(await screen.findByText('Loading packages…')).toBeTruthy();
    expect(screen.queryByText('Robin Park')).toBeNull();
    birchGate();
    await waiting();
    expect(rows()[0].textContent).toContain('Birch Person');
  });
});

describe('an unreadable photo (criterion 11)', () => {
  it('shows "Image unavailable" in its row and still renders the rest', async () => {
    const photo = '01929a4e-0000-7000-8000-0000000f0002';
    stubApi(
      desk({
        [list()]: () => page([pkg(1, { photo_file_id: photo }), pkg(2, { recipient_name: 'Sam Lee' })]),
        [`GET /api/buildings/${MAPLE.id}/files/${photo}/download-url`]: () => problem(404, 'file_not_found'),
      }),
    );
    renderApp([PAGE]);
    await waiting();

    expect(await within(rows()[0]).findByText('Image unavailable')).toBeTruthy();
    expect(rows()[0].textContent).toContain('Robin Park');
    expect(rows()[1].textContent).toContain('Sam Lee');
  });
});
