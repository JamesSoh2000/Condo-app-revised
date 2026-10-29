// @vitest-environment jsdom
/**
 * P3-05: the header's notification bell and panel. Each `describe` names the criterion it proves
 * (docs/tickets/P3-05-frontend-notification-center.md). The shell is rendered for real; only `fetch` is stubbed.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { toApiError } from '@/api/errors';
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
    link: '/Dashboard',
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
    const target = notification({ link: '/Dashboard' });
    const server = notificationServer(MAPLE, [target, notification()]);
    const fetchMock = stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME), ...server.routes });

    renderApp(['/']);
    await bell('Notifications, 2 unread');
    const region = await openPanel();
    fireEvent.click(await within(region).findByRole('button', { name: new RegExp(target.title) }));

    await waitFor(() => expect(location()).toBe('/Dashboard'));
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
    const target = notification({ read_at: '2026-10-17T00:00:00Z', link: '/Dashboard' });
    const server = notificationServer(MAPLE, [target]);
    const fetchMock = stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME), ...server.routes });

    renderApp(['/']);
    const region = await openPanel();
    fireEvent.click(await within(region).findByRole('button', { name: new RegExp(target.title) }));

    await waitFor(() => expect(location()).toBe('/Dashboard'));
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
    fireEvent.pointerDown(screen.getByRole('main'));
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

describe('review round 1 (Codex gpt-6.1-sol)', () => {
  it('F2: asks again at once when the tab is visible after only 5 s hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = notificationServer(MAPLE, [notification()]);
    const fetchMock = stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME), ...server.routes });

    renderApp(['/']);
    await bell('Notifications, 1 unread');
    setVisibility('hidden');
    server.state.items = [notification(), ...server.state.items];
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(summaryCalls(fetchMock)).toHaveLength(1);

    setVisibility('visible');
    expect(await bell('Notifications, 2 unread')).toBeTruthy();
    expect(summaryCalls(fetchMock)).toHaveLength(2);
  });

  it('F3: drops the count while a refresh of the summary fails, and shows it again when it recovers', async () => {
    let broken = false;
    const server = notificationServer(MAPLE, [notification()]);
    stubApi({
      'GET /api/auth/me': () => json(RESIDENT_ME),
      ...server.routes,
      [`GET ${base(MAPLE)}/summary`]: (request) =>
        broken ? problem(500, 'internal_error') : server.routes[`GET ${base(MAPLE)}/summary`](request),
    });
    const app = renderApp(['/']);
    await bell('Notifications, 1 unread');

    broken = true;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'notifications', 'summary'] }));
    expect(await bell('Notifications')).toBeTruthy();
    expect(liveRegion()?.textContent).toBe('');

    broken = false;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'notifications', 'summary'] }));
    expect(await bell('Notifications, 1 unread')).toBeTruthy();
  });

  it('F4: keeps a failed mark-read of a linked notification, so the reopened panel shows the error', async () => {
    const target = notification({ link: '/Dashboard' });
    const server = notificationServer(MAPLE, [target]);
    stubApi({
      'GET /api/auth/me': () => json(RESIDENT_ME),
      ...server.routes,
      [`POST ${base(MAPLE)}/${target.id}/read`]: () => problem(500, 'internal_error'),
    });
    renderApp(['/']);
    fireEvent.click(await within(await openPanel()).findByRole('button', { name: new RegExp(target.title) }));

    await waitFor(() => expect(location()).toBe('/Dashboard'));
    const region = await openPanel();
    expect((await within(region).findByRole('alert')).textContent).toMatch(/could not mark/i);
  });

  it('F4 neighbour: a later successful mark-read clears the error', async () => {
    const failing = notification({ link: null, title: 'Failing one' });
    const fine = notification({ link: null, title: 'Fine one' });
    const server = notificationServer(MAPLE, [failing, fine]);
    stubApi({
      'GET /api/auth/me': () => json(RESIDENT_ME),
      ...server.routes,
      [`POST ${base(MAPLE)}/${failing.id}/read`]: () => problem(500, 'internal_error'),
    });
    renderApp(['/']);
    const region = await openPanel();
    fireEvent.click(await within(region).findByRole('button', { name: /failing one/i }));
    await within(region).findByRole('alert');

    fireEvent.click(within(region).getByRole('button', { name: /fine one/i }));
    await waitFor(() => expect(within(region).queryByRole('alert')).toBeNull());
  });

  it('F4 neighbour: a successful mark-read after a failed mark-all-read clears the error', async () => {
    const target = notification({ link: null, title: 'Single one' });
    const server = notificationServer(MAPLE, [target, notification()]);
    stubApi({
      'GET /api/auth/me': () => json(RESIDENT_ME),
      ...server.routes,
      [`POST ${base(MAPLE)}/read-all`]: () => problem(500, 'internal_error'),
    });
    renderApp(['/']);
    await bell('Notifications, 2 unread');
    const region = await openPanel();
    await within(region).findByText('Single one');
    fireEvent.click(within(region).getByRole('button', { name: /mark all read/i }));
    await within(region).findByRole('alert');

    fireEvent.click(within(region).getByRole('button', { name: /single one/i }));
    await waitFor(() => expect(within(region).queryByRole('alert')).toBeNull());
    expect(await bell('Notifications, 1 unread')).toBeTruthy();
  });

  it('F4 neighbour: a failed mark-all-read is not shown in another building', async () => {
    const maple = notificationServer(MAPLE, [notification()]);
    const birch = notificationServer(BIRCH, [notification({ title: 'Birch notice' })]);
    stubApi({
      'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE), membership(BIRCH)] }),
      [`GET /api/buildings/${BIRCH.id}`]: () => json(buildingOut(BIRCH, ['resident'])),
      ...maple.routes,
      ...birch.routes,
      [`POST ${base(MAPLE)}/read-all`]: () => problem(500, 'internal_error'),
    });
    sessionStorage.setItem(KEY, MAPLE.id);
    renderApp(['/']);
    const region = await openPanel();
    await within(region).findByText(/notification \d+/i);
    fireEvent.click(within(region).getByRole('button', { name: /mark all read/i }));
    await within(region).findByRole('alert');
    fireEvent.keyDown(region, { key: 'Escape' });

    openAccountMenu();
    fireEvent.change(screen.getByLabelText(/building/i), { target: { value: BIRCH.id } });
    await bell('Notifications, 1 unread');
    const birchPanel = await openPanel();
    await within(birchPanel).findByText('Birch notice');
    expect(within(birchPanel).queryByRole('alert')).toBeNull();
  });

  it.each([
    [404, 'building_not_found'],
    [401, 'unauthorized'],
  ])('F1: hides the bell and its cached notifications when the building refetch answers %s', async (status, code) => {
    let revoked = false;
    const target = notification({ title: 'Private package notice' });
    const server = notificationServer(MAPLE, [target]);
    stubApi({
      // A 401 means the session is gone, so /me says so too.
      'GET /api/auth/me': () => (revoked && status === 401 ? problem(401, code) : json(RESIDENT_ME)),
      ...server.routes,
      [`GET /api/buildings/${MAPLE.id}`]: () =>
        revoked ? problem(status, code) : json(buildingOut(MAPLE, ['resident'])),
    });
    const app = renderApp(['/']);
    await within(await openPanel()).findByText(target.title);

    revoked = true;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'building'] }));

    await waitFor(() => expect(screen.queryByRole('button', { name: /^notifications/i })).toBeNull());
    expect(screen.queryByText(target.title)).toBeNull();
  });

  it('F1 neighbour: keeps the bell when the building refetch fails with a 5xx (cached building still shown)', async () => {
    let broken = false;
    const server = notificationServer(MAPLE, [notification()]);
    stubApi({
      'GET /api/auth/me': () => json(RESIDENT_ME),
      ...server.routes,
      [`GET /api/buildings/${MAPLE.id}`]: () =>
        broken ? problem(500, 'internal_error') : json(buildingOut(MAPLE, ['resident'])),
    });
    const app = renderApp(['/']);
    await bell('Notifications, 1 unread');

    broken = true;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'building'] }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 25)));
    expect(screen.getByRole('button', { name: 'Notifications, 1 unread' })).toBeTruthy();
  });
});

describe('review round 2 (Codex gpt-6.1-sol)', () => {
  it('R2-F1: a 5xx after a building 404 neither brings the bell back nor its cached notifications', async () => {
    let status = 200;
    const target = notification({ title: 'Revoked building private notice' });
    const server = notificationServer(MAPLE, [target]);
    const down = (request: Request, ok: Handler) => (status === 200 ? ok(request) : problem(status, 'building_not_found'));
    stubApi({
      'GET /api/auth/me': () => (status === 500 ? problem(500, 'internal_error') : json(RESIDENT_ME)),
      [`GET /api/buildings/${MAPLE.id}`]: (request) => down(request, () => json(buildingOut(MAPLE, ['resident']))),
      [`GET ${base(MAPLE)}/summary`]: (request) => down(request, server.routes[`GET ${base(MAPLE)}/summary`]),
      [`GET ${base(MAPLE)}`]: (request) => down(request, server.routes[`GET ${base(MAPLE)}`]),
    });
    const app = renderApp(['/']);
    await within(await openPanel()).findByText(target.title);

    status = 404;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'building'] }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^notifications/i })).toBeNull());
    expect(app.queryClient.getQueryCache().findAll({ queryKey: ['b', MAPLE.id, 'notifications'] })).toEqual([]);

    status = 500;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'building'] }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(app.queryClient.getQueryState(['b', MAPLE.id, 'building'])?.error).toHaveProperty('status', 500);
    expect(screen.queryByRole('button', { name: /^notifications/i })).toBeNull();
    expect(screen.queryByText(target.title)).toBeNull();

    // Access restored: a successful building answer newer than the 404 brings the bell back.
    status = 200;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'building'] }));
    expect(await bell('Notifications, 1 unread')).toBeTruthy();
  });

  it('R2-F1 neighbour: "Choose again" after a 404 brings the bell back once the building loads again', async () => {
    let status = 200;
    const server = notificationServer(MAPLE, [notification()]);
    stubApi({
      'GET /api/auth/me': () => json(RESIDENT_ME),
      ...server.routes,
      [`GET /api/buildings/${MAPLE.id}`]: () =>
        status === 200 ? json(buildingOut(MAPLE, ['resident'])) : problem(404, 'building_not_found'),
    });
    const app = renderApp(['/']);
    await bell('Notifications, 1 unread');

    status = 404;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'building'] }));
    const chooseAgain = await screen.findByRole('button', { name: /choose again/i });
    expect(screen.queryByRole('button', { name: /^notifications/i })).toBeNull();

    status = 200;
    fireEvent.click(chooseAgain);
    expect(await bell('Notifications, 1 unread')).toBeTruthy();
  });

  it.each(['mark-read', 'mark-all-read'] as const)(
    'R2-F2: while a %s is pending, the read actions are disabled, and its failure shows',
    async (firstAction) => {
      const first = notification({ link: null, title: 'First unread notice' });
      const second = notification({ link: null, title: 'Second unread notice' });
      const server = notificationServer(MAPLE, [first, second]);
      let finishFirst!: (response: Response) => void;
      const firstReply = new Promise<Response>((resolve) => (finishFirst = resolve));
      const fetchMock = stubApi({
        'GET /api/auth/me': () => json(RESIDENT_ME),
        ...server.routes,
        [`POST ${base(MAPLE)}/${first.id}/read`]: () => firstReply,
        [`POST ${base(MAPLE)}/read-all`]: () => firstReply,
      });
      renderApp(['/']);
      await bell('Notifications, 2 unread');
      const region = await openPanel();
      await within(region).findByText('First unread notice');
      fireEvent.click(
        within(region).getByRole('button', { name: firstAction === 'mark-read' ? /first unread notice/i : /mark all read/i }),
      );

      const secondButton = within(region).getByRole('button', { name: /second unread notice/i });
      await waitFor(() => expect(secondButton).toHaveProperty('disabled', true));
      expect(within(region).getByRole('button', { name: /mark all read/i })).toHaveProperty('disabled', true);
      fireEvent.click(secondButton);

      await act(async () => {
        finishFirst(problem(500, 'internal_error'));
        await firstReply;
      });
      expect((await within(region).findByRole('alert')).textContent).toMatch(/could not mark/i);
      expect(notificationCalls(fetchMock)).not.toContain(`POST ${base(MAPLE)}/${second.id}/read`);
      await waitFor(() => expect(secondButton).toHaveProperty('disabled', false));
    },
  );

  it('coverage: the open list does not poll with the summary', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = notificationServer(MAPLE, [notification()]);
    const fetchMock = stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME), ...server.routes });
    renderApp(['/']);
    await within(await openPanel()).findByText(/notification \d+/i);

    await act(() => vi.advanceTimersByTimeAsync(90_000));

    expect(notificationCalls(fetchMock).filter((call) => call === `GET ${base(MAPLE)}`)).toHaveLength(1);
    expect(summaryCalls(fetchMock)).toHaveLength(4);
  });

  it('coverage: /me ending the membership hides the open panel and drops its notifications', async () => {
    let me = RESIDENT_ME;
    const target = notification({ title: 'Removed membership private notice' });
    const server = notificationServer(MAPLE, [target]);
    stubApi({ 'GET /api/auth/me': () => json(me), ...server.routes });
    const app = renderApp(['/']);
    await within(await openPanel()).findByText(target.title);

    me = { ...RESIDENT_ME, memberships: [] };
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['me'] }));

    await waitFor(() => expect(screen.queryByRole('button', { name: /^notifications/i })).toBeNull());
    expect(screen.queryByText(target.title)).toBeNull();
    expect(app.queryClient.getQueryCache().findAll({ queryKey: ['b', MAPLE.id] })).toEqual([]);
  });
});

describe('review round 3 (Codex gpt-6.1-sol) and inbox B-5: one shared building denial', () => {
  /** Maple answers 200 until `state.status` changes; the building and the notification routes all follow it. */
  function revocableMaple(items: Notification[]) {
    const state = { status: 200 };
    const server = notificationServer(MAPLE, items);
    const follow = (ok: Handler): Handler => (request) =>
      state.status === 200 ? ok(request) : problem(state.status, state.status === 404 ? 'building_not_found' : 'internal_error');
    const routes: Record<string, Handler> = {
      'GET /api/auth/me': () => json(RESIDENT_ME),
      ...server.routes,
      [`GET /api/buildings/${MAPLE.id}`]: follow(() => json(buildingOut(MAPLE, ['resident']))),
      [`GET ${base(MAPLE)}/summary`]: follow(server.routes[`GET ${base(MAPLE)}/summary`]),
      [`GET ${base(MAPLE)}`]: follow(server.routes[`GET ${base(MAPLE)}`]),
    };
    return { state, routes };
  }
  const denialShown = async () => {
    await waitFor(() => expect(screen.queryByRole('button', { name: /^notifications/i })).toBeNull());
    expect(await screen.findByRole('heading', { name: /no longer have access/i })).toBeTruthy();
  };

  it('R3-F1: a summary poll answering building_not_found hides the open panel, drops the rows and shows lost access', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const target = notification({ title: 'Private package notice' });
    const maple = revocableMaple([target]);
    const fetchMock = stubApi(maple.routes);
    const app = renderApp(['/']);
    await within(await openPanel()).findByText(target.title);
    const buildingRequests = () => calls(fetchMock).filter((call) => call === `GET /api/buildings/${MAPLE.id}`).length;
    const before = buildingRequests();

    maple.state.status = 404;
    await act(() => vi.advanceTimersByTimeAsync(30_000));

    await denialShown();
    expect(screen.queryByText(target.title)).toBeNull();
    expect(app.queryClient.getQueryCache().findAll({ queryKey: ['b', MAPLE.id, 'notifications'] })).toEqual([]);
    // Only the summary told us: the building itself was not asked again.
    expect(buildingRequests()).toBe(before);
  });

  it('R3-F1: a list refetch answering building_not_found hides its previous rows', async () => {
    const target = notification({ title: 'Private package notice' });
    const maple = revocableMaple([target]);
    stubApi(maple.routes);
    renderApp(['/']);
    await within(await openPanel()).findByText(target.title);
    fireEvent.keyDown(panel(), { key: 'Escape' });

    maple.state.status = 404;
    fireEvent.click(await bell());

    await denialShown();
    expect(screen.queryByText(target.title)).toBeNull();
  });

  it('R3-F1 neighbour: a mark-read answering building_not_found is a denial too', async () => {
    const target = notification({ link: null, title: 'Private package notice' });
    const server = notificationServer(MAPLE, [target]);
    stubApi({
      'GET /api/auth/me': () => json(RESIDENT_ME),
      ...server.routes,
      [`POST ${base(MAPLE)}/${target.id}/read`]: () => problem(404, 'building_not_found'),
    });
    renderApp(['/']);
    fireEvent.click(await within(await openPanel()).findByRole('button', { name: /private package notice/i }));

    await denialShown();
    expect(screen.queryByText(target.title)).toBeNull();
  });

  it('R3-F1 neighbour: notification_not_found on a mark-read is only that notification, not a denial', async () => {
    const target = notification({ link: null, title: 'Gone notice' });
    const server = notificationServer(MAPLE, [target]);
    stubApi({
      'GET /api/auth/me': () => json(RESIDENT_ME),
      ...server.routes,
      [`POST ${base(MAPLE)}/${target.id}/read`]: () => problem(404, 'notification_not_found'),
    });
    renderApp(['/']);
    const region = await openPanel();
    fireEvent.click(await within(region).findByRole('button', { name: /gone notice/i }));

    expect((await within(region).findByRole('alert')).textContent).toMatch(/could not mark/i);
    expect(screen.getByRole('button', { name: /^notifications/i })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /no longer have access/i })).toBeNull();
  });

  it('R3-F2: leaving the shell and coming back (Back) keeps a denial that a 5xx followed', async () => {
    const maple = revocableMaple([notification()]);
    const fetchMock = stubApi(maple.routes);
    const app = renderApp(['/']);
    await bell('Notifications, 1 unread');

    maple.state.status = 404;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'building'] }));
    await denialShown();
    maple.state.status = 500;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'building'] }));

    // The catch-all route is outside the shell: Back remounts it with the same query cache.
    act(() => app.navigate()('/not-an-app-page'));
    await screen.findByRole('heading', { name: /not found/i });
    const before = notificationCalls(fetchMock).length;
    act(() => app.navigate()(-1));

    await denialShown();
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.queryByRole('button', { name: /^notifications/i })).toBeNull();
    expect(notificationCalls(fetchMock).slice(before)).toEqual([]);
  });

  it('B-5: the page and the nav stay closed when a 5xx follows a building 404, until the building answers again', async () => {
    const maple = revocableMaple([notification()]);
    stubApi(maple.routes);
    const app = renderApp(['/Dashboard']);
    await screen.findByText(/being migrated/i);
    expect(screen.getByRole('navigation')).toBeTruthy();

    maple.state.status = 404;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'building'] }));
    await denialShown();
    maple.state.status = 500;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'building'] }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(app.queryClient.getQueryState(['b', MAPLE.id, 'building'])?.error).toHaveProperty('status', 500);
    expect(screen.getByRole('heading', { name: /no longer have access/i })).toBeTruthy();
    expect(screen.queryByText(/being migrated/i)).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();

    maple.state.status = 200;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'building'] }));
    expect(await screen.findByText(/being migrated/i)).toBeTruthy();
    expect(await bell('Notifications, 1 unread')).toBeTruthy();
  });

  it('B-5: a denial does not wear off with time (no garbage collection of the marker)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const maple = revocableMaple([notification()]);
    stubApi(maple.routes);
    const app = renderApp(['/Dashboard']);
    await bell('Notifications, 1 unread');
    maple.state.status = 404;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'building'] }));
    await denialShown();
    maple.state.status = 500;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'building'] }));

    await act(() => vi.advanceTimersByTimeAsync(6 * 60_000));

    expect(screen.getByRole('heading', { name: /no longer have access/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^notifications/i })).toBeNull();
    expect(screen.queryByText(/being migrated/i)).toBeNull();
  });

  it('B-5: a denial of one building does not close another', async () => {
    const maple = revocableMaple([notification({ title: 'Maple notice' })]);
    const birch = notificationServer(BIRCH, [notification({ title: 'Birch notice' })]);
    stubApi({
      ...maple.routes,
      'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE), membership(BIRCH)] }),
      [`GET /api/buildings/${BIRCH.id}`]: () => json(buildingOut(BIRCH, ['resident'])),
      ...birch.routes,
    });
    sessionStorage.setItem(KEY, MAPLE.id);
    const app = renderApp(['/']);
    await bell('Notifications, 1 unread');
    maple.state.status = 404;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'building'] }));
    await denialShown();

    openAccountMenu();
    fireEvent.change(screen.getByLabelText(/building/i), { target: { value: BIRCH.id } });

    expect(await bell('Notifications, 1 unread')).toBeTruthy();
    expect(await within(await openPanel()).findByText('Birch notice')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /no longer have access/i })).toBeNull();
  });
});

