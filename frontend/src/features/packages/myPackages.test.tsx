// @vitest-environment jsdom
/**
 * P5-04: the resident's `/packages` page, its detail dialog at `/packages/<id>` and the "My packages" nav badge. Each
 * `describe` names the criteria it proves (docs/tickets/P5-04-resident-packages-page.md).
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

let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  act(() => {
    window.dispatchEvent(new Event('visibilitychange'));
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  if (visibility !== 'visible') setVisibility('visible');
});

type Package = components['schemas']['PackageOut'];
type Role = components['schemas']['Role'];
type Feature = components['schemas']['Feature'];

const BASE = `/api/buildings/${MAPLE.id}/packages`;
// 23:30 UTC on 15 March 2026 is 19:30 in Toronto (EDT since 8 March).
const LATE = '2026-03-15T23:30:00Z';
const LATE_TORONTO = 'Mar 15, 2026, 7:30 PM';

function pkg(n: number, fields: Partial<Package> = {}): Package {
  return {
    id: `01929a4e-0000-7000-8000-0000000e00${String(n).padStart(2, '0')}`,
    unit_id: '01929a4e-0000-7000-8000-0000000c0001',
    recipient_membership_id: null,
    carrier: 'UPS',
    description: null,
    tracking_last4: null,
    photo_file_id: null,
    status: 'received',
    received_at: '2026-10-20T14:00:00Z',
    received_by_membership_id: '01929a4e-0000-7000-8000-0000000d0009',
    picked_up_at: null,
    returned_at: null,
    unit_tower: 'A',
    unit_label: '101',
    recipient_name: null,
    ...fields,
  };
}
const pickedUp = (n: number, fields: Partial<Package> = {}) =>
  pkg(n, { status: 'picked_up', picked_up_at: '2026-10-21T15:00:00Z', ...fields });

const page = (items: Package[], next_cursor: string | null = null) => json({ items, next_cursor });
const statuses = (request: Request) => new URL(request.url).searchParams.getAll('status').join(',');

interface Server {
  waiting: Package[];
  history: Package[];
  summary?: number;
}

/** A resident's packages API over `state`: the two lists by their `status` values, the summary and each package. */
function packagesApi(state: Server, overrides: Record<string, Handler> = {}): Record<string, Handler> {
  const routes: Record<string, Handler> = {
    [`GET ${BASE}`]: (request) => {
      const asked = statuses(request);
      if (asked === 'received') return page(state.waiting);
      if (asked === 'picked_up,returned') return page(state.history);
      throw new Error(`unexpected statuses ${asked}`);
    },
    [`GET ${BASE}/summary`]: () => json({ waiting: state.summary ?? state.waiting.length }),
  };
  for (const item of [...state.waiting, ...state.history]) routes[`GET ${BASE}/${item.id}`] = () => json(item);
  return { ...routes, ...overrides };
}

function resident(state: Server, overrides: Record<string, Handler> = {}, roles: Role[] = ['resident'], features?: Feature[]) {
  return {
    'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles })] }),
    [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, roles, features)),
    ...packagesApi(state),
    ...overrides,
  };
}

const location = () => screen.getByTestId('location').textContent;
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
const waitingList = () => screen.findByRole('list', { name: 'Waiting for you' });
const historyList = () => screen.findByRole('list', { name: 'Package history' });
const navLink = (name: string | RegExp) =>
  within(screen.getByRole('navigation', { name: 'Main' })).findByRole('link', { name });
const listCalls = (fetchMock: ReturnType<typeof stubApi>, asked: string) =>
  fetchMock.mock.calls.filter(([request]) => new URL(request.url).pathname === BASE && statuses(request) === asked);
const summaryCalls = (fetchMock: ReturnType<typeof stubApi>) => calls(fetchMock).filter((call) => call === `GET ${BASE}/summary`);

const TWO_AND_THREE: Server = {
  waiting: [pkg(1, { carrier: 'Amazon' }), pkg(2, { carrier: 'FedEx', description: 'Small box' })],
  history: [
    pickedUp(3),
    pkg(4, { status: 'returned', returned_at: '2026-10-19T16:00:00Z', carrier: 'DHL' }),
    pickedUp(5, { carrier: 'Purolator' }),
  ],
};

