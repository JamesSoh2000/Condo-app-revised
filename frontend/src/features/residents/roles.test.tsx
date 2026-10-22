// @vitest-environment jsdom
/**
 * P4-08e: the roles editor and the unit transfer on the "Members" tab of `/manage/residents`. Each `describe`
 * names the criteria it proves (docs/tickets/P4-08e-member-roles-and-transfer.md).
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { components } from '@/api/schema';
import { MAPLE, RESIDENT_ME, buildingOut, calls, json, membership, problem, renderApp, stubApi, type Handler } from '@/test/renderApp';

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, ...actual.createApiClient({ baseUrl: 'http://app.test' }) };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

type Member = components['schemas']['MemberOut'];
type Role = components['schemas']['Role'];
type Unit = components['schemas']['UnitOut'];

const PAGE = '/manage/residents?tab=members';
const ME = 'GET /api/auth/me';
const list = `GET /api/buildings/${MAPLE.id}/members`;
const units = `GET /api/buildings/${MAPLE.id}/units`;
const summary = `GET /api/buildings/${MAPLE.id}/onboarding-requests/summary`;
const rolesRoute = (id: string) => `POST /api/buildings/${MAPLE.id}/members/${id}/roles`;
const transferRoute = (id: string) => `POST /api/buildings/${MAPLE.id}/members/${id}/transfer`;

function member(n: number, fields: Partial<Member> = {}): Member {
  return {
    membership_id: `01929a4e-0000-7000-8000-0000000d000${n}`,
    user_id: `01929a4e-0000-7000-8000-0000000f000${n}`,
    full_name: `Person ${n}`,
    email: `person${n}@example.test`,
    status: 'active',
    status_reason: null,
    roles: ['resident'],
    unit_id: `01929a4e-0000-7000-8000-0000000c000${n}`,
    unit_label: `100${n}`,
    tower: null,
    relationship: 'tenant',
    ...fields,
  };
}

function unit(n: number, label: string, tower: string | null = null): Unit {
  return { id: `01929a4e-0000-7000-8000-0000000e000${n}`, tower, label, floor: null, is_active: true, current_occupant_count: 0 };
}

const ROBIN = member(1, { full_name: 'Robin Park', email: 'robin@example.test', unit_label: '1203', tower: 'A', relationship: 'owner' });
const KIM = member(3, { full_name: 'Kim Staff', roles: ['property_management', 'security'], unit_id: null, unit_label: null, relationship: null });
const SAM = member(2, { full_name: 'Sam Lee', status: 'suspended', status_reason: 'Unpaid fees', roles: ['council', 'resident'] });
// The caller's own row: `/me`'s user.
const SELF = member(8, {
  user_id: RESIDENT_ME.user.id,
  full_name: 'Alex Chen',
  roles: ['council', 'property_management'],
  unit_id: null,
  unit_label: null,
  relationship: null,
});
const U1 = unit(1, '1203', 'A');
const U2 = unit(2, '1204', 'A');
const U3 = unit(3, '905', 'B');

const page = (items: Member[], next_cursor: string | null = null) => json({ items, next_cursor });

/** A manager in Maple, whose roles `/me` and the building report from `roles` (read on each request). */
function manager(routes: Record<string, Handler> = {}, roles: { current: Role[] } = { current: ['council', 'property_management'] }) {
  return {
    [ME]: () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles: roles.current })] }),
    [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, roles.current)),
    [list]: () => page([ROBIN, KIM, SAM]),
    [units]: (request: Request) => {
      const search = new URL(request.url).searchParams.get('search') ?? '';
      return json({ items: [U1, U2, U3].filter((u) => `${u.tower}-${u.label}`.includes(search) || u.label.startsWith(search)), next_cursor: null });
    },
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

const settle = (ms = 25) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const membersList = () => screen.getByRole('list', { name: 'Members' });
const rows = () => within(membersList()).getAllByRole('listitem');
const row = (name: string) => rows().find((item) => item.textContent?.includes(name))!;
const status = () => screen.getByTestId('member-message');
const count = (fetchMock: ReturnType<typeof stubApi>, key: string) => calls(fetchMock).filter((c) => c === key).length;
const unitQueries = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls
    .map(([request]) => new URL(request.url))
    .filter((url) => url.pathname === `/api/buildings/${MAPLE.id}/units`)
    .map((url) => url.search);

