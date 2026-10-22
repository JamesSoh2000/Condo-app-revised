// @vitest-environment jsdom
/**
 * P4-08g: the "Invitations" tab of `/manage/residents`: the staff invite form and the pending invitations. Each
 * `describe` names the criteria it proves (docs/tickets/P4-08g-staff-invitations-screen.md).
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

const PAGE = '/manage/residents?tab=invitations';
const ME = 'GET /api/auth/me';
const list = (building = MAPLE) => `GET /api/buildings/${building.id}/invitations`;
const create = (building = MAPLE) => `POST /api/buildings/${building.id}/invitations`;

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

const GUARD = invitation(1, { email: 'guard@example.test' });
const BOSS = invitation(2, { email: 'boss@example.test', roles: ['council', 'property_management'] });

const page = (items: Invitation[], next_cursor: string | null = null) => json({ items, next_cursor });

function manager(routes: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    [ME]: () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles: ['property_management'] })] }),
    [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, ['property_management'])),
    [list()]: () => page([GUARD, BOSS]),
    ...routes,
  };
}

function deferred(response: () => Response): { handler: Handler; release: () => void } {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { handler: () => gate.then(response), release };
}

/** Records each JSON body sent to the route, then answers. */
function recording(answer: (body: unknown) => Response | Promise<Response>) {
  const bodies: unknown[] = [];
  const handler: Handler = async (request) => {
    const body: unknown = await request.json();
    bodies.push(body);
    return answer(body);
  };
  return { bodies, handler };
}

const created = (body: unknown, fields: Partial<Invitation> = {}) => {
  const { email, roles } = body as { email: string; roles: Invitation['roles'] };
  return json(invitation(9, { email: email.toLowerCase(), roles, ...fields }), 201);
};

const settle = (ms = 25) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const count = (fetchMock: ReturnType<typeof stubApi>, key: string) => calls(fetchMock).filter((c) => c === key).length;
const listQueries = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls
    .map(([request]) => new URL(request.url))
    .filter((url) => url.pathname === `/api/buildings/${MAPLE.id}/invitations`)
    .map((url) => url.search);
const invitationsList = () => screen.getByRole('list', { name: 'Pending invitations' });
const rows = () => within(invitationsList()).getAllByRole('listitem');
const emails = () => rows().map((item) => within(item).getByRole('heading').textContent);
const emailField = () => screen.getByLabelText<HTMLInputElement>('Email');
const role = (label: string) => within(screen.getByRole('group', { name: 'Roles' })).getByRole<HTMLInputElement>('checkbox', { name: label });
const send = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Send invitation' });
const message = () => screen.queryByTestId('invitation-message');

function fill(email: string, ...roles: string[]) {
  fireEvent.change(emailField(), { target: { value: email } });
  for (const label of roles) fireEvent.click(role(label));
}

function submit() {
  send().focus();
  fireEvent.click(send());
}

describe('tab (criterion 1)', () => {
  it('is the third tab: End and the arrows reach it, it puts itself in the URL, and Back returns', async () => {
    stubApi(manager());
    const app = renderApp(['/manage/residents']);
    const pending = await screen.findByRole('tab', { name: 'Pending requests' });

    pending.focus();
    fireEvent.keyDown(pending, { key: 'End' });

    const invitations = screen.getByRole('tab', { name: 'Invitations' });
    await waitFor(() => expect(invitations.getAttribute('aria-selected')).toBe('true'));
    expect(document.activeElement).toBe(invitations);
    expect(screen.getByTestId('location').textContent).toBe(PAGE);
    await screen.findByRole('list', { name: 'Pending invitations' });

    fireEvent.keyDown(invitations, { key: 'ArrowRight' });
    await waitFor(() => expect(pending.getAttribute('aria-selected')).toBe('true'));
    fireEvent.keyDown(pending, { key: 'ArrowLeft' });
    await waitFor(() => expect(invitations.getAttribute('aria-selected')).toBe('true'));
    fireEvent.keyDown(invitations, { key: 'ArrowLeft' });
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Members' }).getAttribute('aria-selected')).toBe('true'));

    act(() => app.navigate()(-1));
    await waitFor(() => expect(invitations.getAttribute('aria-selected')).toBe('true'));
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Pending requests', 'Members', 'Invitations']);
  });

  it('opens from a link; an unknown tab still shows Pending requests', async () => {
    stubApi({ ...manager(), [`GET /api/buildings/${MAPLE.id}/onboarding-requests`]: () => json({ items: [], next_cursor: null }) });
    const app = renderApp([PAGE]);
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Invitations' }).getAttribute('aria-selected')).toBe('true'));

    act(() => app.navigate()('/manage/residents?tab=nope'));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Pending requests' }).getAttribute('aria-selected')).toBe('true'));
  });
});