describe('the lists and the badge (criterion 1)', () => {
  it('shows 2 waiting cards, 3 history rows and a badge of 2', async () => {
    stubApi(resident(TWO_AND_THREE));
    renderApp(['/packages']);

    expect(await screen.findByRole('heading', { name: 'My packages', level: 1 })).toBeTruthy();
    const cards = within(await waitingList()).getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain('Amazon');
    expect(cards[1].textContent).toContain('FedEx');
    expect(cards[1].textContent).toContain('Small box');
    expect(cards[1].textContent).toContain('Pick up at the front desk');
    expect(within(await historyList()).getAllByRole('listitem')).toHaveLength(3);
    expect(await navLink('My packages, 2 waiting')).toBeTruthy();
  });

  it('says how each history package ended', async () => {
    stubApi(resident(TWO_AND_THREE));
    renderApp(['/packages']);

    const rows = within(await historyList()).getAllByRole('listitem');
    expect(rows[0].textContent).toMatch(/Picked up Oct 21, 2026/);
    expect(rows[1].textContent).toMatch(/Returned Oct 19, 2026/);
    expect(rows[1].textContent).not.toContain('Pick up at the front desk');
  });

  it('asks for waiting packages with status=received and history with picked_up and returned', async () => {
    const fetchMock = stubApi(resident(TWO_AND_THREE));
    renderApp(['/packages']);
    await historyList();
    await waitingList();

    expect(listCalls(fetchMock, 'received')).toHaveLength(1);
    expect(listCalls(fetchMock, 'picked_up,returned')).toHaveLength(1);
  });

  it('loads more history with the cursor', async () => {
    const more = pickedUp(9, { carrier: 'Canada Post' });
    stubApi(
      resident(TWO_AND_THREE, {
        [`GET ${BASE}`]: (request) => {
          const url = new URL(request.url);
          if (statuses(request) === 'received') return page(TWO_AND_THREE.waiting);
          return url.searchParams.get('cursor') === 'c'.repeat(22) ? page([more]) : page(TWO_AND_THREE.history, 'c'.repeat(22));
        },
      }),
    );
    renderApp(['/packages']);

    await historyList();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Package history' })).getAllByRole('listitem')).toHaveLength(4));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('shows plain "My packages" with nothing waiting, and over 99 as 99+', async () => {
    stubApi(resident({ waiting: [], history: [] }));
    renderApp(['/packages']);
    expect(await navLink(/^My packages$/)).toBeTruthy();
    cleanup();

    stubApi(resident({ waiting: [], history: [], summary: 120 }));
    renderApp(['/packages']);
    const link = await navLink('My packages, 120 waiting');
    expect(link.textContent).toContain('99+');
  });

  it('drops the count when a refresh of the summary fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let fail = false;
    stubApi(resident(TWO_AND_THREE, { [`GET ${BASE}/summary`]: () => (fail ? problem(500, 'internal_error') : json({ waiting: 2 })) }));
    renderApp(['/']);
    await navLink('My packages, 2 waiting');

    fail = true;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(await navLink(/^My packages$/)).toBeTruthy();
  });
});