function press(button: HTMLElement) {
  button.focus();
  fireEvent.click(button);
}

async function openRoles(name: string) {
  await screen.findByRole('list', { name: 'Members' });
  press(within(row(name)).getByRole('button', { name: `Change roles of ${name}` }));
  return screen.getByRole('dialog');
}

async function openTransfer(name: string) {
  await screen.findByRole('list', { name: 'Members' });
  press(within(row(name)).getByRole('button', { name: `Transfer ${name} to another unit` }));
  return screen.getByRole('dialog');
}

const checkbox = (dialog: HTMLElement, label: string) => within(dialog).getByRole<HTMLInputElement>('checkbox', { name: label });
const save = (dialog: HTMLElement) => within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Save' });
const transferButton = (dialog: HTMLElement) => within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Transfer' });

/** Types a unit search and waits for its (debounced) list to show `label`. */
async function pickUnit(dialog: HTMLElement, search: string, label: string) {
  fireEvent.change(within(dialog).getByLabelText('Unit number'), { target: { value: search } });
  const radio = await within(dialog).findByRole<HTMLInputElement>('radio', { name: label });
  fireEvent.click(radio);
  return radio;
}

const LAST_MANAGER = 'The building must keep at least one active property manager, so this wasn’t done.';

describe('buttons by row (criterion 3)', () => {
  it('active rows have Change roles, and Transfer unit when they list Resident; other statuses neither', async () => {
    stubApi(manager());
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Members' });

    const buttons = (name: string) => within(row(name)).queryAllByRole('button').map((button) => button.getAttribute('aria-label'));
    expect(buttons('Robin Park')).toEqual(['Change roles of Robin Park', 'Transfer Robin Park to another unit', 'Suspend Robin Park', 'Move out Robin Park']);
    expect(buttons('Kim Staff')).toEqual(['Change roles of Kim Staff', 'Suspend Kim Staff', 'Move out Kim Staff']);
    expect(buttons('Sam Lee')).toEqual(['Reactivate Sam Lee', 'Move out Sam Lee']);
  });
});

describe('the roles dialog (criterion 4)', () => {
  it('shows the row’s roles ticked, sends the change as add and remove, closes and asks for the list again', async () => {
    const sent = recording(() => json({ ...KIM, roles: ['council', 'security'] }));
    const fetchMock = stubApi(manager({ [rolesRoute(KIM.membership_id)]: sent.handler }));
    renderApp([PAGE]);

    const dialog = await openRoles('Kim Staff');
    expect(dialog.textContent).toContain('Kim Staff');
    expect(dialog.textContent).toContain(KIM.email);
    expect(['Resident', 'Security', 'Property manager', 'Council'].map((label) => checkbox(dialog, label).checked)).toEqual([false, true, true, false]);
    expect(document.activeElement).toBe(checkbox(dialog, 'Resident'));

    fireEvent.click(checkbox(dialog, 'Property manager'));
    fireEvent.click(checkbox(dialog, 'Council'));
    press(save(dialog));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent.bodies).toEqual([{ add: ['council'], remove: ['property_management'] }]);
    expect(status().textContent).toBe('Kim Staff’s roles were updated.');
    expect(document.activeElement).toBe(status());
    await waitFor(() => expect(count(fetchMock, list)).toBe(2));
  });

  it('sends roles in Role order', async () => {
    const sent = recording(() => json(ROBIN));
    stubApi(manager({ [rolesRoute(ROBIN.membership_id)]: sent.handler }));
    renderApp([PAGE]);

    const dialog = await openRoles('Robin Park');
    fireEvent.click(checkbox(dialog, 'Council'));
    fireEvent.click(checkbox(dialog, 'Security'));
    fireEvent.click(checkbox(dialog, 'Property manager'));
    press(save(dialog));

    await waitFor(() => expect(sent.bodies).toEqual([{ add: ['security', 'property_management', 'council'], remove: [] }]));
  });

  it('with nothing changed says so and sends nothing; with nothing ticked says a role must stay', async () => {
    const fetchMock = stubApi(manager());
    renderApp([PAGE]);

    const dialog = await openRoles('Robin Park');
    press(save(dialog));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Change at least one role.');

    fireEvent.click(checkbox(dialog, 'Resident'));
    press(save(dialog));
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe('A member must keep at least one role.'));
    expect(document.activeElement).toBe(within(dialog).getByRole('alert'));
    expect(calls(fetchMock).filter((c) => c.startsWith('POST'))).toEqual([]);
  });
});