describe('review round 4 (Codex gpt-6-astra): denials from mutations, whenever they answer', () => {
  it('R4-F1: a mark-read denied while the shell is unmounted still closes the building after Back', async () => {
    const target = notification({ link: null, title: 'Private notice' });
    const server = notificationServer(MAPLE, [target]);
    let finish!: (response: Response) => void;
    const reply = new Promise<Response>((resolve) => (finish = resolve));
    stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME), ...server.routes, [`POST ${base(MAPLE)}/${target.id}/read`]: () => reply });
    const app = renderApp(['/Dashboard']);
    fireEvent.click(await within(await openPanel()).findByRole('button', { name: /private notice/i }));
    await waitFor(() => expect(app.queryClient.isMutating()).toBe(1));

    // The catch-all route is outside the shell and BuildingProvider.
    act(() => app.navigate()('/not-an-app-page'));
    await screen.findByRole('heading', { name: /not found/i });
    await act(async () => {
      finish(problem(404, 'building_not_found'));
      await reply;
    });
    await waitFor(() => expect(app.queryClient.isMutating()).toBe(0));
    act(() => app.navigate()(-1));

    expect(await screen.findByRole('heading', { name: /no longer have access/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^notifications/i })).toBeNull();
    expect(screen.queryByText(/being migrated/i)).toBeNull();
  });

  it('R4-F2: a denied mark-read closes the building at once, even while its follow-up refetches hang', async () => {
    const target = notification({ link: null, title: 'Private notice' });
    const server = notificationServer(MAPLE, [target]);
    let revoked = false;
    let hanging = 0;
    const hang = (ok: Handler): Handler => (request) => {
      if (!revoked) return ok(request);
      hanging += 1;
      return new Promise<Response>(() => {});
    };
    stubApi({
      'GET /api/auth/me': () => json(RESIDENT_ME),
      ...server.routes,
      [`GET ${base(MAPLE)}/summary`]: hang(server.routes[`GET ${base(MAPLE)}/summary`]),
      [`GET ${base(MAPLE)}`]: hang(server.routes[`GET ${base(MAPLE)}`]),
      [`POST ${base(MAPLE)}/${target.id}/read`]: () => {
        revoked = true;
        return problem(404, 'building_not_found');
      },
    });
    renderApp(['/Dashboard']);
    fireEvent.click(await within(await openPanel()).findByRole('button', { name: /private notice/i }));

    expect(await screen.findByRole('heading', { name: /no longer have access/i })).toBeTruthy();
    expect(screen.queryByText('Private notice')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(hanging).toBeLessThanOrEqual(2);
  });

  it('R4 neighbour: a query denied while the shell is unmounted still closes the building after Back', async () => {
    let status = 200;
    const server = notificationServer(MAPLE, [notification()]);
    let finish!: (response: Response) => void;
    const reply = new Promise<Response>((resolve) => (finish = resolve));
    stubApi({
      'GET /api/auth/me': () => json(RESIDENT_ME),
      ...server.routes,
      [`GET ${base(MAPLE)}/summary`]: (request) =>
        status === 200 ? server.routes[`GET ${base(MAPLE)}/summary`](request) : reply,
    });
    const app = renderApp(['/Dashboard']);
    await bell('Notifications, 1 unread');
    status = 404;
    // A summary fetch outlives the shell (fetchQuery, as a prefetch would): only the cache sees its answer.
    const pending = app.queryClient.fetchQuery({
      queryKey: ['b', MAPLE.id, 'notifications', 'summary'],
      queryFn: async () => {
        const response = await reply;
        throw toApiError(response, await response.json());
      },
      staleTime: 0,
    });
    act(() => app.navigate()('/not-an-app-page'));
    await screen.findByRole('heading', { name: /not found/i });
    await act(async () => {
      finish(problem(404, 'building_not_found'));
      await pending.catch(() => undefined);
    });
    act(() => app.navigate()(-1));

    expect(await screen.findByRole('heading', { name: /no longer have access/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^notifications/i })).toBeNull();
  });
});

