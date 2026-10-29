// @vitest-environment jsdom
/**
 * P6-04b: the resident's "New request" panel on `/maintenance`. Each `describe` names the criteria it proves
 * (docs/tickets/P6-04b-maintenance-submit-and-cancel.md).
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeSelectedBuilding } from '@/app/buildingStorage';
import { expectFocusKept } from '@/test/focus';
import { OCCUPANCY, U101, maintenanceBase, maintenanceRequest, newWorld, residentWorld, type World } from '@/test/maintenance';
import { BIRCH, MAPLE, RESIDENT_ME, buildingOut, calls, json, membership, openAccountMenu, problem, renderApp, stubApi, type Handler } from '@/test/renderApp';

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, ...actual.createApiClient({ baseUrl: 'http://app.test' }) };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const networkDown: Handler = () => Promise.reject(new TypeError('Failed to fetch'));
/** Answers each call with the next handler; the last one repeats. */
function inTurn(...handlers: Handler[]): Handler {
  let call = 0;
  return (request) => handlers[Math.min(call++, handlers.length - 1)](request);
}

const form = () => screen.getByRole('form', { name: 'New maintenance request' });
const inForm = () => within(form());
const submitButton = () => inForm().getByRole<HTMLButtonElement>('button', { name: 'Submit request' });
const description = () => inForm().getByLabelText<HTMLTextAreaElement>('Description');
const category = () => inForm().getByRole<HTMLSelectElement>('combobox', { name: 'Category' });
const commonArea = () => inForm().getByLabelText<HTMLInputElement>('Which common area?');

function start(world: World, options: Parameters<typeof residentWorld>[1] = {}, extra: Record<string, Handler> = {}) {
  const fetchMock = stubApi({ ...residentWorld(world, options), ...extra });
  renderApp(['/maintenance']);
  return fetchMock;
}

async function openForm() {
  fireEvent.click(await screen.findByRole('button', { name: 'New request' }));
  return form();
}

function fill({ cat = 'plumbing', text = 'The kitchen tap drips.' }: { cat?: string; text?: string } = {}) {
  fireEvent.change(category(), { target: { value: cat } });
  fireEvent.change(description(), { target: { value: text } });
}

const outcome = () => screen.findByTestId('maintenance-outcome');

