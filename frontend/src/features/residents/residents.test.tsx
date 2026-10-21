// @vitest-environment jsdom
/**
 * P4-08b: the manager's `/manage/residents` page, its pending list and the approve / deny dialogs. Each
 * `describe` names the criteria it proves (docs/tickets/P4-08b-manager-pending-requests.md).
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

type Schemas = components['schemas'];
type Request = Schemas['OnboardingRequestManagerOut'];
type Role = Schemas['Role'];

const PAGE = '/manage/residents';
const list = (building = MAPLE) => `GET /api/buildings/${building.id}/onboarding-requests`;
const approve = (id: string, building = MAPLE) => `POST /api/buildings/${building.id}/onboarding-requests/${id}/approve`;
const deny = (id: string, building = MAPLE) => `POST /api/buildings/${building.id}/onboarding-requests/${id}/deny`;

function request(n: number, fields: Partial<Request> = {}): Request {
  return {
    id: `01929a4e-0000-7000-8000-0000000e000${n}`,
    full_name: `Person ${n}`,
    email: `person${n}@example.test`,
    unit_id: `01929a4e-0000-7000-8000-0000000c000${n}`,
    unit_label: `100${n}`,
    tower: null,
    relationship: 'tenant',
    status: 'pending',
    submitted_at: '2026-10-20T14:30:00Z',
    decided_at: null,
    decision_reason: null,
    ...fields,
  };
}

const ROBIN = request(1, {
  full_name: 'Robin Park',
  email: 'robin@example.test',
  unit_label: '1203',
  tower: 'A',
  relationship: 'household',
  // 22:00 on Oct 20 in Toronto, already Oct 21 in UTC.
  submitted_at: '2026-10-21T02:00:00Z',
});
const SAM = request(2, { full_name: 'Sam Lee', email: 'sam@example.test', unit_label: '1003', relationship: 'tenant' });

const page = (items: Request[], next_cursor: string | null = null) => json({ items, next_cursor });

/** Maple with `roles` in both `/me` and the building's answer, and its pending list. */
function persona(roles: Role[], routes: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles })] }),
    [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, roles)),
    ...routes,
  };
}

const manager = (routes: Record<string, Handler> = {}) =>
  persona(['property_management'], { [list()]: () => page([ROBIN, SAM]), ...routes });

/** A response that answers only when `release` is called. */
function deferred(response: () => Response): { handler: Handler; release: () => void } {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { handler: () => gate.then(response), release };
}

function invalid(errors: { loc: (string | number)[]; msg: string; type: string }[]): Response {
  return json(
    { type: 'about:blank', title: 'Validation error', status: 422, code: 'validation_error', request_id: 'req', errors },
    422,
  );
}

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
const rows = () => within(screen.getByRole('list', { name: 'Pending requests' })).getAllByRole('listitem');
const row = (name: string) => rows().find((item) => item.textContent?.includes(name))!;
const status = () => screen.getByTestId('decision-message');
const count = (fetchMock: ReturnType<typeof stubApi>, key: string) => calls(fetchMock).filter((c) => c === key).length;

/** Focuses then clicks, as a browser does (`fireEvent.click` alone doesn't move focus; P4-07a). */
function press(button: HTMLElement) {
  button.focus();
  fireEvent.click(button);
}

async function openDialog(name: string, action: 'Approve' | 'Deny') {
  await screen.findByRole('list', { name: 'Pending requests' });
  press(within(row(name)).getByRole('button', { name: new RegExp(`^${action}`) }));
  return screen.getByRole('dialog');
}