describe('P4-08f: the bell closes for good and asks again on mount (criteria 4, 5, 8)', () => {
  it('criterion 4: a touch outside (pointerdown, no mousedown) closes the panel; one inside does not', async () => {
    const server = notificationServer(MAPLE, [notification()]);
    stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME), ...server.routes });
    renderApp(['/']);
    const region = await openPanel();

    fireEvent.pointerDown(within(region).getByRole('heading', { name: 'Notifications' }), { pointerType: 'touch' });
    expect(panel()).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole('main'), { pointerType: 'touch' });
    expect(screen.queryByRole('region', { name: /notifications/i })).toBeNull();
  });

  it('criterion 5: Back to where the panel was opened leaves it closed', async () => {
    const server = notificationServer(MAPLE, [notification()]);
    stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME), ...server.routes });
    const app = renderApp(['/']);
    await openPanel();

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'My packages' }));
    await waitFor(() => expect(location()).toBe('/packages'));
    act(() => app.navigate()(-1));
    await waitFor(() => expect(location()).toBe('/'));

    expect(screen.queryByRole('region', { name: /notifications/i })).toBeNull();
    expect((await bell()).getAttribute('aria-expanded')).toBe('false');
  });

  it('criterion 8: a count changed while the bell was gone is asked for again when it comes back', async () => {
    const server = notificationServer(MAPLE, [notification()]);
    const fetchMock = stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME), ...server.routes });
    const app = renderApp(['/']);
    await bell('Notifications, 1 unread');

    // The catch-all route is outside the shell: Back remounts the bell with the same query cache, within 30 s.
    act(() => app.navigate()('/not-an-app-page'));
    await screen.findByRole('heading', { name: /not found/i });
    server.state.items = server.state.items.map((item) => ({ ...item, read_at: '2026-10-18T12:05:00Z' }));
    const before = summaryCalls(fetchMock).length;
    act(() => app.navigate()(-1));

    expect(await bell('Notifications, 0 unread')).toBeTruthy();
    expect(summaryCalls(fetchMock).length).toBe(before + 1);
  });
});

