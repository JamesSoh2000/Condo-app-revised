// @vitest-environment jsdom
/**
 * P6-02b criteria A and B: one notice at `/notices/<id>`, a dialog over the feed
 * (docs/tickets/P6-02b-urgent-banner-and-attachments.md).
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAPLE, calls, problem, renderApp, stubApi } from '@/test/renderApp';
import { notice, noticeMember, noticesBase, type NoticeServer } from '@/test/notices';

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, ...actual.createApiClient({ baseUrl: 'http://app.test' }) };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const BASE = noticesBase();
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
const feed = () => screen.findByRole('list', { name: 'Notices' });
const navLink = async (name: string | RegExp) =>
  within(await screen.findByRole('navigation', { name: 'Main' })).findByRole('link', { name });
const readCalls = (fetchMock: ReturnType<typeof stubApi>) => calls(fetchMock).filter((call) => call.startsWith(`POST ${BASE}/`));
const oneCalls = (fetchMock: ReturnType<typeof stubApi>) =>
  calls(fetchMock).filter((call) => call.startsWith(`GET ${BASE}/`) && !call.endsWith('/summary'));

const TWO = (): NoticeServer => ({
  notices: [
    notice(2, {
      title: 'Water shut-off',
      body: 'Water off **Tuesday**.',
      expires_at: '2026-03-16T04:00:00Z',
      published_at: '2026-03-15T23:30:00Z',
    }),
    notice(1, { read_at: '2026-10-21T09:00:00Z' }),
  ],
});

describe('one notice (criterion A)', () => {
  it('shows the notice over the feed, with its body, times in building time, and no read on open', async () => {
    const fetchMock = stubApi(noticeMember(TWO()));
    renderApp([`/notices/${notice(2).id}`]);

    const dialog = await screen.findByRole('dialog', { name: 'Water shut-off' });
    expect(within(dialog).getByText('Tuesday').tagName).toBe('STRONG');
    expect(dialog.textContent).toContain('Published Mar 15, 2026, 7:30 PM');
    expect(dialog.textContent).toContain('Until Mar 16, 2026, 12:00 AM');
    expect(within(dialog).getByText('Unread')).toBeTruthy();
    expect(await feed()).toBeTruthy();
    await settle();
    expect(readCalls(fetchMock)).toEqual([]);
  });

  it('labels an urgent notice', async () => {
    stubApi(noticeMember({ notices: [notice(3, { priority: 'urgent' })] }));
    renderApp([`/notices/${notice(3).id}`]);
    const dialog = await screen.findByRole('dialog', { name: 'Notice 3' });
    expect(within(dialog).getByText('Urgent')).toBeTruthy();
  });

  it('marks it read once, and the dialog, the card and the badge clear without a reload', async () => {
    const fetchMock = stubApi(noticeMember(TWO()));
    renderApp([`/notices/${notice(2).id}`]);

    const dialog = await screen.findByRole('dialog', { name: 'Water shut-off' });
    expect(await navLink('Notices, 1 unread')).toBeTruthy();
    const button = within(dialog).getByRole('button', { name: 'Mark as read' });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(within(dialog).queryByText('Unread')).toBeNull());
    expect(within(dialog).queryByRole('button', { name: 'Mark as read' })).toBeNull();
    expect(readCalls(fetchMock)).toEqual([`POST ${BASE}/${notice(2).id}/read`]);
    expect(await navLink(/^Notices$/)).toBeTruthy();
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Notices' })).queryByText('Unread')).toBeNull());
  });

  it('a read notice has no "Mark as read"', async () => {
    stubApi(noticeMember(TWO()));
    renderApp([`/notices/${notice(1).id}`]);
    const dialog = await screen.findByRole('dialog', { name: 'Notice 1' });
    expect(within(dialog).queryByRole('button', { name: 'Mark as read' })).toBeNull();
  });

  it('a failed read says so and keeps the button', async () => {
    stubApi(noticeMember(TWO(), { [`POST ${BASE}/${notice(2).id}/read`]: () => problem(500, 'internal_error') }));
    renderApp([`/notices/${notice(2).id}`]);
    const dialog = await screen.findByRole('dialog', { name: 'Water shut-off' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as read' }));
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'Could not mark the notice read.');
    expect(within(dialog).getByRole('button', { name: 'Mark as read' })).toBeTruthy();
  });

  it('a failed load offers a retry, and hides an answer cached from before', async () => {
    let fail = true;
    const state = TWO();
    const routes = noticeMember(state);
    const ok = routes[`GET ${BASE}/${notice(2).id}`];
    stubApi({ ...routes, [`GET ${BASE}/${notice(2).id}`]: (request) => (fail ? problem(500, 'internal_error') : ok(request)) });
    renderApp([`/notices/${notice(2).id}`]);

    const dialog = await screen.findByRole('dialog', { name: 'Notice' });
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Could not load the notice.'));
    fail = false;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('dialog', { name: 'Water shut-off' })).toBeTruthy();
  });

  it('opens from the feed, and Close goes back to it', async () => {
    stubApi(noticeMember(TWO()));
    const app = renderApp(['/notices']);
    const card = within(await feed()).getAllByRole('listitem')[0];
    fireEvent.click(within(card).getByRole('link', { name: 'Open: Water shut-off' }));

    const dialog = await screen.findByRole('dialog', { name: 'Water shut-off' });
    expect(app.location().pathname).toBe(`/notices/${notice(2).id}`);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(app.location().pathname).toBe('/notices'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a manager sees a draft with its status', async () => {
    const draft = notice(5, { status: 'draft', published_at: null, published_by_membership_id: null });
    stubApi(noticeMember({ notices: [], hidden: [draft] }, {}, ['property_management']));
    renderApp([`/notices/${draft.id}`]);
    const dialog = await screen.findByRole('dialog', { name: 'Notice 5' });
    expect(within(dialog).getByText('Draft')).toBeTruthy();
  });
});

describe('a notice the member may not see (criterion B)', () => {
  const random = '01929a4e-0000-7000-8000-0000000e0077';

  it.each([
    ['a draft', notice(4, { status: 'draft' })],
    ['an archived notice', notice(4, { status: 'archived' })],
    ['an expired notice', notice(4, { status: 'published', expires_at: '2026-01-01T00:00:00Z' })],
  ])('shows "Notice not found" for %s, with the feed behind it', async (_, hidden) => {
    // The API answers 404 for every one of them (visible_notices); the feed shows the live one.
    stubApi(noticeMember({ notices: [notice(1)] }, { [`GET ${BASE}/${hidden.id}`]: () => problem(404, 'notice_not_found') }));
    const app = renderApp([`/notices/${hidden.id}`]);

    const dialog = await screen.findByRole('dialog', { name: 'Notice not found' });
    expect(dialog.textContent).toContain('There is no notice at this address.');
    expect(await feed()).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(app.location().pathname).toBe('/notices'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows it for another building’s notice or a random UUID (404)', async () => {
    stubApi(noticeMember(TWO(), { [`GET ${BASE}/${random}`]: () => problem(404, 'notice_not_found') }));
    renderApp([`/notices/${random}`]);
    expect(await screen.findByRole('dialog', { name: 'Notice not found' })).toBeTruthy();
    // A notice 404 doesn't mark the building denied.
    await settle();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
  });

  it('shows it for a segment that is not a UUID, without asking the API', async () => {
    const fetchMock = stubApi(noticeMember(TWO()));
    renderApp(['/notices/not-a-notice']);
    expect(await screen.findByRole('dialog', { name: 'Notice not found' })).toBeTruthy();
    await feed();
    await settle();
    expect(oneCalls(fetchMock)).toEqual([]);
  });

  it('Escape closes it to /notices too', async () => {
    stubApi(noticeMember(TWO()));
    const app = renderApp(['/notices/not-a-notice']);
    const dialog = await screen.findByRole('dialog', { name: 'Notice not found' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(app.location().pathname).toBe('/notices'));
  });

  it('a notice that leaves while open shows "Notice not found" after the read’s refresh', async () => {
    const state = TWO();
    stubApi(noticeMember(state));
    renderApp([`/notices/${notice(2).id}`]);
    const dialog = await screen.findByRole('dialog', { name: 'Water shut-off' });
    state.notices = state.notices.map((item) => (item.id === notice(2).id ? { ...item, status: 'archived' } : item));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as read' }));
    expect(await screen.findByRole('dialog', { name: 'Notice not found' })).toBeTruthy();
  });
});

it('a notice in Maple is asked in Maple', async () => {
  const fetchMock = stubApi(noticeMember(TWO()));
  renderApp([`/notices/${notice(2).id}`]);
  await screen.findByRole('dialog', { name: 'Water shut-off' });
  expect(oneCalls(fetchMock)).toEqual([`GET /api/buildings/${MAPLE.id}/notices/${notice(2).id}`]);
});