describe('pending list (criterion 2)', () => {
  it('lists pending invitations with their roles in Role order and expiry date, asking for status=pending', async () => {
    const fetchMock = stubApi(manager());
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });

    expect(emails()).toEqual(['guard@example.test', 'boss@example.test']);
    expect(rows()[0].textContent).toContain('Security');
    expect(rows()[1].textContent).toContain('Property manager, Council');
    expect(rows()[0].textContent).toContain('Expires Oct 29, 2026');
    expect(listQueries(fetchMock)).toEqual(['?status=pending']);
  });

  it('says when nothing is pending, and while loading', async () => {
    const gate = deferred(() => page([]));
    stubApi(manager({ [list()]: gate.handler }));
    renderApp([PAGE]);

    expect(await screen.findByText('Loading invitations…')).toBeTruthy();
    gate.release();
    expect(await screen.findByText('No pending invitations.')).toBeTruthy();
  });

  it('a failed first load and a failed refresh each say so with Try again; a 429 gives its wait', async () => {
    let answer: () => Response = () => problem(500, 'internal');
    stubApi(manager({ [list()]: () => answer() }));
    const app = renderApp([PAGE]);

    expect((await screen.findByRole('alert')).textContent).toContain('Could not load the invitations.');
    answer = () => page([GUARD]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('list', { name: 'Pending invitations' });

    answer = () => problem(500, 'internal');
    await act(() => app.queryClient.refetchQueries({ queryKey: ['b', MAPLE.id, 'invitations'] }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not refresh the invitations.');
    expect(emails()).toEqual(['guard@example.test']);

    answer = () => problem(429, 'rate_limited', { 'Retry-After': '30' });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Try again in 30 seconds.'));
  });

  it('Show more loads the next page; it waits for any fetch and hides after a failed refresh', async () => {
    let second: () => Response = () => page([BOSS]);
    const fetchMock = stubApi(
      manager({
        [list()]: (request) => {
          const cursor = new URL(request.url).searchParams.get('cursor');
          return cursor === null ? page([GUARD], 'c1') : second();
        },
      }),
    );
    const app = renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(emails()).toEqual(['guard@example.test', 'boss@example.test']));
    expect(listQueries(fetchMock)).toContain('?status=pending&cursor=c1');
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();

    // A failed next page says so.
    second = () => problem(500, 'internal');
    act(() => void app.queryClient.resetQueries({ queryKey: ['b', MAPLE.id, 'invitations'] }));
    await screen.findByRole('button', { name: 'Show more' });
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Could not load more invitations.')).toBeTruthy();
  });

  it('Show more is disabled while a refresh is out, and hidden after a failed refresh', async () => {
    let first: Handler = () => page([GUARD], 'c1');
    stubApi(manager({ [list()]: (request) => first(request) }));
    const app = renderApp([PAGE]);
    await screen.findByRole('button', { name: 'Show more' });

    const gate = deferred(() => problem(500, 'internal'));
    first = gate.handler;
    act(() => void app.queryClient.refetchQueries({ queryKey: ['b', MAPLE.id, 'invitations'] }));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Show more' }).disabled).toBe(true));
    gate.release();
    expect((await screen.findByRole('alert')).textContent).toContain('Could not refresh the invitations.');
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });
});

describe('fresh list (criterion 3)', () => {
  it('is keyed by building and asked for again when the tab comes back', async () => {
    const fetchMock = stubApi({ ...manager(), [`GET /api/buildings/${MAPLE.id}/members`]: () => json({ items: [], next_cursor: null }) });
    const app = renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });
    expect(app.queryClient.getQueryData(['b', MAPLE.id, 'invitations', 'pending'])).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
    await screen.findByText("No members match.");
    fireEvent.click(screen.getByRole('tab', { name: 'Invitations' }));
    await screen.findByRole('list', { name: 'Pending invitations' });
    await waitFor(() => expect(count(fetchMock, list())).toBe(2));
  });

  it.each([
    ['201', (body: unknown) => created(body)],
    ['500', () => problem(500, 'internal')],
  ])('asks for the list again after a create answered %s', async (_label, answer) => {
    const fetchMock = stubApi(manager({ [create()]: recording(answer).handler }));
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });

    fill('new@example.test', 'Security');
    submit();

    await waitFor(() => expect(count(fetchMock, list())).toBe(2));
  });
});

