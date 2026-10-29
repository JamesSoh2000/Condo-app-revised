// @vitest-environment jsdom
/**
 * P6-04a: the resident's `/maintenance` page, its list of requests. Each `describe` names the criteria it proves
 * (docs/tickets/P6-04a-resident-maintenance-list.md).
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { components } from '@/api/schema';
import { writeSelectedBuilding } from '@/app/buildingStorage';
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
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

type Request_ = components['schemas']['MaintenanceRequestOut'];
type Role = components['schemas']['Role'];
type Feature = components['schemas']['Feature'];

const BASE = `/api/buildings/${MAPLE.id}/maintenance-requests`;
const OWN = membership(MAPLE).membership_id;
const CO_OCCUPANT = '01929a4e-0000-7000-8000-0000000d0007';
// 23:30 UTC on 15 March 2026 is 19:30 in Toronto (EDT since 8 March).
const LATE = '2026-03-15T23:30:00Z';
const LATE_TORONTO = 'Mar 15, 2026, 7:30 PM';
const CURSOR = 'c'.repeat(22);

function request(n: number, fields: Partial<Request_> = {}): Request_ {
  return {
    id: `01929a4e-0000-7000-8000-0000000f00${String(n).padStart(2, '0')}`,
    requester_membership_id: OWN,
    location: 'unit',
    unit_id: '01929a4e-0000-7000-8000-0000000c0001',
    common_area: null,
    category: 'plumbing',
    description: `Request ${n}`,
    status: 'submitted',
    submitted_at: '2026-10-20T14:00:00Z',
    started_at: null,
    on_hold_at: null,
    resolved_at: null,
    cancelled_at: null,
    photo_file_ids: [],
    unit_tower: 'A',
    unit_label: '101',
    requester_name: null,
    emergency_phone: null,
    ...fields,
  };
}

const page = (items: Request_[], next_cursor: string | null = null) => json({ items, next_cursor });

function resident(list: Handler, overrides: Record<string, Handler> = {}, roles: Role[] = ['resident'], features?: Feature[]) {
  return {
    'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles })] }),
    [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, roles, features)),
    [`GET ${BASE}`]: list,
    ...overrides,
  };
}

const THREE = [
  request(3, { status: 'in_progress', category: 'heating_cooling', description: 'No heat in the bedroom' }),
  request(2, {
    status: 'on_hold',
    category: 'doors_windows',
    location: 'common_area',
    unit_id: null,
    unit_tower: null,
    unit_label: null,
    common_area: 'Lobby, north door',
    description: 'The door sticks\nIt has done so since Monday.',
    photo_file_ids: ['01929a4e-0000-7000-8000-0000000a0001', '01929a4e-0000-7000-8000-0000000a0002'],
  }),
  request(1, { status: 'resolved', category: 'pest_control', unit_tower: null, unit_label: '7', photo_file_ids: ['01929a4e-0000-7000-8000-0000000a0003'] }),
];

const location = () => screen.getByTestId('location').textContent;
const list = () => screen.findByRole('list', { name: 'Your maintenance requests' });
const cards = async () => within(await list()).getAllByRole('listitem');
/** The status a card shows: the text beside its category heading. */
const statusOf = (card: HTMLElement) => within(card).getByRole('heading', { level: 3 }).nextElementSibling?.textContent;
const heading = () => screen.findByRole('heading', { name: 'Maintenance requests', level: 1 });
const listRequests = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls.map(([asked]) => new URL(asked.url)).filter((url) => url.pathname.endsWith('/maintenance-requests'));
const navLink = async (name: string | RegExp) =>
  within(await screen.findByRole('navigation', { name: 'Main' })).findByRole('link', { name });

/** 26 requests, newest first: 25 on the first page, the 26th on the next. */
const TWENTY_SIX = Array.from({ length: 26 }, (_, i) => request(26 - i));
const twoPages: Handler = (asked) =>
  new URL(asked.url).searchParams.get('cursor') === CURSOR ? page(TWENTY_SIX.slice(25)) : page(TWENTY_SIX.slice(0, 25), CURSOR);

