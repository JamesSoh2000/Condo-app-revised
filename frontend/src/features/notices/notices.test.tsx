// @vitest-environment jsdom
/**
 * P6-02a: the `/notices` feed, "Mark as read" and the "Notices" nav badge. Each `describe` names the criteria it proves
 * (docs/tickets/P6-02a-notices-feed-and-detail.md).
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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

let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  visibility = 'visible';
});

type Notice = components['schemas']['NoticeOut'];
type Role = components['schemas']['Role'];
type Feature = components['schemas']['Feature'];

const BASE = `/api/buildings/${MAPLE.id}/notices`;
// 23:30 UTC on 15 March 2026 is 19:30 in Toronto (EDT since 8 March).
const LATE = '2026-03-15T23:30:00Z';
const LATE_TORONTO = 'Mar 15, 2026, 7:30 PM';

function notice(n: number, fields: Partial<Notice> = {}): Notice {
  return {
    id: `01929a4e-0000-7000-8000-0000000f00${String(n).padStart(2, '0')}`,
    title: `Notice ${n}`,
    body: `Body of notice ${n}.`,
    priority: 'normal',
    status: 'published',
    expires_at: null,
    attachment_file_id: null,
    author_membership_id: '01929a4e-0000-7000-8000-0000000d0009',
    published_at: '2026-10-20T14:00:00Z',
    published_by_membership_id: '01929a4e-0000-7000-8000-0000000d0009',
    archived_at: null,
    archived_by_membership_id: null,
    created_at: '2026-10-20T13:00:00Z',
    updated_at: '2026-10-20T14:00:00Z',
    read_at: null,
    ...fields,
  };
}

interface Server {
  notices: Notice[];
  /** The summary's `unread`; the unread notices by default. */
  unread?: number;
}

const page = (items: Notice[], next_cursor: string | null = null) => json({ items, next_cursor });
const unreadOf = (state: Server) => state.unread ?? state.notices.filter((item) => item.read_at === null).length;

/** The notices API over `state`: the live list, the summary and the read, which marks the notice read in `state`. */
function noticesApi(state: Server): Record<string, Handler> {
  const routes: Record<string, Handler> = {
    [`GET ${BASE}`]: (request) => {
      if (new URL(request.url).searchParams.get('live') !== 'true') throw new Error('the feed asks live=true');
      return page(state.notices);
    },
    [`GET ${BASE}/summary`]: () => json({ unread: unreadOf(state), urgent_unread: 0 }),
  };
  for (const item of state.notices) {
    routes[`POST ${BASE}/${item.id}/read`] = () => {
      state.notices = state.notices.map((other) => (other.id === item.id ? { ...other, read_at: '2026-10-22T10:00:00Z' } : other));
      if (state.unread !== undefined) state.unread -= 1;
      return noContent();
    };
  }
  return routes;
}

function member(state: Server, overrides: Record<string, Handler> = {}, roles: Role[] = ['resident'], features?: Feature[]) {
  return {
    'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles })] }),
    [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, roles, features)),
    ...noticesApi(state),
    ...overrides,
  };
}

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
const feed = () => screen.findByRole('list', { name: 'Notices' });
const cards = async () => within(await feed()).getAllByRole('listitem');
const navLink = async (name: string | RegExp) =>
  within(await screen.findByRole('navigation', { name: 'Main' })).findByRole('link', { name });
const listCalls = (fetchMock: ReturnType<typeof stubApi>) => calls(fetchMock).filter((call) => call === `GET ${BASE}`);
const readCalls = (fetchMock: ReturnType<typeof stubApi>) => calls(fetchMock).filter((call) => call.startsWith(`POST ${BASE}/`));

const THREE = (): Server => ({
  notices: [notice(3, { priority: 'urgent' }), notice(2, { read_at: '2026-10-21T09:00:00Z' }), notice(1)],
});

