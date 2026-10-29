// @vitest-environment jsdom
/**
 * P6-04b: the resident's "New request" panel on `/maintenance`. Each `describe` names the criteria it proves
 * (docs/tickets/P6-04b-maintenance-submit-and-cancel.md).
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeSelectedBuilding } from '@/app/buildingStorage';
import { expectFocusKept } from '@/test/focus';
import {
  FILES,
  FakeXHR,
  U101,
  maintenanceBase,
  maintenanceRequest,
  newWorld,
  residentWorld,
  type World,
} from '@/test/maintenance';
import { BIRCH, MAPLE, RESIDENT_ME, buildingOut, calls, json, membership, openAccountMenu, problem, renderApp, stubApi, type Handler } from '@/test/renderApp';

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, ...actual.createApiClient({ baseUrl: 'http://app.test' }) };
});

beforeEach(() => {
  FakeXHR.instances = [];
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() }));
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

async function addPhoto(n: number, name = `leak-${n}.jpg`) {
  fireEvent.click(inForm().getByRole('button', { name: 'Add a photo' }));
  const row = await inForm().findByRole('group', { name: `Photo ${n}` });
  const input = row.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [new File(['x'], name, { type: 'image/jpeg' })] } });
  await waitFor(() => expect(FakeXHR.instances.length).toBeGreaterThanOrEqual(n));
  return row;
}

async function uploadPhoto(n: number) {
  const row = await addPhoto(n);
  FakeXHR.instances[n - 1].respond(204);
  await within(row).findByText(`Uploaded leak-${n}.jpg.`);
  return row;
}

const outcome = () => screen.findByTestId('maintenance-outcome');

describe('submitting a request (criterion 1)', () => {
  it('sends one request with both photos in order, shows it first in the list and focuses the outcome', async () => {
    const world = newWorld([maintenanceRequest(1, { description: 'Older request' })]);
    start(world);
    await openForm();
    fill();
    await uploadPhoto(1);
    await uploadPhoto(2);
    const button = submitButton();
    button.focus();

    await expectFocusKept(() => void fireEvent.click(button), { control: () => button, settle: async () => void (await outcome()) });

    expect(world.created).toHaveLength(1);
    expect(world.created[0].body).toEqual({
      location: 'unit',
      unit_id: U101,
      category: 'plumbing',
      description: 'The kitchen tap drips.',
      photo_file_ids: [FILES[0], FILES[1]],
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
      photo_file_ids: [],
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

    fireEvent.change(description(), { target: { value: 'Line one\r\n\tLine two' } });
    fireEvent.click(submitButton());
    await outcome();
    expect(world.created[0].body.description).toBe('Line one\r\n\tLine two');
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
  it('a double press sends one create', async () => {
    const world = newWorld();
    start(world);
    await openForm();
    fill();
    fireEvent.click(submitButton());
    fireEvent.click(submitButton());
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
    fireEvent.submit(form());
    fireEvent.click(submitButton());
    await outcome();
    expect(world.created).toHaveLength(1);
  });

  it('a retry after a network failure sends the same key and body', async () => {
    const world = newWorld();
    start(world, { create: inTurn(networkDown, () => json(maintenanceRequest(90), 201)) });
    await openForm();
    fill();
    await uploadPhoto(1);
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

describe('photos (criterion 3)', () => {
  it('disables submit while a photo uploads and says why', async () => {
    start(newWorld());
    await openForm();
    fill();
    await addPhoto(1);

    expect(submitButton().disabled).toBe(true);
    const why = inForm().getByText('Wait for the photos to finish uploading.');
    expect(submitButton().getAttribute('aria-describedby')).toContain(why.id);
    FakeXHR.instances[0].respond(204);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
  });

  it('a failed upload can be retried, keeping the other fields', async () => {
    const world = newWorld();
    start(world);
    await openForm();
    fill();
    const row = await addPhoto(1);
    FakeXHR.instances[0].fail();
    fireEvent.click(await within(row).findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(2));
    FakeXHR.instances[1].respond(204);
    await within(row).findByText('Uploaded leak-1.jpg.');
    expect(description().value).toBe('The kitchen tap drips.');
    fireEvent.click(submitButton());
    await outcome();
    expect(world.created[0].body.photo_file_ids).toEqual([FILES[0]]);
  });

  it('a failed upload can be removed, keeping the other photos and fields; focus goes to Add a photo', async () => {
    const world = newWorld();
    start(world);
    await openForm();
    fill();
    await uploadPhoto(1);
    const row = await addPhoto(2);
    FakeXHR.instances[1].fail();
    const remove = await within(row).findByRole('button', { name: 'Remove photo 2' });
    remove.focus();
    fireEvent.click(remove);

    expect(inForm().queryByRole('group', { name: 'Photo 2' })).toBeNull();
    expect(document.activeElement).toBe(inForm().getByRole('button', { name: 'Add a photo' }));
    fireEvent.click(submitButton());
    await outcome();
    expect(world.created[0].body.photo_file_ids).toEqual([FILES[0]]);
  });

  it('refuses to send while a photo failed, saying to retry or remove it', async () => {
    const world = newWorld();
    start(world);
    await openForm();
    fill();
    await addPhoto(1);
    FakeXHR.instances[0].fail();
    await inForm().findByRole('button', { name: 'Retry' });
    fireEvent.click(submitButton());

    expect(inForm().getByText('A photo didn’t upload. Retry it or remove it.')).toBeTruthy();
    expect(world.created).toHaveLength(0);
  });

  it('refuses a photo row with no file chosen', async () => {
    const world = newWorld();
    start(world);
    await openForm();
    fill();
    fireEvent.click(inForm().getByRole('button', { name: 'Add a photo' }));
    fireEvent.click(submitButton());

    expect(inForm().getByText('Choose a file for each photo, or remove the empty one.')).toBeTruthy();
    expect(world.created).toHaveLength(0);
  });

  it('Add a photo focuses the new photo’s button, and is disabled at five photos with the reason', async () => {
    start(newWorld());
    await openForm();
    for (let n = 1; n <= 5; n += 1) {
      fireEvent.click(inForm().getByRole('button', { name: 'Add a photo' }));
      await waitFor(() => expect(document.activeElement).toBe(inForm().getByRole('button', { name: `Choose photo ${n}` })));
    }
    expect(inForm().getByRole<HTMLButtonElement>('button', { name: 'Add a photo' }).disabled).toBe(true);
    expect(inForm().getByText('A request takes at most 5 photos.')).toBeTruthy();
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
    { name: 'invalid_file', answer: () => problem(422, 'invalid_file'), message: 'A photo can’t be attached. Remove it and add it again.' },
    { name: 'file_not_found', answer: () => problem(404, 'file_not_found'), message: 'A photo can’t be attached. Remove it and add it again.' },
    { name: '429', answer: () => problem(429, 'rate_limited', { 'Retry-After': '30' }), message: 'Too many requests. Try again in 30 seconds.' },
    { name: '500', answer: () => problem(500, 'internal_error'), message: 'Could not send your request. What you typed is kept; try again.' },
    { name: 'a network failure', answer: networkDown, message: 'Could not send your request. What you typed is kept; try again.' },
  ];

  it.each(cases)('$name: the message takes focus and the values and photos stay', async ({ answer, message }) => {
    start(newWorld(), { create: answer });
    await openForm();
    fill();
    await uploadPhoto(1);
    const button = submitButton();
    button.focus();
    fireEvent.click(button);

    const alert = await inForm().findByText(message);
    expect(alert.getAttribute('role')).toBe('alert');
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(category().value).toBe('plumbing');
    expect(description().value).toBe('The kitchen tap drips.');
    expect(within(inForm().getByRole('group', { name: 'Photo 1' })).getByText('Uploaded leak-1.jpg.')).toBeTruthy();
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

    const shown = await outcome();
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

    expect(within(await outcome()).getByTestId('emergency-notice').textContent).toBe(
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
