// @vitest-environment jsdom
/**
 * P4-08c: the "Members" tab of `/manage/residents`: the list, its filters and search, and the suspend,
 * reactivate and move-out dialogs. Each `describe` names the criteria it proves
 * (docs/tickets/P4-08c-members-administration.md).
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

type Member = components['schemas']['MemberOut'];

const PAGE = '/manage/residents?tab=members';
const list = (building = MAPLE) => `GET /api/buildings/${building.id}/members`;
const action = (kind: 'suspend' | 'reactivate' | 'deactivate', id: string) =>
  `POST /api/buildings/${MAPLE.id}/members/${id}/${kind}`;

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

const ROBIN = member(1, { full_name: 'Robin Park', email: 'robin@example.test', unit_label: '1203', tower: 'A', relationship: 'owner' });
const SAM = member(2, {
  full_name: 'Sam Lee',
  email: 'sam@example.test',
  status: 'suspended',
  status_reason: 'Unpaid fees',
  roles: ['council', 'resident'],
});
const KIM = member(3, { full_name: 'Kim Staff', status: 'active', roles: ['property_management', 'security'], unit_id: null, unit_label: null, relationship: null });
const PAT = member(4, { full_name: 'Pat Gone', status: 'deactivated', status_reason: 'Lease ended', unit_id: null, unit_label: null, relationship: null });
const NEW = member(5, { full_name: 'Nia New', status: 'pending' });
const DEN = member(6, { full_name: 'Dee Denied', status: 'denied', unit_id: null, unit_label: null, relationship: null });

const page = (items: Member[], next_cursor: string | null = null) => json({ items, next_cursor });

function manager(routes: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles: ['property_management'] })] }),
    [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, ['property_management'])),
    [list()]: () => page([ROBIN, SAM]),
    ...routes,
  };
}

function deferred(response: () => Response): { handler: Handler; release: () => void } {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { handler: () => gate.then(response), release };
}

function invalid(loc: (string | number)[], type: string): Response {
  return json(
    { type: 'about:blank', title: 'Validation error', status: 422, code: 'validation_error', request_id: 'req', errors: [{ loc, msg: 'x', type }] },
    422,
  );
}

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
const membersList = () => screen.getByRole('list', { name: 'Members' });
const rows = () => within(membersList()).getAllByRole('listitem');
const names = () => rows().map((item) => item.querySelector('h3')?.textContent);
const row = (name: string) => rows().find((item) => item.textContent?.includes(name))!;
const status = () => screen.getByTestId('member-message');
const count = (fetchMock: ReturnType<typeof stubApi>, key: string) => calls(fetchMock).filter((c) => c === key).length;
const listQueries = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls
    .map(([request]) => new URL(request.url))
    .filter((url) => url.pathname === `/api/buildings/${MAPLE.id}/members`)
    .map((url) => url.search);

function press(button: HTMLElement) {
  button.focus();
  fireEvent.click(button);
}

const LABELS = { suspend: 'Suspend', reactivate: 'Reactivate', deactivate: 'Move out' } as const;

async function openDialog(name: string, kind: keyof typeof LABELS) {
  await screen.findByRole('list', { name: 'Members' });
  press(within(row(name)).getByRole('button', { name: `${LABELS[kind]} ${name}` }));
  return screen.getByRole('dialog');
}

const confirmButton = (dialog: HTMLElement, kind: keyof typeof LABELS) =>
  within(dialog).getByRole<HTMLButtonElement>('button', { name: LABELS[kind] });

describe('the list (criterion 3)', () => {
  it('lists the members newest first with status, roles, unit, relationship and reason', async () => {
    stubApi(manager({ [list()]: () => page([ROBIN, SAM, KIM, PAT]) }));
    renderApp([PAGE]);

    await screen.findByRole('list', { name: 'Members' });
    expect(names()).toEqual(['Robin Park', 'Sam Lee', 'Kim Staff', 'Pat Gone']);
    expect(row('Robin Park').textContent).toContain('robin@example.test');
    expect(row('Robin Park').textContent).toContain('Active · Resident');
    expect(row('Robin Park').textContent).toContain('Unit A-1203 · Owner');
    expect(row('Sam Lee').textContent).toContain('Suspended · Council, Resident');
    expect(row('Sam Lee').textContent).toContain('Unit 1002 · Tenant');
    expect(row('Sam Lee').textContent).toContain('Reason: Unpaid fees');
    expect(row('Kim Staff').textContent).toContain('Active · Property manager, Security');
    expect(row('Kim Staff').textContent).not.toContain('Unit');
    expect(row('Kim Staff').textContent).not.toContain('Reason');
    expect(row('Pat Gone').textContent).toContain('Moved out');
    expect(row('Pat Gone').textContent).toContain('Reason: Lease ended');
  });

  it('says when no member matches', async () => {
    stubApi(manager({ [list()]: () => page([]) }));
    renderApp([PAGE]);

    expect(await screen.findByText('No members match.')).toBeTruthy();
  });

  it('offers Try again when the list fails, and shows the list once it answers', async () => {
    let fail = true;
    stubApi(manager({ [list()]: () => (fail ? problem(403, 'forbidden') : page([SAM])) }));
    renderApp([PAGE]);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not load the members/i);
    fail = false;
    press(within(alert).getByRole('button', { name: 'Try again' }));

    await screen.findByRole('list', { name: 'Members' });
    expect(names()).toEqual(['Sam Lee']);
  });

  it('shows more with next_cursor, below the first page, with the same filters', async () => {
    const fetchMock = stubApi(
      manager({
        [list()]: (req) => (new URL(req.url).searchParams.get('cursor') === null ? page([ROBIN], 'next-1') : page([SAM])),
      }),
    );
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Members' });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'active' } });
    await waitFor(() => expect(listQueries(fetchMock)).toEqual(['', '?status=active']));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Show more' }).disabled).toBe(false));

    press(screen.getByRole('button', { name: 'Show more' }));

    await waitFor(() => expect(names()).toEqual(['Robin Park', 'Sam Lee']));
    expect(listQueries(fetchMock)).toEqual(['', '?status=active', '?status=active&cursor=next-1']);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('wraps a long name and a 254-character email instead of overflowing (criterion 2, jsdom part)', async () => {
    const email = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.test`;
    stubApi(manager({ [list()]: () => page([member(1, { full_name: 'X'.repeat(120), email })]) }));
    renderApp([PAGE]);

    await screen.findByRole('list', { name: 'Members' });
    expect(email).toHaveLength(254);
    expect(rows()[0].className).toContain('[overflow-wrap:anywhere]');
  });
});

describe('filters and search (criterion 4)', () => {
  it('sends the role and status filters, combined with the search, each from the first page', async () => {
    const fetchMock = stubApi(manager());
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Members' });

    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'security' } });
    await waitFor(() => expect(listQueries(fetchMock)).toHaveLength(2));
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'suspended' } });
    await waitFor(() => expect(listQueries(fetchMock)).toHaveLength(3));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search members' }), { target: { value: '  Robin  ' } });
    press(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(listQueries(fetchMock)).toHaveLength(4));

    expect(listQueries(fetchMock)).toEqual([
      '',
      '?role=security',
      '?role=security&status=suspended',
      '?role=security&status=suspended&search=Robin',
    ]);
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: '' } });
    await waitFor(() => expect(listQueries(fetchMock).at(-1)).toBe('?status=suspended&search=Robin'));
  });

  it('offers all roles and all statuses', async () => {
    stubApi(manager());
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Members' });

    const options = (label: string) =>
      Array.from(screen.getByLabelText<HTMLSelectElement>(label).options).map((option) => [option.value, option.textContent]);
    expect(options('Role')).toEqual([
      ['', 'All roles'],
      ['resident', 'Resident'],
      ['security', 'Security'],
      ['property_management', 'Property manager'],
      ['council', 'Council'],
    ]);
    expect(options('Status')).toEqual([
      ['', 'All statuses'],
      ['active', 'Active'],
      ['pending', 'Pending'],
      ['suspended', 'Suspended'],
      ['deactivated', 'Moved out'],
      ['denied', 'Denied'],
    ]);
  });

  it('searches on Enter, and leaves an empty (or blank) search out', async () => {
    const fetchMock = stubApi(manager());
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Members' });
    const search = screen.getByRole('searchbox', { name: 'Search members' });

    fireEvent.change(search, { target: { value: 'sam@' } });
    fireEvent.submit(search.closest('form')!);
    await waitFor(() => expect(listQueries(fetchMock)).toEqual(['', '?search=sam%40']));
    fireEvent.change(search, { target: { value: '   ' } });
    fireEvent.submit(search.closest('form')!);

    await waitFor(() => expect(listQueries(fetchMock)).toEqual(['', '?search=sam%40', '']));
  });

  it('can’t take more than 100 characters', async () => {
    stubApi(manager());
    renderApp([PAGE]);

    expect((await screen.findByRole<HTMLInputElement>('searchbox', { name: 'Search members' })).maxLength).toBe(100);
  });

  it('refuses a search with a control character and sends nothing', async () => {
    const fetchMock = stubApi(manager());
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Members' });
    const search = screen.getByRole('searchbox', { name: 'Search members' });

    fireEvent.change(search, { target: { value: 'Rob\tin' } });
    press(screen.getByRole('button', { name: 'Search' }));
    await settle();

    expect(screen.getByText('Search with visible characters only.')).toBeTruthy();
    expect(search.getAttribute('aria-invalid')).toBe('true');
    expect(listQueries(fetchMock)).toEqual(['']);
    fireEvent.change(search, { target: { value: 'Robin' } });
    expect(screen.queryByText('Search with visible characters only.')).toBeNull();
  });

  it('shows the same message for a 422 on the search', async () => {
    stubApi(
      manager({
        [list()]: (req) => (new URL(req.url).searchParams.has('search') ? invalid(['query', 'search'], 'control_characters') : page([ROBIN])),
      }),
    );
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Members' });

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search members' }), { target: { value: 'Rob\u0085in' } });
    press(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('Search with visible characters only.')).toBeTruthy();
    expect(screen.queryByText(/could not load the members/i)).toBeNull();
  });
});

describe('actions by status (criterion 5)', () => {
  it('offers Suspend and Move out on active rows, Reactivate and Move out on suspended ones, nothing on the others', async () => {
    stubApi(manager({ [list()]: () => page([ROBIN, SAM, PAT, NEW, DEN]) }));
    renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Members' });

    const buttons = (name: string) => within(row(name)).queryAllByRole('button').map((button) => button.getAttribute('aria-label'));
    expect(buttons('Robin Park')).toEqual(['Suspend Robin Park', 'Move out Robin Park']);
    expect(buttons('Sam Lee')).toEqual(['Reactivate Sam Lee', 'Move out Sam Lee']);
    expect(buttons('Pat Gone')).toEqual([]);
    expect(buttons('Nia New')).toEqual([]);
    expect(buttons('Dee Denied')).toEqual([]);
  });
});

describe('suspend, reactivate, move out (criteria 6–8)', () => {
  it('suspends with the reason as typed: one request, dialog closed, message shown, list asked again', async () => {
    let suspended = false;
    const bodies: unknown[] = [];
    const fetchMock = stubApi(
      manager({
        [list()]: () => page(suspended ? [{ ...ROBIN, status: 'suspended', status_reason: 'Unpaid fees' }, SAM] : [ROBIN, SAM]),
        [action('suspend', ROBIN.membership_id)]: async (req) => {
          bodies.push(await req.json());
          suspended = true;
          return json({ ...ROBIN, status: 'suspended', status_reason: 'Unpaid fees' });
        },
      }),
    );
    renderApp([PAGE]);

    const dialog = await openDialog('Robin Park', 'suspend');
    expect(within(dialog).getByRole('heading').textContent).toBe('Suspend this member?');
    expect(dialog.textContent).toContain('Robin Park (robin@example.test), unit A-1203');
    expect(document.activeElement).toBe(screen.getByLabelText('Reason (only managers see it)'));
    fireEvent.change(screen.getByLabelText('Reason (only managers see it)'), { target: { value: ' Unpaid fees ' } });
    press(confirmButton(dialog, 'suspend'));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(status().textContent).toBe('Robin Park was suspended.');
    expect(bodies).toEqual([{ reason: ' Unpaid fees ' }]);
    await waitFor(() => expect(count(fetchMock, list())).toBe(2));
    await waitFor(() => expect(within(row('Robin Park')).queryByRole('button', { name: 'Suspend Robin Park' })).toBeNull());
    expect(document.activeElement).toBe(status());
  });

  it('reactivates after confirming, with no body', async () => {
    const bodies: string[] = [];
    const fetchMock = stubApi(
      manager({
        [action('reactivate', SAM.membership_id)]: async (req) => {
          bodies.push(await req.text());
          return json({ ...SAM, status: 'active', status_reason: null });
        },
      }),
    );
    renderApp([PAGE]);

    const dialog = await openDialog('Sam Lee', 'reactivate');
    expect(within(dialog).getByRole('heading').textContent).toBe('Reactivate this member?');
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    press(confirmButton(dialog, 'reactivate'));

    await waitFor(() => expect(status().textContent).toBe('Sam Lee was reactivated.'));
    expect(bodies).toEqual(['']);
    await waitFor(() => expect(count(fetchMock, list())).toBe(2));
  });

  it('moves out with a reason, saying the occupancy ends', async () => {
    const bodies: unknown[] = [];
    const fetchMock = stubApi(
      manager({
        [action('deactivate', ROBIN.membership_id)]: async (req) => {
          bodies.push(await req.json());
          return json({ ...ROBIN, status: 'deactivated', status_reason: 'Lease ended', unit_id: null, unit_label: null, tower: null, relationship: null });
        },
      }),
    );
    renderApp([PAGE]);

    const dialog = await openDialog('Robin Park', 'deactivate');
    expect(within(dialog).getByRole('heading').textContent).toBe('Move this member out?');
    expect(dialog.textContent).toMatch(/occupancy of unit A-1203 ends and they lose access to this building/);
    fireEvent.change(screen.getByLabelText('Reason (only managers see it)'), { target: { value: 'Lease ended' } });
    press(confirmButton(dialog, 'deactivate'));

    await waitFor(() => expect(status().textContent).toBe('Robin Park was moved out.'));
    expect(bodies).toEqual([{ reason: 'Lease ended' }]);
    await waitFor(() => expect(count(fetchMock, list())).toBe(2));
  });

  it('names no unit for a member without one', async () => {
    stubApi(manager({ [list()]: () => page([KIM]) }));
    renderApp([PAGE]);

    const dialog = await openDialog('Kim Staff', 'deactivate');
    expect(dialog.textContent).toContain('Kim Staff (person3@example.test), no unit');
    expect(dialog.textContent).toMatch(/They lose access to this building/);
  });

  it.each([
    ['empty', '', 'Give a reason of at least 3 characters.'],
    ['two characters after trimming', '  ab  ', 'Give a reason of at least 3 characters.'],
    ['over 500 code points', 'x'.repeat(501), 'Use at most 500 characters.'],
    ['on two lines', 'Unpaid\nfees', 'Write the reason on one line, with visible characters only.'],
    ['with an invisible character', 'Unpaid​fees', 'Write the reason on one line, with visible characters only.'],
  ])('%s: %s refuses the reason and sends nothing', async (kind, value, message) => {
    void kind;
    const fetchMock = stubApi(manager());
    renderApp([PAGE]);

    for (const which of ['suspend', 'deactivate'] as const) {
      const dialog = await openDialog('Robin Park', which);
      const field = screen.getByLabelText('Reason (only managers see it)');
      fireEvent.change(field, { target: { value } });
      press(confirmButton(dialog, which));

      expect(within(dialog).getByText(message)).toBeTruthy();
      expect(field.getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement).toBe(field);
      fireEvent.keyDown(dialog, { key: 'Escape' });
    }
    expect(calls(fetchMock).filter((c) => c.startsWith('POST'))).toEqual([]);
  });

  it('places a 422 on the reason by its type and keeps the dialog and its text', async () => {
    stubApi(manager({ [action('suspend', ROBIN.membership_id)]: () => invalid(['body', 'reason'], 'invisible_characters') }));
    renderApp([PAGE]);

    const dialog = await openDialog('Robin Park', 'suspend');
    fireEvent.change(screen.getByLabelText('Reason (only managers see it)'), { target: { value: 'Unpaid fees' } });
    press(confirmButton(dialog, 'suspend'));

    expect(await within(dialog).findByText('Write the reason on one line, with visible characters only.')).toBeTruthy();
    expect(screen.getByLabelText<HTMLTextAreaElement>('Reason (only managers see it)').value).toBe('Unpaid fees');
    expect(document.activeElement).toBe(screen.getByLabelText('Reason (only managers see it)'));
  });
});

describe('one request, Cancel and Escape (criterion 9)', () => {
  it.each(['suspend', 'reactivate', 'deactivate'] as const)('%s: a double-click sends one request, the button disabled until the answer', async (kind) => {
    const target = kind === 'reactivate' ? SAM : ROBIN;
    const gate = deferred(() => json({ ...target, status: kind === 'reactivate' ? 'active' : 'suspended' }));
    const fetchMock = stubApi(manager({ [action(kind, target.membership_id)]: gate.handler }));
    renderApp([PAGE]);

    const dialog = await openDialog(target.full_name, kind);
    if (kind !== 'reactivate') fireEvent.change(screen.getByLabelText('Reason (only managers see it)'), { target: { value: 'Unpaid fees' } });
    const confirm = confirmButton(dialog, kind);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await settle();

    expect(count(fetchMock, action(kind, target.membership_id))).toBe(1);
    expect(confirm.disabled).toBe(true);
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(true);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBe(dialog);
    gate.release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(count(fetchMock, action(kind, target.membership_id))).toBe(1);
  });

  it('Cancel and Escape send nothing and return focus to the row’s button', async () => {
    const fetchMock = stubApi(manager());
    renderApp([PAGE]);

    let dialog = await openDialog('Robin Park', 'suspend');
    press(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(within(row('Robin Park')).getByRole('button', { name: 'Suspend Robin Park' })));

    dialog = await openDialog('Sam Lee', 'reactivate');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(within(row('Sam Lee')).getByRole('button', { name: 'Reactivate Sam Lee' })));
    expect(calls(fetchMock).filter((c) => c.startsWith('POST'))).toEqual([]);
  });

  it('keeps Tab inside the dialog', async () => {
    stubApi(manager());
    renderApp([PAGE]);

    const dialog = await openDialog('Robin Park', 'suspend');
    const confirm = confirmButton(dialog, 'suspend');
    confirm.focus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByLabelText('Reason (only managers see it)'));
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });
});

describe('refusals that end the dialog (criteria 1, 10)', () => {
  it.each([
    ['suspend', 409, 'last_manager', 'The building must keep at least one active property manager, so this wasn’t done.'],
    ['deactivate', 409, 'last_manager', 'The building must keep at least one active property manager, so this wasn’t done.'],
    ['suspend', 409, 'cannot_target_self', 'You can’t suspend yourself.'],
    ['deactivate', 409, 'cannot_target_self', 'You can’t move yourself out.'],
    ['suspend', 409, 'invalid_transition', 'Robin Park’s status changed in the meantime, so this wasn’t done. Check the list and try again.'],
    ['reactivate', 409, 'invalid_transition', 'Robin Park’s status changed in the meantime, so this wasn’t done. Check the list and try again.'],
    ['deactivate', 409, 'invalid_transition', 'Robin Park’s status changed in the meantime, so this wasn’t done. Check the list and try again.'],
    ['deactivate', 409, 'occupancy_changed', 'Robin Park’s unit changed at the same time, so this wasn’t done. Check the list and try again.'],
    ['suspend', 404, 'member_not_found', 'This member is no longer in this building.'],
    ['reactivate', 404, 'member_not_found', 'This member is no longer in this building.'],
    ['deactivate', 404, 'member_not_found', 'This member is no longer in this building.'],
  ] as const)('%s answered %i %s: closes, says so and asks for the list again', async (kind, code, errorCode, message) => {
    const target = kind === 'reactivate' ? { ...ROBIN, status: 'suspended' as const } : ROBIN;
    const fetchMock = stubApi(
      manager({
        [list()]: () => page([target, KIM]),
        [action(kind, ROBIN.membership_id)]: () => problem(code, errorCode),
      }),
    );
    renderApp([PAGE]);

    const dialog = await openDialog('Robin Park', kind);
    if (kind !== 'reactivate') fireEvent.change(screen.getByLabelText('Reason (only managers see it)'), { target: { value: 'Unpaid fees' } });
    press(confirmButton(dialog, kind));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(status().textContent).toBe(message);
    expect(document.activeElement).toBe(status());
    await waitFor(() => expect(count(fetchMock, list())).toBe(2));
    expect(names()).toEqual(['Robin Park', 'Kim Staff']);
  });
});

describe('failures that keep the dialog (criterion 11)', () => {
  it.each([
    ['a 429 with Retry-After', () => problem(429, 'rate_limited', { 'Retry-After': '30' }), 'Too many requests. Try again in 30 seconds.'],
    ['a 500', () => problem(500, 'internal_error'), 'Could not move out Robin Park. Try again.'],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch')), 'Could not move out Robin Park. Try again.'],
    ['an unknown 409', () => problem(409, 'something_new'), 'Could not move out Robin Park. Try again.'],
    ['a 403 forbidden_role', () => problem(403, 'forbidden_role'), 'Could not move out Robin Park. Try again.'],
  ])('move out: %s keeps the dialog open with its reason, and the button works again', async (_label, answer, message) => {
    let n = 0;
    stubApi(manager({ [action('deactivate', ROBIN.membership_id)]: () => (++n === 1 ? answer() : json({ ...ROBIN, status: 'deactivated' })) }));
    renderApp([PAGE]);

    const dialog = await openDialog('Robin Park', 'deactivate');
    fireEvent.change(screen.getByLabelText('Reason (only managers see it)'), { target: { value: 'Lease ended' } });
    press(confirmButton(dialog, 'deactivate'));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toBe(message);
    expect(document.activeElement).toBe(alert);
    expect(screen.getByLabelText<HTMLTextAreaElement>('Reason (only managers see it)').value).toBe('Lease ended');
    expect(confirmButton(dialog, 'deactivate').disabled).toBe(false);
    press(confirmButton(dialog, 'deactivate'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(n).toBe(2);
  });

  it.each([
    ['suspend', 'Could not suspend Robin Park. Try again.'],
    ['reactivate', 'Could not reactivate Robin Park. Try again.'],
  ] as const)('%s: a 500 says what failed', async (kind, message) => {
    const target = kind === 'reactivate' ? { ...ROBIN, status: 'suspended' as const } : ROBIN;
    stubApi(manager({ [list()]: () => page([target]), [action(kind, ROBIN.membership_id)]: () => problem(500, 'internal_error') }));
    renderApp([PAGE]);

    const dialog = await openDialog('Robin Park', kind);
    if (kind === 'suspend') fireEvent.change(screen.getByLabelText('Reason (only managers see it)'), { target: { value: 'Unpaid fees' } });
    press(confirmButton(dialog, kind));

    expect((await within(dialog).findByRole('alert')).textContent).toBe(message);
  });
});

describe('a failed refresh and Show more (criterion 12)', () => {
  it('a failed refresh after an action warns above the old rows, offers no Show more until Try again works', async () => {
    let refresh: 'ok' | 'fail' = 'ok';
    let suspended = false;
    stubApi(
      manager({
        [list()]: (req) => {
          if (new URL(req.url).searchParams.has('cursor')) return page([KIM]);
          if (refresh === 'fail') return problem(500, 'internal_error');
          return page(suspended ? [{ ...ROBIN, status: 'suspended' }, SAM] : [ROBIN, SAM], 'older');
        },
        [action('suspend', ROBIN.membership_id)]: () => {
          suspended = true;
          refresh = 'fail';
          return json({ ...ROBIN, status: 'suspended' });
        },
      }),
    );
    renderApp([PAGE]);
    await screen.findByRole('button', { name: 'Show more' });

    const dialog = await openDialog('Robin Park', 'suspend');
    fireEvent.change(screen.getByLabelText('Reason (only managers see it)'), { target: { value: 'Unpaid fees' } });
    press(confirmButton(dialog, 'suspend'));

    const alert = await screen.findByRole('alert', {}, { timeout: 3000 });
    expect(alert.textContent).toMatch(/could not refresh the members/i);
    expect(names()).toEqual(['Robin Park', 'Sam Lee']);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    refresh = 'ok';
    press(within(alert).getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(within(row('Robin Park')).queryByRole('button', { name: 'Suspend Robin Park' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy();
  });

  it('Show more is disabled during any refetch (a focus refetch too)', async () => {
    let release = () => {};
    let held = false;
    stubApi(
      manager({
        [list()]: async () => {
          if (held) await new Promise<void>((resolve) => (release = resolve));
          return page([ROBIN], 'older');
        },
      }),
    );
    const app = renderApp([PAGE]);
    await screen.findByRole('list', { name: 'Members' });

    held = true;
    void app.queryClient.refetchQueries({ queryKey: ['b', MAPLE.id, 'members'] });

    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Show more' }).disabled).toBe(true));
    await act(async () => release());
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Show more' }).disabled).toBe(false));
  });
});

describe('leaving, history and buildings (criterion 13)', () => {
  it('an answer after leaving the page changes nothing on the new one, and the list is still asked again', async () => {
    const gate = deferred(() => json({ ...ROBIN, status: 'suspended' }));
    const fetchMock = stubApi(manager({ [action('suspend', ROBIN.membership_id)]: gate.handler }));
    const app = renderApp([PAGE]);
    const dialog = await openDialog('Robin Park', 'suspend');
    fireEvent.change(screen.getByLabelText('Reason (only managers see it)'), { target: { value: 'Unpaid fees' } });
    press(confirmButton(dialog, 'suspend'));
    await settle();

    act(() => app.navigate()('/Contacts'));
    await screen.findByText(/being migrated/i);
    gate.release();
    await settle();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('member-message')).toBeNull();
    expect(app.queryClient.getQueryState(['b', MAPLE.id, 'members', 'list', { role: null, status: null, search: '' }])?.isInvalidated).toBe(true);
    act(() => app.navigate()(PAGE));
    await waitFor(() => expect(count(fetchMock, list())).toBe(2));
  });

  it('Back to the Pending tab while a dialog is open closes it; Forward doesn’t bring it back', async () => {
    stubApi(manager({ [`GET /api/buildings/${MAPLE.id}/onboarding-requests`]: () => json({ items: [], next_cursor: null }) }));
    const app = renderApp(['/manage/residents', PAGE]);

    await openDialog('Robin Park', 'suspend');
    act(() => app.navigate()(-1));
    await screen.findByText('No pending requests.');
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => app.navigate()(1));

    await screen.findByRole('list', { name: 'Members' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a building switch lists the other building’s members and closes the dialog', async () => {
    const me = {
      ...RESIDENT_ME,
      memberships: [membership(MAPLE, { roles: ['property_management'] }), membership(BIRCH, { roles: ['property_management'] })],
    };
    const fetchMock = stubApi({
      'GET /api/auth/me': () => json(me),
      [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, ['property_management'])),
      [`GET /api/buildings/${BIRCH.id}`]: () => json(buildingOut(BIRCH, ['property_management'])),
      [`GET /api/buildings/${BIRCH.id}/notifications/summary`]: () => json({ unread_count: 0 }),
      [list()]: () => page([ROBIN, SAM]),
      [list(BIRCH)]: () => page([member(7, { full_name: 'Birch Person' })]),
    });
    sessionStorage.setItem('condo.buildingId', MAPLE.id);
    const app = renderApp([PAGE]);
    await openDialog('Robin Park', 'suspend');

    openAccountMenu();
    fireEvent.change(screen.getByLabelText(/building/i), { target: { value: BIRCH.id } });

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/'));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => app.navigate()(PAGE));
    await waitFor(() => expect(names()).toEqual(['Birch Person']));
    expect(calls(fetchMock)).toContain(list(BIRCH));
  });

  it('building_not_found on an action marks the building denied, as other building requests do', async () => {
    stubApi(manager({ [action('reactivate', SAM.membership_id)]: () => problem(404, 'building_not_found') }));
    const app = renderApp([PAGE]);

    const dialog = await openDialog('Sam Lee', 'reactivate');
    press(confirmButton(dialog, 'reactivate'));

    await waitFor(() => expect(app.queryClient.getQueryData(['b', MAPLE.id, 'denied'])).toEqual(expect.any(Number)));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Members' })).toBeNull());
  });
});

describe('a refetch under an open dialog (criterion 14)', () => {
  it.each([
    ['changes the row', () => page([{ ...ROBIN, status: 'suspended', status_reason: 'Elsewhere' }, SAM]), 409, 'invalid_transition', 'Robin Park’s status changed in the meantime, so this wasn’t done. Check the list and try again.'],
    ['drops the row', () => page([SAM]), 404, 'member_not_found', 'This member is no longer in this building.'],
  ] as const)('keeps the dialog on its member when a refetch %s, and the server decides', async (_label, after, code, errorCode, message) => {
    let changed = false;
    const fetchMock = stubApi(
      manager({
        [list()]: () => (changed ? after() : page([ROBIN, SAM])),
        [action('suspend', ROBIN.membership_id)]: () => problem(code, errorCode),
      }),
    );
    const app = renderApp([PAGE]);
    const dialog = await openDialog('Robin Park', 'suspend');
    fireEvent.change(screen.getByLabelText('Reason (only managers see it)'), { target: { value: 'Unpaid fees' } });

    changed = true;
    await act(() => app.queryClient.refetchQueries({ queryKey: ['b', MAPLE.id, 'members'] }));
    await waitFor(() => expect(within(membersList()).queryByRole('button', { name: 'Suspend Robin Park' })).toBeNull());

    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(dialog.textContent).toContain('Robin Park');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Reason (only managers see it)').value).toBe('Unpaid fees');
    press(confirmButton(dialog, 'suspend'));

    await waitFor(() => expect(status().textContent).toBe(message));
    expect(count(fetchMock, action('suspend', ROBIN.membership_id))).toBe(1);
    expect(document.activeElement).toBe(status());
  });
});