describe('roles refusals that end the dialog (criteria 1, 5)', () => {
  it.each([
    [409, 'no_roles_left', 'A member must keep at least one role, so this wasn’t done.'],
    [409, 'resident_has_unit', 'Robin Park lives in a unit, so Resident can’t be removed while they do.'],
    [409, 'membership_not_active', 'Robin Park is no longer active, so this wasn’t done. Check the list and try again.'],
    [404, 'member_not_found', 'This member is no longer in this building.'],
    [409, 'last_manager', LAST_MANAGER],
  ] as const)('%i %s: closes, says so and asks for the list again', async (code, errorCode, message) => {
    const fetchMock = stubApi(manager({ [rolesRoute(ROBIN.membership_id)]: () => problem(code, errorCode) }));
    renderApp([PAGE]);

    const dialog = await openRoles('Robin Park');
    fireEvent.click(checkbox(dialog, 'Resident'));
    fireEvent.click(checkbox(dialog, 'Security'));
    press(save(dialog));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(status().textContent).toBe(message);
    expect(document.activeElement).toBe(status());
    await waitFor(() => expect(count(fetchMock, list)).toBe(2));
  });

  it('the only manager removing their own role: last_manager, the row and the nav unchanged (criterion 1)', async () => {
    const fetchMock = stubApi(
      manager({
        [list]: () => page([SELF, ROBIN]),
        [rolesRoute(SELF.membership_id)]: () => problem(409, 'last_manager'),
      }),
    );
    renderApp([PAGE]);

    const dialog = await openRoles('Alex Chen');
    fireEvent.click(checkbox(dialog, 'Property manager'));
    press(save(dialog));

    await waitFor(() => expect(status().textContent).toBe(LAST_MANAGER));
    await waitFor(() => expect(count(fetchMock, list)).toBe(2));
    expect(row('Alex Chen').textContent).toContain('Council, Property manager');
    // A change to oneself asks `/me` again after every outcome (criterion 6); here nothing changed.
    await waitFor(() => expect(count(fetchMock, ME)).toBe(2));
    await settle();
    expect(screen.getByRole('link', { name: /Residents/ })).toBeTruthy();
    expect(screen.getByTestId('location').textContent).toBe('/manage/residents');
  });
});

describe('own roles follow (criterion 6)', () => {
  it('removing one’s own Property manager: /me asked again, the nav loses Residents and its badge, the page goes to /403', async () => {
    const roles = { current: ['council', 'property_management'] as Role[] };
    const fetchMock = stubApi(
      manager(
        {
          [list]: () => page([SELF, ROBIN]),
          [rolesRoute(SELF.membership_id)]: () => {
            roles.current = ['council'];
            return json({ ...SELF, roles: ['council'] });
          },
        },
        roles,
      ),
    );
    renderApp([PAGE]);
    await waitFor(() => expect(count(fetchMock, summary)).toBe(1));
    expect(screen.getByRole('link', { name: /Residents/ })).toBeTruthy();

    const dialog = await openRoles('Alex Chen');
    fireEvent.click(checkbox(dialog, 'Property manager'));
    press(save(dialog));

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/403'));
    expect(count(fetchMock, ME)).toBe(2);
    expect(screen.queryByRole('link', { name: /Residents/ })).toBeNull();
    const summaries = count(fetchMock, summary);
    await act(() => window.dispatchEvent(new Event('focus')));
    await settle(100);
    expect(count(fetchMock, summary)).toBe(summaries);
  });

  it('a change to another member doesn’t ask for /me', async () => {
    const fetchMock = stubApi(manager({ [rolesRoute(ROBIN.membership_id)]: () => json({ ...ROBIN, roles: ['council', 'resident'] }) }));
    renderApp([PAGE]);

    const dialog = await openRoles('Robin Park');
    fireEvent.click(checkbox(dialog, 'Council'));
    press(save(dialog));

    await waitFor(() => expect(status().textContent).toBe('Robin Park’s roles were updated.'));
    await waitFor(() => expect(count(fetchMock, list)).toBe(2));
    await settle();
    expect(count(fetchMock, ME)).toBe(1);
  });

  it('a failed change to oneself still asks /me again (it may have been written)', async () => {
    const fetchMock = stubApi(manager({ [list]: () => page([SELF]), [rolesRoute(SELF.membership_id)]: () => Promise.reject(new TypeError('Failed to fetch')) }));
    renderApp([PAGE]);

    const dialog = await openRoles('Alex Chen');
    fireEvent.click(checkbox(dialog, 'Security'));
    press(save(dialog));

    await within(dialog).findByRole('alert');
    await waitFor(() => expect(count(fetchMock, ME)).toBe(2));
  });

  it('transferring oneself asks /me again (its occupancy)', async () => {
    const resident = { ...SELF, roles: ['property_management', 'resident'] as Role[] };
    const fetchMock = stubApi(
      manager({
        [list]: () => page([resident]),
        [transferRoute(SELF.membership_id)]: () => json({ ...resident, unit_id: U2.id, unit_label: '1204', tower: 'A', relationship: 'tenant' }),
      }),
    );
    renderApp([PAGE]);

    const dialog = await openTransfer('Alex Chen');
    await pickUnit(dialog, '1204', 'A-1204');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Tenant' }));
    press(transferButton(dialog));

    await waitFor(() => expect(status().textContent).toBe('Alex Chen now lives in unit A-1204 as tenant.'));
    await waitFor(() => expect(count(fetchMock, ME)).toBe(2));
  });
});