describe('the cards (criterion 1)', () => {
  it('shows three cards in the API’s order with status, category, location, time, first line and photos', async () => {
    stubApi(resident(() => page(THREE)));
    renderApp(['/maintenance']);

    expect(await heading()).toBeTruthy();
    const [first, second, third] = await cards();
    expect(within(first).getByRole('heading', { name: 'Heating and cooling', level: 3 })).toBeTruthy();
    expect(statusOf(first)).toBe('In progress');
    expect(first.textContent).toContain('Unit A-101');
    expect(first.textContent).toContain('No heat in the bedroom');
    expect(first.textContent).toContain('Submitted Oct 20, 2026, 10:00 AM');
    expect(first.textContent).not.toMatch(/photo/);

    expect(within(second).getByRole('heading', { name: 'Doors and windows', level: 3 })).toBeTruthy();
    expect(statusOf(second)).toBe('On hold');
    expect(second.textContent).toContain('Lobby, north door');
    expect(second.textContent).not.toContain('Unit');
    expect(second.textContent).toContain('The door sticks');
    expect(second.textContent).not.toContain('since Monday');
    expect(second.textContent).toContain('2 photos');

    expect(within(third).getByRole('heading', { name: 'Pest control', level: 3 })).toBeTruthy();
    expect(statusOf(third)).toBe('Resolved');
    expect(third.textContent).toContain('Unit 7');
    expect(third.textContent).toContain('1 photo');
    expect(third.textContent).not.toContain('1 photos');
  });

  it('labels every status and category in words, never the raw value', async () => {
    const statuses = ['submitted', 'in_progress', 'on_hold', 'resolved', 'cancelled'] as const;
    const categories = ['plumbing', 'electrical', 'heating_cooling', 'appliance', 'doors_windows', 'pest_control', 'other', 'emergency'] as const;
    const items = categories.map((category, i) => request(i + 1, { category, status: statuses[i % statuses.length] }));
    stubApi(resident(() => page(items)));
    renderApp(['/maintenance']);

    const shown = await cards();
    expect(shown.map((card) => within(card).getByRole('heading', { level: 3 }).textContent)).toEqual([
      'Plumbing',
      'Electrical',
      'Heating and cooling',
      'Appliance',
      'Doors and windows',
      'Pest control',
      'Other',
      'Emergency',
    ]);
    const labels = ['Submitted', 'In progress', 'On hold', 'Resolved', 'Cancelled'];
    expect(shown.map(statusOf)).toEqual(items.map((_, i) => labels[i % labels.length]));
    for (const card of shown) expect(card.textContent).not.toMatch(/_/);
  });

  it('cuts a long first line at 120 characters, not UTF-16 units, with an ellipsis', async () => {
    // The emoji is the 120th character but the 120th and 121st UTF-16 units: a unit cut would split it.
    const long = `${'x'.repeat(119)}😀 and more`;
    stubApi(resident(() => page([request(1, { description: long }), request(2, { description: 'y'.repeat(120) })])));
    renderApp(['/maintenance']);

    const [cut, whole] = await cards();
    expect(cut.textContent).toContain(`${'x'.repeat(119)}😀…`);
    expect(cut.textContent).not.toContain('and more');
    expect(whole.textContent).toContain('y'.repeat(120));
    expect(whole.textContent).not.toContain('…');
  });

  it('asks limit=25 first, then the cursor, and shows 26 cards once each in order', async () => {
    const fetchMock = stubApi(resident(twoPages));
    renderApp(['/maintenance']);

    expect(await cards()).toHaveLength(25);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(async () => expect(await cards()).toHaveLength(26));
    expect((await cards()).map((card) => within(card).getByText(/^Request \d+$/).textContent)).toEqual(
      TWENTY_SIX.map((item) => item.description),
    );
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();

    const [firstAsk, secondAsk] = listRequests(fetchMock);
    expect(firstAsk.searchParams.get('limit')).toBe('25');
    expect(firstAsk.searchParams.has('cursor')).toBe(false);
    expect(secondAsk.searchParams.get('cursor')).toBe(CURSOR);
    expect(secondAsk.searchParams.get('limit')).toBe('25');
  });

  it('moves focus to the first new card once the next page has landed', async () => {
    stubApi(resident(twoPages));
    renderApp(['/maintenance']);

    await list();
    const button = screen.getByRole('button', { name: 'Load more' });
    button.focus();
    fireEvent.click(button);
    await waitFor(async () => expect(document.activeElement).toBe((await cards())[25]));
  });

  it('sends focus to the heading after an empty last page', async () => {
    stubApi(resident((asked) => (new URL(asked.url).searchParams.get('cursor') === CURSOR ? page([]) : page(THREE, CURSOR))));
    renderApp(['/maintenance']);

    await list();
    const button = screen.getByRole('button', { name: 'Load more' });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull());
    await waitFor(async () => expect(document.activeElement).toBe(await heading()));
  });
});