describe('P4-08f: Load more never discards a refresh (criteria 6 and 7)', () => {
  const unread = (title: string) =>
    within(panel()).getByRole('button', { name: new RegExp(title) }).textContent?.includes('Unread');
  const loadMore = () => within(panel()).getByRole<HTMLButtonElement>('button', { name: /load more/i });

  /** 30 notifications without links (a click stays on the page); the first page's refreshes can be held. */
  function heldServer() {
    const items = Array.from({ length: 30 }, () => notification({ link: null }));
    const server = notificationServer(MAPLE, items);
    const list = server.routes[`GET ${base(MAPLE)}`];
    const state = { hold: false, fail: false, holdMore: false, refreshes: [] as Request[] };
    let release = () => {};
    let gate = Promise.resolve();
    let releaseMore = () => {};
    const moreGate = new Promise<void>((resolve) => (releaseMore = resolve));
    const routes: Record<string, Handler> = {
      'GET /api/auth/me': () => json(RESIDENT_ME),
      ...server.routes,
      [`GET ${base(MAPLE)}`]: async (request) => {
        if (new URL(request.url).searchParams.has('cursor')) {
          if (state.holdMore) await moreGate;
          return list(request);
        }
        if (state.fail) return problem(500, 'internal_error');
        if (state.hold) {
          state.refreshes.push(request);
          await gate;
        }
        return list(request);
      },
    };
    return {
      items,
      state,
      routes,
      hold: () => {
        state.hold = true;
        gate = new Promise<void>((resolve) => (release = resolve));
      },
      release: () =>
        act(async () => {
          release();
          await gate;
        }),
      releaseMore: () =>
        act(async () => {
          releaseMore();
          await moreGate;
        }),
    };
  }

  it('criterion 6: after a mark-read, Load more waits for the refresh, which then shows it read', async () => {
    const server = heldServer();
    stubApi(server.routes);
    const app = renderApp(['/']);
    await within(await openPanel()).findByText(server.items[0].title);

    server.hold();
    fireEvent.click(within(panel()).getByRole('button', { name: new RegExp(server.items[0].title) }));
    await waitFor(() => expect(server.state.refreshes).toHaveLength(1));

    expect(loadMore().disabled).toBe(true);
    fireEvent.click(loadMore());
    await server.release();

    await waitFor(() => expect(unread(server.items[0].title)).toBe(false));
    expect(server.state.refreshes.some((request) => request.signal.aborted)).toBe(false);
    expect(app.queryClient.getQueryState(['b', MAPLE.id, 'notifications', 'list'])?.isInvalidated).toBe(false);
    fireEvent.click(loadMore());
    expect(await within(panel()).findByText(server.items[29].title)).toBeTruthy();
    expect(unread(server.items[0].title)).toBe(false);
  });

  it('criterion 6: Load more is disabled during any list refetch (a focus refetch too)', async () => {
    const server = heldServer();
    stubApi(server.routes);
    const app = renderApp(['/']);
    await within(await openPanel()).findByText(server.items[0].title);

    server.hold();
    void app.queryClient.refetchQueries({ queryKey: ['b', MAPLE.id, 'notifications', 'list'] });

    await waitFor(() => expect(loadMore().disabled).toBe(true));
    await server.release();
    await waitFor(() => expect(loadMore().disabled).toBe(false));
  });

  it('criterion 6 (review round 1, Codex): disabled during a refetch the tab becoming visible starts', async () => {
    const server = heldServer();
    stubApi(server.routes);
    renderApp(['/']);
    await within(await openPanel()).findByText(server.items[0].title);

    server.hold();
    setVisibility('hidden');
    setVisibility('visible');

    await waitFor(() => expect(server.state.refreshes).toHaveLength(1));
    expect(loadMore().disabled).toBe(true);
    await server.release();
    await waitFor(() => expect(loadMore().disabled).toBe(false));
  });

  it('criterion 6: a mark-read while Load more is loading ends with the server’s list (it read)', async () => {
    const server = heldServer();
    stubApi(server.routes);
    renderApp(['/']);
    await within(await openPanel()).findByText(server.items[0].title);

    server.state.holdMore = true;
    fireEvent.click(loadMore());
    fireEvent.click(within(panel()).getByRole('button', { name: new RegExp(server.items[0].title) }));
    await server.releaseMore();

    await waitFor(() => expect(unread(server.items[0].title)).toBe(false));
    await act(() => new Promise((resolve) => setTimeout(resolve, 25)));
    expect(unread(server.items[0].title)).toBe(false);
  });

  it('criterion 7: a failed refresh offers only Try again, which shows it read and brings Load more back', async () => {
    const server = heldServer();
    stubApi(server.routes);
    renderApp(['/']);
    await within(await openPanel()).findByText(server.items[0].title);

    server.state.fail = true;
    fireEvent.click(within(panel()).getByRole('button', { name: new RegExp(server.items[0].title) }));

    const alert = await within(panel()).findByText(/could not refresh notifications/i);
    expect(within(panel()).queryByRole('button', { name: /load more/i })).toBeNull();

    server.state.fail = false;
    fireEvent.click(within(alert.closest('[role="alert"]') as HTMLElement).getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(unread(server.items[0].title)).toBe(false));
    expect(within(panel()).queryByText(/could not refresh notifications/i)).toBeNull();
    expect(loadMore()).toBeTruthy();
  });
});