describe('the badge polls on a visible tab and the bell deep-links (criterion 2)', () => {
  it('asks again at 30 s, not before, and shows the new count', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const state: Server = { waiting: [pkg(1), pkg(2)], history: [] };
    const fetchMock = stubApi(resident(state));
    renderApp(['/']);
    await navLink('My packages, 2 waiting');
    const before = summaryCalls(fetchMock).length;

    state.waiting = [pkg(3), ...state.waiting];
    await act(() => vi.advanceTimersByTimeAsync(29_000));
    expect(summaryCalls(fetchMock)).toHaveLength(before);

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(await navLink('My packages, 3 waiting')).toBeTruthy();
    expect(summaryCalls(fetchMock)).toHaveLength(before + 1);
  });

  it('does not ask while the tab is hidden, and asks as soon as it is visible', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const state: Server = { waiting: [pkg(1), pkg(2)], history: [] };
    const fetchMock = stubApi(resident(state));
    renderApp(['/']);
    await navLink('My packages, 2 waiting');
    const before = summaryCalls(fetchMock).length;

    setVisibility('hidden');
    await act(() => vi.advanceTimersByTimeAsync(90_000));
    expect(summaryCalls(fetchMock)).toHaveLength(before);

    state.waiting = [pkg(3), ...state.waiting];
    setVisibility('visible');
    expect(await navLink('My packages, 3 waiting')).toBeTruthy();
  });

  it('opens the package from the bell’s package.arrived notification', async () => {
    const arrived = pkg(3, { carrier: 'Canada Post' });
    const notification = {
      id: '01929a4e-0000-7000-8000-0000000f0001',
      kind: 'package.arrived',
      title: 'A package arrived',
      body: 'A package is waiting at the front desk.',
      link: `/packages/${arrived.id}`,
      entity_type: 'package',
      entity_id: arrived.id,
      read_at: null,
      created_at: '2026-10-20T14:00:00Z',
    };
    const notifications = `/api/buildings/${MAPLE.id}/notifications`;
    stubApi(
      resident(
        { waiting: [arrived], history: [] },
        {
          [`GET ${notifications}/summary`]: () => json({ unread_count: 1 }),
          [`GET ${notifications}`]: () => json({ items: [notification], next_cursor: null }),
          [`POST ${notifications}/${notification.id}/read`]: () => noContent(),
        },
      ),
    );
    renderApp(['/']);

    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    fireEvent.click(await screen.findByRole('button', { name: /A package arrived/ }));

    await waitFor(() => expect(location()).toBe(`/packages/${arrived.id}`));
    const dialog = await screen.findByRole('dialog', { name: 'Canada Post package' });
    expect(within(dialog).getByText('Waiting at the front desk')).toBeTruthy();
  });
});

