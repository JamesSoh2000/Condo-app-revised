// @vitest-environment jsdom
/**
 * P3-05: the header's notification bell and panel. Each `describe` names the criterion it proves
 * (docs/tickets/P3-05-frontend-notification-center.md). The shell is rendered for real; only `fetch` is stubbed.
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

type Notification = components['schemas']['NotificationOut'];

const KEY = 'condo.buildingId';

let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  // React Query's focus manager listens on window.
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

let sequence = 0;
function notification(overrides: Partial<Notification> = {}): Notification {
  sequence += 1;
  return {
    id: `01929a4e-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
    kind: 'package.arrived',
    title: `Notification ${sequence}`,
    body: 'A package is waiting at the front desk.',
    link: '/Maintenance',
    entity_type: null,
    entity_id: null,
    read_at: null,
    created_at: '2026-10-18T12:00:00Z',
    ...overrides,
  };
}

const base = (building: { id: string }) => `/api/buildings/${building.id}/notifications`;

/**
 * A server holding `items` for `building`: the summary counts the unread ones, read and read-all mark them.
 * `pages` splits the list (each page's next_cursor is the following page's index).
 */
function notificationServer(building: { id: string }, items: Notification[], { pageSize = 25 } = {}) {
  const state = { items };
  const routes: Record<string, Handler> = {
    [`GET ${base(building)}/summary`]: () =>
      json({ unread_count: state.items.filter((item) => item.read_at === null).length }),
    [`GET ${base(building)}`]: (request) => {
      const cursor = new URL(request.url).searchParams.get('cursor');
      const start = cursor === null ? 0 : Number(cursor.replace(/^c+/, '')) || 0;
      const page = state.items.slice(start, start + pageSize);
      const next = start + pageSize < state.items.length ? `c${start + pageSize}`.padStart(22, 'c') : null;
      return json({ items: page, next_cursor: next });
    },
    [`POST ${base(building)}/read-all`]: () => {
      state.items = state.items.map((item) => ({ ...item, read_at: item.read_at ?? '2026-10-18T12:05:00Z' }));
      return noContent();
    },
  };
  for (const item of items) {
    routes[`POST ${base(building)}/${item.id}/read`] = () => {
      state.items = state.items.map((other) =>
        other.id === item.id ? { ...other, read_at: other.read_at ?? '2026-10-18T12:05:00Z' } : other,
      );
      return noContent();
    };
  }
  return { state, routes };
}

const location = () => screen.getByTestId('location').textContent;
const bell = (name: RegExp | string = /^notifications/i) => screen.findByRole('button', { name });
const panel = () => screen.getByRole('region', { name: /notifications/i });
const liveRegion = () => document.querySelector('[aria-live="polite"]');
const notificationCalls = (fetchMock: ReturnType<typeof stubApi>) =>
  calls(fetchMock).filter((call) => call.includes('/notifications'));
const summaryCalls = (fetchMock: ReturnType<typeof stubApi>) =>
  notificationCalls(fetchMock).filter((call) => call.endsWith('/summary'));

async function openPanel() {
  fireEvent.click(await bell());
  return panel();
}

describe('the badge polls every 30 s while the tab is visible (criterion 1)', () => {
  it('asks again at 30 s, not before, and shows the new count', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = notificationServer(MAPLE, [notification()]);
    const fetchMock = stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME), ...server.routes });

    renderApp(['/']);
    expect(await bell('Notifications, 1 unread')).toBeTruthy();
    expect(summaryCalls(fetchMock)).toHaveLength(1);

    server.state.items = [notification(), ...server.state.items];
    await act(() => vi.advanceTimersByTimeAsync(29_000));
    expect(summaryCalls(fetchMock)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Notifications, 1 unread' })).toBeTruthy();

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(await bell('Notifications, 2 unread')).toBeTruthy();
    expect(summaryCalls(fetchMock)).toHaveLength(2);
  });
});

describe('no polling in a hidden tab (criterion 2)', () => {
  it('makes no summary request while hidden, and asks again as soon as it is visible', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = notificationServer(MAPLE, [notification()]);
    const fetchMock = stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME), ...server.routes });

    renderApp(['/']);
    await bell('Notifications, 1 unread');
    expect(summaryCalls(fetchMock)).toHaveLength(1);

    setVisibility('hidden');
    await act(() => vi.advanceTimersByTimeAsync(90_000));
    expect(summaryCalls(fetchMock)).toHaveLength(1);

    server.state.items = [notification(), ...server.state.items];
    setVisibility('visible');
    expect(await bell('Notifications, 2 unread')).toBeTruthy();
    expect(summaryCalls(fetchMock)).toHaveLength(2);
  });
});