describe('the page, its nav item and its guard (criteria 3, 4)', () => {
  it('lists the pending requests for a manager, newest first, in the building’s time zone', async () => {
    const fetchMock = stubApi(manager());

    renderApp([PAGE]);

    expect(await screen.findByRole('heading', { level: 1, name: 'Residents' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Pending requests' }).getAttribute('aria-selected')).toBe('true');
    await screen.findByRole('list', { name: 'Pending requests' });
    expect(rows().map((item) => item.querySelector('h3')?.textContent)).toEqual(['Robin Park', 'Sam Lee']);
    const robin = row('Robin Park');
    expect(robin.textContent).toContain('robin@example.test');
    expect(robin.textContent).toContain('Unit A-1203');
    expect(robin.textContent).toContain('Household member');
    expect(robin.textContent).toContain('Oct 20, 2026');
    expect(row('Sam Lee').textContent).toContain('Unit 1003');
    expect(row('Sam Lee').textContent).toContain('Tenant');
    expect(count(fetchMock, list())).toBe(1);
  });

  it('links the nav’s Residents item, in its old place, to /manage/residents', async () => {
    stubApi(manager());

    renderApp(['/']);

    const nav = await screen.findByRole('navigation', { name: 'Main' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'Dashboard',
      'My profile',
      'Contacts',
      'Residents',
      'Package log',
      'Daily notices',
      'Maintenance',
    ]);
    expect(within(nav).getByRole('link', { name: 'Residents' }).getAttribute('href')).toBe(PAGE);
  });

  it('marks the Residents item current on the page', async () => {
    stubApi(manager());

    renderApp([PAGE]);

    const nav = await screen.findByRole('navigation', { name: 'Main' });
    await waitFor(() =>
      expect(within(nav).getByRole('link', { name: 'Residents' }).getAttribute('aria-current')).toBe('page'),
    );
  });

  it.each([['resident'], ['security'], ['council']] as const)(
    'sends a %s to /403 without asking for the list',
    async (role) => {
      const fetchMock = stubApi(persona([role]));

      renderApp([PAGE]);

      expect(await screen.findByRole('heading', { name: /can’t open this page/i })).toBeTruthy();
      expect(screen.getByTestId('location').textContent).toBe('/403');
      expect(calls(fetchMock)).not.toContain(list());
    },
  );

  it('shows Page not found at the legacy /Residents path', async () => {
    stubApi(manager());

    renderApp(['/Residents']);

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });
});

describe('tabs (criterion 5)', () => {
  it('switches tabs with the arrow keys, keeping focus on the tab, and puts the tab in the URL', async () => {
    stubApi(manager());
    renderApp([PAGE]);
    const pending = await screen.findByRole('tab', { name: 'Pending requests' });

    pending.focus();
    fireEvent.keyDown(pending, { key: 'ArrowRight' });

    const members = screen.getByRole('tab', { name: 'Members' });
    await waitFor(() => expect(members.getAttribute('aria-selected')).toBe('true'));
    expect(document.activeElement).toBe(members);
    expect(screen.getByTestId('location').textContent).toBe(`${PAGE}?tab=members`);
    expect(screen.getByRole('tabpanel').textContent).toMatch(/member administration is coming/i);
    expect(screen.queryByRole('list', { name: 'Pending requests' })).toBeNull();

    fireEvent.keyDown(members, { key: 'ArrowLeft' });
    await waitFor(() => expect(pending.getAttribute('aria-selected')).toBe('true'));
    expect(document.activeElement).toBe(pending);
    expect(screen.getByTestId('location').textContent).toBe(PAGE);
  });

  it('follows Back and Forward between tabs', async () => {
    stubApi(manager());
    const app = renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending requests' });

    press(screen.getByRole('tab', { name: 'Members' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Members' }).getAttribute('aria-selected')).toBe('true'));

    act(() => app.navigate()(-1));
    await screen.findByRole('list', { name: 'Pending requests' });
    act(() => app.navigate()(1));
    await waitFor(() => expect(screen.getByRole('tabpanel').textContent).toMatch(/member administration/i));
  });

  it('opens the Members tab from a link', async () => {
    stubApi(manager());

    renderApp([`${PAGE}?tab=members`]);

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Members' }).getAttribute('aria-selected')).toBe('true'));
  });
});

describe('list states (criterion 6)', () => {
  it('says when nothing is pending', async () => {
    stubApi(manager({ [list()]: () => page([]) }));

    renderApp([PAGE]);

    expect(await screen.findByText('No pending requests.')).toBeTruthy();
  });

  it('offers Try again when the list fails, and shows the list once it answers', async () => {
    let fail = true;
    stubApi(manager({ [list()]: () => (fail ? problem(403, 'forbidden') : page([SAM])) }));
    renderApp([PAGE]);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not load the requests/i);
    fail = false;
    press(within(alert).getByRole('button', { name: 'Try again' }));

    await screen.findByRole('list', { name: 'Pending requests' });
    expect(rows()).toHaveLength(1);
  });

  it('shows more with next_cursor, below the first page', async () => {
    const cursors: (string | null)[] = [];
    stubApi(
      manager({
        [list()]: (req) => {
          const cursor = new URL(req.url).searchParams.get('cursor');
          cursors.push(cursor);
          return cursor === null ? page([ROBIN], 'next-1') : page([SAM]);
        },
      }),
    );
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Pending requests' });

    press(screen.getByRole('button', { name: 'Show more' }));

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()[1].textContent).toContain('Sam Lee');
    expect(cursors).toEqual([null, 'next-1']);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });
});

describe('approve (criteria 1, 7)', () => {
  it('approves after confirming: one request, dialog closed, message shown, list asked again', async () => {
    let decided = false;
    const fetchMock = stubApi(
      manager({
        [list()]: () => page(decided ? [SAM] : [ROBIN, SAM]),
        [approve(ROBIN.id)]: () => {
          decided = true;
          return json({ ...ROBIN, status: 'approved', decided_at: '2026-10-21T15:00:00Z' });
        },
      }),
    );
    renderApp([PAGE]);

    const dialog = await openDialog('Robin Park', 'Approve');
    expect(within(dialog).getByRole('heading').textContent).toBe('Approve this request?');
    expect(dialog.textContent).toContain('Robin Park');
    expect(dialog.textContent).toContain('A-1203');
    expect(dialog.textContent).toContain('Household member');
    press(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(status().textContent).toBe('Robin Park was approved.');
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(count(fetchMock, approve(ROBIN.id))).toBe(1);
    expect(count(fetchMock, list())).toBe(2);
    // The row is gone: focus goes to the message, not to <body>.
    expect(document.activeElement).toBe(status());
  });

  it('sends one approve on a double-click, with the button disabled until the answer', async () => {
    const gate = deferred(() => json({ ...ROBIN, status: 'approved' }));
    const fetchMock = stubApi(manager({ [approve(ROBIN.id)]: gate.handler }));
    renderApp([PAGE]);
    const dialog = await openDialog('Robin Park', 'Approve');
    const confirm = within(dialog).getByRole('button', { name: 'Approve' });

    confirm.focus();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await settle();

    expect(count(fetchMock, approve(ROBIN.id))).toBe(1);
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    // Not closable while it is sent.
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(true);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeNull();
    gate.release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(count(fetchMock, approve(ROBIN.id))).toBe(1);
  });

  it('Cancel and Escape send nothing and return focus to the row’s button', async () => {
    const fetchMock = stubApi(manager());
    renderApp([PAGE]);

    let dialog = await openDialog('Robin Park', 'Approve');
    expect(dialog.contains(document.activeElement)).toBe(true);
    press(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(within(row('Robin Park')).getByRole('button', { name: /^Approve/ }));

    dialog = await openDialog('Sam Lee', 'Deny');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(within(row('Sam Lee')).getByRole('button', { name: /^Deny/ }));
    expect(calls(fetchMock).filter((c) => c.startsWith('POST'))).toEqual([]);
  });

  it('keeps Tab inside the dialog', async () => {
    stubApi(manager());
    renderApp([PAGE]);
    const dialog = await openDialog('Robin Park', 'Approve');
    const [first, last] = [within(dialog).getByRole('button', { name: 'Cancel' }), within(dialog).getByRole('button', { name: 'Approve' })];

    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

describe('deny (criteria 1, 8)', () => {
  const reason = () => screen.getByLabelText<HTMLTextAreaElement>(/reason/i);
  const type = (value: string) => fireEvent.change(reason(), { target: { value } });

  it('denies with the reason as typed', async () => {
    const bodies: unknown[] = [];
    const fetchMock = stubApi(
      manager({
        [deny(SAM.id)]: async (req) => {
          bodies.push(await req.json());
          return json({ ...SAM, status: 'denied', decision_reason: 'Not on the lease' });
        },
      }),
    );
    renderApp([PAGE]);

    const dialog = await openDialog('Sam Lee', 'Deny');
    expect(within(dialog).getByRole('heading').textContent).toBe('Deny this request?');
    type('  Not on the lease ');
    press(within(dialog).getByRole('button', { name: 'Deny' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(status().textContent).toBe('Sam Lee’s request was denied.');
    expect(bodies).toEqual([{ reason: '  Not on the lease ' }]);
    expect(count(fetchMock, list())).toBe(2);
  });

  it.each([
    ['empty', '', 'Give a reason of at least 3 characters.'],
    ['two characters after trimming', '  ab  ', 'Give a reason of at least 3 characters.'],
    ['over 500 code points', '😀'.repeat(501), 'Use at most 500 characters.'],
    ['a line break', 'Not on\nthe lease', 'Write the reason on one line, with visible characters only.'],
    ['a zero-width space', 'ab​c', 'Write the reason on one line, with visible characters only.'],
    ['a line separator', 'abc def', 'Write the reason on one line, with visible characters only.'],
  ])('refuses a reason that is %s and sends nothing', async (_label, value, message) => {
    const fetchMock = stubApi(manager());
    renderApp([PAGE]);

    const dialog = await openDialog('Sam Lee', 'Deny');
    type(value);
    press(within(dialog).getByRole('button', { name: 'Deny' }));

    expect(within(dialog).getByText(message)).toBeTruthy();
    expect(reason().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(reason());
    await settle();
    expect(calls(fetchMock)).not.toContain(deny(SAM.id));
  });

  it('accepts exactly 500 code points (emoji count once, as Python counts them)', async () => {
    const fetchMock = stubApi(manager({ [deny(SAM.id)]: () => json({ ...SAM, status: 'denied' }) }));
    renderApp([PAGE]);

    const dialog = await openDialog('Sam Lee', 'Deny');
    type('😀'.repeat(500));
    press(within(dialog).getByRole('button', { name: 'Deny' }));

    await waitFor(() => expect(count(fetchMock, deny(SAM.id))).toBe(1));
  });

  it.each([
    ['invisible_characters', 'Write the reason on one line, with visible characters only.'],
    ['control_characters', 'Write the reason on one line, with visible characters only.'],
    ['string_too_short', 'Give a reason of at least 3 characters.'],
    ['string_too_long', 'Use at most 500 characters.'],
  ])('places a 422 %s on the reason and keeps the text', async (errorType, message) => {
    stubApi(manager({ [deny(SAM.id)]: () => invalid([{ loc: ['body', 'reason'], msg: 'bad', type: errorType }]) }));
    renderApp([PAGE]);

    const dialog = await openDialog('Sam Lee', 'Deny');
    type('Looks fine here');
    press(within(dialog).getByRole('button', { name: 'Deny' }));

    expect(await within(dialog).findByText(message)).toBeTruthy();
    expect(reason().value).toBe('Looks fine here');
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Deny' }).disabled).toBe(false);
  });

  it('sends one deny on a double-click', async () => {
    const gate = deferred(() => json({ ...SAM, status: 'denied' }));
    const fetchMock = stubApi(manager({ [deny(SAM.id)]: gate.handler }));
    renderApp([PAGE]);
    const dialog = await openDialog('Sam Lee', 'Deny');
    type('Not on the lease');
    const confirm = within(dialog).getByRole('button', { name: 'Deny' });

    confirm.focus();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await settle();

    expect(count(fetchMock, deny(SAM.id))).toBe(1);
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(reason().readOnly).toBe(true);
    gate.release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('refusals that close the dialog (criteria 1, 9)', () => {
  it.each([
    ['approve', 409, 'already_decided', 'Already decided by someone else.'],
    ['deny', 409, 'already_decided', 'Already decided by someone else.'],
    [
      'approve',
      409,
      'membership_not_pending',
      'This request can no longer be decided: the person’s membership changed (for example, they accepted an invitation).',
    ],
    [
      'deny',
      409,
      'membership_not_pending',
      'This request can no longer be decided: the person’s membership changed (for example, they accepted an invitation).',
    ],
    ['approve', 409, 'unit_inactive', 'Unit 1003 is no longer active, so this request can’t be approved. Deny it instead.'],
    ['approve', 404, 'onboarding_request_not_found', 'This request no longer exists.'],
    ['deny', 404, 'onboarding_request_not_found', 'This request no longer exists.'],
  ] as const)('%s answered %i %s: closes, says so and asks for the list again', async (kind, code, errorCode, message) => {
    let decided = false;
    const route = kind === 'approve' ? approve(SAM.id) : deny(SAM.id);
    const fetchMock = stubApi(
      manager({
        [list()]: () => page(decided && errorCode !== 'unit_inactive' ? [ROBIN] : [ROBIN, SAM]),
        [route]: () => {
          decided = true;
          return problem(code, errorCode);
        },
      }),
    );
    renderApp([PAGE]);

    const dialog = await openDialog('Sam Lee', kind === 'approve' ? 'Approve' : 'Deny');
    if (kind === 'deny') fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Not on the lease' } });
    press(within(dialog).getByRole('button', { name: kind === 'approve' ? 'Approve' : 'Deny' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(status().textContent).toBe(message);
    await waitFor(() => expect(count(fetchMock, list())).toBe(2));
    if (errorCode !== 'unit_inactive') await waitFor(() => expect(rows()).toHaveLength(1));
    expect(document.activeElement).toBe(errorCode === 'unit_inactive' ? within(row('Sam Lee')).getByRole('button', { name: /^Approve/ }) : status());
  });

  it('names a towered unit in the unit_inactive message', async () => {
    stubApi(manager({ [approve(ROBIN.id)]: () => problem(409, 'unit_inactive') }));
    renderApp([PAGE]);

    const dialog = await openDialog('Robin Park', 'Approve');
    press(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(status().textContent).toMatch(/^Unit A-1203 is no longer active/));
  });
});

describe('failures that keep the dialog (criterion 10)', () => {
  it.each([
    ['a 429 with Retry-After', () => problem(429, 'rate_limited', { 'Retry-After': '30' }), 'Too many requests. Try again in 30 seconds.'],
    ['a 500', () => problem(500, 'internal_error'), 'Could not approve the request. Try again.'],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch')), 'Could not approve the request. Try again.'],
    ['an unknown 409', () => problem(409, 'invalid_transition'), 'Could not approve the request. Try again.'],
  ])('approve: %s keeps the dialog open with a message, and the button works again', async (_label, answer, message) => {
    let calls = 0;
    stubApi(manager({ [approve(ROBIN.id)]: () => (++calls === 1 ? answer() : json({ ...ROBIN, status: 'approved' })) }));
    renderApp([PAGE]);

    const dialog = await openDialog('Robin Park', 'Approve');
    press(within(dialog).getByRole('button', { name: 'Approve' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toBe(message);
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Approve' });
    expect(confirm.disabled).toBe(false);
    press(confirm);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls).toBe(2);
  });

  it('deny: a 500 keeps the reason and says the deny failed', async () => {
    stubApi(manager({ [deny(SAM.id)]: () => problem(500, 'internal_error') }));
    renderApp([PAGE]);

    const dialog = await openDialog('Sam Lee', 'Deny');
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Not on the lease' } });
    press(within(dialog).getByRole('button', { name: 'Deny' }));

    expect((await within(dialog).findByRole('alert')).textContent).toBe('Could not deny the request. Try again.');
    expect(screen.getByLabelText<HTMLTextAreaElement>(/reason/i).value).toBe('Not on the lease');
  });
});

describe('leaving, history and buildings (criteria 11, 12)', () => {
  it('an answer after leaving the page changes nothing on the new one, and the list is still asked again', async () => {
    const gate = deferred(() => json({ ...ROBIN, status: 'approved' }));
    const fetchMock = stubApi(manager({ [approve(ROBIN.id)]: gate.handler }));
    const app = renderApp([PAGE]);
    const dialog = await openDialog('Robin Park', 'Approve');
    press(within(dialog).getByRole('button', { name: 'Approve' }));
    await settle();

    act(() => app.navigate()('/Contacts'));
    await screen.findByText(/being migrated/i);
    gate.release();
    await settle();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('decision-message')).toBeNull();
    // Invalidated while nothing watches the list: marked stale, then asked again when the page is back.
    expect(app.queryClient.getQueryState(['b', MAPLE.id, 'onboarding-requests', 'pending'])?.isInvalidated).toBe(true);
    act(() => app.navigate()(PAGE));
    await waitFor(() => expect(count(fetchMock, list())).toBe(2));
  });

  it('Back to the previous tab while a dialog is open closes it; Forward doesn’t bring it back', async () => {
    stubApi(manager());
    const app = renderApp([`${PAGE}?tab=members`, PAGE]);

    await openDialog('Robin Park', 'Approve');
    act(() => app.navigate()(-1));
    await waitFor(() => expect(screen.getByRole('tabpanel').textContent).toMatch(/member administration/i));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => app.navigate()(1));

    await screen.findByRole('list', { name: 'Pending requests' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a message from one history entry doesn’t show on another', async () => {
    stubApi(manager({ [approve(ROBIN.id)]: () => json({ ...ROBIN, status: 'approved' }) }));
    const app = renderApp([PAGE]);
    const dialog = await openDialog('Robin Park', 'Approve');
    press(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(status().textContent).toBe('Robin Park was approved.'));

    act(() => app.navigate()(`${PAGE}?tab=members`));
    act(() => app.navigate()(PAGE));

    await screen.findByRole('list', { name: 'Pending requests' });
    expect(screen.queryByTestId('decision-message')).toBeNull();
  });

  it('a building switch shows the other building’s list and closes the dialog', async () => {
    const me = {
      ...RESIDENT_ME,
      memberships: [
        membership(MAPLE, { roles: ['property_management'] }),
        membership(BIRCH, { roles: ['property_management'] }),
      ],
    };
    const fetchMock = stubApi({
      'GET /api/auth/me': () => json(me),
      [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, ['property_management'])),
      [`GET /api/buildings/${BIRCH.id}`]: () => json(buildingOut(BIRCH, ['property_management'])),
      [`GET /api/buildings/${BIRCH.id}/notifications/summary`]: () => json({ unread_count: 0 }),
      [list()]: () => page([ROBIN, SAM]),
      [list(BIRCH)]: () => page([request(7, { full_name: 'Birch Person' })]),
    });
    sessionStorage.setItem('condo.buildingId', MAPLE.id);
    const app = renderApp([PAGE]);
    await openDialog('Robin Park', 'Approve');

    openAccountMenu();
    fireEvent.change(screen.getByLabelText(/building/i), { target: { value: BIRCH.id } });

    // A switch goes home (BuildingProvider::select); the page opened again is Birch's.
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/'));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => app.navigate()(PAGE));
    await waitFor(() => expect(rows().map((item) => item.querySelector('h3')?.textContent)).toEqual(['Birch Person']));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls(fetchMock)).toContain(list(BIRCH));
  });

  it('building_not_found on a decision marks the building denied, as other building requests do', async () => {
    stubApi(manager({ [approve(ROBIN.id)]: () => problem(404, 'building_not_found') }));
    const app = renderApp([PAGE]);

    const dialog = await openDialog('Robin Park', 'Approve');
    press(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(app.queryClient.getQueryData(['b', MAPLE.id, 'denied'])).toEqual(expect.any(Number)));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Pending requests' })).toBeNull());
  });
});

describe('a refetch under an open dialog (criterion 13)', () => {
  it('keeps the dialog on its request when a refetch drops the row, and the server’s 409 decides', async () => {
    let decidedElsewhere = false;
    const fetchMock = stubApi(
      manager({
        [list()]: () => page(decidedElsewhere ? [SAM] : [ROBIN, SAM]),
        [approve(ROBIN.id)]: () => problem(409, 'already_decided'),
      }),
    );
    const app = renderApp([PAGE]);
    const dialog = await openDialog('Robin Park', 'Approve');

    decidedElsewhere = true;
    await act(() => app.queryClient.refetchQueries({ queryKey: ['b', MAPLE.id, 'onboarding-requests'] }));
    await waitFor(() => expect(rows()).toHaveLength(1));

    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(dialog.textContent).toContain('Robin Park');
    press(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(status().textContent).toBe('Already decided by someone else.'));
    expect(count(fetchMock, approve(ROBIN.id))).toBe(1);
    expect(document.activeElement).toBe(status());
  });
});