describe('invite form checks (criterion 4)', () => {
  // P4-08g's "no Resident" was until P4-08i, which adds it first (P4-08i criterion 10).
  it('offers the three staff roles, after Resident', async () => {
    stubApi(manager());
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });

    const group = screen.getByRole('group', { name: 'Roles' });
    expect(within(group).getAllByRole('checkbox').map((box) => box.closest('label')?.textContent)).toEqual([
      'Resident',
      'Security',
      'Property manager',
      'Council',
    ]);
  });

  it.each([
    ['', 'Enter one email address.'],
    ['   ', 'Enter one email address.'],
    ['no-at-sign', 'Enter one email address.'],
    ['two words@example.test', 'Enter one email address.'],
    [`${'a'.repeat(64)}@${'b'.repeat(186)}.test`, 'Use at most 254 characters.'],
  ])('the email %j says %s and nothing is sent', async (email, text) => {
    const fetchMock = stubApi(manager());
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });

    fill(email, 'Security');
    submit();
    await settle();

    expect(screen.getByText(text)).toBeTruthy();
    expect(emailField().getAttribute('aria-invalid')).toBe('true');
    expect(count(fetchMock, create())).toBe(0);
  });

  it('no role says so and sends nothing', async () => {
    const fetchMock = stubApi(manager());
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });

    fill('new@example.test');
    submit();
    await settle();

    expect(screen.getByText('Choose at least one role.')).toBeTruthy();
    expect(count(fetchMock, create())).toBe(0);
  });

  it('sends the trimmed email and the roles in Role order, nothing else', async () => {
    const recorded = recording((body) => created(body));
    stubApi(manager({ [create()]: recorded.handler }));
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });

    fill('  New@Example.test ', 'Council', 'Security', 'Property manager');
    submit();

    await waitFor(() => expect(recorded.bodies).toEqual([{ email: 'New@Example.test', roles: ['security', 'property_management', 'council'] }]));
  });

  it('a 254-byte email is sent', async () => {
    const recorded = recording((body) => created(body));
    stubApi(manager({ [create()]: recorded.handler }));
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });

    const email = `${'a'.repeat(64)}@${'b'.repeat(184)}.test`;
    expect(email.length).toBe(254);
    fill(email, 'Security');
    submit();

    await waitFor(() => expect(recorded.bodies).toHaveLength(1));
  });
});

describe('sent (criterion 5)', () => {
  it('says to whom (as the server wrote it), takes focus, clears the form and shows the new invitation', async () => {
    let listed = [GUARD];
    const recorded = recording((body) => {
      const answer = created(body);
      listed = [invitation(9, { email: 'new@example.test', roles: ['council'] }), GUARD];
      return answer;
    });
    stubApi(manager({ [list()]: () => page(listed), [create()]: recorded.handler }));
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });

    fill('New@Example.test', 'Council');
    submit();

    await waitFor(() => expect(message()?.textContent).toBe('Invitation sent to new@example.test.'));
    expect(message()?.getAttribute('role')).toBe('status');
    await waitFor(() => expect(document.activeElement).toBe(message()));
    expect(emailField().value).toBe('');
    expect(role('Council').checked).toBe(false);
    await waitFor(() => expect(emails()).toEqual(['new@example.test', 'guard@example.test']));
  });
});