describe('mark all read (criterion 3)', () => {
  it('posts once, fetches the summary and the list again, and clears the badge and the unread marks', async () => {
    const items = [notification(), notification(), notification({ read_at: '2026-10-17T00:00:00Z' })];
    const server = notificationServer(MAPLE, items);
    const fetchMock = stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME), ...server.routes });

    renderApp(['/']);
    await bell('Notifications, 2 unread');
    const region = await openPanel();
    await within(region).findByText(items[0].title);
    expect(within(region).getAllByText('Unread')).toHaveLength(2);
    const before = notificationCalls(fetchMock).length;

    fireEvent.click(within(region).getByRole('button', { name: /mark all read/i }));

    expect(await bell('Notifications, 0 unread')).toBeTruthy();
    await waitFor(() => expect(within(panel()).queryAllByText('Unread')).toHaveLength(0));
    const after = notificationCalls(fetchMock).slice(before);
    expect(after[0]).toBe(`POST ${base(MAPLE)}/read-all`);
    expect(after.filter((call) => call.startsWith('POST'))).toHaveLength(1);
    expect(after).toContain(`GET ${base(MAPLE)}/summary`);
    expect(after).toContain(`GET ${base(MAPLE)}`);
    expect(within(panel()).getByRole('button', { name: /mark all read/i })).toHaveProperty('disabled', true);
  });

  it('is disabled when nothing is unread', async () => {
    const server = notificationServer(MAPLE, [notification({ read_at: '2026-10-17T00:00:00Z' })]);
    stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME), ...server.routes });

    renderApp(['/']);
    await bell('Notifications, 0 unread');
    const region = await openPanel();
    await within(region).findByText(/notification \d+/i);
    expect(within(region).getByRole('button', { name: /mark all read/i })).toHaveProperty('disabled', true);
  });
});

describe('clicking a notification (criteria 4 and 10)', () => {
  it('marks it read, navigates to its link, closes the panel and refreshes the badge', async () => {
    const target = notification({ link: '/Maintenance' });
    const server = notificationServer(MAPLE, [target, notification()]);
    const fetchMock = stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME), ...server.routes });

    renderApp(['/']);
    await bell('Notifications, 2 unread');
    const region = await openPanel();
    fireEvent.click(await within(region).findByRole('button', { name: new RegExp(target.title) }));

    await waitFor(() => expect(location()).toBe('/Maintenance'));
    expect(screen.queryByRole('region', { name: /notifications/i })).toBeNull();
    expect(await bell('Notifications, 1 unread')).toBeTruthy();
    expect(notificationCalls(fetchMock)).toContain(`POST ${base(MAPLE)}/${target.id}/read`);
  });

  it('marks a notification without a link read and stays on the page', async () => {
    const target = notification({ link: null });
    const server = notificationServer(MAPLE, [target]);
    const fetchMock = stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME), ...server.routes });

    renderApp(['/']);
    const region = await openPanel();
    fireEvent.click(await within(region).findByRole('button', { name: new RegExp(target.title) }));

    expect(await bell('Notifications, 0 unread')).toBeTruthy();
    expect(location()).toBe('/');
    expect(notificationCalls(fetchMock)).toContain(`POST ${base(MAPLE)}/${target.id}/read`);
  });

  it('sends nothing for a notification that is already read, and still follows its link', async () => {
    const target = notification({ read_at: '2026-10-17T00:00:00Z', link: '/Maintenance' });
    const server = notificationServer(MAPLE, [target]);
    const fetchMock = stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME), ...server.routes });

    renderApp(['/']);
    const region = await openPanel();
    fireEvent.click(await within(region).findByRole('button', { name: new RegExp(target.title) }));

    await waitFor(() => expect(location()).toBe('/Maintenance'));
    expect(notificationCalls(fetchMock).filter((call) => call.startsWith('POST'))).toEqual([]);
  });

  it.each(['//evil.example/x', 'https://evil.example/', '/\\evil.example', 'javascript:alert(1)', 'Maintenance'])(
    'marks a notification linking to %s read but does not follow the link',
    async (link) => {
      const target = notification({ link });
      const server = notificationServer(MAPLE, [target]);
      const fetchMock = stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME), ...server.routes });

      renderApp(['/']);
      const region = await openPanel();
      fireEvent.click(await within(region).findByRole('button', { name: new RegExp(target.title) }));

      expect(await bell('Notifications, 0 unread')).toBeTruthy();
      expect(location()).toBe('/');
      expect(notificationCalls(fetchMock)).toContain(`POST ${base(MAPLE)}/${target.id}/read`);
    },
  );
});

