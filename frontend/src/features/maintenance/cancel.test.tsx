// @vitest-environment jsdom
/**
 * P6-04b criterion 7 (and 8 for the dialog): cancelling one's own `submitted` maintenance request from its card
 * (docs/tickets/P6-04b-maintenance-submit-and-cancel.md).
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeSelectedBuilding } from '@/app/buildingStorage';
import { expectFocusKept } from '@/test/focus';
import { CO_OCCUPANT, maintenanceBase, maintenanceRequest, newWorld, residentWorld, type World } from '@/test/maintenance';
import { BIRCH, MAPLE, RESIDENT_ME, buildingOut, calls, json, membership, openAccountMenu, problem, renderApp, stubApi } from '@/test/renderApp';

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, ...actual.createApiClient({ baseUrl: 'http://app.test' }) };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const OWN_SUBMITTED = maintenanceRequest(3, { description: 'Own and submitted' });
const OTHERS = maintenanceRequest(2, { description: 'A co-occupant’s', requester_membership_id: CO_OCCUPANT });
const OWN_STARTED = maintenanceRequest(1, { description: 'Own and started', status: 'in_progress', started_at: '2026-10-21T10:00:00Z' });

const cards = async () => within(await screen.findByRole('list', { name: 'Your maintenance requests' })).getAllByRole('listitem');
const card = async (text: string) => (await cards()).find((item) => item.textContent?.includes(text))!;
const dialog = () => screen.findByRole('dialog', { name: 'Cancel this request?' });
const listCalls = (fetchMock: ReturnType<typeof stubApi>) => calls(fetchMock).filter((call) => call === `GET ${maintenanceBase()}`).length;

async function openDialog(world: World, options: Parameters<typeof residentWorld>[1] = {}) {
  const fetchMock = stubApi(residentWorld(world, options));
  renderApp(['/maintenance']);
  const opener = within(await card('Own and submitted')).getByRole('button', { name: 'Cancel request' });
  opener.focus();
  fireEvent.click(opener);
  return { fetchMock, opener, shown: await dialog() };
}

describe('who gets the button (criterion 7)', () => {
  it('only the caller’s own submitted request has Cancel request', async () => {
    stubApi(residentWorld(newWorld([OWN_SUBMITTED, OTHERS, OWN_STARTED])));
    renderApp(['/maintenance']);

    expect(within(await card('Own and submitted')).queryByRole('button', { name: 'Cancel request' })).not.toBeNull();
    expect(within(await card('A co-occupant’s')).queryByRole('button')).toBeNull();
    expect(within(await card('Own and started')).queryByRole('button')).toBeNull();
  });
});

describe('confirming (criterion 7)', () => {
  it('sends one cancel, shows the card as cancelled, says so and focuses the card', async () => {
    const world = newWorld([OWN_SUBMITTED, OTHERS]);
    const { shown } = await openDialog(world);
    const confirm = within(shown).getByRole('button', { name: 'Cancel request' });
    confirm.focus();

    await expectFocusKept(() => void fireEvent.click(confirm), {
      control: () => confirm,
      settle: async () => void (await screen.findByText('Request cancelled.')),
    });

    expect(world.cancelled).toEqual([OWN_SUBMITTED.id]);
    expect(screen.queryByRole('dialog')).toBeNull();
    const done = await card('Own and submitted');
    expect(done.textContent).toContain('Cancelled');
    expect(within(done).queryByRole('button')).toBeNull();
    expect(document.activeElement).toBe(done);
  });

  it('a double press sends one cancel', async () => {
    const world = newWorld([OWN_SUBMITTED]);
    const { shown } = await openDialog(world);
    const confirm = within(shown).getByRole('button', { name: 'Cancel request' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await screen.findByText('Request cancelled.');
    expect(world.cancelled).toHaveLength(1);
  });

  it('shows the card as cancelled at once, before the refresh answers', async () => {
    const world = newWorld([OWN_SUBMITTED]);
    const routes = residentWorld(world);
    let hold = false;
    stubApi({
      ...routes,
      [`GET ${maintenanceBase()}`]: (request) => (hold ? new Promise<Response>(() => {}) : routes[`GET ${maintenanceBase()}`](request)),
    });
    renderApp(['/maintenance']);
    fireEvent.click(within(await card('Own and submitted')).getByRole('button', { name: 'Cancel request' }));
    hold = true;
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Cancel request' }));

    await screen.findByText('Request cancelled.');
    expect((await card('Own and submitted')).textContent).toContain('Cancelled');
  });
});

describe('dismissing (criterion 7)', () => {
  it('Keep request returns focus to the opener and sends nothing', async () => {
    const world = newWorld([OWN_SUBMITTED]);
    const { shown, opener } = await openDialog(world);
    fireEvent.click(within(shown).getByRole('button', { name: 'Keep request' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(world.cancelled).toHaveLength(0);
  });

  it('Escape returns focus to the opener and sends nothing', async () => {
    const world = newWorld([OWN_SUBMITTED]);
    const { shown, opener } = await openDialog(world);
    fireEvent.keyDown(shown, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(world.cancelled).toHaveLength(0);
  });

  it('opens with focus on Keep request', async () => {
    const { shown } = await openDialog(newWorld([OWN_SUBMITTED]));
    expect(document.activeElement).toBe(within(shown).getByRole('button', { name: 'Keep request' }));
  });
});

describe('refusals (criterion 7)', () => {
  const ended = [
    { name: '409 invalid_transition', status: 409, code: 'invalid_transition', message: 'It was already started or cancelled.' },
    { name: '404 maintenance_request_not_found', status: 404, code: 'maintenance_request_not_found', message: 'It was already started or cancelled.' },
    { name: '403 not_requester', status: 403, code: 'not_requester', message: 'Only the resident who filed this request can cancel it.' },
  ];

  it.each(ended)('$name: says so, keeps the dialog with only Close, refreshes the list', async ({ status, code, message }) => {
    const world = newWorld([OWN_SUBMITTED]);
    const { shown, fetchMock } = await openDialog(world, {
      cancel: () => {
        // A manager started it meanwhile.
        world.items = [{ ...OWN_SUBMITTED, status: 'in_progress', started_at: '2026-10-29T15:00:00Z' }];
        return problem(status, code);
      },
    });
    const before = listCalls(fetchMock);
    const confirm = within(shown).getByRole('button', { name: 'Cancel request' });
    confirm.focus();
    fireEvent.click(confirm);

    const alert = await within(shown).findByRole('alert');
    expect(alert.textContent).toBe(message);
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(within(shown).getAllByRole('button').map((button) => button.textContent)).toEqual(['Close']);
    await waitFor(() => expect(listCalls(fetchMock)).toBeGreaterThan(before));
    await waitFor(async () => expect((await card('Own and submitted')).textContent).toContain('In progress'));
  });

  it('Close after a 409 returns focus to the card when the opener is gone', async () => {
    const world = newWorld([OWN_SUBMITTED]);
    const { shown } = await openDialog(world, {
      cancel: () => {
        world.items = [{ ...OWN_SUBMITTED, status: 'in_progress', started_at: '2026-10-29T15:00:00Z' }];
        return problem(409, 'invalid_transition');
      },
    });
    fireEvent.click(within(shown).getByRole('button', { name: 'Cancel request' }));
    await within(shown).findByRole('alert');
    await waitFor(async () => expect(within(await card('Own and submitted')).queryByRole('button')).toBeNull());
    fireEvent.click(within(shown).getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(await card('Own and submitted'));
  });

  it('Close after a 409 returns focus to the opener when it is still there', async () => {
    const world = newWorld([OWN_SUBMITTED]);
    const { shown, opener } = await openDialog(world, { cancel: () => problem(409, 'invalid_transition') });
    fireEvent.click(within(shown).getByRole('button', { name: 'Cancel request' }));
    await within(shown).findByRole('alert');
    fireEvent.click(within(shown).getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(opener);
  });

  it.each([
    { name: '429', answer: () => problem(429, 'rate_limited', { 'Retry-After': '30' }), message: 'Too many requests. Try again in 30 seconds.' },
    { name: '500', answer: () => problem(500, 'internal_error'), message: 'Could not cancel the request. Try again.' },
    { name: 'a network failure', answer: () => Promise.reject(new TypeError('Failed to fetch')), message: 'Could not cancel the request. Try again.' },
  ])('$name: says so and keeps both buttons, so it can be tried again', async ({ answer, message }) => {
    const world = newWorld([OWN_SUBMITTED]);
    const { shown } = await openDialog(world, { cancel: answer });
    fireEvent.click(within(shown).getByRole('button', { name: 'Cancel request' }));

    const alert = await within(shown).findByRole('alert');
    expect(alert.textContent).toBe(message);
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(within(shown).getAllByRole('button').map((button) => button.textContent)).toEqual(['Keep request', 'Cancel request']);
  });
});

describe('switching building (criterion 8)', () => {
  it('closes the dialog and sends no cancel', async () => {
    const world = newWorld([OWN_SUBMITTED]);
    const birch = `/api/buildings/${BIRCH.id}`;
    const fetchMock = stubApi({
      ...residentWorld(world),
      'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE), membership(BIRCH)] }),
      [`GET ${birch}`]: () => json(buildingOut(BIRCH, ['resident'])),
      [`GET ${birch}/notifications/summary`]: () => json({ unread_count: 0 }),
      [`GET ${birch}/maintenance-requests`]: () => json({ items: [], next_cursor: null }),
    });
    writeSelectedBuilding(MAPLE.id);
    renderApp(['/maintenance']);
    fireEvent.click(within(await card('Own and submitted')).getByRole('button', { name: 'Cancel request' }));
    await dialog();

    openAccountMenu();
    fireEvent.change(screen.getByRole('combobox', { name: 'Building' }), { target: { value: BIRCH.id } });
    fireEvent.click(await within(await screen.findByRole('navigation', { name: 'Main' })).findByRole('link', { name: 'Maintenance requests' }));

    await screen.findByText('You haven’t submitted any requests.');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls(fetchMock).some((call) => call.endsWith('/cancel'))).toBe(false);
  });
});