describe('refusals (criterion 6)', () => {
  it.each([
    [409, 'invitation_pending', 'new@example.test already has a pending invitation.'],
    [403, 'forbidden_role', 'You can no longer invite people to this building.'],
    [422, 'validation_error', 'Could not send the invitation. Try again.'],
    [500, 'internal', 'Could not send the invitation. Try again.'],
  ])('%i %s: "%s", the form keeps what was typed and works again', async (status, code, text) => {
    stubApi(manager({ [create()]: () => problem(status, code) }));
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });

    fill('new@example.test', 'Security');
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(text);
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(emailField().value).toBe('new@example.test');
    expect(role('Security').checked).toBe(true);
    expect(send().disabled).toBe(false);
    expect(message()).toBeNull();
  });

  it('invitation_pending asks for the list again, so the colleague’s invitation shows', async () => {
    let listed = [GUARD];
    stubApi(
      manager({
        [list()]: () => page(listed),
        [create()]: () => {
          listed = [invitation(9, { email: 'new@example.test' }), GUARD];
          return problem(409, 'invitation_pending');
        },
      }),
    );
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });

    fill('new@example.test', 'Security');
    submit();

    await waitFor(() => expect(emails()).toEqual(['new@example.test', 'guard@example.test']));
  });

  it('a 429 gives its wait', async () => {
    stubApi(manager({ [create()]: () => problem(429, 'rate_limited', { 'Retry-After': '120' }) }));
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });

    fill('new@example.test', 'Security');
    submit();

    expect((await screen.findByRole('alert')).textContent).toBe('Too many requests. Try again in 2 minutes.');
  });

  it.each([
    ['email_address', 'Enter one email address.'],
    ['string_too_long', 'Use at most 254 characters.'],
    ['missing', 'Enter one email address.'],
  ])('a 422 %s on the email shows on the field', async (type, text) => {
    stubApi(
      manager({
        [create()]: () =>
          json({ type: 'about:blank', title: 'Invalid', status: 422, code: 'validation_error', errors: [{ loc: ['body', 'email'], type, msg: 'x' }] }, 422),
      }),
    );
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });

    fill('new@example.test', 'Security');
    submit();

    await waitFor(() => expect(emailField().getAttribute('aria-invalid')).toBe('true'));
    const describedBy = emailField().getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)?.textContent).toBe(text);
    expect(send().disabled).toBe(false);
  });

  it('building_not_found marks the building denied', async () => {
    stubApi(manager({ [create()]: () => problem(404, 'building_not_found') }));
    const app = renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });

    fill('new@example.test', 'Security');
    submit();

    await waitFor(() => expect(app.queryClient.getQueryData(['b', MAPLE.id, 'denied'])).toEqual(expect.any(Number)));
  });
});

describe('one request (criterion 7)', () => {
  it('a double click sends one request; while out the fields are read-only and focus stays in the form', async () => {
    const gate = deferred(() => json(invitation(9, { email: 'new@example.test' }), 201));
    const fetchMock = stubApi(manager({ [create()]: gate.handler }));
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });

    fill('new@example.test', 'Security');
    send().focus();
    fireEvent.click(send());
    fireEvent.click(send());
    fireEvent.submit(send().closest('form')!);
    await settle();

    expect(count(fetchMock, create())).toBe(1);
    expect(send().disabled).toBe(true);
    expect(emailField().readOnly).toBe(true);
    expect(role('Security').disabled).toBe(true);
    expect(send().closest('form')!.contains(document.activeElement)).toBe(true);
    gate.release();
    await waitFor(() => expect(message()?.textContent).toBe('Invitation sent to new@example.test.'));
  });
});

describe('leaving and switching (criterion 8)', () => {
  it('an answer after leaving the page shows nothing on the new one; the list is still asked for again', async () => {
    const gate = deferred(() => json(invitation(9, { email: 'new@example.test' }), 201));
    stubApi(manager({ [create()]: gate.handler }));
    const app = renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });

    fill('new@example.test', 'Security');
    submit();
    await settle();
    act(() => app.navigate()('/Contacts'));
    await screen.findByText(/being migrated/i);
    gate.release();
    await settle();

    expect(message()).toBeNull();
    expect(screen.queryByText(/Invitation sent/)).toBeNull();
    expect(app.queryClient.getQueryState(['b', MAPLE.id, 'invitations', 'pending'])?.isInvalidated).toBe(true);
  });

  it('a building switch while a create is out lists the other building’s invitations and shows nothing of the first', async () => {
    const me = {
      ...RESIDENT_ME,
      memberships: [membership(MAPLE, { roles: ['property_management'] }), membership(BIRCH, { roles: ['property_management'] })],
    };
    const gate = deferred(() => json(invitation(9, { email: 'new@example.test' }), 201));
    const fetchMock = stubApi({
      [ME]: () => json(me),
      [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, ['property_management'])),
      [`GET /api/buildings/${BIRCH.id}`]: () => json(buildingOut(BIRCH, ['property_management'])),
      [`GET /api/buildings/${BIRCH.id}/notifications/summary`]: () => json({ unread_count: 0 }),
      [list()]: () => page([GUARD]),
      [list(BIRCH)]: () => page([invitation(7, { email: 'birch@example.test' })]),
      [create()]: gate.handler,
    });
    sessionStorage.setItem('condo.buildingId', MAPLE.id);
    const app = renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });
    fill('new@example.test', 'Security');
    submit();
    await settle();

    openAccountMenu();
    fireEvent.change(screen.getByLabelText(/building/i), { target: { value: BIRCH.id } });
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/'));
    act(() => app.navigate()(PAGE));
    await waitFor(() => expect(emails()).toEqual(['birch@example.test']));
    gate.release();
    await settle();

    expect(message()).toBeNull();
    expect(emails()).toEqual(['birch@example.test']);
    expect(calls(fetchMock)).toContain(list(BIRCH));
    expect(count(fetchMock, create(BIRCH))).toBe(0);
  });
});