describe('the feed and the badge (criteria 1, 11)', () => {
  it('shows three cards in the API order, two unread, and "Notices, 2 unread"', async () => {
    stubApi(member(THREE()));
    renderApp(['/notices']);

    expect(await screen.findByRole('heading', { name: 'Notices', level: 1 })).toBeTruthy();
    const shown = await cards();
    expect(shown.map((card) => within(card).getByRole('heading', { level: 2 }).textContent)).toEqual(['Notice 3', 'Notice 2', 'Notice 1']);
    expect(within(shown[0]).getByText('Urgent')).toBeTruthy();
    expect(within(shown[1]).queryByText('Urgent')).toBeNull();
    expect(shown.map((card) => within(card).queryByText('Unread') !== null)).toEqual([true, false, true]);
    expect(shown.map((card) => within(card).queryByRole('button', { name: /^Mark as read/ }) !== null)).toEqual([true, false, true]);
    expect(within(shown[2]).getByText('Body of notice 1.')).toBeTruthy();
    expect(await navLink('Notices, 2 unread')).toBeTruthy();
  });

  it('shows "Published" and "Until" in the building timezone', async () => {
    stubApi(member({ notices: [notice(1, { published_at: LATE, expires_at: '2026-03-16T04:00:00Z' })] }));
    renderApp(['/notices']);

    const [card] = await cards();
    expect(card.textContent).toContain(`Published ${LATE_TORONTO}`);
    expect(card.textContent).toContain('Until Mar 16, 2026, 12:00 AM');
    expect(within(card).getByText(LATE_TORONTO).getAttribute('dateTime')).toBe(LATE);
  });

  it('a notice without an expiry says no "Until"', async () => {
    stubApi(member({ notices: [notice(1)] }));
    renderApp(['/notices']);
    expect((await cards())[0].textContent).not.toContain('Until');
  });

  it('renders the body as Markdown', async () => {
    stubApi(member({ notices: [notice(1, { body: 'Water off **Tuesday**.\n\n<b>raw</b>' })] }));
    renderApp(['/notices']);
    const [card] = await cards();
    expect(within(card).getByText('Tuesday').tagName).toBe('STRONG');
    expect(card.querySelector('b')).toBeNull();
    expect(card.textContent).toContain('<b>raw</b>');
  });

  it('is plain "Notices" with nothing unread, 99+ over 99, and after a failed summary', async () => {
    stubApi(member({ notices: [notice(1, { read_at: '2026-10-21T09:00:00Z' })] }));
    renderApp(['/notices']);
    expect(await navLink(/^Notices$/)).toBeTruthy();
    cleanup();

    stubApi(member({ notices: [], unread: 120 }));
    renderApp(['/notices']);
    expect((await navLink('Notices, 120 unread')).textContent).toContain('99+');
    cleanup();

    stubApi(member({ notices: [] }, { [`GET ${BASE}/summary`]: () => problem(500, 'internal_error') }));
    renderApp(['/notices']);
    await screen.findByText('No notices right now.');
    expect(await navLink(/^Notices$/)).toBeTruthy();
  });

  it('loads more with the cursor', async () => {
    const more = notice(9, { title: 'Older' });
    stubApi(
      member(THREE(), {
        [`GET ${BASE}`]: (request) =>
          new URL(request.url).searchParams.get('cursor') === 'c'.repeat(22) ? page([more]) : page(THREE().notices, 'c'.repeat(22)),
      }),
    );
    renderApp(['/notices']);

    await feed();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Notices' })).getAllByRole('listitem')).toHaveLength(4));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('shows the empty, failed and failed-"Load more" states', async () => {
    stubApi(member({ notices: [] }));
    renderApp(['/notices']);
    expect(await screen.findByText('No notices right now.')).toBeTruthy();
    cleanup();

    let fail = true;
    stubApi(member(THREE(), { [`GET ${BASE}`]: () => (fail ? problem(500, 'internal_error') : page(THREE().notices)) }));
    renderApp(['/notices']);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load the notices.');
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await cards()).toHaveLength(3);
    cleanup();

    stubApi(
      member(THREE(), {
        [`GET ${BASE}`]: (request) =>
          new URL(request.url).searchParams.get('cursor') ? problem(500, 'internal_error') : page(THREE().notices, 'c'.repeat(22)),
      }),
    );
    renderApp(['/notices']);
    await feed();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load more notices.');
    expect(await cards()).toHaveLength(3);
  });
});

