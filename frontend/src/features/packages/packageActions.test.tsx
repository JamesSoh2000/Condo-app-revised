// @vitest-environment jsdom
/**
 * P5-03d: hand a waiting package out, or send it back, from the desk's "Waiting" list. Each `describe` names the
 * criteria it proves (docs/tickets/P5-03d-package-pickup-and-return-dialogs.md).
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { components } from '@/api/schema';
import { MAPLE, RESIDENT_ME, buildingOut, json, membership, problem, renderApp, stubApi, type Handler } from '@/test/renderApp';

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, ...actual.createApiClient({ baseUrl: 'http://app.test' }) };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

type Package = components['schemas']['PackageOut'];
type Occupant = components['schemas']['OccupantOut'];

const PAGE = '/security/packages';
const base = `/api/buildings/${MAPLE.id}`;
const LIST = `GET ${base}/packages`;
const U101 = '01929a4e-0000-7000-8000-0000000c0001';
const OCCUPANTS = `GET ${base}/units/${U101}/occupants`;
const ROBIN: Occupant = { membership_id: '01929a4e-0000-7000-8000-0000000d0001', full_name: 'Robin Park', relationship: 'owner' };
const SAM: Occupant = { membership_id: '01929a4e-0000-7000-8000-0000000d0002', full_name: 'Sam Lee', relationship: 'tenant' };
const GONE = { membership_id: '01929a4e-0000-7000-8000-0000000d0003', name: 'Alex Moved' };

function pkg(fields: Partial<Package> = {}): Package {
  return {
    id: '01929a4e-0000-7000-8000-0000000e0001',
    unit_id: U101,
    recipient_membership_id: ROBIN.membership_id,
    carrier: 'UPS',
    description: null,
    tracking_last4: null,
    photo_file_id: null,
    status: 'received',
    received_at: new Date(Date.now() - 3_600_000).toISOString(),
    received_by_membership_id: '01929a4e-0000-7000-8000-0000000d0009',
    picked_up_at: null,
    returned_at: null,
    unit_tower: 'A',
    unit_label: '101',
    recipient_name: 'Robin Park',
    ...fields,
  };
}
const PKG = pkg();
const PICKUP = `POST ${base}/packages/${PKG.id}/pickup`;
const RETURN = `POST ${base}/packages/${PKG.id}/return`;

function deferred(response: () => Response): { handler: Handler; release: () => void } {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { handler: () => gate.then(response), release };
}

/** Records each JSON body sent to the route, then answers. */
function recording(answer: (body: unknown) => Response | Promise<Response>) {
  const bodies: unknown[] = [];
  const handler: Handler = async (request) => {
    const body: unknown = await request.clone().json();
    bodies.push(body);
    return answer(body);
  };
  return { bodies, handler };
}

function desk(routes: Record<string, Handler> = {}, item: Package = PKG) {
  return stubApi({
    'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles: ['security'] })] }),
    [`GET ${base}`]: () => json(buildingOut(MAPLE, ['security'])),
    [LIST]: () => json({ items: [item], next_cursor: null }),
    [`GET ${base}/units`]: () => json({ items: [], next_cursor: null }),
    [OCCUPANTS]: () => json([ROBIN, SAM]),
    ...routes,
  });
}

const count = (fetchMock: ReturnType<typeof stubApi>, route: string) =>
  fetchMock.mock.calls.filter(([request]) => `${request.method} ${new URL(request.url).pathname}` === route).length;
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
const dialog = () => screen.getByRole('dialog');
const inDialog = () => within(dialog());
const message = () => screen.queryByTestId('package-message');
const rowButton = (name: 'Hand out' | 'Return') => screen.getByRole<HTMLButtonElement>('button', { name: `${name} the UPS package for unit A-101` });

function press(button: HTMLElement) {
  button.focus();
  fireEvent.click(button);
}

async function open(name: 'Hand out' | 'Return') {
  await screen.findByRole('list', { name: 'Waiting packages' });
  press(rowButton(name));
  return dialog();
}

const choose = (name: string | RegExp) => fireEvent.click(inDialog().getByRole('radio', { name }));
const typeName = (value: string) => fireEvent.change(inDialog().getByRole('textbox', { name: 'Their name' }), { target: { value } });
const typeReason = (value: string) => fireEvent.change(inDialog().getByRole('textbox', { name: 'Reason' }), { target: { value } });
const confirm = (name: 'Hand out' | 'Return') => press(inDialog().getByRole('button', { name }));