describe('access (criterion 9)', () => {
  it.each([['resident'], ['security'], ['council']] as const)('a %s gets /403 and no invitations request', async (only) => {
    const fetchMock = stubApi({
      [ME]: () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles: [only] })] }),
      [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, [only])),
    });
    renderApp([PAGE]);

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/403'));
    expect(count(fetchMock, list())).toBe(0);
  });
});

describe('labels (criterion 10)', () => {
  it('links each error to its field and the roles group, and names the list', async () => {
    stubApi(manager());
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });

    submit();
    await settle();

    const emailError = document.getElementById(emailField().getAttribute('aria-describedby')!);
    expect(emailError?.textContent).toBe('Enter one email address.');
    const group = screen.getByRole('group', { name: 'Roles' });
    expect(document.getElementById(group.getAttribute('aria-describedby')!)?.textContent).toBe('Choose at least one role.');
    expect(document.activeElement).toBe(emailField());

    fill('new@example.test', 'Security');
    expect(emailField().getAttribute('aria-invalid')).toBe('false');
    expect(group.getAttribute('aria-describedby')).toBeNull();
  });
});

// Review round 1 (Codex gpt-6.1-sol) F1: a list fetch already out when the create settled was reused by the
// invalidation, so its answer, read before the create, was shown as the refreshed list.
describe('review round 1 (Codex gpt-6.1-sol): a list fetch out during a create (criteria 3, 5)', () => {
  const NEW = invitation(9, { email: 'new@example.test' });

  it('F1: the first load still out when the create succeeds is asked again, and the new row shows', async () => {
    const gate = deferred(() => page([]));
    let gets = 0;
    const fetchMock = stubApi(
      manager({
        [list()]: (request) => (++gets === 1 ? gate.handler(request) : page([NEW])),
        [create()]: () => json(NEW, 201),
      }),
    );
    const app = renderApp([PAGE]);
    await screen.findByText('Loading invitations…');

    fill('new@example.test', 'Security');
    submit();
    await waitFor(() => expect(message()?.textContent).toBe('Invitation sent to new@example.test.'));
    gate.release();

    await waitFor(() => expect(emails()).toEqual(['new@example.test']));
    await waitFor(() => expect(app.queryClient.getQueryState(['b', MAPLE.id, 'invitations', 'pending'])?.fetchStatus).toBe('idle'));
    expect(screen.queryByText('No pending invitations.')).toBeNull();
    expect(count(fetchMock, list())).toBe(2);
  });

  it('F1 neighbour: a refresh still out when the create is refused invitation_pending is asked again', async () => {
    let answer: Handler = () => page([GUARD]);
    stubApi(manager({ [list()]: (request) => answer(request), [create()]: () => problem(409, 'invitation_pending') }));
    const app = renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });

    const gate = deferred(() => page([GUARD]));
    answer = gate.handler;
    act(() => void app.queryClient.refetchQueries({ queryKey: ['b', MAPLE.id, 'invitations'] }));
    await settle();
    answer = () => page([NEW, GUARD]);
    fill('new@example.test', 'Security');
    submit();
    await screen.findByRole('alert');
    gate.release();

    await waitFor(() => expect(emails()).toEqual(['new@example.test', 'guard@example.test']));
  });

  it('F1 neighbour: a next page still out when the create succeeds; the list is asked again from its first page', async () => {
    const second = deferred(() => page([BOSS]));
    let first = page([GUARD], 'c1');
    stubApi(
      manager({
        [list()]: (request) => (new URL(request.url).searchParams.get('cursor') === null ? first.clone() : second.handler(request)),
        [create()]: () => {
          first = page([NEW, GUARD], 'c1');
          return json(NEW, 201);
        },
      }),
    );
    renderApp([PAGE]);
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    await settle();

    fill('new@example.test', 'Security');
    submit();
    await waitFor(() => expect(message()?.textContent).toBe('Invitation sent to new@example.test.'));
    second.release();

    await waitFor(() => expect(emails()).toEqual(['new@example.test', 'guard@example.test']));
    expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy();
  });
});