describe('the transfer dialog (criterion 7)', () => {
  it('names the member and unit, searches units, sends the pick and relationship, says where they live now', async () => {
    const sent = recording(() => json({ ...ROBIN, unit_id: U3.id, unit_label: '905', tower: 'B', relationship: 'household' }));
    const fetchMock = stubApi(manager({ [transferRoute(ROBIN.membership_id)]: sent.handler }));
    renderApp([PAGE]);

    const dialog = await openTransfer('Robin Park');
    expect(dialog.textContent).toContain('Robin Park');
    expect(dialog.textContent).toContain('unit A-1203');
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Unit number'));
    // The first page of active units, before any search; the current relationship preset.
    await within(dialog).findByRole('radio', { name: 'A-1203' });
    expect(within(dialog).getByRole<HTMLInputElement>('radio', { name: 'Owner' }).checked).toBe(true);

    await pickUnit(dialog, '9', 'B-905');
    expect(within(dialog).queryByRole('radio', { name: 'A-1203' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Household member' }));
    press(transferButton(dialog));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent.bodies).toEqual([{ unit_id: U3.id, relationship: 'household' }]);
    expect(unitQueries(fetchMock)).toEqual(['?active=true', '?active=true&search=9']);
    expect(status().textContent).toBe('Robin Park now lives in unit B-905 as household member.');
    await waitFor(() => expect(count(fetchMock, list)).toBe(2));
  });

  it('asks for a unit and a relationship before sending', async () => {
    const fetchMock = stubApi(manager({ [list]: () => page([{ ...ROBIN, unit_id: null, unit_label: null, tower: null, relationship: null }]) }));
    renderApp([PAGE]);

    const dialog = await openTransfer('Robin Park');
    expect(dialog.textContent).toContain('no unit');
    await within(dialog).findByRole('radio', { name: 'A-1203' });
    press(transferButton(dialog));

    expect(within(dialog).getByText('Choose a unit.')).toBeTruthy();
    expect(within(dialog).getByText('Choose how they relate to the unit.')).toBeTruthy();
    expect(calls(fetchMock).filter((c) => c.startsWith('POST'))).toEqual([]);
  });

  it('the same unit and relationship: 200 and the same message', async () => {
    stubApi(manager({ [transferRoute(ROBIN.membership_id)]: () => json(ROBIN) }));
    renderApp([PAGE]);

    const dialog = await openTransfer('Robin Park');
    fireEvent.click(await within(dialog).findByRole('radio', { name: 'A-1203' }));
    press(transferButton(dialog));

    await waitFor(() => expect(status().textContent).toBe('Robin Park now lives in unit A-1203 as owner.'));
  });
});

describe('unit search states (criterion 8)', () => {
  it('a pick the new search doesn’t show is no longer picked', async () => {
    const fetchMock = stubApi(manager());
    renderApp([PAGE]);

    const dialog = await openTransfer('Robin Park');
    fireEvent.click(await within(dialog).findByRole('radio', { name: 'A-1204' }));
    fireEvent.change(within(dialog).getByLabelText('Unit number'), { target: { value: '9' } });
    await within(dialog).findByRole('radio', { name: 'B-905' });
    fireEvent.change(within(dialog).getByLabelText('Unit number'), { target: { value: '' } });
    const back = await within(dialog).findByRole<HTMLInputElement>('radio', { name: 'A-1204' });
    expect(back.checked).toBe(false);
    press(transferButton(dialog));

    expect(within(dialog).getByText('Choose a unit.')).toBeTruthy();
    expect(calls(fetchMock).filter((c) => c.startsWith('POST'))).toEqual([]);
  });

  it('says when no unit matches, and the search takes at most 20 characters', async () => {
    stubApi(manager());
    renderApp([PAGE]);

    const dialog = await openTransfer('Robin Park');
    expect(within(dialog).getByLabelText<HTMLInputElement>('Unit number').maxLength).toBe(20);
    fireEvent.change(within(dialog).getByLabelText('Unit number'), { target: { value: '77' } });

    expect(await within(dialog).findByText('No active unit starts with “77”.')).toBeTruthy();
  });

  it('a failed units request offers Try again, with a 429’s wait', async () => {
    let n = 0;
    stubApi(
      manager({
        [units]: () => (++n === 1 ? problem(429, 'rate_limited', { 'Retry-After': '30' }) : json({ items: [U1], next_cursor: null })),
      }),
    );
    renderApp([PAGE]);

    const dialog = await openTransfer('Robin Park');
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('Too many requests. Try again in 30 seconds.');
    press(within(alert).getByRole('button', { name: 'Try again' }));

    expect(await within(dialog).findByRole('radio', { name: 'A-1203' })).toBeTruthy();
  });

  it('a search with a control character says so and isn’t sent', async () => {
    const fetchMock = stubApi(manager());
    renderApp([PAGE]);

    const dialog = await openTransfer('Robin Park');
    await within(dialog).findByRole('radio', { name: 'A-1203' });
    fireEvent.change(within(dialog).getByLabelText('Unit number'), { target: { value: '12\u0007' } });
    await settle(400);

    expect(within(dialog).getByText('Search with visible characters only.')).toBeTruthy();
    expect(unitQueries(fetchMock)).toEqual(['?active=true']);
  });
});

describe('transfer refusals (criteria 1, 9)', () => {
  it.each([
    [404, 'unit_not_found'],
    [409, 'unit_inactive'],
  ] as const)('%i %s keeps the dialog open, the unit no longer picked, and asks for the units again', async (code, errorCode) => {
    const fetchMock = stubApi(manager({ [transferRoute(ROBIN.membership_id)]: () => problem(code, errorCode) }));
    renderApp([PAGE]);

    const dialog = await openTransfer('Robin Park');
    const radio = await pickUnit(dialog, '', 'A-1204');
    press(transferButton(dialog));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toBe('That unit is no longer available. Choose another.');
    expect(document.activeElement).toBe(alert);
    expect(radio.checked).toBe(false);
    await waitFor(() => expect(unitQueries(fetchMock)).toEqual(['?active=true', '?active=true']));
    expect(count(fetchMock, list)).toBe(1);
  });

  it.each([
    [409, 'not_a_resident', 'Robin Park is no longer a resident, so this wasn’t done.'],
    [409, 'membership_not_active', 'Robin Park is no longer active, so this wasn’t done. Check the list and try again.'],
    [404, 'member_not_found', 'This member is no longer in this building.'],
    [409, 'occupancy_changed', 'Robin Park’s unit changed at the same time, so this wasn’t done. Check the list and try again.'],
    [409, 'last_manager', LAST_MANAGER],
  ] as const)('%i %s: closes, says so and asks for the list again', async (code, errorCode, message) => {
    const fetchMock = stubApi(manager({ [transferRoute(ROBIN.membership_id)]: () => problem(code, errorCode) }));
    renderApp([PAGE]);

    const dialog = await openTransfer('Robin Park');
    await pickUnit(dialog, '', 'A-1204');
    press(transferButton(dialog));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(status().textContent).toBe(message);
    expect(document.activeElement).toBe(status());
    await waitFor(() => expect(count(fetchMock, list)).toBe(2));
  });
});

describe('one request, Cancel and Escape (criterion 10)', () => {
  it.each(['roles', 'transfer'] as const)('%s: a double-click sends one request; nothing closes the dialog until the answer', async (kind) => {
    const route = kind === 'roles' ? rolesRoute(ROBIN.membership_id) : transferRoute(ROBIN.membership_id);
    const gate = deferred(() => json(ROBIN));
    const fetchMock = stubApi(manager({ [route]: gate.handler }));
    renderApp([PAGE]);

    let dialog: HTMLElement;
    let confirm: HTMLButtonElement;
    if (kind === 'roles') {
      dialog = await openRoles('Robin Park');
      fireEvent.click(checkbox(dialog, 'Council'));
      confirm = save(dialog);
    } else {
      dialog = await openTransfer('Robin Park');
      await pickUnit(dialog, '', 'A-1204');
      confirm = transferButton(dialog);
    }
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await settle();

    expect(count(fetchMock, route)).toBe(1);
    expect(confirm.disabled).toBe(true);
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(true);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBe(dialog);
    gate.release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(count(fetchMock, route)).toBe(1);
  });

  it('Cancel and Escape send nothing and return focus to the row’s button', async () => {
    const fetchMock = stubApi(manager());
    renderApp([PAGE]);

    let dialog = await openRoles('Robin Park');
    fireEvent.click(checkbox(dialog, 'Council'));
    press(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(within(row('Robin Park')).getByRole('button', { name: 'Change roles of Robin Park' })));

    dialog = await openTransfer('Robin Park');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(within(row('Robin Park')).getByRole('button', { name: 'Transfer Robin Park to another unit' })),
    );
    expect(calls(fetchMock).filter((c) => c.startsWith('POST'))).toEqual([]);
  });

  it('keeps Tab inside each dialog, its checkboxes and search included', async () => {
    stubApi(manager());
    renderApp([PAGE]);

    let dialog = await openRoles('Robin Park');
    save(dialog).focus();
    fireEvent.keyDown(save(dialog), { key: 'Tab' });
    expect(document.activeElement).toBe(checkbox(dialog, 'Resident'));
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(save(dialog));
    fireEvent.keyDown(dialog, { key: 'Escape' });

    dialog = await openTransfer('Robin Park');
    transferButton(dialog).focus();
    fireEvent.keyDown(transferButton(dialog), { key: 'Tab' });
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Unit number'));
  });
});

describe('failures that keep the dialog (criterion 11)', () => {
  it.each([
    ['a 429 with Retry-After', () => problem(429, 'rate_limited', { 'Retry-After': '30' }), 'Too many requests. Try again in 30 seconds.'],
    ['a 500', () => problem(500, 'internal_error'), 'Could not change Robin Park’s roles. Try again.'],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch')), 'Could not change Robin Park’s roles. Try again.'],
    ['an unknown 409', () => problem(409, 'something_new'), 'Could not change Robin Park’s roles. Try again.'],
  ])('roles: %s keeps the dialog open with its choices, and Save works again', async (_label, answer, message) => {
    let n = 0;
    stubApi(manager({ [rolesRoute(ROBIN.membership_id)]: () => (++n === 1 ? answer() : json(ROBIN)) }));
    renderApp([PAGE]);

    const dialog = await openRoles('Robin Park');
    fireEvent.click(checkbox(dialog, 'Council'));
    press(save(dialog));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toBe(message);
    expect(document.activeElement).toBe(alert);
    expect(checkbox(dialog, 'Council').checked).toBe(true);
    expect(save(dialog).disabled).toBe(false);
    press(save(dialog));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(n).toBe(2);
  });

  it('transfer: a 500 keeps the pick and says what failed', async () => {
    stubApi(manager({ [transferRoute(ROBIN.membership_id)]: () => problem(500, 'internal_error') }));
    renderApp([PAGE]);

    const dialog = await openTransfer('Robin Park');
    const radio = await pickUnit(dialog, '', 'A-1204');
    press(transferButton(dialog));

    expect((await within(dialog).findByRole('alert')).textContent).toBe('Could not transfer Robin Park. Try again.');
    expect(radio.checked).toBe(true);
    expect(transferButton(dialog).disabled).toBe(false);
  });
});

describe('leaving and switching (criterion 12)', () => {
  it('an answer after leaving the page shows nothing on the new one; the list and /me are still asked again', async () => {
    const gate = deferred(() => json({ ...SELF, roles: ['council', 'property_management', 'security'] }));
    const fetchMock = stubApi(manager({ [list]: () => page([SELF]), [rolesRoute(SELF.membership_id)]: gate.handler }));
    const app = renderApp([PAGE]);
    const dialog = await openRoles('Alex Chen');
    fireEvent.click(checkbox(dialog, 'Security'));
    press(save(dialog));
    await settle();

    act(() => app.navigate()('/Contacts'));
    await screen.findByText(/being migrated/i);
    gate.release();
    await settle();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('member-message')).toBeNull();
    expect(app.queryClient.getQueryState(['b', MAPLE.id, 'members', 'list', { role: null, status: null, search: '' }])?.isInvalidated).toBe(true);
    await waitFor(() => expect(count(fetchMock, ME)).toBe(2));
  });

  it('the units are asked for under the building’s key', async () => {
    stubApi(manager());
    const app = renderApp([PAGE]);

    const dialog = await openTransfer('Robin Park');
    await within(dialog).findByRole('radio', { name: 'A-1203' });
    expect(app.queryClient.getQueryData(['b', MAPLE.id, 'units', { active: true, search: '' }])).toBeTruthy();
  });

  it.each(['roles', 'transfer'] as const)('building_not_found on %s marks the building denied', async (kind) => {
    const route = kind === 'roles' ? rolesRoute(ROBIN.membership_id) : transferRoute(ROBIN.membership_id);
    stubApi(manager({ [route]: () => problem(404, 'building_not_found') }));
    const app = renderApp([PAGE]);

    if (kind === 'roles') {
      const dialog = await openRoles('Robin Park');
      fireEvent.click(checkbox(dialog, 'Council'));
      press(save(dialog));
    } else {
      const dialog = await openTransfer('Robin Park');
      await pickUnit(dialog, '', 'A-1204');
      press(transferButton(dialog));
    }

    await waitFor(() => expect(app.queryClient.getQueryData(['b', MAPLE.id, 'denied'])).toEqual(expect.any(Number)));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Members' })).toBeNull());
  });
});