describe('marking read (criterion 2)', () => {
  it('sends one read, then the label, the button and one of the badge go, without a reload', async () => {
    const fetchMock = stubApi(member(THREE()));
    renderApp(['/notices']);
    await navLink('Notices, 2 unread');

    const button = within((await cards())[2]).getByRole('button', { name: 'Mark as read: Notice 1' });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(within(screen.getAllByRole('listitem')[2]).queryByText('Unread')).toBeNull());
    expect(within(screen.getAllByRole('listitem')[2]).queryByRole('button', { name: /^Mark as read/ })).toBeNull();
    expect(await navLink('Notices, 1 unread')).toBeTruthy();
    expect(readCalls(fetchMock)).toEqual([`POST ${BASE}/${notice(1).id}/read`]);
  });

  it('keeps the button disabled while the read is out', async () => {
    let finish: (() => void) | undefined;
    const fetchMock = stubApi(
      member(THREE(), { [`POST ${BASE}/${notice(1).id}/read`]: () => new Promise<Response>((resolve) => (finish = () => resolve(noContent()))) }),
    );
    renderApp(['/notices']);
    const button = within((await cards())[2]).getByRole('button', { name: 'Mark as read: Notice 1' });
    fireEvent.click(button);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(button);
    await settle();
    expect(readCalls(fetchMock)).toHaveLength(1);
    finish!();
  });

  it('a failed read keeps the card unread with a message on it', async () => {
    stubApi(member(THREE(), { [`POST ${BASE}/${notice(1).id}/read`]: () => problem(500, 'internal_error') }));
    renderApp(['/notices']);
    const card = (await cards())[2];
    fireEvent.click(within(card).getByRole('button', { name: 'Mark as read: Notice 1' }));

    expect((await within(card).findByRole('alert')).textContent).toContain('Could not mark the notice read.');
    expect(within(card).getByText('Unread')).toBeTruthy();
    expect(within(card).getByRole<HTMLButtonElement>('button', { name: 'Mark as read: Notice 1' }).disabled).toBe(false);
  });

  it('a notice gone meanwhile (404) says so and the feed is asked again', async () => {
    const state = THREE();
    const fetchMock = stubApi(
      member(state, {
        [`POST ${BASE}/${notice(1).id}/read`]: () => {
          state.notices = state.notices.filter((item) => item.id !== notice(1).id);
          return problem(404, 'notice_not_found');
        },
      }),
    );
    renderApp(['/notices']);
    const card = (await cards())[2];
    const before = listCalls(fetchMock).length;
    fireEvent.click(within(card).getByRole('button', { name: 'Mark as read: Notice 1' }));

    expect((await screen.findByRole('alert')).textContent).toBe('“Notice 1” is no longer available.');
    await waitFor(() => expect(listCalls(fetchMock).length).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Notice 1' })).toBeNull());
    expect(await cards()).toHaveLength(2);
    expect(screen.getByRole('alert').textContent).toBe('“Notice 1” is no longer available.');
  });
});

describe('access (criterion 4)', () => {
  it.each<Role[]>([['resident'], ['security'], ['property_management'], ['council']])('%s opens the feed, in the nav', async (role) => {
    stubApi(member(THREE(), {}, [role]));
    renderApp(['/notices']);
    expect(await cards()).toHaveLength(3);
    expect(await navLink('Notices, 2 unread')).toBeTruthy();
  });

  it('a signed-out user goes to login with the way back', async () => {
    const fetchMock = stubApi({ 'GET /api/auth/me': () => problem(401, 'not_authenticated') });
    const app = renderApp(['/notices']);
    await waitFor(() => expect(app.location().pathname).toBe('/login'));
    expect(app.location().search).toContain(encodeURIComponent('/notices'));
    expect(calls(fetchMock).some((call) => call.includes('/notices'))).toBe(false);
  });

  it('a building with notices off gives /403, no notices request and no nav item', async () => {
    const fetchMock = stubApi(member(THREE(), {}, ['resident'], ['packages', 'maintenance']));
    const app = renderApp(['/notices']);
    await waitFor(() => expect(app.location().pathname).toBe('/403'));
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).queryByRole('link', { name: /^Notices/ })).toBeNull();
    await settle();
    expect(calls(fetchMock).some((call) => call.startsWith(`GET ${BASE}`))).toBe(false);
  });

  it('/notices/<id>, the notifications’ link, shows the feed', async () => {
    stubApi(member(THREE()));
    const app = renderApp([`/notices/${notice(1).id}`]);
    expect(await cards()).toHaveLength(3);
    expect(app.location().pathname).toBe(`/notices/${notice(1).id}`);
  });
});

