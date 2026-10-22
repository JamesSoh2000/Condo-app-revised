// @vitest-environment jsdom
/**
 * P4-08i: resend and revoke on the "Invitations" tab, the expired invitations, and a pre-approved resident in the
 * invite form. Each `describe` names the criteria it proves
 * (docs/tickets/P4-08i-invitation-resend-revoke-and-residents.md).
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

type Invitation = components['schemas']['InvitationOut'];
type Unit = components['schemas']['UnitOut'];

const PAGE = '/manage/residents?tab=invitations';
const ME = 'GET /api/auth/me';
const list = (building = MAPLE) => `GET /api/buildings/${building.id}/invitations`;
const create = (building = MAPLE) => `POST /api/buildings/${building.id}/invitations`;
const units = `GET /api/buildings/${MAPLE.id}/units`;

function invitation(n: number, fields: Partial<Invitation> = {}): Invitation {
  return {
    id: `01929a4e-0000-7000-8000-0000000e000${n}`,
    email: `staff${n}@example.test`,
    roles: ['security'],
    unit_id: null,
    relationship: null,
    status: 'pending',
    expires_at: '2026-10-29T15:00:00Z',
    created_at: '2026-10-22T15:00:00Z',
    ...fields,
  };
}

function unit(n: number, label: string, tower: string | null = null): Unit {
  return { id: `01929a4e-0000-7000-8000-0000000u000${n}`, tower, label, floor: null, is_active: true, current_occupant_count: 0 };
}

const GUARD = invitation(1, { email: 'guard@example.test' });
const BOSS = invitation(2, { email: 'boss@example.test', roles: ['council', 'property_management'] });
const OLD = invitation(3, { email: 'old@example.test', status: 'expired', expires_at: '2026-10-15T15:00:00Z' });
const U1 = unit(1, '1203', 'A');
const U2 = unit(2, '1204', 'A');
const resend = (inv: Invitation = GUARD, building = MAPLE) => `POST /api/buildings/${building.id}/invitations/${inv.id}/resend`;
const revoke = (inv: Invitation = GUARD, building = MAPLE) => `POST /api/buildings/${building.id}/invitations/${inv.id}/revoke`;

const page = (items: Invitation[], next_cursor: string | null = null) => json({ items, next_cursor });
const statusOf = (request: Request) => new URL(request.url).searchParams.get('status');

function manager(routes: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    [ME]: () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles: ['property_management'] })] }),
    [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, ['property_management'])),
    [list()]: (request) => (statusOf(request) === 'expired' ? page([OLD]) : page([GUARD, BOSS])),
    [units]: (request) => {
      const search = new URL(request.url).searchParams.get('search') ?? '';
      return json({ items: [U1, U2].filter((u) => u.label.startsWith(search)), next_cursor: null });
    },
    ...routes,
  };
}

function deferred(response: () => Response): { handler: Handler; release: () => void } {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { handler: () => gate.then(response), release };
}

function recording(answer: (body: unknown) => Response | Promise<Response>) {
  const bodies: unknown[] = [];
  const handler: Handler = async (request) => {
    const body: unknown = await request.json();
    bodies.push(body);
    return answer(body);
  };
  return { bodies, handler };
}

const noContent = () => new Response(null, { status: 204 });
const settle = (ms = 25) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const count = (fetchMock: ReturnType<typeof stubApi>, key: string) => calls(fetchMock).filter((c) => c === key).length;
const listSearches = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls
    .map(([request]) => new URL(request.url))
    .filter((url) => url.pathname === `/api/buildings/${MAPLE.id}/invitations`)
    .map((url) => url.search);
const unitSearches = (fetchMock: ReturnType<typeof stubApi>) => calls(fetchMock).filter((c) => c === units).length;
const pendingList = () => screen.getByRole('list', { name: 'Pending invitations' });
const rows = (name = 'Pending invitations') => within(screen.getByRole('list', { name })).getAllByRole('listitem');
const emails = (name = 'Pending invitations') => rows(name).map((item) => within(item).getByRole('heading').textContent);
const show = () => screen.getByLabelText<HTMLSelectElement>('Show');
const message = () => screen.queryByTestId('invitation-message');
const dialog = () => screen.getByRole('dialog');
const rowButton = (verb: 'Resend' | 'Revoke', email = 'guard@example.test') =>
  screen.getByRole<HTMLButtonElement>('button', { name: `${verb} the invitation to ${email}` });
const confirmButton = (verb: 'Resend' | 'Revoke') => within(dialog()).getByRole<HTMLButtonElement>('button', { name: verb });

async function open(verb: 'Resend' | 'Revoke', email = 'guard@example.test') {
  const button = await screen.findByRole<HTMLButtonElement>('button', { name: `${verb} the invitation to ${email}` });
  button.focus();
  fireEvent.click(button);
  await screen.findByRole('dialog');
  return button;
}

function confirm(verb: 'Resend' | 'Revoke') {
  const button = confirmButton(verb);
  button.focus();
  fireEvent.click(button);
}

describe('shown: pending or expired (criterion 2)', () => {
  it('defaults to Pending; Expired asks status=expired and says "Expired <date>"', async () => {
    const fetchMock = stubApi(manager());
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });
    expect(show().value).toBe('pending');
    expect(Array.from(show().options).map((option) => option.textContent)).toEqual(['Pending', 'Expired']);
    expect(rows()[0].textContent).toContain('Expires Oct 29, 2026');

    fireEvent.change(show(), { target: { value: 'expired' } });

    await waitFor(() => expect(emails('Expired invitations')).toEqual(['old@example.test']));
    expect(rows('Expired invitations')[0].textContent).toContain('Expired Oct 15, 2026');
    expect(screen.queryByRole('list', { name: 'Pending invitations' })).toBeNull();
    expect(listSearches(fetchMock)).toEqual(['?status=pending', '?status=expired']);
  });

  it('an empty Expired list says so', async () => {
    stubApi(manager({ [list()]: (request) => (statusOf(request) === 'expired' ? page([]) : page([GUARD])) }));
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });

    fireEvent.change(show(), { target: { value: 'expired' } });

    expect(await screen.findByText('No expired invitations.')).toBeTruthy();
  });

  it('each change starts from the first page: going back to Pending after Show more asks one page again', async () => {
    const fetchMock = stubApi(
      manager({
        [list()]: (request) => {
          const url = new URL(request.url);
          if (url.searchParams.get('status') === 'expired') return page([OLD]);
          return url.searchParams.get('cursor') === null ? page([GUARD], 'c1') : page([BOSS]);
        },
      }),
    );
    renderApp([PAGE]);
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(emails()).toEqual(['guard@example.test', 'boss@example.test']));

    fireEvent.change(show(), { target: { value: 'expired' } });
    await waitFor(() => expect(emails('Expired invitations')).toEqual(['old@example.test']));
    fireEvent.change(show(), { target: { value: 'pending' } });

    await waitFor(() => expect(emails()).toEqual(['guard@example.test']));
    expect(listSearches(fetchMock)).toEqual(['?status=pending', '?status=pending&cursor=c1', '?status=expired', '?status=pending']);
  });

  it('the expired list is keyed by building and status, stale at once', async () => {
    stubApi(manager());
    const app = renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });
    fireEvent.change(show(), { target: { value: 'expired' } });
    await screen.findByRole('list', { name: 'Expired invitations' });

    expect(app.queryClient.getQueryState(['b', MAPLE.id, 'invitations', 'expired'])?.isInvalidated).toBe(false);
    expect(app.queryClient.getQueryCache().find({ queryKey: ['b', MAPLE.id, 'invitations', 'expired'] })?.isStale()).toBe(true);
  });
});

describe('row actions (criterion 3)', () => {
  it('every row, pending or expired, has Resend and Revoke named with its email', async () => {
    stubApi(manager());
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });

    for (const email of ['guard@example.test', 'boss@example.test']) {
      expect(rowButton('Resend', email).textContent).toBe('Resend');
      expect(rowButton('Revoke', email).textContent).toBe('Revoke');
    }
    fireEvent.change(show(), { target: { value: 'expired' } });
    await screen.findByRole('list', { name: 'Expired invitations' });
    expect(rowButton('Resend', 'old@example.test')).toBeTruthy();
    expect(rowButton('Revoke', 'old@example.test')).toBeTruthy();
  });

  it('Resend’s dialog names the email and roles and says the old link stops working', async () => {
    stubApi(manager());
    renderApp([PAGE]);
    await open('Resend', 'boss@example.test');

    expect(within(dialog()).getByRole('heading').textContent).toBe('Resend this invitation?');
    expect(dialog().textContent).toContain('boss@example.test');
    expect(dialog().textContent).toContain('Property manager, Council');
    expect(dialog().textContent).toContain('The link already sent stops working, and a new one, valid for 7 days, is emailed.');
  });

  it('Revoke’s dialog says the link stops working', async () => {
    stubApi(manager());
    renderApp([PAGE]);
    await open('Revoke');

    expect(within(dialog()).getByRole('heading').textContent).toBe('Revoke this invitation?');
    expect(dialog().textContent).toContain('guard@example.test');
    expect(dialog().textContent).toContain('The link already sent stops working.');
  });

  it.each(['Cancel', 'Escape'])('%s closes with nothing sent and focus back on the row’s button', async (how) => {
    const fetchMock = stubApi(manager());
    renderApp([PAGE]);
    const opener = await open('Revoke');

    if (how === 'Cancel') fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    else fireEvent.keyDown(dialog(), { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(count(fetchMock, revoke())).toBe(0);
    expect(message()).toBeNull();
  });
});

describe('resend (criteria 4, 7)', () => {
  it('posts resend; the message gives the email and new expiry and takes focus; the list is asked again', async () => {
    const fetchMock = stubApi(manager({ [resend()]: () => json({ ...GUARD, expires_at: '2026-11-05T15:00:00Z' }) }));
    renderApp([PAGE]);
    await open('Resend');

    confirm('Resend');

    await waitFor(() => expect(message()?.textContent).toBe('A new invitation was sent to guard@example.test. It expires Nov 5, 2026.'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(message());
    expect(count(fetchMock, resend())).toBe(1);
    await waitFor(() => expect(listSearches(fetchMock)).toEqual(['?status=pending', '?status=pending']));
  });

  it('a resent expired invitation leaves the Expired list', async () => {
    let expired = [OLD];
    stubApi(
      manager({
        [list()]: (request) => (statusOf(request) === 'expired' ? page(expired) : page([GUARD])),
        [resend(OLD)]: () => {
          expired = [];
          return json({ ...OLD, status: 'pending', expires_at: '2026-11-05T15:00:00Z' });
        },
      }),
    );
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });
    fireEvent.change(show(), { target: { value: 'expired' } });
    await open('Resend', 'old@example.test');

    confirm('Resend');

    expect(await screen.findByText('No expired invitations.')).toBeTruthy();
    expect(message()?.textContent).toBe('A new invitation was sent to old@example.test. It expires Nov 5, 2026.');
  });
});

describe('revoke (criteria 5, 7)', () => {
  it('posts revoke; the message takes focus and the row leaves the list', async () => {
    let items = [GUARD, BOSS];
    const fetchMock = stubApi(
      manager({
        [list()]: () => page(items),
        [revoke()]: () => {
          items = [BOSS];
          return noContent();
        },
      }),
    );
    renderApp([PAGE]);
    await open('Revoke');

    confirm('Revoke');

    await waitFor(() => expect(message()?.textContent).toBe('The invitation to guard@example.test was revoked.'));
    expect(document.activeElement).toBe(message());
    await waitFor(() => expect(emails()).toEqual(['boss@example.test']));
    expect(count(fetchMock, revoke())).toBe(1);
  });
});

describe('refusals (criteria 6, 7)', () => {
  it.each([
    ['Resend', 404, 'invitation_not_found', 'This invitation no longer exists.'],
    ['Revoke', 404, 'invitation_not_found', 'This invitation no longer exists.'],
    ['Resend', 409, 'invalid_transition', 'This invitation was already accepted or revoked.'],
    ['Revoke', 409, 'invalid_transition', 'This invitation was already accepted or revoked.'],
    ['Resend', 409, 'invitation_pending', 'guard@example.test already has another pending invitation. Revoke one of them first.'],
    ['Resend', 403, 'forbidden_role', 'You can no longer manage invitations in this building.'],
    ['Revoke', 403, 'forbidden_role', 'You can no longer manage invitations in this building.'],
  ] as const)('%s → %i %s ends the dialog with its message focused, and the list is asked again', async (verb, status, code, text) => {
    const route = verb === 'Resend' ? resend() : revoke();
    const fetchMock = stubApi(manager({ [route]: () => problem(status, code) }));
    renderApp([PAGE]);
    await open(verb);

    confirm(verb);

    await waitFor(() => expect(message()?.textContent).toBe(text));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(message());
    await waitFor(() => expect(listSearches(fetchMock)).toHaveLength(2));
  });

  it.each([
    ['Resend', '500', () => problem(500, 'internal_error'), 'Could not resend the invitation. Try again.'],
    ['Revoke', 'a network error', () => Promise.reject(new TypeError('Failed to fetch')), 'Could not revoke the invitation. Try again.'],
    ['Revoke', '409 unknown', () => problem(409, 'something_else'), 'Could not revoke the invitation. Try again.'],
  ] as const)('%s → %s keeps the dialog open with a focused alert, the buttons enabled, the list asked again', async (verb, _label, answer, text) => {
    const route = verb === 'Resend' ? resend() : revoke();
    const fetchMock = stubApi(manager({ [route]: answer }));
    renderApp([PAGE]);
    await open(verb);

    confirm(verb);

    const alert = await within(dialog()).findByRole('alert');
    expect(alert.textContent).toBe(text);
    expect(document.activeElement).toBe(alert);
    expect(confirmButton(verb).disabled).toBe(false);
    expect(within(dialog()).getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(false);
    await waitFor(() => expect(listSearches(fetchMock)).toHaveLength(2));
    expect(message()).toBeNull();
  });

  it('a 429 gives its wait, and Confirm works again', async () => {
    let n = 0;
    const fetchMock = stubApi(
      manager({ [resend()]: () => (++n === 1 ? problem(429, 'rate_limited', { 'Retry-After': '30' }) : json(GUARD)) }),
    );
    renderApp([PAGE]);
    await open('Resend');

    confirm('Resend');
    const alert = await within(dialog()).findByRole('alert');
    expect(alert.textContent).toMatch(/30 seconds/);

    confirm('Resend');
    await waitFor(() => expect(message()?.textContent).toMatch(/^A new invitation was sent to guard@example.test/));
    expect(count(fetchMock, resend())).toBe(2);
  });

  it('building_not_found marks the building denied', async () => {
    stubApi(manager({ [revoke()]: () => problem(404, 'building_not_found') }));
    const app = renderApp([PAGE]);
    await open('Revoke');

    confirm('Revoke');

    await waitFor(() => expect(app.queryClient.getQueryData(['b', MAPLE.id, 'denied'])).toEqual(expect.any(Number)));
  });
});

describe('one request (criterion 8)', () => {
  it('a double click sends one request; while out the buttons are disabled, Escape does nothing, focus stays in the dialog', async () => {
    const gate = deferred(noContent);
    const fetchMock = stubApi(manager({ [revoke()]: gate.handler }));
    renderApp([PAGE]);
    await open('Revoke');

    const button = confirmButton('Revoke');
    button.focus();
    fireEvent.click(button);
    fireEvent.click(button);
    await settle();

    expect(count(fetchMock, revoke())).toBe(1);
    expect(button.disabled).toBe(true);
    expect(within(dialog()).getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(true);
    expect(dialog().contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();

    gate.release();
    await waitFor(() => expect(message()?.textContent).toBe('The invitation to guard@example.test was revoked.'));
  });
});

describe('leaving and switching (criterion 9)', () => {
  it('an answer after leaving the page shows nothing on the new one; the list is still asked again', async () => {
    const gate = deferred(() => json(GUARD));
    stubApi(manager({ [resend()]: gate.handler }));
    const app = renderApp([PAGE]);
    await open('Resend');
    confirm('Resend');
    await settle();

    act(() => app.navigate()('/Contacts'));
    await screen.findByText(/being migrated/i);
    gate.release();
    await settle();

    expect(message()).toBeNull();
    expect(screen.queryByText(/A new invitation was sent/)).toBeNull();
    expect(app.queryClient.getQueryState(['b', MAPLE.id, 'invitations', 'pending'])?.isInvalidated).toBe(true);
  });

  it('a building switch while a revoke is out lists the other building’s invitations and shows nothing of the first', async () => {
    const me = {
      ...RESIDENT_ME,
      memberships: [membership(MAPLE, { roles: ['property_management'] }), membership(BIRCH, { roles: ['property_management'] })],
    };
    const gate = deferred(noContent);
    const fetchMock = stubApi({
      [ME]: () => json(me),
      [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, ['property_management'])),
      [`GET /api/buildings/${BIRCH.id}`]: () => json(buildingOut(BIRCH, ['property_management'])),
      [`GET /api/buildings/${BIRCH.id}/notifications/summary`]: () => json({ unread_count: 0 }),
      [list()]: () => page([GUARD]),
      [list(BIRCH)]: () => page([invitation(7, { email: 'birch@example.test' })]),
      [revoke()]: gate.handler,
    });
    sessionStorage.setItem('condo.buildingId', MAPLE.id);
    const app = renderApp([PAGE]);
    await open('Revoke');
    confirm('Revoke');
    await settle();

    openAccountMenu();
    fireEvent.change(screen.getByLabelText(/building/i), { target: { value: BIRCH.id } });
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/'));
    act(() => app.navigate()(PAGE));
    await waitFor(() => expect(emails()).toEqual(['birch@example.test']));
    gate.release();
    await settle();

    expect(message()).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(emails()).toEqual(['birch@example.test']);
    // The switch removed Maple's queries (BuildingProvider), so nothing read before the revoke is left to serve: going
    // back asks again.
    expect(app.queryClient.getQueryState(['b', MAPLE.id, 'invitations', 'pending'])).toBeUndefined();
    expect(count(fetchMock, revoke(GUARD, BIRCH))).toBe(0);
  });
});

const emailField = () => screen.getByLabelText<HTMLInputElement>('Email');
const role = (label: string) => within(screen.getByRole('group', { name: 'Roles' })).getByRole<HTMLInputElement>('checkbox', { name: label });
const unitSearch = () => screen.queryByLabelText<HTMLInputElement>('Unit number');
const unitGroup = () => screen.getByRole('group', { name: 'Unit' });
const relationshipGroup = () => screen.getByRole('group', { name: 'How they relate to the unit' });
const send = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Send invitation' });

function submit() {
  send().focus();
  fireEvent.click(send());
}

async function residentForm(routes: Record<string, Handler> = {}) {
  const fetchMock = stubApi(manager(routes));
  renderApp([PAGE]);
  await screen.findByRole('list', { name: 'Pending invitations' });
  fireEvent.change(emailField(), { target: { value: 'robin@example.test' } });
  fireEvent.click(role('Resident'));
  await within(unitGroup()).findByRole('radio', { name: 'A-1203' });
  return fetchMock;
}

describe('resident in the invite form (criterion 10)', () => {
  it('the form is "Invite people"; Resident comes first; its unit fields show only while it is ticked', async () => {
    const fetchMock = stubApi(manager());
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });

    expect(screen.getByRole('form', { name: 'Invite people' })).toBeTruthy();
    const group = screen.getByRole('group', { name: 'Roles' });
    expect(within(group).getAllByRole('checkbox').map((box) => box.closest('label')?.textContent)).toEqual([
      'Resident',
      'Security',
      'Property manager',
      'Council',
    ]);
    expect(unitSearch()).toBeNull();
    expect(unitSearches(fetchMock)).toBe(0);

    fireEvent.click(role('Resident'));
    await within(unitGroup()).findByRole('radio', { name: 'A-1203' });
    expect(unitSearch()).toBeTruthy();
    expect(within(relationshipGroup()).getAllByRole('radio').length).toBeGreaterThan(1);

    fireEvent.click(role('Resident'));
    expect(unitSearch()).toBeNull();
    expect(screen.queryByRole('group', { name: 'How they relate to the unit' })).toBeNull();
  });

  it('with Resident, a unit and relationship are required; nothing is sent while either is missing', async () => {
    const fetchMock = await residentForm();

    submit();
    await settle();

    expect(within(unitGroup()).getByText('Choose a unit.')).toBeTruthy();
    expect(within(relationshipGroup()).getByText('Choose how they relate to the unit.')).toBeTruthy();
    expect(document.activeElement).toBe(unitSearch());
    expect(count(fetchMock, create())).toBe(0);

    fireEvent.click(within(unitGroup()).getByRole('radio', { name: 'A-1203' }));
    expect(within(unitGroup()).queryByText('Choose a unit.')).toBeNull();
    submit();
    await settle();
    expect(document.activeElement).toBe(within(relationshipGroup()).getAllByRole('radio')[0]);
    expect(count(fetchMock, create())).toBe(0);
  });

  it('sends the unit and relationship with Resident, then clears the form', async () => {
    const recorded = recording(() => json(invitation(9, { email: 'robin@example.test', roles: ['resident'], unit_id: U1.id, relationship: 'owner' }), 201));
    await residentForm({ [create()]: recorded.handler });

    fireEvent.click(within(unitGroup()).getByRole('radio', { name: 'A-1203' }));
    fireEvent.click(within(relationshipGroup()).getByRole('radio', { name: 'Owner' }));
    submit();

    await waitFor(() => expect(message()?.textContent).toBe('Invitation sent to robin@example.test.'));
    expect(recorded.bodies).toEqual([{ email: 'robin@example.test', roles: ['resident'], unit_id: U1.id, relationship: 'owner' }]);
    expect(role('Resident').checked).toBe(false);
    expect(unitSearch()).toBeNull();
  });

  it('unticking Resident sends no unit or relationship', async () => {
    const recorded = recording(() => json(invitation(9, { email: 'robin@example.test' }), 201));
    await residentForm({ [create()]: recorded.handler });
    fireEvent.click(within(unitGroup()).getByRole('radio', { name: 'A-1203' }));
    fireEvent.click(within(relationshipGroup()).getByRole('radio', { name: 'Owner' }));

    fireEvent.click(role('Resident'));
    fireEvent.click(role('Security'));
    submit();

    await waitFor(() => expect(recorded.bodies).toEqual([{ email: 'robin@example.test', roles: ['security'] }]));
  });

  it('typing a new search clears the unit choice; control characters are refused and not searched', async () => {
    const fetchMock = await residentForm();
    fireEvent.click(within(unitGroup()).getByRole('radio', { name: 'A-1203' }));
    const before = unitSearches(fetchMock);

    fireEvent.change(unitSearch()!, { target: { value: '12\t' } });

    expect(screen.getByText('Search with visible characters only.')).toBeTruthy();
    expect(unitSearch()!.getAttribute('aria-invalid')).toBe('true');
    await settle(400);
    expect(unitSearches(fetchMock)).toBe(before);

    fireEvent.change(unitSearch()!, { target: { value: '1204' } });
    await within(unitGroup()).findByRole('radio', { name: 'A-1204' });
    await waitFor(() => expect(within(unitGroup()).queryByRole('radio', { name: 'A-1203' })).toBeNull());
    expect(within(unitGroup()).getByRole<HTMLInputElement>('radio', { name: 'A-1204' }).checked).toBe(false);
    expect(unitSearch()!.maxLength).toBe(20);
  });

  it('Resident with a staff role sends both roles in Role order', async () => {
    const recorded = recording(() => json(invitation(9, { email: 'robin@example.test', roles: ['resident', 'council'] }), 201));
    await residentForm({ [create()]: recorded.handler });
    fireEvent.click(role('Council'));
    fireEvent.click(within(unitGroup()).getByRole('radio', { name: 'A-1204' }));
    fireEvent.click(within(relationshipGroup()).getByRole('radio', { name: 'Tenant' }));
    submit();

    await waitFor(() => expect(recorded.bodies).toEqual([{ email: 'robin@example.test', roles: ['resident', 'council'], unit_id: U2.id, relationship: 'tenant' }]));
  });
});

describe('unit refusals keep the form open (criterion 11)', () => {
  it.each([
    [404, 'unit_not_found'],
    [409, 'unit_inactive'],
  ] as const)('%i %s: a focused alert, the unit cleared, the units asked again, the rest kept', async (status, code) => {
    let n = 0;
    const fetchMock = await residentForm({ [create()]: () => (++n === 1 ? problem(status, code) : json(invitation(9), 201)) });
    fireEvent.click(within(unitGroup()).getByRole('radio', { name: 'A-1203' }));
    fireEvent.click(within(relationshipGroup()).getByRole('radio', { name: 'Owner' }));
    const before = unitSearches(fetchMock);

    submit();

    const alert = await screen.findByText('That unit is no longer available. Choose another.');
    expect(document.activeElement).toBe(alert);
    expect(within(unitGroup()).getByRole<HTMLInputElement>('radio', { name: 'A-1203' }).checked).toBe(false);
    await waitFor(() => expect(unitSearches(fetchMock)).toBe(before + 1));
    expect(emailField().value).toBe('robin@example.test');
    expect(role('Resident').checked).toBe(true);
    expect(within(relationshipGroup()).getByRole<HTMLInputElement>('radio', { name: 'Owner' }).checked).toBe(true);
    expect(send().disabled).toBe(false);
  });
});

describe('labels (criterion 12)', () => {
  it('links the unit and relationship errors to their groups; the dialog is named by its title', async () => {
    await residentForm();
    submit();
    await settle();

    for (const [group, text] of [
      [unitGroup(), 'Choose a unit.'],
      [relationshipGroup(), 'Choose how they relate to the unit.'],
    ] as const) {
      expect(document.getElementById(group.getAttribute('aria-describedby')!)?.textContent).toBe(text);
    }

    await open('Resend');
    expect(screen.getByRole('dialog', { name: 'Resend this invitation?' })).toBeTruthy();
    expect(pendingList()).toBeTruthy();
  });
});