describe('expiry date in the building’s time zone (criterion 2; review round 1, Codex gap)', () => {
  it('a time past midnight UTC shows the building’s own date', async () => {
    stubApi(manager({ [list()]: () => page([invitation(3, { expires_at: '2026-10-30T02:30:00Z' })]) }));
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });

    // 22:30 on Oct 29 in America/Toronto (the fixtures' building).
    expect(rows()[0].textContent).toContain('Expires Oct 29, 2026');
  });
});

// Review round 2 (Codex gpt-6.1-sol) F1: after the server placed an error on the email (a 65-character local part
// passes the client's shape check), Send posted the same address again while the error still showed.
describe('review round 2 (Codex gpt-6.1-sol): a server-placed email error (criteria 4, 6)', () => {
  const refusedEmail = () =>
    json({ type: 'about:blank', title: 'Invalid', status: 422, code: 'validation_error', errors: [{ loc: ['body', 'email'], type: 'email_address', msg: 'x' }] }, 422);
  const LONG_LOCAL = `${'a'.repeat(65)}@example.test`;

  it('F1: Send again sends nothing while it shows, and focus goes to the email', async () => {
    const fetchMock = stubApi(manager({ [create()]: refusedEmail }));
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });
    fill(LONG_LOCAL, 'Security');
    submit();
    await waitFor(() => expect(emailField().getAttribute('aria-invalid')).toBe('true'));

    submit();
    await settle();

    expect(count(fetchMock, create())).toBe(1);
    expect(document.activeElement).toBe(emailField());
    expect(screen.getByText('Enter one email address.')).toBeTruthy();
  });

  it('F1 neighbours: a roles change keeps it; editing the email clears it and Send works again', async () => {
    const recorded = recording((body) => ((body as { email: string }).email === LONG_LOCAL ? refusedEmail() : created(body)));
    stubApi(manager({ [create()]: recorded.handler }));
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending invitations' });
    fill(LONG_LOCAL, 'Security');
    submit();
    await waitFor(() => expect(emailField().getAttribute('aria-invalid')).toBe('true'));

    fireEvent.click(role('Council'));
    submit();
    await settle();
    expect(recorded.bodies).toHaveLength(1);

    fireEvent.change(emailField(), { target: { value: 'new@example.test' } });
    expect(emailField().getAttribute('aria-invalid')).toBe('false');
    submit();
    await waitFor(() => expect(message()?.textContent).toBe('Invitation sent to new@example.test.'));
    expect(recorded.bodies).toHaveLength(2);
  });
});

describe('tab keys and Forward (criterion 1; review round 2, Codex gap)', () => {
  it('Home goes to the first tab from Invitations, and Forward comes back to it', async () => {
    stubApi({ ...manager(), [`GET /api/buildings/${MAPLE.id}/onboarding-requests`]: () => json({ items: [], next_cursor: null }) });
    const app = renderApp(['/manage/residents', PAGE]);
    const invitations = await screen.findByRole('tab', { name: 'Invitations' });
    await waitFor(() => expect(invitations.getAttribute('aria-selected')).toBe('true'));

    invitations.focus();
    fireEvent.keyDown(invitations, { key: 'Home' });
    const pending = screen.getByRole('tab', { name: 'Pending requests' });
    await waitFor(() => expect(pending.getAttribute('aria-selected')).toBe('true'));
    expect(document.activeElement).toBe(pending);

    act(() => app.navigate()(-1));
    await waitFor(() => expect(invitations.getAttribute('aria-selected')).toBe('true'));
    act(() => app.navigate()(1));
    await waitFor(() => expect(pending.getAttribute('aria-selected')).toBe('true'));
    act(() => app.navigate()(-1));
    act(() => app.navigate()(-1));
    await waitFor(() => expect(pending.getAttribute('aria-selected')).toBe('true'));
    act(() => app.navigate()(1));
    await waitFor(() => expect(invitations.getAttribute('aria-selected')).toBe('true'));
    await screen.findByRole('list', { name: 'Pending invitations' });
  });
});