describe('submitting a request (criterion 1)', () => {
  it('sends one request for the unit, shows it first in the list and focuses the outcome', async () => {
    const world = newWorld([maintenanceRequest(1, { description: 'Older request' })]);
    start(world);
    await openForm();
    fill();
    const button = submitButton();
    button.focus();

    await expectFocusKept(() => void fireEvent.click(button), { control: () => button, settle: async () => void (await outcome()) });

    expect(world.created).toHaveLength(1);
    expect(world.created[0].body).toEqual({
      location: 'unit',
      unit_id: U101,
      category: 'plumbing',
      description: 'The kitchen tap drips.',
    });
    expect(document.activeElement).toBe(await outcome());
    expect((await outcome()).textContent).toContain('Your request was submitted.');
    expect(screen.queryByRole('form', { name: 'New maintenance request' })).toBeNull();
    const list = await screen.findByRole('list', { name: 'Your maintenance requests' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    expect(within(list).getAllByRole('listitem')[0].textContent).toContain('The kitchen tap drips.');
  });

  it('sends a common-area request with its detail and no unit', async () => {
    const world = newWorld();
    start(world);
    await openForm();
    fireEvent.click(inForm().getByRole('radio', { name: 'A common area' }));
    fireEvent.change(commonArea(), { target: { value: '  Lobby, north door ' } });
    fill({ cat: 'doors_windows', text: 'The door sticks.' });
    fireEvent.click(submitButton());

    await outcome();
    expect(world.created[0].body).toEqual({
      location: 'common_area',
      common_area: 'Lobby, north door',
      category: 'doors_windows',
      description: 'The door sticks.',
    });
  });

  it('opens with the unit chosen and the category list in P6-04a’s order', async () => {
    start(newWorld());
    await openForm();
    expect(inForm().getByRole<HTMLInputElement>('radio', { name: 'My unit, A-101' }).checked).toBe(true);
    expect(within(category()).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Choose a category',
      'Plumbing',
      'Electrical',
      'Heating and cooling',
      'Appliance',
      'Doors and windows',
      'Pest control',
      'Other',
      'Emergency',
    ]);
  });

  it('Close shuts the panel and returns focus to New request; nothing is sent', async () => {
    const world = newWorld();
    start(world);
    await openForm();
    fill();
    fireEvent.click(inForm().getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('form', { name: 'New maintenance request' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New request' }));
    expect(world.created).toHaveLength(0);
  });

  it('Dismiss on the outcome returns focus to New request', async () => {
    start(newWorld());
    await openForm();
    fill();
    fireEvent.click(submitButton());
    fireEvent.click(within(await outcome()).getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByTestId('maintenance-outcome')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New request' }));
  });
});

describe('the checks before sending (criteria 1 and 4)', () => {
  it('asks for a category and a description, focusing the first, and sends nothing', async () => {
    const world = newWorld();
    start(world);
    await openForm();
    fireEvent.click(submitButton());

    expect(inForm().getByText('Choose a category.')).toBeTruthy();
    expect(inForm().getByText('Describe the problem.')).toBeTruthy();
    expect(document.activeElement).toBe(category());
    expect(world.created).toHaveLength(0);
  });

  it('counts the description in code points after the strip, as the server does, and refuses 2,001', async () => {
    const world = newWorld();
    start(world);
    await openForm();
    fill({ text: ` ${'😀'.repeat(2000)} ` });
    expect(inForm().getByText('2000 of 2000 characters')).toBeTruthy();
    fireEvent.click(submitButton());
    await outcome();
    expect(world.created).toHaveLength(1);
  });

  it('refuses a description of 2,001 code points', async () => {
    const world = newWorld();
    start(world);
    await openForm();
    fill({ text: '😀'.repeat(2001) });
    fireEvent.click(submitButton());
    expect(inForm().getByText('Use at most 2000 characters.')).toBeTruthy();
    expect(document.activeElement).toBe(description());
    expect(world.created).toHaveLength(0);
  });

  it('keeps tabs and line breaks in a description but refuses another control character', async () => {
    const world = newWorld();
    start(world);
    await openForm();
    fill({ text: 'Line one\n\tLine two\u0007' });
    fireEvent.click(submitButton());
    expect(inForm().getByText('Use visible characters only.')).toBeTruthy();
    expect(world.created).toHaveLength(0);

    // A textarea's value has LF line breaks only (the HTML spec normalises CRLF), in a browser as in jsdom.
    fireEvent.change(description(), { target: { value: 'Line one\n\tLine two' } });
    fireEvent.click(submitButton());
    await outcome();
    expect(world.created[0].body.description).toBe('Line one\n\tLine two');
  });

  it('asks for the common area, refuses 121 characters and a control character', async () => {
    const world = newWorld();
    start(world);
    await openForm();
    fill();
    fireEvent.click(inForm().getByRole('radio', { name: 'A common area' }));
    fireEvent.click(submitButton());
    expect(inForm().getByText('Say which common area.')).toBeTruthy();
    expect(document.activeElement).toBe(commonArea());

    fireEvent.change(commonArea(), { target: { value: 'x'.repeat(121) } });
    fireEvent.click(submitButton());
    expect(inForm().getByText('Use at most 120 characters.')).toBeTruthy();

    fireEvent.change(commonArea(), { target: { value: 'Lobby\tdoor' } });
    fireEvent.click(submitButton());
    expect(inForm().getByText('Use visible characters only.')).toBeTruthy();
    expect(world.created).toHaveLength(0);
  });
});

describe('one request per submit (criterion 2)', () => {
  // Both presses in one act: React renders nothing between them, so the second still finds the button enabled, as a
  // fast double click does in a browser. Two separate `fireEvent`s would let the disabled button refuse the second.
  it('a double press sends one create', async () => {
    const world = newWorld();
    start(world);
    await openForm();
    fill();
    const button = submitButton();
    act(() => {
      button.click();
      button.click();
    });
    await outcome();
    expect(world.created).toHaveLength(1);
  });

  it('Enter in the common-area field then a press sends one create', async () => {
    const world = newWorld();
    start(world);
    await openForm();
    fill();
    fireEvent.click(inForm().getByRole('radio', { name: 'A common area' }));
    fireEvent.change(commonArea(), { target: { value: 'Garage' } });
    const button = submitButton();
    act(() => {
      fireEvent.submit(form());
      button.click();
    });
    await outcome();
    expect(world.created).toHaveLength(1);
  });

  it('while the create is out, focus is on the status line, not on the disabled submit', async () => {
    let answer: (response: Response) => void = () => undefined;
    start(newWorld(), { create: () => new Promise<Response>((resolve) => (answer = resolve)) });
    await openForm();
    fill();
    const button = submitButton();
    button.focus();

    await expectFocusKept(() => void fireEvent.click(button), { control: () => button, settle: async () => void (await inForm().findByText('Sending…')) });
    expect(button.disabled).toBe(true);
    expect(document.activeElement).toBe(inForm().getByText('Sending…'));
    answer(json(maintenanceRequest(90), 201));
    const shown = await outcome();
    await waitFor(() => expect(document.activeElement).toBe(shown));
  });

  it('a retry after a network failure sends the same key and body', async () => {
    const world = newWorld();
    start(world, { create: inTurn(networkDown, () => json(maintenanceRequest(90), 201)) });
    await openForm();
    fill();
    fireEvent.click(submitButton());
    await inForm().findByText('Could not send your request. What you typed is kept; try again.');
    fireEvent.click(submitButton());
    await outcome();

    expect(world.created).toHaveLength(2);
    expect(world.created[0].key).toMatch(UUID);
    expect(world.created[1]).toEqual(world.created[0]);
  });

  it('a replayed 201 is a success', async () => {
    const world = newWorld();
    start(world, { create: () => json(maintenanceRequest(90), 201, { 'Idempotent-Replayed': 'true' }) });
    await openForm();
    fill();
    fireEvent.click(submitButton());
    expect((await outcome()).textContent).toContain('Your request was submitted.');
  });

  it('a new form gets a new key', async () => {
    const world = newWorld();
    start(world);
    await openForm();
    fill();
    fireEvent.click(submitButton());
    fireEvent.click(within(await outcome()).getByRole('button', { name: 'Dismiss' }));
    await openForm();
    fill();
    fireEvent.click(submitButton());
    await outcome();
    expect(world.created).toHaveLength(2);
    expect(world.created[1].key).not.toBe(world.created[0].key);
  });

  it('idempotency_key_reused says the earlier attempt was filed, keeps the values and takes a new key', async () => {
    const world = newWorld();
    const fetchMock = start(world, { create: inTurn(() => problem(409, 'idempotency_key_reused'), () => json(maintenanceRequest(90), 201)) });
    await openForm();
    fill();
    fireEvent.click(submitButton());

    const alert = await inForm().findByText(/An earlier attempt of this form was already submitted/);
    expect(document.activeElement).toBe(alert);
    expect(description().value).toBe('The kitchen tap drips.');
    await waitFor(() => expect(calls(fetchMock).filter((call) => call === `GET ${maintenanceBase()}`).length).toBeGreaterThan(1));
    fireEvent.click(submitButton());
    await outcome();
    expect(world.created[1].key).not.toBe(world.created[0].key);
  });
});

describe('errors from the server (criterion 4)', () => {
  const cases: { name: string; answer: Handler; message: string }[] = [
    {
      name: '422 on the description',
      answer: () =>
        json({ type: 'about:blank', title: 'x', status: 422, code: 'validation_error', errors: [{ loc: ['body', 'description'], type: 'string_too_long', msg: 'x' }] }, 422),
      message: 'Use at most 2000 characters.',
    },
    { name: '422 that cannot be placed', answer: () => problem(422, 'validation_error'), message: 'Check the details and try again.' },
    { name: 'unit_not_occupied', answer: () => problem(422, 'unit_not_occupied'), message: 'You no longer live in this unit. Choose a common area, or ask the building office.' },
    { name: 'unit_not_found', answer: () => problem(404, 'unit_not_found'), message: 'You no longer live in this unit. Choose a common area, or ask the building office.' },
    { name: 'unit_inactive', answer: () => problem(409, 'unit_inactive'), message: 'You no longer live in this unit. Choose a common area, or ask the building office.' },
    { name: 'occupancy_changed', answer: () => problem(409, 'occupancy_changed'), message: 'Your unit changed while you were sending. Check where the problem is and send again.' },
    { name: '429', answer: () => problem(429, 'rate_limited', { 'Retry-After': '30' }), message: 'Too many requests. Try again in 30 seconds.' },
    { name: '500', answer: () => problem(500, 'internal_error'), message: 'Could not send your request. What you typed is kept; try again.' },
    { name: 'a network failure', answer: networkDown, message: 'Could not send your request. What you typed is kept; try again.' },
  ];

  it.each(cases)('$name: the message takes focus and the values stay', async ({ answer, message }) => {
    start(newWorld(), { create: answer });
    await openForm();
    fill();
    const button = submitButton();
    button.focus();
    fireEvent.click(button);

    const alert = await inForm().findByText(message);
    expect(alert.getAttribute('role')).toBe('alert');
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(category().value).toBe('plumbing');
    expect(description().value).toBe('The kitchen tap drips.');
    expect(submitButton().disabled).toBe(false);
  });

  it('unit_not_occupied asks /me again', async () => {
    const fetchMock = start(newWorld(), { create: () => problem(422, 'unit_not_occupied') });
    await openForm();
    fill();
    const before = calls(fetchMock).filter((call) => call === 'GET /api/auth/me').length;
    fireEvent.click(submitButton());
    await inForm().findByText(/You no longer live in this unit/);
    await waitFor(() => expect(calls(fetchMock).filter((call) => call === 'GET /api/auth/me').length).toBeGreaterThan(before));
  });
});

describe('no current unit (criterion 5)', () => {
  it('offers only a common area, says why, and sends it', async () => {
    const world = newWorld();
    start(world, { occupancy: null });
    await openForm();

    expect(inForm().queryByRole('radio')).toBeNull();
    expect(inForm().getByText('You have no unit on file in this building, so you can report a common-area problem only.')).toBeTruthy();
    fireEvent.change(commonArea(), { target: { value: 'Garage' } });
    fill();
    fireEvent.click(submitButton());
    await outcome();
    expect(world.created[0].body).toMatchObject({ location: 'common_area', common_area: 'Garage' });
    expect(world.created[0].body).not.toHaveProperty('unit_id');
  });
});

describe('emergency (criterion 6)', () => {
  const NOT_PROMISED = /notified|alerted|on (its|their) way|will call|has been sent to/i;

  it('shows the fixed text before submit, only for emergency', async () => {
    start(newWorld());
    await openForm();
    expect(screen.queryByTestId('emergency-notice')).toBeNull();
    fill({ cat: 'emergency' });
    const notice = screen.getByTestId('emergency-notice');
    expect(notice.textContent).toBe('This request alerts no one. If this is an emergency, call the emergency services or building staff now.');
    fireEvent.change(category(), { target: { value: 'plumbing' } });
    expect(screen.queryByTestId('emergency-notice')).toBeNull();
  });

  it('after the 201 shows the response’s phone as a call link until dismissed', async () => {
    start(newWorld(), { create: () => json(maintenanceRequest(90, { category: 'emergency', emergency_phone: '+1 416 555 0199' }), 201) });
    await openForm();
    fill({ cat: 'emergency' });
    fireEvent.click(submitButton());

    const shown = await screen.findByTestId('emergency-outcome');
    expect(document.activeElement).toBe(shown);
    expect(within(shown).getByTestId('emergency-notice').textContent).toBe(
      'Your request was submitted, but it alerts no one. If this is an emergency, call the emergency services, or building staff at +1 416 555 0199, now.',
    );
    expect(within(shown).getByRole('link', { name: '+1 416 555 0199' }).getAttribute('href')).toBe('tel:+14165550199');
    expect(document.body.textContent).not.toMatch(NOT_PROMISED);
  });

  it('with no phone for the building says to call directly', async () => {
    start(newWorld(), { create: () => json(maintenanceRequest(90, { category: 'emergency', emergency_phone: null }), 201) });
    await openForm();
    fill({ cat: 'emergency' });
    fireEvent.click(submitButton());

    expect(within(await screen.findByTestId('emergency-outcome')).getByTestId('emergency-notice').textContent).toBe(
      'Your request was submitted, but it alerts no one. If this is an emergency, call the emergency services and building staff directly, now.',
    );
    expect(document.body.textContent).not.toMatch(NOT_PROMISED);
  });
});

describe('switching building (criterion 8)', () => {
  it('closes the form, and nothing typed in Maple is sent to either building', async () => {
    const world = newWorld();
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
    await openForm();
    fireEvent.change(commonArea(), { target: { value: 'Maple lobby' } });
    fill({ text: 'Typed in Maple' });

    openAccountMenu();
    fireEvent.change(screen.getByRole('combobox', { name: 'Building' }), { target: { value: BIRCH.id } });
    fireEvent.click(await within(await screen.findByRole('navigation', { name: 'Main' })).findByRole('link', { name: 'Maintenance requests' }));

    await screen.findByText('You haven’t submitted any requests.');
    expect(screen.queryByRole('form', { name: 'New maintenance request' })).toBeNull();
    await openForm();
    expect(description().value).toBe('');
    expect(commonArea().value).toBe('');
    expect(world.created).toHaveLength(0);
    expect(calls(fetchMock).some((call) => call.startsWith('POST') && call.includes('maintenance-requests'))).toBe(false);
  });
});

describe('review round 1 (Codex gpt-6.1-sol)', () => {
  async function emergencyWith(phone: string | null) {
    start(newWorld(), { create: () => json(maintenanceRequest(90, { category: 'emergency', emergency_phone: phone }), 201) });
    await openForm();
    fill({ cat: 'emergency' });
    fireEvent.click(submitButton());
    return screen.findByTestId('emergency-outcome');
  }

  it.each(['+1-416-555-0199;ext=123', '416-555-0199 x123', 'Front desk 416-555-0199', '+1 (416) 555-0199 #2'])(
    'F1: a phone that is not plainly a number (%s) is shown whole, as text, not as a call link',
    async (phone) => {
      const shown = await emergencyWith(phone);
      expect(within(shown).getByTestId('emergency-notice').textContent).toContain(phone);
      expect(within(shown).queryByRole('link')).toBeNull();
    },
  );

  it.each([
    ['+1 416 555 0199', 'tel:+14165550199'],
    ['(416) 555-0199', 'tel:4165550199'],
    ['416.555.0199', 'tel:4165550199'],
  ])('F1 neighbour: a plain number (%s) is a call link to its digits', async (phone, href) => {
    const shown = await emergencyWith(phone);
    expect(within(shown).getByRole('link', { name: phone }).getAttribute('href')).toBe(href);
  });

  it('F2: the emergency text and phone stay when New request opens another form, until Dismiss', async () => {
    const shown = await emergencyWith('+1 416 555 0199');
    fireEvent.click(screen.getByRole('button', { name: 'New request' }));
    expect(within(screen.getByTestId('emergency-outcome')).getByRole('link', { name: '+1 416 555 0199' })).toBe(
      within(shown).getByRole('link', { name: '+1 416 555 0199' }),
    );
    expect(form()).toBeTruthy();
    fireEvent.click(within(shown).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('emergency-outcome')).toBeNull();
    // "New request" is gone while the form is open: focus goes to the form's first field, which stays.
    expect(document.activeElement).not.toBe(document.body);
    expect(form().contains(document.activeElement)).toBe(true);
  });

  it('F2 neighbour: a later ordinary request keeps the emergency text, and shows its own outcome too', async () => {
    let call = 0;
    start(newWorld(), {
      create: () =>
        json(call++ === 0 ? maintenanceRequest(90, { category: 'emergency', emergency_phone: '+1 416 555 0199' }) : maintenanceRequest(91), 201),
    });
    await openForm();
    fill({ cat: 'emergency' });
    fireEvent.click(submitButton());
    await screen.findByTestId('emergency-outcome');
    await openForm();
    fill();
    fireEvent.click(submitButton());
    const ordinary = await outcome();
    await waitFor(() => expect(document.activeElement).toBe(ordinary));
    expect(ordinary.textContent).toContain('Your request was submitted.');
    expect(within(screen.getByTestId('emergency-outcome')).getByRole('link', { name: '+1 416 555 0199' })).toBeTruthy();
  });

  it('F2 neighbour: Dismiss on the emergency text with no form open returns focus to New request', async () => {
    const shown = await emergencyWith(null);
    expect(document.activeElement).toBe(shown);
    fireEvent.click(within(shown).getByRole('button', { name: 'Dismiss' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New request' }));
  });

  it('F3: losing the occupancy while a unit radio has focus moves focus to the common-area field', async () => {
    stubApi(residentWorld(newWorld()));
    const app = renderApp(['/maintenance']);
    await openForm();
    const unit = inForm().getByRole('radio', { name: 'My unit, A-101' });
    unit.focus();

    await expectFocusKept(
      () => void app.queryClient.setQueryData(['me'], { ...RESIDENT_ME, memberships: [{ ...membership(MAPLE), occupancy: null }] }),
      { control: () => unit, settle: async () => void (await waitFor(() => expect(inForm().queryByRole('radio')).toBeNull())) },
    );
    expect(document.activeElement).toBe(commonArea());
  });

  it('F3 neighbour: losing the occupancy while focus is elsewhere in the form leaves focus there', async () => {
    stubApi(residentWorld(newWorld()));
    const app = renderApp(['/maintenance']);
    await openForm();
    description().focus();
    act(() => {
      app.queryClient.setQueryData(['me'], { ...RESIDENT_ME, memberships: [{ ...membership(MAPLE), occupancy: null }] });
    });
    await waitFor(() => expect(inForm().queryByRole('radio')).toBeNull());
    expect(document.activeElement).toBe(description());
  });

  it('F3 neighbour: losing the occupancy with the common-area radio focused (field shown) moves focus to that field', async () => {
    stubApi(residentWorld(newWorld()));
    const app = renderApp(['/maintenance']);
    await openForm();
    const area = inForm().getByRole('radio', { name: 'A common area' });
    fireEvent.click(area);
    area.focus();
    act(() => {
      app.queryClient.setQueryData(['me'], { ...RESIDENT_ME, memberships: [{ ...membership(MAPLE), occupancy: null }] });
    });
    await waitFor(() => expect(inForm().queryByRole('radio')).toBeNull());
    expect(document.activeElement).toBe(commonArea());
  });
});

describe('review round 2 (Codex gpt-6.1-sol)', () => {
  it('F1: Dismiss on the emergency text while the next request is sending keeps focus off <body>', async () => {
    let call = 0;
    start(newWorld(), {
      create: () =>
        call++ === 0
          ? json(maintenanceRequest(90, { category: 'emergency', emergency_phone: '+1 416 555 0199' }), 201)
          : new Promise<Response>(() => {}),
    });
    await openForm();
    fill({ cat: 'emergency' });
    fireEvent.click(submitButton());
    const shown = await screen.findByTestId('emergency-outcome');
    await openForm();
    fill();
    fireEvent.click(submitButton());
    await inForm().findByText('Sending…');
    const dismiss = within(shown).getByRole('button', { name: 'Dismiss' });
    dismiss.focus();

    await expectFocusKept(() => void fireEvent.click(dismiss), { control: () => dismiss });
    expect(screen.queryByTestId('emergency-outcome')).toBeNull();
  });
});

describe('review round 3 (Codex gpt-6.1-sol): the location after the occupancy goes', () => {
  const U102 = '01929a4e-0000-7000-8000-0000000c0002';
  const meWith = (occupancy: typeof OCCUPANCY | null) => ({ ...RESIDENT_ME, memberships: [{ ...membership(MAPLE), occupancy }] });
  const OTHER_UNIT = { ...OCCUPANCY, unit_id: U102, unit_label: '102' };

  function openWith(world: World) {
    stubApi(residentWorld(world));
    return renderApp(['/maintenance']);
  }
  // React Query tells its observers on a later macrotask (`notifyManager`), so the form renders after that turn.
  const setMe = (app: ReturnType<typeof renderApp>, occupancy: typeof OCCUPANCY | null) =>
    act(async () => {
      app.queryClient.setQueryData(['me'], meWith(occupancy));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

  it('F1: a common area typed after the unit went stays chosen, typed and focused when another unit comes, and is what is sent', async () => {
    const world = newWorld();
    const app = openWith(world);
    await openForm();
    await setMe(app, null);
    commonArea().focus();
    fireEvent.change(commonArea(), { target: { value: 'Lobby' } });

    const field = commonArea();
    await expectFocusKept(() => setMe(app, OTHER_UNIT), {
      control: () => field,
      settle: async () => void (await inForm().findByRole('radio', { name: 'My unit, A-102' })),
    });
    expect(inForm().getByRole<HTMLInputElement>('radio', { name: 'A common area' }).checked).toBe(true);
    expect(inForm().getByRole<HTMLInputElement>('radio', { name: 'My unit, A-102' }).checked).toBe(false);
    expect(commonArea()).toBe(field);
    expect(field.value).toBe('Lobby');

    fill();
    fireEvent.click(submitButton());
    await outcome();
    expect(world.created[0].body).toEqual({ location: 'common_area', common_area: 'Lobby', category: 'plumbing', description: 'The kitchen tap drips.' });
  });

  it('F1 neighbour: with nothing typed, the unit coming back leaves "A common area" chosen; the resident picks the unit again', async () => {
    const world = newWorld();
    const app = openWith(world);
    await openForm();
    await setMe(app, null);
    await setMe(app, OTHER_UNIT);

    expect(inForm().getByRole<HTMLInputElement>('radio', { name: 'A common area' }).checked).toBe(true);
    fireEvent.click(inForm().getByRole('radio', { name: 'My unit, A-102' }));
    fill();
    fireEvent.click(submitButton());
    await outcome();
    expect(world.created[0].body).toMatchObject({ location: 'unit', unit_id: U102 });
  });

  it('F1 neighbour: the same unit coming back also leaves the typed common area chosen', async () => {
    const world = newWorld();
    const app = openWith(world);
    await openForm();
    await setMe(app, null);
    fireEvent.change(commonArea(), { target: { value: 'Garage' } });
    await setMe(app, OCCUPANCY);

    expect(inForm().getByRole<HTMLInputElement>('radio', { name: 'A common area' }).checked).toBe(true);
    expect(commonArea().value).toBe('Garage');
  });

  it('F1 neighbour: a form opened with no unit keeps the common area when a unit arrives', async () => {
    const world = newWorld();
    stubApi(residentWorld(world, { occupancy: null }));
    const app = renderApp(['/maintenance']);
    await openForm();
    fireEvent.change(commonArea(), { target: { value: 'Pool' } });
    await setMe(app, OCCUPANCY);

    expect(inForm().getByRole<HTMLInputElement>('radio', { name: 'A common area' }).checked).toBe(true);
    expect(commonArea().value).toBe('Pool');
  });

  it('F1 neighbour: a unit changing straight to another (no gap) keeps "My unit" chosen, now naming the new unit', async () => {
    const world = newWorld();
    const app = openWith(world);
    await openForm();
    await setMe(app, OTHER_UNIT);

    expect(inForm().getByRole<HTMLInputElement>('radio', { name: 'My unit, A-102' }).checked).toBe(true);
    fill();
    fireEvent.click(submitButton());
    await outcome();
    expect(world.created[0].body).toMatchObject({ location: 'unit', unit_id: U102 });
  });
});