describe('the pickup choices and what is sent (criterion 2)', () => {
  it('offers the recipient, the other occupants once each and someone else, with nothing chosen', async () => {
    desk();
    renderApp([PAGE]);
    await open('Hand out');

    expect(inDialog().getByRole('heading', { name: 'Hand out this package?' })).toBeTruthy();
    expect(inDialog().getByText(/UPS package for unit A-101/)).toBeTruthy();
    await waitFor(() => expect(inDialog().getAllByRole('radio')).toHaveLength(3));
    const radios = inDialog().getAllByRole<HTMLInputElement>('radio');
    expect(radios.map((radio) => radio.labels?.[0]?.textContent)).toEqual(['Robin Park (recipient)', 'Sam Lee', 'Someone else']);
    expect(radios.some((radio) => radio.checked)).toBe(false);
    expect(inDialog().queryByRole('textbox', { name: 'Their name' })).toBeNull();
  });

  it('offers a recipient who moved out but may still collect, before the occupants', async () => {
    desk({}, pkg({ recipient_membership_id: GONE.membership_id, recipient_name: GONE.name }));
    renderApp([PAGE]);
    await open('Hand out');

    await waitFor(() => expect(inDialog().getAllByRole('radio')).toHaveLength(4));
    expect(inDialog().getAllByRole<HTMLInputElement>('radio').map((radio) => radio.labels?.[0]?.textContent)).toEqual([
      'Alex Moved (recipient)',
      'Robin Park',
      'Sam Lee',
      'Someone else',
    ]);
  });

  it('offers only the occupants for a package addressed to the unit', async () => {
    desk({}, pkg({ recipient_membership_id: null, recipient_name: null }));
    renderApp([PAGE]);
    await open('Hand out');

    await waitFor(() => expect(inDialog().getAllByRole('radio')).toHaveLength(3));
    expect(inDialog().getByRole('radio', { name: 'Robin Park' })).toBeTruthy();
  });

  it('sends the chosen member only', async () => {
    const pickup = recording(() => json(pkg({ status: 'picked_up' })));
    desk({ [PICKUP]: pickup.handler });
    renderApp([PAGE]);
    await open('Hand out');
    await waitFor(() => choose('Sam Lee'));

    confirm('Hand out');

    await waitFor(() => expect(pickup.bodies).toEqual([{ picked_up_by_membership_id: SAM.membership_id }]));
  });

  it('sends a typed name only, trimmed', async () => {
    const pickup = recording(() => json(pkg({ status: 'picked_up' })));
    desk({ [PICKUP]: pickup.handler });
    renderApp([PAGE]);
    await open('Hand out');
    choose('Someone else');
    typeName('  Jo Courier ');

    confirm('Hand out');

    await waitFor(() => expect(pickup.bodies).toEqual([{ picked_up_by_name: 'Jo Courier' }]));
  });

  it.each([
    ['nothing chosen', null, 'Choose who is collecting it.'],
    ['a blank name', '   ', 'Type their name.'],
    ['a control character', 'Jo\u0007', 'Use visible characters only.'],
    ['121 code points', '😀'.repeat(121), 'Use at most 120 characters.'],
  ])('refuses %s in the dialog and sends nothing', async (_case, name, error) => {
    const fetchMock = desk();
    renderApp([PAGE]);
    await open('Hand out');
    if (name !== null) {
      choose('Someone else');
      typeName(name);
    }

    confirm('Hand out');
    await settle();

    expect(inDialog().getByText(error)).toBeTruthy();
    expect(count(fetchMock, PICKUP)).toBe(0);
  });

  it('takes 120 code points', async () => {
    const pickup = recording(() => json(pkg({ status: 'picked_up' })));
    desk({ [PICKUP]: pickup.handler });
    renderApp([PAGE]);
    await open('Hand out');
    choose('Someone else');
    typeName('😀'.repeat(120));

    confirm('Hand out');

    await waitFor(() => expect(pickup.bodies).toEqual([{ picked_up_by_name: '😀'.repeat(120) }]));
  });

  it('shows the occupants loading, then their failure with Try again; someone else works without them', async () => {
    let fail = true;
    const gate = deferred(() => (fail ? problem(500, 'internal_error') : json([ROBIN, SAM])));
    const pickup = recording(() => json(pkg({ status: 'picked_up' })));
    desk({ [OCCUPANTS]: (request) => (fail ? gate.handler(request) : json([ROBIN, SAM])), [PICKUP]: pickup.handler });
    renderApp([PAGE]);
    await open('Hand out');

    expect(inDialog().getByText('Loading who lives in the unit…')).toBeTruthy();
    gate.release();
    expect(await inDialog().findByText('Could not load who lives in the unit.')).toBeTruthy();
    // The recipient is known from the package itself.
    expect(inDialog().getByRole('radio', { name: 'Robin Park (recipient)' })).toBeTruthy();

    fail = false;
    fireEvent.click(inDialog().getByRole('button', { name: 'Try again' }));
    expect(await inDialog().findByRole('radio', { name: 'Sam Lee' })).toBeTruthy();

    choose('Someone else');
    typeName('Jo Courier');
    confirm('Hand out');
    await waitFor(() => expect(pickup.bodies).toEqual([{ picked_up_by_name: 'Jo Courier' }]));
  });
});