describe('a package the resident may not see (criterion 3; tenant rows 3 and 5)', () => {
  it.each([
    ['another resident’s or another building’s package (404)', '01929a4e-0000-7000-8000-0000000e0077'],
  ])('shows the not-found dialog for %s, with the lists behind it', async (_, id) => {
    stubApi(resident(TWO_AND_THREE, { [`GET ${BASE}/${id}`]: () => problem(404, 'package_not_found') }));
    renderApp([`/packages/${id}`]);

    const dialog = await screen.findByRole('dialog', { name: 'Package not found' });
    expect(within(dialog).queryByRole('img')).toBeNull();
    expect(await waitingList()).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(location()).toBe('/packages'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the same dialog for an id that is not a UUID, without asking the API', async () => {
    const fetchMock = stubApi(resident(TWO_AND_THREE));
    renderApp(['/packages/not-a-package']);

    expect(await screen.findByRole('dialog', { name: 'Package not found' })).toBeTruthy();
    await waitingList();
    expect(calls(fetchMock).filter((call) => call.startsWith(`GET ${BASE}/`) && !call.endsWith('/summary'))).toEqual([]);
  });

  it('does not mark the building denied on a package 404', async () => {
    const id = '01929a4e-0000-7000-8000-0000000e0077';
    stubApi(resident(TWO_AND_THREE, { [`GET ${BASE}/${id}`]: () => problem(404, 'package_not_found') }));
    renderApp([`/packages/${id}`]);

    await screen.findByRole('dialog', { name: 'Package not found' });
    await settle();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
  });
});

describe('building time (criterion 4)', () => {
  it('shows 23:30 UTC as 7:30 PM in an America/Toronto building, on cards, history and the dialog', async () => {
    const waiting = pkg(1, { received_at: LATE });
    const returned = pkg(2, { status: 'returned', received_at: '2026-03-14T12:00:00Z', returned_at: LATE });
    stubApi(resident({ waiting: [waiting], history: [returned] }));
    renderApp([`/packages/${waiting.id}`]);

    const card = within(await waitingList()).getByRole('listitem');
    expect(card.textContent).toContain(`Arrived ${LATE_TORONTO}`);
    expect(within(card).getByText(LATE_TORONTO).getAttribute('dateTime')).toBe(LATE);
    expect(within(await historyList()).getByRole('listitem').textContent).toContain(`Returned ${LATE_TORONTO}`);
    const dialog = await screen.findByRole('dialog', { name: 'UPS package' });
    expect(dialog.textContent).toContain(LATE_TORONTO);
  });
});

describe('photos and their text (criterion 5)', () => {
  it('gives each photo "Package photo: <carrier>" as alt, and shows "No photo" without one', async () => {
    const fileId = '01929a4e-0000-7000-8000-0000000f0010';
    stubApi(
      resident(
        { waiting: [pkg(1, { carrier: 'FedEx', photo_file_id: fileId }), pkg(2)], history: [] },
        {
          [`GET /api/buildings/${MAPLE.id}/files/${fileId}/download-url`]: () =>
            json({ url: 'http://s3.test/photo.jpg', expires_at: new Date(Date.now() + 600_000).toISOString() }),
        },
      ),
    );
    renderApp(['/packages']);

    const cards = within(await waitingList()).getAllByRole('listitem');
    expect((await within(cards[0]).findByRole('img')).getAttribute('alt')).toBe('Package photo: FedEx');
    expect(within(cards[1]).getByText('No photo')).toBeTruthy();
  });
});

describe('the detail dialog (criterion 6)', () => {
  it('opens from a card’s Details link, shows the package, and Escape closes it back to /packages', async () => {
    stubApi(resident(TWO_AND_THREE));
    renderApp(['/packages']);

    const card = within(await waitingList()).getAllByRole('listitem')[1];
    const link = within(card).getByRole('link', { name: /^Details: FedEx/ });
    fireEvent.click(link);

    const dialog = await screen.findByRole('dialog', { name: 'FedEx package' });
    expect(location()).toBe(`/packages/${TWO_AND_THREE.waiting[1].id}`);
    expect(dialog.textContent).toContain('Small box');
    expect(dialog.textContent).toContain('A-101');
    await waitFor(() => expect(document.activeElement).toBe(dialog));

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(location()).toBe('/packages'));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(within(screen.getAllByRole('listitem')[1]).getByRole('link')));
  });

  it('opens a history package with how it ended', async () => {
    stubApi(resident(TWO_AND_THREE));
    renderApp(['/packages']);

    fireEvent.click(within(await historyList()).getByRole('link', { name: /^Details: DHL/ }));
    const dialog = await screen.findByRole('dialog', { name: 'DHL package' });
    expect(within(dialog).getByText('Returned to the carrier')).toBeTruthy();
    expect(dialog.textContent).toContain('Oct 19, 2026');
  });

  it('opens and closes with Back and Forward without asking for the lists again', async () => {
    const fetchMock = stubApi(resident(TWO_AND_THREE));
    const app = renderApp(['/packages']);
    await historyList();
    await waitingList();

    fireEvent.click(within(await waitingList()).getAllByRole('link')[0]);
    await screen.findByRole('dialog', { name: 'Amazon package' });
    act(() => app.navigate()(-1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    act(() => app.navigate()(1));
    expect(await screen.findByRole('dialog', { name: 'Amazon package' })).toBeTruthy();
    await settle();

    expect(listCalls(fetchMock, 'received')).toHaveLength(1);
    expect(listCalls(fetchMock, 'picked_up,returned')).toHaveLength(1);
  });

  it('closes a deep link opened from elsewhere to /packages, replacing it', async () => {
    stubApi(resident(TWO_AND_THREE));
    const app = renderApp(['/', `/packages/${TWO_AND_THREE.waiting[0].id}`]);

    const dialog = await screen.findByRole('dialog', { name: 'Amazon package' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(location()).toBe('/packages'));
    act(() => app.navigate()(-1));
    await waitFor(() => expect(location()).toBe('/'));
  });

  it('shows a failure with Try again, apart from not-found', async () => {
    let fail = true;
    const id = TWO_AND_THREE.waiting[0].id;
    stubApi(resident(TWO_AND_THREE, { [`GET ${BASE}/${id}`]: () => (fail ? problem(500, 'internal_error') : json(TWO_AND_THREE.waiting[0])) }));
    renderApp([`/packages/${id}`]);

    const dialog = await screen.findByRole('dialog', { name: 'Package' });
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Could not load the package.');
    fail = false;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('dialog', { name: 'Amazon package' })).toBeTruthy();
  });
});

describe('access (criterion 7; tenant rows 1, 2 and 4)', () => {
  it.each([['security'], ['property_management'], ['council']] as const)('sends %s to /403 without asking for packages', async (role) => {
    const fetchMock = stubApi(resident(TWO_AND_THREE, {}, [role]));
    renderApp(['/packages']);

    await waitFor(() => expect(location()).toBe('/403'));
    expect(calls(fetchMock).filter((call) => call.startsWith(`GET ${BASE}`))).toEqual([]);
  });

  it('sends a resident to /403 when the building has packages off', async () => {
    const fetchMock = stubApi(resident(TWO_AND_THREE, {}, ['resident'], ['notices']));
    renderApp(['/packages']);

    await waitFor(() => expect(location()).toBe('/403'));
    expect(calls(fetchMock).filter((call) => call.startsWith(`GET ${BASE}`))).toEqual([]);
  });

  it('sends a signed-out user to the login page with the way back', async () => {
    stubApi({ 'GET /api/auth/me': () => problem(401, 'not_authenticated') });
    renderApp([`/packages/${TWO_AND_THREE.waiting[0].id}`]);

    await waitFor(() => expect(location()).toBe(`/login?next=${encodeURIComponent(`/packages/${TWO_AND_THREE.waiting[0].id}`)}`));
  });

  it('opens the page at the legacy /Packages path', async () => {
    stubApi(resident(TWO_AND_THREE));
    renderApp(['/Packages']);

    expect(await screen.findByRole('heading', { name: 'My packages', level: 1 })).toBeTruthy();
    await waitingList();
    expect(location()).toBe('/Packages');
  });

  it('shows the page in the navigation for a resident, linking to /packages', async () => {
    stubApi(resident(TWO_AND_THREE));
    renderApp(['/']);

    expect((await navLink('My packages, 2 waiting')).getAttribute('href')).toBe('/packages');
  });

  it('starts over in another building', async () => {
    const birchBase = `/api/buildings/${BIRCH.id}/packages`;
    stubApi({
      ...resident(TWO_AND_THREE),
      'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE), membership(BIRCH)] }),
      [`GET /api/buildings/${BIRCH.id}`]: () => json(buildingOut(BIRCH, ['resident'])),
      [`GET ${birchBase}`]: () => page([]),
      [`GET ${birchBase}/summary`]: () => json({ waiting: 0 }),
    });
    sessionStorage.setItem('condo.buildingId', BIRCH.id);
    renderApp(['/packages']);

    expect(await screen.findByText('No packages are waiting for you.')).toBeTruthy();
    expect(screen.getByText('No package history yet.')).toBeTruthy();
  });
});

describe('the lists’ states (criterion 8)', () => {
  it('shows each list’s empty message', async () => {
    stubApi(resident({ waiting: [], history: [] }));
    renderApp(['/packages']);

    expect(await screen.findByText('No packages are waiting for you.')).toBeTruthy();
    expect(await screen.findByText('No package history yet.')).toBeTruthy();
  });

  it('shows a failed list with Try again, leaving the other list alone', async () => {
    let fail = true;
    stubApi(
      resident(TWO_AND_THREE, {
        [`GET ${BASE}`]: (request) => {
          if (statuses(request) === 'received') return page(TWO_AND_THREE.waiting);
          return fail ? problem(500, 'internal_error') : page(TWO_AND_THREE.history);
        },
      }),
    );
    renderApp(['/packages']);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load your package history.');
    expect(within(await waitingList()).getAllByRole('listitem')).toHaveLength(2);
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(within(await historyList()).getAllByRole('listitem')).toHaveLength(3);
  });

  it('says so when Load more fails, keeping the rows', async () => {
    stubApi(
      resident(TWO_AND_THREE, {
        [`GET ${BASE}`]: (request) => {
          if (statuses(request) === 'received') return page(TWO_AND_THREE.waiting, 'w'.repeat(22));
          return page(TWO_AND_THREE.history);
        },
      }),
    );
    renderApp(['/packages']);
    await waitingList();
    stubApi(resident(TWO_AND_THREE, { [`GET ${BASE}`]: () => problem(500, 'internal_error') }));

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load more packages.');
    expect(within(screen.getByRole('list', { name: 'Waiting for you' })).getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('the lists follow the badge (criterion 9)', () => {
  it('asks for both lists again when the polled count changes, and not when it stays', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const state: Server = { waiting: [pkg(1), pkg(2)], history: [] };
    const fetchMock = stubApi(resident(state));
    renderApp(['/packages']);
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Waiting for you' })).getAllByRole('listitem')).toHaveLength(2));

    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(listCalls(fetchMock, 'received')).toHaveLength(1);

    state.waiting = [pkg(3), ...state.waiting];
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Waiting for you' })).getAllByRole('listitem')).toHaveLength(3));
    expect(listCalls(fetchMock, 'received')).toHaveLength(2);
    expect(listCalls(fetchMock, 'picked_up,returned')).toHaveLength(2);
  });
});
