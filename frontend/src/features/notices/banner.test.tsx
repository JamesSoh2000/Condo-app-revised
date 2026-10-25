// @vitest-environment jsdom
/**
 * P6-02b criteria 1–5, 9 and 10: the urgent banner in the building shell
 * (docs/tickets/P6-02b-urgent-banner-and-attachments.md).
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
} from '@/test/renderApp';
import { notice, noticeMember, noticeRoutes, noticesBase, type NoticeServer } from '@/test/notices';

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

const BASE = noticesBase();
const DISCLAIMER = 'This app is not an emergency alert system: in an emergency, call 911.';
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
const poll = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
const banner = () => screen.findByRole('region', { name: 'Urgent notices' });
const noBanner = () => expect(screen.queryByRole('region', { name: 'Urgent notices' })).toBeNull();
const navLink = async (name: string | RegExp) =>
  within(await screen.findByRole('navigation', { name: 'Main' })).findByRole('link', { name });
const bannerCalls = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls
    .map(([request]) => new URL(request.url))
    .filter((url) => url.pathname.endsWith('/notices') && url.searchParams.get('priority') === 'urgent');
const noticesCalls = (fetchMock: ReturnType<typeof stubApi>) => calls(fetchMock).filter((call) => call.includes('/notices'));

const urgent = (n: number, fields = {}) => notice(n, { priority: 'urgent', title: `Urgent ${n}`, ...fields });
const ONE = (): NoticeServer => ({ notices: [urgent(2), notice(1)] });

describe('the banner names the unread urgent notice (criterion 1)', () => {
  it('shows its title and a link to it on any page of the building, after the nav', async () => {
    const fetchMock = stubApi(noticeMember(ONE()));
    renderApp(['/packages']);

    const region = await banner();
    const link = await within(region).findByRole('link', { name: 'Urgent 2' });
    expect(link.getAttribute('href')).toBe(`/notices/${urgent(2).id}`);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(nav.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(region.compareDocumentPosition(screen.getByRole('main')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const [url] = bannerCalls(fetchMock);
    expect(Object.fromEntries(url.searchParams)).toEqual({ live: 'true', priority: 'urgent', unread: 'true', limit: '3' });
  });

  it('follows the link to the notice', async () => {
    stubApi(noticeMember(ONE()));
    const app = renderApp(['/packages']);
    fireEvent.click(await within(await banner()).findByRole('link', { name: 'Urgent 2' }));
    await waitFor(() => expect(app.location().pathname).toBe(`/notices/${urgent(2).id}`));
    expect(await screen.findByRole('dialog', { name: 'Urgent 2' })).toBeTruthy();
  });

  it('appears within one 30 s poll of publication while the tab is visible, and not in a hidden tab', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const state: NoticeServer = { notices: [notice(1)] };
    const fetchMock = stubApi(noticeMember(state));
    renderApp(['/packages']);
    await navLink('Notices, 1 unread');
    await settle();
    noBanner();
    expect(bannerCalls(fetchMock)).toEqual([]);

    visibility = 'hidden';
    state.notices = [urgent(2), ...state.notices];
    await poll();
    noBanner();

    visibility = 'visible';
    await poll();
    expect(await within(await banner()).findByRole('link', { name: 'Urgent 2' })).toBeTruthy();
  });
});

describe('acknowledging (criterion 2)', () => {
  it('marks the notice read once, the banner leaves every page, and the badge agrees', async () => {
    const state = ONE();
    const fetchMock = stubApi(noticeMember(state));
    const app = renderApp(['/packages']);

    const region = await banner();
    expect(await navLink('Notices, 2 unread')).toBeTruthy();
    const button = await within(region).findByRole('button', { name: 'Acknowledge: Urgent 2' });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(noBanner);
    expect(calls(fetchMock).filter((call) => call.startsWith('POST'))).toEqual([`POST ${BASE}/${urgent(2).id}/read`]);
    expect(await navLink('Notices, 1 unread')).toBeTruthy();
    app.navigate()('/notices');
    const card = (await screen.findByRole('heading', { name: 'Urgent 2' })).closest('li')!;
    expect(within(card).queryByText('Unread')).toBeNull();
    await settle();
    noBanner();
  });

  it('a reload doesn’t bring it back, and a later urgent notice does', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const state = ONE();
    state.notices[0] = { ...state.notices[0], read_at: '2026-10-22T10:00:00Z' };
    const fetchMock = stubApi(noticeMember(state));
    renderApp(['/packages']);
    await navLink('Notices, 1 unread');
    await settle();
    noBanner();
    expect(bannerCalls(fetchMock)).toEqual([]);

    state.notices = [urgent(3, { title: 'Second alert' }), ...state.notices];
    await poll();
    const region = await banner();
    expect(await within(region).findByRole('link', { name: 'Second alert' })).toBeTruthy();
    expect(within(region).queryByRole('link', { name: 'Urgent 2' })).toBeNull();
  });

  it('never shows a row cached from before the count changed (read elsewhere, then a new one)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const state = ONE();
    const routes = noticeMember(state);
    let held = false;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    stubApi({
      ...routes,
      [`GET ${BASE}`]: async (request) => {
        if (held) await gate;
        return routes[`GET ${BASE}`](request);
      },
    });
    renderApp(['/packages']);
    expect(await within(await banner()).findByRole('link', { name: 'Urgent 2' })).toBeTruthy();

    // Read on another device: the next poll's count is 0 and the banner goes, its list still cached.
    state.notices = state.notices.map((item) => ({ ...item, read_at: item.read_at ?? '2026-10-22T10:00:00Z' }));
    await poll();
    await waitFor(noBanner);

    // A new urgent notice: the list's answer is held, and the cached "Urgent 2" must not show meanwhile.
    held = true;
    state.notices = [urgent(3, { title: 'Second alert' }), ...state.notices];
    await poll();
    const region = await banner();
    expect(within(region).queryByRole('link', { name: 'Urgent 2' })).toBeNull();
    expect(within(region).getByRole('link', { name: 'See the notices' })).toBeTruthy();
    release!();
    expect(await within(region).findByRole('link', { name: 'Second alert' })).toBeTruthy();
    expect(within(region).queryByRole('link', { name: 'Urgent 2' })).toBeNull();
  });

  it('a failed acknowledgement says so and keeps the row', async () => {
    stubApi(noticeMember(ONE(), { [`POST ${BASE}/${urgent(2).id}/read`]: () => problem(500, 'internal_error') }));
    renderApp(['/packages']);
    const region = await banner();
    fireEvent.click(await within(region).findByRole('button', { name: 'Acknowledge: Urgent 2' }));
    expect(await within(region).findByText('Could not acknowledge the notice, try again.')).toBeTruthy();
    expect(within(region).getByRole('link', { name: 'Urgent 2' })).toBeTruthy();
  });
});

describe('more than one (criterion 3)', () => {
  it('says "2 urgent notices" and links to each', async () => {
    stubApi(noticeMember({ notices: [urgent(3), urgent(2), notice(1)] }));
    renderApp(['/']);
    const region = await banner();
    expect(await within(region).findByText('2 urgent notices')).toBeTruthy();
    expect(within(region).getByRole('link', { name: 'Urgent 3' })).toBeTruthy();
    expect(within(region).getByRole('link', { name: 'Urgent 2' })).toBeTruthy();
    expect(within(region).queryByRole('link', { name: /more/ })).toBeNull();
  });

  it('lists the newest three of five and links "and 2 more" to the feed', async () => {
    stubApi(noticeMember({ notices: [urgent(5), urgent(4), urgent(3), urgent(2), urgent(1)] }));
    renderApp(['/']);
    const region = await banner();
    expect(await within(region).findByText('5 urgent notices')).toBeTruthy();
    expect(within(region).getAllByRole('button', { name: /^Acknowledge/ })).toHaveLength(3);
    expect(within(region).queryByRole('link', { name: 'Urgent 2' })).toBeNull();
    expect(within(region).getByRole('link', { name: 'and 2 more' }).getAttribute('href')).toBe('/notices');
  });
});

describe('the disclaimer (criterion 4)', () => {
  it('says the app is not an emergency alert system and to call 911', async () => {
    stubApi(noticeMember(ONE()));
    renderApp(['/']);
    const region = await banner();
    expect(await within(region).findByText('Urgent building notice')).toBeTruthy();
    expect(within(region).getByText(DISCLAIMER)).toBeTruthy();
  });
});

describe('no banner (criterion 5)', () => {
  it('in a building with notices off, and no notices request at all', async () => {
    const fetchMock = stubApi(noticeMember(ONE(), {}, ['resident'], ['packages', 'maintenance']));
    renderApp(['/packages']);
    await screen.findByRole('heading', { name: 'My packages' });
    await settle();
    noBanner();
    expect(noticesCalls(fetchMock)).toEqual([]);
  });

  it('with only normal unread notices, and no banner list request', async () => {
    const fetchMock = stubApi(noticeMember({ notices: [notice(2), notice(1)] }));
    renderApp(['/packages']);
    await navLink('Notices, 2 unread');
    await settle();
    noBanner();
    expect(bannerCalls(fetchMock)).toEqual([]);
  });

  it('for a signed-out user, with no notices request', async () => {
    const fetchMock = stubApi({ 'GET /api/auth/me': () => problem(401, 'not_authenticated') });
    const app = renderApp(['/packages']);
    await waitFor(() => expect(app.location().pathname).toBe('/login'));
    await settle();
    noBanner();
    expect(noticesCalls(fetchMock)).toEqual([]);
  });

  it('on a session-only page (/403) before any building page loaded, with no notices request', async () => {
    const fetchMock = stubApi(noticeMember(ONE()));
    renderApp(['/403']);
    await settle();
    noBanner();
    expect(noticesCalls(fetchMock)).toEqual([]);
  });
});

describe('an urgent notice gone before its acknowledgement (criterion 9)', () => {
  it('drops the row after the refresh, without an error', async () => {
    const state = ONE();
    stubApi(noticeMember(state));
    renderApp(['/packages']);
    const region = await banner();
    const button = await within(region).findByRole('button', { name: 'Acknowledge: Urgent 2' });
    state.notices = state.notices.map((item) => (item.id === urgent(2).id ? { ...item, status: 'archived' } : item));
    fireEvent.click(button);

    await waitFor(noBanner);
    expect(screen.queryByText('Could not acknowledge the notice, try again.')).toBeNull();
  });
});

describe('tenancy (criterion 10)', () => {
  it('shows nothing of A’s banner in B, and B’s own', async () => {
    const birch: NoticeServer = { notices: [urgent(7, { title: 'Birch alert' })] };
    stubApi({
      'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE), membership(BIRCH)] }),
      [`GET /api/buildings/${BIRCH.id}`]: () => json(buildingOut(BIRCH, ['resident'])),
      [`GET /api/buildings/${BIRCH.id}/notifications/summary`]: () => json({ unread_count: 0 }),
      ...noticeRoutes(ONE()),
      ...noticeRoutes(birch, BIRCH.id),
    });
    writeSelectedBuilding(MAPLE.id);
    renderApp(['/packages']);
    expect(await within(await banner()).findByRole('link', { name: 'Urgent 2' })).toBeTruthy();

    openAccountMenu();
    fireEvent.change(screen.getByRole('combobox', { name: 'Building' }), { target: { value: BIRCH.id } });

    const region = await banner();
    expect(await within(region).findByRole('link', { name: 'Birch alert' })).toBeTruthy();
    expect(within(region).queryByRole('link', { name: 'Urgent 2' })).toBeNull();
  });

  it('goes when the building is denied mid-session', async () => {
    stubApi(noticeMember(ONE(), { [`POST ${BASE}/${urgent(2).id}/read`]: () => problem(404, 'building_not_found') }));
    renderApp(['/packages']);
    fireEvent.click(await within(await banner()).findByRole('button', { name: 'Acknowledge: Urgent 2' }));
    await waitFor(noBanner);
  });
});

describe('review round 2 (Codex gpt-6.1-sol), the neighbour of F1', () => {
  it('after Acknowledge, focus is kept by the banner’s slot, not dropped to the page', async () => {
    stubApi(noticeMember({ notices: [urgent(3), urgent(2)] }));
    renderApp(['/packages']);
    const region = await banner();
    const button = await within(region).findByRole('button', { name: 'Acknowledge: Urgent 3' });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Acknowledge: Urgent 3' })).toBeNull());
    const slot = region.parentElement!;
    expect(slot.getAttribute('aria-live')).toBe('polite');
    expect(document.activeElement).toBe(slot);

    // The last one: the banner goes, and focus stays on the slot, where Tab carries on into the page.
    fireEvent.click(await within(region).findByRole('button', { name: 'Acknowledge: Urgent 2' }));
    await waitFor(noBanner);
    expect(document.activeElement).toBe(slot);
  });
});