describe('a building switch (criterion 5)', () => {
  it('shows only the new building’s notifications and drops the old building’s queries', async () => {
    const maple = notificationServer(MAPLE, [notification({ title: 'Maple notice' })]);
    const birch = notificationServer(BIRCH, [
      notification({ title: 'Birch notice' }),
      notification({ title: 'Birch second' }),
    ]);
    const fetchMock = stubApi({
      'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE), membership(BIRCH)] }),
      [`GET /api/buildings/${BIRCH.id}`]: () => json(buildingOut(BIRCH, ['resident'])),
      ...maple.routes,
      ...birch.routes,
    });
    sessionStorage.setItem(KEY, MAPLE.id);

    const app = renderApp(['/']);
    await bell('Notifications, 1 unread');
    await within(await openPanel()).findByText('Maple notice');
    fireEvent.keyDown(panel(), { key: 'Escape' });
    const before = notificationCalls(fetchMock).length;

    openAccountMenu();
    fireEvent.change(screen.getByLabelText(/building/i), { target: { value: BIRCH.id } });

    expect(await bell('Notifications, 2 unread')).toBeTruthy();
    const region = await openPanel();
    expect(await within(region).findByText('Birch notice')).toBeTruthy();
    expect(within(region).queryByText('Maple notice')).toBeNull();
    const after = notificationCalls(fetchMock).slice(before);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((call) => call.includes(`/api/buildings/${BIRCH.id}/`) || call.endsWith(BIRCH.id + '/notifications'))).toBe(true);
    expect(app.queryClient.getQueryCache().findAll({ queryKey: ['b', MAPLE.id] })).toEqual([]);
  });
});

describe('another user in this tab (criterion 5, a server-driven change)', () => {
  it('drops the previous user’s notifications and shows the new user’s building', async () => {
    // Another tab logged in as Kim, a member of Birch only: /me now answers Kim (P2-06b).
    let me = RESIDENT_ME;
    const maple = notificationServer(MAPLE, [notification({ title: 'Alex’s notice' })]);
    const birch = notificationServer(BIRCH, [notification({ title: 'Kim’s notice' }), notification()]);
    const fetchMock = stubApi({
      'GET /api/auth/me': () => json(me),
      [`GET /api/buildings/${BIRCH.id}`]: () => json(buildingOut(BIRCH, ['resident'])),
      ...maple.routes,
      ...birch.routes,
    });
    const app = renderApp(['/']);
    await bell('Notifications, 1 unread');
    const before = notificationCalls(fetchMock).length;

    me = { user: { ...RESIDENT_ME.user, id: 'kim', full_name: 'Kim Laurent' }, memberships: [membership(BIRCH)] };
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['me'] }));

    expect(await bell('Notifications, 2 unread')).toBeTruthy();
    expect(await within(await openPanel()).findByText('Kim’s notice')).toBeTruthy();
    expect(screen.queryByText('Alex’s notice')).toBeNull();
    expect(notificationCalls(fetchMock).slice(before).every((call) => call.includes(BIRCH.id))).toBe(true);
    expect(app.queryClient.getQueryCache().findAll({ queryKey: ['b', MAPLE.id] })).toEqual([]);
  });
});

describe('screen readers and the keyboard (criterion 6)', () => {
  it('names the bell with the count and announces a change politely', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = notificationServer(MAPLE, [notification()]);
    stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME), ...server.routes });

    renderApp(['/']);
    const button = await bell('Notifications, 1 unread');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(liveRegion()?.textContent).toBe('1 unread notification');

    server.state.items = [notification(), notification(), ...server.state.items];
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    await bell('Notifications, 3 unread');
    expect(liveRegion()?.textContent).toBe('3 unread notifications');
  });

  it('opens as a disclosure; Escape closes it and returns focus to the bell', async () => {
    const server = notificationServer(MAPLE, [notification()]);
    stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME), ...server.routes });

    renderApp(['/']);
    const button = await bell('Notifications, 1 unread');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const region = panel();
    expect(button.getAttribute('aria-controls')).toBe(region.id);
    const item = await within(region).findByRole('button', { name: /notification \d+/i });
    item.focus();

    fireEvent.keyDown(item, { key: 'Escape' });

    expect(screen.queryByRole('region', { name: /notifications/i })).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  it('closes on a click outside', async () => {
    const server = notificationServer(MAPLE, [notification()]);
    stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME), ...server.routes });

    renderApp(['/']);
    await openPanel();
    fireEvent.mouseDown(screen.getByRole('main'));
    expect(screen.queryByRole('region', { name: /notifications/i })).toBeNull();
  });
});