describe('the feed follows the badge (criterion 5)', () => {
  it('asks the feed again, cancelled first, when the polled unread count changes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const state = THREE();
    const fetchMock = stubApi(member(state));
    renderApp(['/notices']);
    expect(await cards()).toHaveLength(3);
    const before = listCalls(fetchMock).length;

    state.notices = [notice(4, { title: 'New one' }), ...state.notices];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(await screen.findByRole('heading', { name: 'New one' })).toBeTruthy();
    expect(listCalls(fetchMock).length).toBe(before + 1);
  });

  it('does not ask the feed again while the count stays the same', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = stubApi(member(THREE()));
    renderApp(['/notices']);
    await cards();
    const before = listCalls(fetchMock).length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await settle();
    expect(listCalls(fetchMock).length).toBe(before);
  });

  it('waits for the first count before asking for the feed', async () => {
    let answer: (() => void) | undefined;
    const fetchMock = stubApi(
      member(THREE(), {
        [`GET ${BASE}/summary`]: () => new Promise<Response>((resolve) => (answer = () => resolve(json({ unread: 2, urgent_unread: 0 })))),
      }),
    );
    renderApp(['/notices']);
    await screen.findByRole('heading', { name: 'Notices', level: 1 });
    await settle();
    expect(listCalls(fetchMock)).toHaveLength(0);
    answer!();
    expect(await cards()).toHaveLength(3);
    expect(listCalls(fetchMock)).toHaveLength(1);
  });

  it('a feed answer that started before a change is not kept', async () => {
    // The first count is 2; the first list is held until the count has moved to 3 and back on its way: the list asked
    // before the change must not be what stays on screen.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const state = THREE();
    let release: (() => void) | undefined;
    let first = true;
    stubApi(
      member(state, {
        [`GET ${BASE}`]: () => {
          if (!first) return page(state.notices);
          first = false;
          const old = [...state.notices];
          return new Promise<Response>((resolve) => (release = () => resolve(page(old))));
        },
      }),
    );
    renderApp(['/notices']);
    await waitFor(() => expect(release).toBeDefined());
    state.notices = [notice(4, { title: 'New one' }), ...state.notices];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    release!();
    expect(await screen.findByRole('heading', { name: 'New one' })).toBeTruthy();
  });
});

describe('switching building (criterion 10)', () => {
  it('shows only the new building’s badge and feed', async () => {
    const birch = `/api/buildings/${BIRCH.id}/notices`;
    stubApi({
      'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE), membership(BIRCH)] }),
      [`GET /api/buildings/${BIRCH.id}`]: () => json(buildingOut(BIRCH, ['resident'])),
      [`GET /api/buildings/${BIRCH.id}/notifications/summary`]: () => json({ unread_count: 0 }),
      ...noticesApi(THREE()),
      [`GET ${birch}`]: () => new Promise<Response>(() => {}),
      [`GET ${birch}/summary`]: () => json({ unread: 7, urgent_unread: 0 }),
    });
    writeSelectedBuilding(MAPLE.id);
    renderApp(['/notices']);
    expect(await cards()).toHaveLength(3);

    openAccountMenu();
    fireEvent.change(screen.getByRole('combobox', { name: 'Building' }), { target: { value: BIRCH.id } });

    // The switch goes home (P2-06a); the nav's badge is B's at once, and B's feed shows none of A's cards.
    fireEvent.click(await navLink('Notices, 7 unread'));
    expect(await screen.findByText('Loading notices…')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Notice 3' })).toBeNull();
  });
});