describe('the return reason (criterion 3)', () => {
  it('sends the trimmed reason', async () => {
    const back = recording(() => json(pkg({ status: 'returned' })));
    desk({ [RETURN]: back.handler });
    renderApp([PAGE]);
    await open('Return');

    expect(inDialog().getByRole('heading', { name: 'Return this package to the carrier?' })).toBeTruthy();
    typeReason('  Refused by resident ');
    confirm('Return');

    await waitFor(() => expect(back.bodies).toEqual([{ reason: 'Refused by resident' }]));
  });

  it.each([
    ['a blank reason', '  ', 'Give a reason.'],
    ['a control character', 'Damaged\nbox', 'Use visible characters only.'],
    ['301 code points', '😀'.repeat(301), 'Use at most 300 characters.'],
  ])('refuses %s and sends nothing', async (_case, reason, error) => {
    const fetchMock = desk();
    renderApp([PAGE]);
    await open('Return');
    typeReason(reason);

    confirm('Return');
    await settle();

    expect(inDialog().getByText(error)).toBeTruthy();
    expect(count(fetchMock, RETURN)).toBe(0);
  });

  it('takes 300 code points', async () => {
    const back = recording(() => json(pkg({ status: 'returned' })));
    desk({ [RETURN]: back.handler });
    renderApp([PAGE]);
    await open('Return');
    typeReason('😀'.repeat(300));

    confirm('Return');

    await waitFor(() => expect(back.bodies).toEqual([{ reason: '😀'.repeat(300) }]));
  });
});