describe('building time (criterion 2)', () => {
  it('shows 23:30 UTC as 7:30 PM in an America/Toronto building', async () => {
    stubApi(resident(() => page([request(1, { submitted_at: LATE })])));
    renderApp(['/maintenance']);

    const [card] = await cards();
    expect(card.textContent).toContain(`Submitted ${LATE_TORONTO}`);
    expect(within(card).getByText(LATE_TORONTO).getAttribute('datetime')).toBe(LATE);
  });
});

describe('access (criterion 3; tenant rows 1, 2 and 4)', () => {
  it.each([[['security']], [['property_management']], [['council']]] as const)(
    'sends %s to /403 without asking for requests',
    async (roles) => {
      const fetchMock = stubApi(resident(() => page(THREE), {}, [...roles]));
      renderApp(['/maintenance']);

      await waitFor(() => expect(location()).toBe('/403'));
      expect(listRequests(fetchMock)).toEqual([]);
    },
  );

  it('sends a resident to /403 when the building has maintenance off, with no nav item', async () => {
    const fetchMock = stubApi(resident(() => page(THREE), {}, ['resident'], ['packages', 'notices']));
    renderApp(['/maintenance']);

    await waitFor(() => expect(location()).toBe('/403'));
    expect(listRequests(fetchMock)).toEqual([]);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    await within(nav).findByRole('link', { name: 'My profile' });
    expect(within(nav).queryByRole('link', { name: 'Maintenance requests' })).toBeNull();
  });

  it.each(['/maintenance', `/maintenance/${THREE[0].id}`])('sends a signed-out user at %s to login with the way back', async (path) => {
    stubApi({ 'GET /api/auth/me': () => problem(401, 'not_authenticated') });
    renderApp([path]);

    await waitFor(() => expect(location()).toBe(`/login?next=${encodeURIComponent(path)}`));
  });

  it('opens the page for a council + resident member', async () => {
    stubApi(resident(() => page(THREE), {}, ['council', 'resident']));
    renderApp(['/maintenance']);

    expect(await cards()).toHaveLength(3);
  });

  it('lists the page in a resident’s navigation, linking to /maintenance', async () => {
    stubApi(resident(() => page(THREE)));
    renderApp(['/']);

    expect((await navLink('Maintenance requests')).getAttribute('href')).toBe('/maintenance');
  });
});

describe('tenant row 3, UI side (criterion 4)', () => {
  it('asks only the selected building’s maintenance URLs', async () => {
    const fetchMock = stubApi({
      ...resident(() => page(THREE)),
      'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE), membership(BIRCH)] }),
    });
    writeSelectedBuilding(MAPLE.id);
    renderApp(['/maintenance']);

    await cards();
    const asked = listRequests(fetchMock).map((url) => url.pathname);
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set([BASE]));
    expect(calls(fetchMock).some((call) => call.includes(BIRCH.id))).toBe(false);
  });

  it('marks the building denied when the list answers building_not_found', async () => {
    stubApi(resident(() => problem(404, 'building_not_found')));
    renderApp(['/maintenance']);

    expect(await screen.findByRole('heading', { name: /no longer have access/i })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Maintenance requests', level: 1 })).toBeNull();
  });
});