describe('a refetch under an open dialog (criterion 13)', () => {
  it('the roles dialog keeps the roles it opened with, and sends only what was changed in it', async () => {
    let changed = false;
    const sent = recording(() => json({ ...ROBIN, roles: ['council', 'resident', 'security'] }));
    stubApi(
      manager({
        [list]: () => page([changed ? { ...ROBIN, roles: ['resident', 'security'] } : ROBIN]),
        [rolesRoute(ROBIN.membership_id)]: sent.handler,
      }),
    );
    const app = renderApp([PAGE]);
    const dialog = await openRoles('Robin Park');

    changed = true;
    await act(() => app.queryClient.refetchQueries({ queryKey: ['b', MAPLE.id, 'members'] }));
    await waitFor(() => expect(row('Robin Park').textContent).toContain('Resident, Security'));
    expect(checkbox(dialog, 'Security').checked).toBe(false);
    fireEvent.click(checkbox(dialog, 'Council'));
    press(save(dialog));

    await waitFor(() => expect(sent.bodies).toEqual([{ add: ['council'], remove: [] }]));
  });

  it('a dropped row keeps the transfer dialog, and the server decides', async () => {
    let changed = false;
    stubApi(
      manager({
        [list]: () => page(changed ? [KIM] : [ROBIN, KIM]),
        [transferRoute(ROBIN.membership_id)]: () => problem(404, 'member_not_found'),
      }),
    );
    const app = renderApp([PAGE]);
    const dialog = await openTransfer('Robin Park');
    await pickUnit(dialog, '', 'A-1204');

    changed = true;
    await act(() => app.queryClient.refetchQueries({ queryKey: ['b', MAPLE.id, 'members'] }));
    await waitFor(() => expect(within(membersList()).queryByText('Robin Park')).toBeNull());
    expect(screen.getByRole('dialog')).toBe(dialog);
    press(transferButton(dialog));

    await waitFor(() => expect(status().textContent).toBe('This member is no longer in this building.'));
  });
});