describe('a colleague got there first (criterion 1; tenant rows 8 and 10)', () => {
  it.each([
    ['pickup', 409, 'invalid_transition'],
    ['pickup', 404, 'package_not_found'],
    ['return', 409, 'invalid_transition'],
    ['return', 404, 'package_not_found'],
  ] as const)('a %s answered %i %s closes the dialog, says so and asks for the list again', async (kind, status, code) => {
    const fetchMock = desk({ [kind === 'pickup' ? PICKUP : RETURN]: () => problem(status, code) });
    renderApp([PAGE]);
    if (kind === 'pickup') {
      await open('Hand out');
      choose('Someone else');
      typeName('Jo Courier');
      confirm('Hand out');
    } else {
      await open('Return');
      typeReason('Damaged');
      confirm('Return');
    }

    await waitFor(() => expect(message()?.textContent).toBe('Already picked up or returned by a colleague.'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(message());
    expect(count(fetchMock, kind === 'pickup' ? PICKUP : RETURN)).toBe(1);
  });

  it('the list is asked again after the 409', async () => {
    let gone = false;
    const fetchMock = desk({
      [PICKUP]: () => {
        gone = true;
        return problem(409, 'invalid_transition');
      },
      [LIST]: () => json({ items: gone ? [] : [PKG], next_cursor: null }),
    });
    renderApp([PAGE]);
    await open('Hand out');
    choose('Someone else');
    typeName('Jo Courier');
    const lists = count(fetchMock, LIST);

    confirm('Hand out');

    expect(await screen.findByText('No packages are waiting.')).toBeTruthy();
    expect(count(fetchMock, LIST)).toBe(lists + 1);
  });
});

describe('refusals that keep the dialog open (criterion 4)', () => {
  it('invalid_pickup_member removes that person, asks for the occupants again and says so', async () => {
    const fetchMock = desk({ [PICKUP]: () => problem(422, 'invalid_pickup_member') });
    renderApp([PAGE]);
    await open('Hand out');
    await waitFor(() => choose('Sam Lee'));
    const asked = count(fetchMock, OCCUPANTS);

    confirm('Hand out');

    expect(await inDialog().findByText('That person can’t collect this package now. Choose someone else or type a name.')).toBeTruthy();
    expect(inDialog().queryByRole('radio', { name: 'Sam Lee' })).toBeNull();
    expect(inDialog().getAllByRole<HTMLInputElement>('radio').some((radio) => radio.checked)).toBe(false);
    await waitFor(() => expect(count(fetchMock, OCCUPANTS)).toBe(asked + 1));
    // Still hidden once the occupants answer again with that person.
    await settle();
    expect(inDialog().queryByRole('radio', { name: 'Sam Lee' })).toBeNull();
  });

  it.each([
    ['pickup', 'picked_up_by_name', 'string_too_long', 'Use at most 120 characters.'],
    ['pickup', 'picked_up_by_name', 'control_characters', 'Use visible characters only.'],
    ['return', 'reason', 'string_too_long', 'Use at most 300 characters.'],
    ['return', 'reason', 'control_characters', 'Use visible characters only.'],
  ] as const)('a 422 on the %s %s (%s) shows under the field', async (kind, field, type, text) => {
    const refusal = () =>
      new Response(JSON.stringify({ type: 'about:blank', title: 'validation_error', status: 422, code: 'validation_error', request_id: 'req', errors: [{ loc: ['body', field], type, msg: 'x' }] }), {
        status: 422,
        headers: { 'Content-Type': 'application/problem+json' },
      });
    desk({ [kind === 'pickup' ? PICKUP : RETURN]: refusal });
    renderApp([PAGE]);
    if (kind === 'pickup') {
      await open('Hand out');
      choose('Someone else');
      typeName('Jo Courier');
      confirm('Hand out');
    } else {
      await open('Return');
      typeReason('Damaged');
      confirm('Return');
    }

    expect(await inDialog().findByText(text)).toBeTruthy();
  });

  it.each([
    ['pickup', 500, 'internal_error', 'Could not record the pickup. Try again.'],
    ['return', 500, 'internal_error', 'Could not record the return. Try again.'],
    ['pickup', 429, 'rate_limited', /too many/i],
  ] as const)('a %s answered %i keeps the dialog and what was typed', async (kind, status, code, text) => {
    desk({ [kind === 'pickup' ? PICKUP : RETURN]: () => problem(status, code, status === 429 ? { 'Retry-After': '30' } : {}) });
    renderApp([PAGE]);
    if (kind === 'pickup') {
      await open('Hand out');
      choose('Someone else');
      typeName('Jo Courier');
      confirm('Hand out');
    } else {
      await open('Return');
      typeReason('Damaged');
      confirm('Return');
    }

    expect(await inDialog().findByText(text)).toBeTruthy();
    const field = inDialog().getByRole<HTMLInputElement>('textbox', { name: kind === 'pickup' ? 'Their name' : 'Reason' });
    expect(field.value).toBe(kind === 'pickup' ? 'Jo Courier' : 'Damaged');
    expect(inDialog().getByRole<HTMLButtonElement>('button', { name: kind === 'pickup' ? 'Hand out' : 'Return' }).disabled).toBe(false);
  });
});

describe('success (criterion 5)', () => {
  it('a pickup closes, names who collected it, focuses the message', async () => {
    desk({ [PICKUP]: () => json(pkg({ status: 'picked_up' })) });
    renderApp([PAGE]);
    await open('Hand out');
    await waitFor(() => choose('Robin Park (recipient)'));

    confirm('Hand out');

    await waitFor(() => expect(message()?.textContent).toBe('Unit A-101’s package was handed to Robin Park.'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(message());
  });

  it('a typed name is named too', async () => {
    desk({ [PICKUP]: () => json(pkg({ status: 'picked_up' })) });
    renderApp([PAGE]);
    await open('Hand out');
    choose('Someone else');
    typeName(' Jo Courier ');

    confirm('Hand out');

    await waitFor(() => expect(message()?.textContent).toBe('Unit A-101’s package was handed to Jo Courier.'));
  });

  it('a return closes and says so', async () => {
    desk({ [RETURN]: () => json(pkg({ status: 'returned' })) });
    renderApp([PAGE]);
    await open('Return');
    typeReason('Damaged');

    confirm('Return');

    await waitFor(() => expect(message()?.textContent).toBe('Unit A-101’s package was marked returned.'));
    expect(document.activeElement).toBe(message());
  });
});

describe('invalidation (criterion 6)', () => {
  it.each([
    ['success', () => json(pkg({ status: 'picked_up' }))],
    ['a refusal', () => problem(422, 'invalid_pickup_member')],
    ['a server error', () => problem(500, 'internal_error')],
    [
      'a network error',
      () => {
        throw new TypeError('Failed to fetch');
      },
    ],
  ] as const)('the packages queries are asked again after %s', async (_case, answer) => {
    const fetchMock = desk({ [PICKUP]: answer });
    const app = renderApp([PAGE]);
    await open('Hand out');
    choose('Someone else');
    typeName('Jo Courier');
    const lists = count(fetchMock, LIST);
    const invalidate = vi.spyOn(app.queryClient, 'invalidateQueries');

    confirm('Hand out');

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['b', MAPLE.id, 'packages'] }));
    await waitFor(() => expect(count(fetchMock, LIST)).toBe(lists + 1));
  });
});

describe('one request per confirmation, and focus (criterion 7)', () => {
  it.each(['Hand out', 'Return'] as const)('%s: a double click sends one request; while out everything is disabled and Escape does nothing', async (name) => {
    const gate = deferred(() => json(pkg({ status: name === 'Hand out' ? 'picked_up' : 'returned' })));
    const route = name === 'Hand out' ? PICKUP : RETURN;
    const fetchMock = desk({ [route]: gate.handler });
    renderApp([PAGE]);
    await open(name);
    if (name === 'Hand out') {
      choose('Someone else');
      typeName('Jo Courier');
    } else typeReason('Damaged');

    const button = inDialog().getByRole<HTMLButtonElement>('button', { name });
    button.focus();
    // In one act, so the second click comes before React re-renders the disabled button: the guard must stop it.
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await settle();

    expect(count(fetchMock, route)).toBe(1);
    expect(button.disabled).toBe(true);
    expect(inDialog().getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(true);
    expect(dialog().contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();

    gate.release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it.each([
    ['Hand out', 'Cancel'],
    ['Hand out', 'Escape'],
    ['Return', 'Cancel'],
    ['Return', 'Escape'],
  ] as const)('%s, then %s, sends nothing and puts focus back on the row button', async (name, how) => {
    const fetchMock = desk();
    renderApp([PAGE]);
    await open(name);

    if (how === 'Cancel') fireEvent.click(inDialog().getByRole('button', { name: 'Cancel' }));
    else fireEvent.keyDown(dialog(), { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(rowButton(name));
    expect(count(fetchMock, PICKUP) + count(fetchMock, RETURN)).toBe(0);
  });

  it('a new dialog starts empty after a cancelled one', async () => {
    desk();
    renderApp([PAGE]);
    await open('Return');
    typeReason('Damaged');
    fireEvent.click(inDialog().getByRole('button', { name: 'Cancel' }));
    await open('Return');

    expect(inDialog().getByRole<HTMLTextAreaElement>('textbox', { name: 'Reason' }).value).toBe('');
  });
});

describe('the dialog keeps its package (criterion 8; tenant rows 3 and 6)', () => {
  it('a list refresh that drops the row leaves the dialog as it was', async () => {
    let listed = [PKG];
    const pickup = recording(() => problem(409, 'invalid_transition'));
    desk({ [LIST]: () => json({ items: listed, next_cursor: null }), [PICKUP]: pickup.handler });
    renderApp([PAGE]);
    await open('Hand out');
    choose('Someone else');
    typeName('Jo Courier');

    listed = [];
    fireEvent.click(screen.getByRole('button', { name: 'Refresh', hidden: true }));
    expect(await screen.findByText('No packages are waiting.')).toBeTruthy();

    expect(inDialog().getByRole<HTMLInputElement>('textbox', { name: 'Their name' }).value).toBe('Jo Courier');
    confirm('Hand out');
    await waitFor(() => expect(message()?.textContent).toBe('Already picked up or returned by a colleague.'));
    expect(pickup.bodies).toHaveLength(1);
  });

  it.each(['Hand out', 'Return'] as const)('building_not_found on %s marks the building denied', async (name) => {
    desk({ [name === 'Hand out' ? PICKUP : RETURN]: () => problem(404, 'building_not_found') });
    const app = renderApp([PAGE]);
    await open(name);
    if (name === 'Hand out') {
      choose('Someone else');
      typeName('Jo Courier');
    } else typeReason('Damaged');

    confirm(name);

    await waitFor(() => expect(app.queryClient.getQueryData(['b', MAPLE.id, 'denied'])).toEqual(expect.any(Number)));
  });
});