describe('switching building (criterion 5)', () => {
  it('shows none of the first building’s requests while the second’s load', async () => {
    const birch = `/api/buildings/${BIRCH.id}`;
    stubApi({
      ...resident(() => page(THREE)),
      'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE), membership(BIRCH)] }),
      [`GET ${birch}`]: () => json(buildingOut(BIRCH, ['resident'])),
      [`GET ${birch}/notifications/summary`]: () => json({ unread_count: 0 }),
      [`GET ${birch}/maintenance-requests`]: () => new Promise<Response>(() => {}),
    });
    writeSelectedBuilding(MAPLE.id);
    renderApp(['/maintenance']);
    expect(await cards()).toHaveLength(3);

    openAccountMenu();
    fireEvent.change(screen.getByRole('combobox', { name: 'Building' }), { target: { value: BIRCH.id } });
    fireEvent.click(await navLink('Maintenance requests'));

    expect(await screen.findByText('Loading requests…')).toBeTruthy();
    expect(screen.queryByText('No heat in the bedroom')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Your maintenance requests' })).toBeNull();
  });
});

describe('states (criterion 6)', () => {
  it('shows loading, then the empty message', async () => {
    let release: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    stubApi(resident(() => held.then(() => page([]))));
    renderApp(['/maintenance']);

    expect((await screen.findByText('Loading requests…')).getAttribute('role')).toBe('status');
    release!();
    expect(await screen.findByText('You haven’t submitted any requests.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Your maintenance requests' })).toBeNull();
  });

  it('shows a failed first page with Try again, which asks again and shows the cards', async () => {
    let fail = true;
    stubApi(resident(() => (fail ? problem(500, 'internal_error') : page(THREE))));
    renderApp(['/maintenance']);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load your requests.');
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await cards()).toHaveLength(3);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the cards when Load more fails, says so, and retries with the button', async () => {
    let fail = true;
    stubApi(
      resident((asked) => {
        if (new URL(asked.url).searchParams.get('cursor') !== CURSOR) return page(THREE, CURSOR);
        return fail ? problem(500, 'internal_error') : page([request(9, { description: 'The ninth' })]);
      }),
    );
    renderApp(['/maintenance']);

    await list();
    const button = screen.getByRole('button', { name: 'Load more' });
    button.focus();
    fireEvent.click(button);
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load more requests.');
    expect(await cards()).toHaveLength(3);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Load more' })));

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(async () => expect(await cards()).toHaveLength(4));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says to wait on a 429, on the first page and on Load more', async () => {
    let first = true;
    stubApi(resident(() => problem(429, 'rate_limited', { 'Retry-After': '30' })));
    renderApp(['/maintenance']);
    expect((await screen.findByRole('alert')).textContent).toContain('Too many requests. Try again in 30 seconds.');
    cleanup();

    stubApi(
      resident((asked) => {
        if (first || new URL(asked.url).searchParams.get('cursor') !== CURSOR) {
          first = false;
          return page(THREE, CURSOR);
        }
        return problem(429, 'rate_limited', { 'Retry-After': '30' });
      }),
    );
    renderApp(['/maintenance']);
    await list();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Too many requests. Try again in 30 seconds.');
    expect(await cards()).toHaveLength(3);
  });
});

describe('legacy path (criterion 7)', () => {
  it('answers /Maintenance with the page itself, keeping the URL, query and hash', async () => {
    stubApi(resident(() => page(THREE)));
    const app = renderApp(['/Maintenance?from=old#top']);

    expect(await cards()).toHaveLength(3);
    expect(location()).toBe('/Maintenance?from=old');
    expect(app.location().hash).toBe('#top');
  });
});

describe('the browser does not filter (criterion 9)', () => {
  it('shows a request a co-occupant filed, and asks for no status', async () => {
    const fetchMock = stubApi(
      resident(() => page([request(2, { requester_membership_id: CO_OCCUPANT, description: 'Filed by my roommate' }), request(1)])),
    );
    renderApp(['/maintenance']);

    const shown = await cards();
    expect(shown).toHaveLength(2);
    expect(shown[0].textContent).toContain('Filed by my roommate');
    for (const url of listRequests(fetchMock)) expect(url.searchParams.has('status')).toBe(false);
  });
});

describe('/maintenance/<id> until P6-04c (criterion 10)', () => {
  it('shows the list at the notification’s link, and Back to /maintenance asks no second time', async () => {
    const fetchMock = stubApi(resident(() => page(THREE)));
    const app = renderApp(['/maintenance', `/maintenance/${THREE[0].id}`]);

    expect(await cards()).toHaveLength(3);
    expect(listRequests(fetchMock)).toHaveLength(1);
    const shownCard = (await cards())[0];

    app.navigate()(-1);
    await waitFor(() => expect(location()).toBe('/maintenance'));
    expect((await cards())[0]).toBe(shownCard);
    expect(listRequests(fetchMock)).toHaveLength(1);
  });

  it('shows the list for an id that is not a UUID', async () => {
    stubApi(resident(() => page(THREE)));
    renderApp(['/maintenance/not-a-uuid']);

    expect(await cards()).toHaveLength(3);
  });
});

describe('coming back (criterion 11)', () => {
  it('asks for the list again after another page, and shows the new status', async () => {
    let status: Request_['status'] = 'submitted';
    const fetchMock = stubApi(resident(() => page([request(1, { status })])));
    renderApp(['/maintenance']);
    const [card] = await cards();
    expect(statusOf(card)).toBe('Submitted');

    fireEvent.click(await navLink('My profile'));
    await waitFor(() => expect(location()).toBe('/Profile'));
    status = 'in_progress';
    fireEvent.click(await navLink('Maintenance requests'));

    await waitFor(async () => expect(statusOf((await cards())[0])).toBe('In progress'));
    expect(listRequests(fetchMock)).toHaveLength(2);
  });
});