describe('no building, no bell (criterion 8)', () => {
  it.each([
    ['the picker', [membership(MAPLE), membership(BIRCH)]],
    ['a pending membership', [membership(MAPLE, { status: 'pending' })]],
  ])('shows no bell and asks for no notifications on %s', async (_label, memberships) => {
    const fetchMock = stubApi({ 'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships }) });

    renderApp(['/']);
    expect(await screen.findByText('Alex Chen')).toBeTruthy();
    await act(() => new Promise((resolve) => setTimeout(resolve, 25)));
    expect(screen.queryByRole('button', { name: /^notifications/i })).toBeNull();
    expect(notificationCalls(fetchMock)).toEqual([]);
  });
});

describe('the list (criteria 9 and 12)', () => {
  it('is requested only while the panel is open, and Load more fetches the next page with the cursor', async () => {
    const items = Array.from({ length: 30 }, () => notification());
    const server = notificationServer(MAPLE, items);
    const fetchMock = stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME), ...server.routes });

    renderApp(['/']);
    await bell('Notifications, 30 unread');
    expect(notificationCalls(fetchMock).filter((call) => call === `GET ${base(MAPLE)}`)).toEqual([]);

    const region = await openPanel();
    await within(region).findByText(items[0].title);
    expect(within(region).queryByText(items[25].title)).toBeNull();

    fireEvent.click(within(region).getByRole('button', { name: /load more/i }));

    expect(await within(region).findByText(items[29].title)).toBeTruthy();
    expect(within(region).getByText(items[0].title)).toBeTruthy();
    const listRequests = fetchMock.mock.calls
      .map(([request]) => new URL(request.url))
      .filter((url) => url.pathname === base(MAPLE));
    expect(listRequests.map((url) => url.searchParams.get('cursor'))).toEqual([null, 'c25'.padStart(22, 'c')]);
    expect(within(region).queryByRole('button', { name: /load more/i })).toBeNull();
  });

  it('shows an empty state', async () => {
    const server = notificationServer(MAPLE, []);
    stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME), ...server.routes });

    renderApp(['/']);
    await bell('Notifications, 0 unread');
    const region = await openPanel();
    expect(await within(region).findByText(/no notifications/i)).toBeTruthy();
  });
});

describe('errors (criterion 11)', () => {
  it('keeps the bell without a count when the summary fails', async () => {
    stubApi({
      'GET /api/auth/me': () => json(RESIDENT_ME),
      [`GET ${base(MAPLE)}/summary`]: () => problem(500, 'internal_error'),
    });

    renderApp(['/']);
    expect(await bell('Notifications')).toBeTruthy();
    await act(() => new Promise((resolve) => setTimeout(resolve, 25)));
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy();
  });

  it('shows an error when mark all read fails, and the badge keeps its count', async () => {
    const server = notificationServer(MAPLE, [notification()]);
    stubApi({
      'GET /api/auth/me': () => json(RESIDENT_ME),
      ...server.routes,
      [`POST ${base(MAPLE)}/read-all`]: () => problem(500, 'internal_error'),
    });

    renderApp(['/']);
    await bell('Notifications, 1 unread');
    const region = await openPanel();
    await within(region).findByText(/notification \d+/i);
    fireEvent.click(within(region).getByRole('button', { name: /mark all read/i }));

    expect((await within(region).findByRole('alert')).textContent).toMatch(/could not mark/i);
    expect(screen.getByRole('button', { name: 'Notifications, 1 unread' })).toBeTruthy();
  });

  it('shows an error when marking one notification read fails', async () => {
    const target = notification({ link: null });
    const server = notificationServer(MAPLE, [target]);
    stubApi({
      'GET /api/auth/me': () => json(RESIDENT_ME),
      ...server.routes,
      [`POST ${base(MAPLE)}/${target.id}/read`]: () => problem(500, 'internal_error'),
    });

    renderApp(['/']);
    const region = await openPanel();
    fireEvent.click(await within(region).findByRole('button', { name: new RegExp(target.title) }));

    expect((await within(region).findByRole('alert')).textContent).toMatch(/could not mark/i);
    expect(screen.getByRole('button', { name: 'Notifications, 1 unread' })).toBeTruthy();
  });
});
