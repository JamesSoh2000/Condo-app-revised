// @vitest-environment jsdom
/**
 * P6-04c: one maintenance request at `/maintenance/<id>`, its details, photos and timeline. Each `describe` names the
 * criteria it proves (docs/tickets/P6-04c-maintenance-request-view.md); the internal comments are in comments.test.tsx.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { maintenanceBase, maintenanceRequest } from '@/test/maintenance';
import { REQUEST, comment, memberWorld, statusEvent, viewState, type ViewState } from '@/test/maintenanceView';
import { MAPLE, calls, json, problem, renderApp, stubApi } from '@/test/renderApp';

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
  vi.unstubAllGlobals();
  sessionStorage.clear();
  if (visibility !== 'visible') setVisibility('visible');
});

const BASE = maintenanceBase();
const ONE = `${BASE}/${REQUEST.id}`;
const PHOTO_A = '01929a4e-0000-7000-8000-0000000fa001';
const PHOTO_B = '01929a4e-0000-7000-8000-0000000fa002';
const download = (fileId: string) => `GET /api/buildings/${MAPLE.id}/files/${fileId}/download-url`;
const photoRoutes = Object.fromEntries(
  [PHOTO_A, PHOTO_B].map((fileId) => [download(fileId), () => json({ url: `https://s3.test/${fileId}`, expires_at: '2099-01-01T00:00:00Z' })]),
);

// Across the EDT change on 8 March 2026 in Toronto: 23:30 UTC on 7 March is 18:30 EST, on 15 March 19:30 EDT.
const FULL: ViewState = viewState({
  request: maintenanceRequest(1, {
    description: 'Kitchen tap drips',
    status: 'on_hold',
    submitted_at: '2026-03-07T23:30:00Z',
    started_at: '2026-03-10T14:00:00Z',
    on_hold_at: '2026-03-15T23:30:00Z',
    photo_file_ids: [PHOTO_A, PHOTO_B],
  }),
  events: [statusEvent('2026-03-10T14:00:00Z', 'submitted', 'in_progress'), statusEvent('2026-03-15T23:30:00Z', 'in_progress', 'on_hold')],
  comments: [
    comment('2026-03-12T15:00:00Z', { body: 'A plumber comes Friday.', author_name: null, author_is_staff: true }),
    // The same instant as the hold: the status change comes first (criterion 1a).
    comment('2026-03-15T23:30:00Z', { body: 'Thanks!', author_name: 'Alex Martin', author_is_staff: false }),
  ],
});

const location = () => screen.getByTestId('location').textContent;
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
const dialog = (name: string | RegExp = 'Plumbing request') => screen.findByRole('dialog', { name });
const timeline = async () => within(await dialog()).findByRole('list', { name: 'Timeline' });
const rows = async () => within(await timeline()).getAllByRole('listitem').map((row) => row.textContent);
const timelineCalls = (fetchMock: ReturnType<typeof stubApi>) =>
  calls(fetchMock).filter((call) => call.endsWith('/comments') || call.endsWith('/status-events'));

describe('the requester opens a request (criteria 1, 1a)', () => {
  it('shows the details, the photos and the timeline in time order, times in the building’s timezone', async () => {
    stubApi(memberWorld(FULL, ['resident'], photoRoutes));
    renderApp([`/maintenance/${REQUEST.id}`]);

    const view = await dialog();
    expect(within(view).getByText('On hold')).toBeTruthy();
    expect(within(view).getByText('Unit A-101')).toBeTruthy();
    expect(within(view).getByText('Kitchen tap drips')).toBeTruthy();
    expect(within(view).getAllByText('Mar 7, 2026, 6:30 PM').length).toBeGreaterThan(0);
    const photos = within(within(view).getByRole('list', { name: 'Photos' })).getAllByRole('listitem');
    expect(photos).toHaveLength(2);
    expect((await within(photos[1]).findByRole<HTMLImageElement>('img')).alt).toBe('Photo 2 of 2');

    expect(await rows()).toEqual([
      'SubmittedMar 7, 2026, 6:30 PM',
      'Work startedMar 10, 2026, 10:00 AM',
      'Building managementMar 12, 2026, 11:00 AMA plumber comes Friday.',
      'Put on holdMar 15, 2026, 7:30 PM',
      'Alex MartinMar 15, 2026, 7:30 PMThanks!',
    ]);
  });

  it('names every move from where it came from, a co-occupant’s comment "Resident", and a cancel from the row', async () => {
    stubApi(
      memberWorld(
        viewState({
          request: maintenanceRequest(1, { status: 'cancelled', submitted_at: '2026-03-14T12:00:00Z', cancelled_at: '2026-03-21T12:00:00Z' }),
          events: [
            statusEvent('2026-03-16T12:00:00Z', 'on_hold', 'in_progress'),
            statusEvent('2026-03-17T12:00:00Z', 'in_progress', 'resolved'),
            statusEvent('2026-03-18T12:00:00Z', 'resolved', 'in_progress'),
          ],
          comments: [comment('2026-03-22T12:00:00Z', { body: 'Same here.', author_name: null, author_is_staff: false })],
        }),
      ),
    );
    renderApp([`/maintenance/${REQUEST.id}`]);

    const titles = (await rows()).map((row) => row?.split(/Mar \d/)[0]);
    expect(titles).toEqual(['Submitted', 'Work resumed', 'Resolved', 'Reopened', 'Cancelled', 'Resident']);
  });

  it('shows the emergency text and phone on an emergency request, and the requester’s name when the API gives it', async () => {
    stubApi(
      memberWorld(viewState({ request: maintenanceRequest(1, { category: 'emergency', emergency_phone: '416-555-0100', requester_name: 'Alex Martin' }) }), [
        'resident',
      ]),
    );
    renderApp([`/maintenance/${REQUEST.id}`]);

    const view = await dialog('Emergency request');
    expect(within(view).getByTestId('emergency-notice').textContent).toContain('416-555-0100');
    expect(within(view).getByText('Alex Martin')).toBeTruthy();
  });

  it('opens from a notification’s link with the timeline', async () => {
    stubApi(memberWorld(FULL, ['resident'], photoRoutes));
    renderApp(['/', `/maintenance/${REQUEST.id}`]);
    expect(await rows()).toHaveLength(5);
  });
});

describe('paging the timeline (criterion 1b)', () => {
  it('shows nothing past the newest time both reads have loaded, then the rest after Load more', async () => {
    // 26 comments a day apart (one more than a page), and a resolve between the 25th and the 26th.
    const day = (n: number) => new Date(Date.UTC(2026, 3, 1 + n, 12)).toISOString();
    const comments = Array.from({ length: 26 }, (_, n) => comment(day(n), { body: `Note ${n + 1}` }));
    const state = viewState({
      request: maintenanceRequest(1, { submitted_at: '2026-03-31T12:00:00Z' }),
      events: [statusEvent(day(24).replace('12:00', '18:00'), 'in_progress', 'resolved')],
      comments,
    });
    stubApi(memberWorld(state));
    renderApp([`/maintenance/${REQUEST.id}`]);

    const before = await rows();
    // Submitted and comments 1–24; the 25th is at the horizon and the resolve after it, so both wait.
    expect(before).toHaveLength(25);
    expect(before.at(-1)).toContain('Note 24');
    expect(before.some((row) => row?.startsWith('Resolved'))).toBe(false);

    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Load more' }));
    await waitFor(async () => expect(await rows()).toHaveLength(28));
    const after = await rows();
    expect(after.slice(-3).map((row) => row?.split(/Apr \d/)[0])).toEqual(['Building management', 'Resolved', 'Building management']);
    expect(after.at(-1)).toContain('Note 26');
    expect(within(await dialog()).queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});

describe('text only (criterion 1c)', () => {
  it('shows HTML and Markdown in a description or comment as typed', async () => {
    const html = '<img src=x onerror=alert(1)> **bold**\nsecond line';
    stubApi(memberWorld(viewState({ request: maintenanceRequest(1, { description: html }), comments: [comment('2026-10-21T12:00:00Z', { body: html })] })));
    renderApp([`/maintenance/${REQUEST.id}`]);

    const view = await dialog();
    await timeline();
    expect(view.querySelector('img')).toBeNull();
    expect(view.querySelector('strong')).toBeNull();
    expect(within(view).getAllByText((_, element) => element?.tagName === 'P' && element.textContent === html)).toHaveLength(2);
  });
});

describe('not found (criteria 5, 5a)', () => {
  it.each([
    ['another resident’s or a hidden request', REQUEST.id],
    ['a request of building B under A’s path', '01929a4e-0000-7000-8000-0000000fb001'],
    ['a random UUID', '01929a4e-0000-7000-8000-00000000dead'],
  ])('shows "Request not found" for %s, and never asks for its timeline', async (_, id) => {
    const fetchMock = stubApi(memberWorld(viewState(), ['resident'], { [`GET ${BASE}/${id}`]: () => problem(404, 'maintenance_request_not_found') }));
    renderApp([`/maintenance/${id}`]);

    expect(await dialog('Request not found')).toBeTruthy();
    await settle();
    expect(timelineCalls(fetchMock)).toEqual([]);
  });

  it('shows "Request not found" for an id that is not a UUID, without asking the API', async () => {
    const fetchMock = stubApi(memberWorld(viewState()));
    renderApp(['/maintenance/not-a-uuid']);

    expect(await dialog('Request not found')).toBeTruthy();
    await settle();
    expect(calls(fetchMock).filter((call) => call.includes('not-a-uuid'))).toEqual([]);
  });

  it('closes "Request not found" back to the list', async () => {
    stubApi(memberWorld(viewState()));
    renderApp(['/maintenance/not-a-uuid']);

    fireEvent.click(within(await dialog('Request not found')).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(location()).toBe('/maintenance'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows a failed timeline read with Try again, the details still shown', async () => {
    let fail = true;
    const state = viewState({ comments: [comment('2026-10-21T12:00:00Z', { body: 'On its way.' })] });
    stubApi(memberWorld(state, ['resident'], { [`GET ${ONE}/comments`]: () => (fail ? problem(500, 'internal_error') : json({ items: state.comments, next_cursor: null })) }));
    renderApp([`/maintenance/${REQUEST.id}`]);

    const view = await dialog();
    expect((await within(view).findByRole('alert')).textContent).toContain('Could not load the timeline.');
    expect(within(view).getByText('Kitchen tap drips')).toBeTruthy();

    fail = false;
    fireEvent.click(within(view).getByRole('button', { name: 'Try again' }));
    expect(await within(view).findByText('On its way.')).toBeTruthy();
  });

  it('turns into "Request not found" when the comments answer 404 (the request left while open)', async () => {
    stubApi(memberWorld(viewState(), ['resident'], { [`GET ${ONE}/status-events`]: () => problem(404, 'maintenance_request_not_found') }));
    renderApp([`/maintenance/${REQUEST.id}`]);

    expect(await dialog('Request not found')).toBeTruthy();
  });

  it('shows a failed request with Try again, apart from not found', async () => {
    let fail = true;
    stubApi(memberWorld(viewState(), ['resident'], { [`GET ${ONE}`]: () => (fail ? problem(500, 'internal_error') : json(REQUEST)) }));
    renderApp([`/maintenance/${REQUEST.id}`]);

    const view = await dialog('Maintenance request');
    expect((await within(view).findByRole('alert')).textContent).toContain('Could not load the request.');
    fail = false;
    fireEvent.click(within(view).getByRole('button', { name: 'Try again' }));
    expect(await dialog()).toBeTruthy();
  });
});

describe('refresh (criterion 6)', () => {
  it('shows a manager’s change when the view is opened again, never the old status first', async () => {
    const state = viewState();
    stubApi(memberWorld(state));
    renderApp(['/maintenance']);

    const link = await screen.findByRole('link', { name: /^Details: Plumbing/ });
    fireEvent.click(link);
    expect(within(await dialog()).getByText('Submitted', { selector: 'dd' })).toBeTruthy();
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    state.request = { ...state.request, status: 'in_progress', started_at: '2026-10-21T12:00:00Z' };
    state.events = [statusEvent('2026-10-21T12:00:00Z', 'submitted', 'in_progress')];
    fireEvent.click(link);
    const view = await dialog();
    expect(within(view).queryByText('Submitted', { selector: 'dd' })).toBeNull();
    expect(within(view).getByText('In progress', { selector: 'dd' })).toBeTruthy();
    expect(await within(view).findByText('Work started')).toBeTruthy();
  });

  it('asks again when the tab is refocused, and shows the new status and timeline', async () => {
    const state = viewState();
    stubApi(memberWorld(state));
    renderApp([`/maintenance/${REQUEST.id}`]);
    await timeline();

    state.request = { ...state.request, status: 'on_hold', started_at: '2026-10-21T12:00:00Z', on_hold_at: '2026-10-22T12:00:00Z' };
    state.events = [statusEvent('2026-10-21T12:00:00Z', 'submitted', 'in_progress'), statusEvent('2026-10-22T12:00:00Z', 'in_progress', 'on_hold')];
    setVisibility('hidden');
    setVisibility('visible');

    const view = await dialog();
    expect(await within(view).findByText('On hold', { selector: 'dd' })).toBeTruthy();
    expect(await within(view).findByText('Put on hold')).toBeTruthy();
  });
});

describe('Back, Forward and the card’s link (criteria 7, 7a)', () => {
  it('opens from a card’s Details link, closes back to the list, and returns focus to the link', async () => {
    stubApi(memberWorld(viewState()));
    renderApp(['/maintenance']);

    const link = await screen.findByRole('link', { name: /^Details: Plumbing, submitted Oct 20, 2026/ });
    fireEvent.click(link);
    const view = await dialog();
    expect(location()).toBe(`/maintenance/${REQUEST.id}`);
    await waitFor(() => expect(document.activeElement).toBe(view));

    fireEvent.keyDown(view, { key: 'Escape' });
    await waitFor(() => expect(location()).toBe('/maintenance'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('link', { name: /^Details: Plumbing/ })));
  });

  it('opens and closes with Back and Forward, the list staying mounted and asked once', async () => {
    const fetchMock = stubApi(memberWorld(viewState()));
    const app = renderApp(['/maintenance']);

    fireEvent.click(await screen.findByRole('link', { name: /^Details: Plumbing/ }));
    await timeline();
    const card = screen.getByRole('link', { name: /^Details: Plumbing/ }).closest('li');
    act(() => app.navigate()(-1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(location()).toBe('/maintenance');
    act(() => app.navigate()(1));
    expect(await timeline()).toBeTruthy();
    await settle();

    expect(screen.getByRole('link', { name: /^Details: Plumbing/ }).closest('li')).toBe(card);
    expect(calls(fetchMock).filter((call) => call === `GET ${BASE}`)).toHaveLength(1);
  });

  it('closes a link opened from elsewhere to the list, replacing it, focus on the heading', async () => {
    stubApi(memberWorld(viewState()));
    const app = renderApp(['/', `/maintenance/${REQUEST.id}`]);

    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(location()).toBe('/maintenance'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Maintenance requests' })));
    act(() => app.navigate()(-1));
    await waitFor(() => expect(location()).toBe('/'));
  });
});
