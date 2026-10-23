// @vitest-environment jsdom
/**
 * P5-03c: the package desk's "Log package" panel: the form, its checks, the `Idempotency-Key` lifecycle, the
 * server's refusals and the building switch. Each `describe` names the criteria it proves
 * (docs/tickets/P5-03c-log-package-panel.md). `fetch` and `XMLHttpRequest` are stubbed; the keyboard run and the
 * widths are in the PR's stack transcript.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { components } from '@/api/schema';
import {
  BIRCH,
  MAPLE,
  RESIDENT_ME,
  buildingOut,
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

type Package = components['schemas']['PackageOut'];
type Unit = components['schemas']['UnitOut'];
type Occupant = components['schemas']['OccupantOut'];

const PAGE = '/security/packages';
const base = (building = MAPLE) => `/api/buildings/${building.id}`;
const LIST = `GET ${base()}/packages`;
const CREATE = `POST ${base()}/packages`;
const FILE_A = '01929a4e-0000-7000-8000-0000000f0001';
const FILE_B = '01929a4e-0000-7000-8000-0000000f0002';

function unit(n: number, label: string, tower: string | null = null): Unit {
  return { id: `01929a4e-0000-7000-8000-0000000c000${n}`, tower, label, floor: 1, is_active: true, current_occupant_count: 1 };
}
const U101 = unit(1, '101', 'A');
const U102 = unit(2, '102');
const ROBIN: Occupant = { membership_id: '01929a4e-0000-7000-8000-0000000d0001', full_name: 'Robin Park', relationship: 'owner' };
const SAM: Occupant = { membership_id: '01929a4e-0000-7000-8000-0000000d0002', full_name: 'Sam Lee', relationship: 'tenant' };
const occupants = (u: Unit) => `GET ${base()}/units/${u.id}/occupants`;

function created(fields: Partial<Package> = {}): Package {
  return {
    id: '01929a4e-0000-7000-8000-0000000e0001',
    unit_id: U101.id,
    recipient_membership_id: null,
    carrier: 'UPS',
    description: null,
    tracking_last4: null,
    photo_file_id: null,
    status: 'received',
    received_at: new Date().toISOString(),
    received_by_membership_id: '01929a4e-0000-7000-8000-0000000d0009',
    picked_up_at: null,
    returned_at: null,
    unit_tower: 'A',
    unit_label: '101',
    recipient_name: null,
    ...fields,
  };
}

/** A test double for the browser's XHR (the S3 form POST): the test answers it. */
class FakeXHR {
  static instances: FakeXHR[] = [];
  status = 0;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open() {}
  send() {
    FakeXHR.instances.push(this);
  }
  abort() {
    this.onabort?.();
  }
  respond(status: number) {
    this.status = status;
    act(() => this.onload?.());
  }
  fail() {
    act(() => this.onerror?.());
  }
}

function uploads(building = MAPLE): Record<string, Handler> {
  const ids = [FILE_A, FILE_B];
  const fileOut = (id: string) =>
    json({ id, purpose: 'package_photo', status: 'ready', content_type: 'image/jpeg', size_bytes: 2048, original_name: 'parcel.jpg', created_at: '2026-10-23T12:00:00Z' });
  return {
    [`POST ${base(building)}/files`]: () => {
      const id = ids.shift()!;
      return json(
        {
          file_id: id,
          upload: { url: 'http://localhost:4566/files', fields: { key: `k/${id}`, policy: 'p', 'Content-Type': 'image/jpeg' } },
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        },
        201,
      );
    },
    [`POST ${base(building)}/files/${FILE_A}/complete`]: () => fileOut(FILE_A),
    [`POST ${base(building)}/files/${FILE_B}/complete`]: () => fileOut(FILE_B),
  };
}

/** The bodies and keys of every create request, in order. */
interface Sent {
  key: string | null;
  body: Record<string, unknown>;
}

function desk(createHandler: Handler = () => json(created(), 201), routes: Record<string, Handler> = {}) {
  const sent: Sent[] = [];
  const fetchMock = stubApi({
    'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles: ['security'] })] }),
    [`GET ${base()}`]: () => json(buildingOut(MAPLE, ['security'])),
    [LIST]: () => json({ items: [], next_cursor: null }),
    [`GET ${base()}/units`]: () => json({ items: [U101, U102], next_cursor: null }),
    [occupants(U101)]: () => json([ROBIN, SAM]),
    [occupants(U102)]: () => json([]),
    [CREATE]: async (request) => {
      sent.push({ key: request.headers.get('idempotency-key'), body: (await request.clone().json()) as Record<string, unknown> });
      return createHandler(request);
    },
    ...uploads(),
    ...routes,
  });
  return { fetchMock, sent };
}

/** Answers each call with the next handler; the last one repeats. */
function inTurn(...handlers: Handler[]): Handler {
  let call = 0;
  return (request) => handlers[Math.min(call++, handlers.length - 1)](request);
}

const networkDown: Handler = () => Promise.reject(new TypeError('Failed to fetch'));
const count = (fetchMock: ReturnType<typeof stubApi>, key: string) =>
  fetchMock.mock.calls.filter(([request]) => `${request.method} ${new URL(request.url).pathname}` === key).length;

const form = () => screen.getByRole('form', { name: 'Log package' });
const inForm = () => within(form());
const submit = () => fireEvent.click(inForm().getByRole('button', { name: 'Log package' }));
const status = () => inForm().getByTestId('log-status').textContent;

async function open() {
  renderApp([PAGE]);
  await screen.findByRole('form', { name: 'Log package' });
}

async function chooseUnit(name: RegExp = /^A-101$/) {
  fireEvent.click(await inForm().findByRole('radio', { name }));
}

function chooseCarrier(name: string) {
  fireEvent.click(inForm().getByRole('radio', { name }));
}

/** Unit A-101 and UPS: the least a package needs. */
async function fillMinimum() {
  await chooseUnit();
  chooseCarrier('UPS');
}

function choosePhoto() {
  const input = form().querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File(['x'], 'parcel.jpg', { type: 'image/jpeg' });
  fireEvent.change(input, { target: { files: [file] } });
}

async function uploadPhoto() {
  choosePhoto();
  await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
  FakeXHR.instances[0].respond(204);
  await inForm().findByText('Uploaded parcel.jpg.');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

describe('logging a package (criterion 1)', () => {
  it('sends every field with the photo, then says "Logged ✓", clears the form, focuses the unit and refetches Waiting', async () => {
    const { fetchMock, sent } = desk();
    await open();
    await waitFor(() => expect(count(fetchMock, LIST)).toBe(1));

    await chooseUnit();
    fireEvent.change(await inForm().findByRole('combobox', { name: 'Recipient' }), { target: { value: ROBIN.membership_id } });
    chooseCarrier('UPS');
    fireEvent.change(inForm().getByLabelText('Description (optional)'), { target: { value: 'Small box' } });
    fireEvent.change(inForm().getByLabelText('Last 4 of tracking (optional)'), { target: { value: 'ab12' } });
    await uploadPhoto();
    submit();

    await waitFor(() => expect(status()).toBe('Logged ✓'));
    expect(sent).toHaveLength(1);
    expect(sent[0].key).toMatch(UUID);
    expect(sent[0].body).toEqual({
      unit_id: U101.id,
      recipient_membership_id: ROBIN.membership_id,
      carrier: 'UPS',
      description: 'Small box',
      tracking_last4: 'ab12',
      photo_file_id: FILE_A,
    });

    const search = inForm().getByLabelText<HTMLInputElement>('Unit');
    expect(search.value).toBe('');
    expect(document.activeElement).toBe(search);
    expect(inForm().queryAllByRole('radio', { checked: true })).toHaveLength(0);
    expect(inForm().getByLabelText<HTMLInputElement>('Description (optional)').value).toBe('');
    expect(inForm().getByLabelText<HTMLInputElement>('Last 4 of tracking (optional)').value).toBe('');
    expect(inForm().queryByText('Uploaded parcel.jpg.')).toBeNull();
    expect(inForm().queryByRole('img')).toBeNull();
    await waitFor(() => expect(count(fetchMock, LIST)).toBe(2));
  });

  it('sends "Anyone in the unit" as no recipient, and the minimum fields as nulls', async () => {
    const { sent } = desk();
    await open();
    await fillMinimum();

    expect(inForm().getByRole<HTMLSelectElement>('combobox', { name: 'Recipient' }).value).toBe('');
    submit();

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toEqual({
      unit_id: U101.id,
      recipient_membership_id: null,
      carrier: 'UPS',
      description: null,
      tracking_last4: null,
      photo_file_id: null,
    });
  });

  it('sends the typed carrier when "Other" is chosen, trimmed', async () => {
    const { sent } = desk();
    await open();
    await chooseUnit();
    chooseCarrier('Other');
    fireEvent.change(inForm().getByLabelText('Other carrier'), { target: { value: '  Intelcom ' } });
    submit();

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body.carrier).toBe('Intelcom');
  });

  it('lists the chosen unit’s occupants and goes back to "Anyone in the unit" when the unit changes', async () => {
    const { sent } = desk();
    await open();
    const recipient = () => inForm().getByRole<HTMLSelectElement>('combobox', { name: 'Recipient' });
    expect(recipient().disabled).toBe(true);

    await chooseUnit();
    await inForm().findByRole('option', { name: 'Sam Lee' });
    fireEvent.change(recipient(), { target: { value: SAM.membership_id } });
    await chooseUnit(/^102$/);

    await waitFor(() => expect(inForm().queryByRole('option', { name: 'Sam Lee' })).toBeNull());
    expect(recipient().value).toBe('');
    chooseCarrier('UPS');
    submit();
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toMatchObject({ unit_id: U102.id, recipient_membership_id: null });
  });
});

describe('the Idempotency-Key (criteria 2 and 5)', () => {
  it('sends the same key when a network failure is retried, then a new key for the next package', async () => {
    const { sent } = desk(inTurn(networkDown, () => json(created(), 201)));
    await open();
    await fillMinimum();

    submit();
    expect(await inForm().findByText(/could not log the package/i)).toBeTruthy();
    // A failed attempt keeps every field.
    expect(inForm().getByRole<HTMLInputElement>('radio', { name: 'UPS' }).checked).toBe(true);
    submit();
    await waitFor(() => expect(status()).toBe('Logged ✓'));

    await fillMinimum();
    submit();
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[1].key).toBe(sent[0].key);
    expect(sent[2].key).not.toBe(sent[0].key);
    expect(sent[2].key).toMatch(UUID);
  });

  it('counts a replayed 201 as logged', async () => {
    desk(() => json(created(), 201, { 'Idempotent-Replayed': 'true' }));
    await open();
    await fillMinimum();
    submit();

    await waitFor(() => expect(status()).toBe('Logged ✓'));
  });

  it('keeps the key when the form is edited between a failure and its retry', async () => {
    const { sent } = desk(inTurn(() => problem(503, 'service_unavailable'), () => json(created(), 201)));
    await open();
    await fillMinimum();
    submit();
    await inForm().findByText(/could not log the package/i);

    fireEvent.change(inForm().getByLabelText('Description (optional)'), { target: { value: 'Envelope' } });
    submit();

    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1].key).toBe(sent[0].key);
    expect(sent[1].body.description).toBe('Envelope');
  });

  it('starts a new form with a new key when the server says the key was used for other details', async () => {
    const { fetchMock, sent } = desk(inTurn(networkDown, () => problem(409, 'idempotency_key_reused'), () => json(created(), 201)));
    await open();
    await fillMinimum();
    submit();
    await inForm().findByText(/could not log the package/i);
    fireEvent.change(inForm().getByLabelText('Description (optional)'), { target: { value: 'Envelope' } });
    const listsBefore = count(fetchMock, LIST);
    submit();

    expect(await inForm().findByText(/your earlier attempt was logged/i)).toBeTruthy();
    await waitFor(() => expect(count(fetchMock, LIST)).toBeGreaterThan(listsBefore));
    expect(inForm().getByLabelText<HTMLInputElement>('Description (optional)').value).toBe('');
    expect(inForm().queryAllByRole('radio', { checked: true })).toHaveLength(0);

    await fillMinimum();
    submit();
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[1].key).toBe(sent[0].key);
    expect(sent[2].key).not.toBe(sent[0].key);
  });
});

describe('the form’s checks (criterion 4)', () => {
  it('sends nothing without a unit and a carrier, and says what is missing', async () => {
    const { sent } = desk();
    await open();
    submit();

    expect(inForm().getByText('Choose a unit.')).toBeTruthy();
    expect(inForm().getByText('Choose a carrier.')).toBeTruthy();
    expect(sent).toHaveLength(0);
  });

  it('sends nothing while "Other" is blank or the tracking is not 4 letters or digits', async () => {
    const { sent } = desk();
    await open();
    await chooseUnit();
    chooseCarrier('Other');
    fireEvent.change(inForm().getByLabelText('Other carrier'), { target: { value: '   ' } });
    fireEvent.change(inForm().getByLabelText('Last 4 of tracking (optional)'), { target: { value: '12-4' } });
    submit();

    expect(inForm().getByText('Type the carrier.')).toBeTruthy();
    expect(inForm().getByText('Use the last 4 letters or digits.')).toBeTruthy();
    expect(sent).toHaveLength(0);
  });

  it('sends nothing with a control character in the carrier or description', async () => {
    const { sent } = desk();
    await open();
    await chooseUnit();
    chooseCarrier('Other');
    fireEvent.change(inForm().getByLabelText('Other carrier'), { target: { value: 'Intel\tcom' } });
    fireEvent.change(inForm().getByLabelText('Description (optional)'), { target: { value: 'Box\u0007' } });
    submit();

    expect(inForm().getAllByText('Use visible characters only.')).toHaveLength(2);
    expect(sent).toHaveLength(0);
  });

  it('sends nothing while the photo is uploading, nor after it failed, until it is removed', async () => {
    const { sent } = desk();
    await open();
    await fillMinimum();
    choosePhoto();
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));

    submit();
    expect(inForm().getByText('Wait for the photo to finish uploading.')).toBeTruthy();
    FakeXHR.instances[0].fail();
    submit();
    expect(await inForm().findByText('The photo didn’t upload. Retry it or remove it.')).toBeTruthy();
    expect(sent).toHaveLength(0);

    fireEvent.click(inForm().getByRole('button', { name: 'Remove photo' }));
    submit();
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body.photo_file_id).toBeNull();
  });

  it('never sends a finished photo once another upload has started', async () => {
    const { sent } = desk();
    await open();
    await fillMinimum();
    await uploadPhoto();
    choosePhoto();
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(2));
    FakeXHR.instances[1].fail();
    await inForm().findByRole('button', { name: 'Retry' });

    submit();
    expect(sent).toHaveLength(0);
    fireEvent.click(inForm().getByRole('button', { name: 'Remove photo' }));
    submit();
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body.photo_file_id).toBeNull();
  });

  it('sends one request for a double click', async () => {
    let answer = () => {};
    const { sent } = desk(() => new Promise<Response>((resolve) => (answer = () => resolve(json(created(), 201)))));
    await open();
    await fillMinimum();
    submit();
    submit();
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(inForm().getByRole<HTMLButtonElement>('button', { name: 'Log package' }).disabled).toBe(true);

    answer();
    await waitFor(() => expect(status()).toBe('Logged ✓'));
    expect(sent).toHaveLength(1);
  });
});

describe('the server’s refusals (criterion 6)', () => {
  it.each([
    [404, 'unit_not_found'],
    [409, 'unit_inactive'],
  ])('a %i %s asks for another unit from a fresh list, keeping the rest and the key', async (code, name) => {
    const { fetchMock, sent } = desk(inTurn(() => problem(code, name), () => json(created({ unit_id: U102.id }), 201)));
    await open();
    await fillMinimum();
    fireEvent.change(inForm().getByLabelText('Description (optional)'), { target: { value: 'Box' } });
    const unitsBefore = count(fetchMock, `GET ${base()}/units`);
    submit();

    expect(await inForm().findByText('That unit is no longer available. Choose another.')).toBeTruthy();
    await waitFor(() => expect(count(fetchMock, `GET ${base()}/units`)).toBeGreaterThan(unitsBefore));
    expect(inForm().getByLabelText<HTMLInputElement>('Description (optional)').value).toBe('Box');
    await chooseUnit(/^102$/);
    submit();
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1].key).toBe(sent[0].key);
    expect(sent[1].body).toMatchObject({ unit_id: U102.id, description: 'Box' });
  });

  it('a 422 invalid_recipient asks for another recipient from a fresh list, keeping the key', async () => {
    const { fetchMock, sent } = desk(inTurn(() => problem(422, 'invalid_recipient'), () => json(created(), 201)));
    await open();
    await chooseUnit();
    fireEvent.change(await inForm().findByRole('combobox', { name: 'Recipient' }), { target: { value: SAM.membership_id } });
    await inForm().findByRole('option', { name: 'Sam Lee' });
    chooseCarrier('UPS');
    const before = count(fetchMock, occupants(U101));
    submit();

    expect(await inForm().findByText('That person no longer lives in this unit. Choose again.')).toBeTruthy();
    await waitFor(() => expect(count(fetchMock, occupants(U101))).toBeGreaterThan(before));
    expect(inForm().getByRole<HTMLSelectElement>('combobox', { name: 'Recipient' }).value).toBe('');
    submit();
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1].key).toBe(sent[0].key);
    expect(sent[1].body.recipient_membership_id).toBeNull();
  });

  it.each([
    [404, 'file_not_found'],
    [422, 'invalid_file'],
    [409, 'upload_incomplete'],
  ])('a %i %s clears the photo for a new upload, keeping the key', async (code, name) => {
    const { sent } = desk(inTurn(() => problem(code, name), () => json(created(), 201)));
    await open();
    await fillMinimum();
    await uploadPhoto();
    submit();

    expect(await inForm().findByText('The photo can’t be attached. Upload it again.')).toBeTruthy();
    expect(inForm().queryByText('Uploaded parcel.jpg.')).toBeNull();
    expect(inForm().getByRole<HTMLInputElement>('radio', { name: 'UPS' }).checked).toBe(true);
    submit();
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1].key).toBe(sent[0].key);
    expect(sent[1].body.photo_file_id).toBeNull();
  });

  it('a 429 says how long to wait', async () => {
    desk(() => problem(429, 'rate_limited', { 'Retry-After': '30' }));
    await open();
    await fillMinimum();
    submit();

    expect(await inForm().findByText(/too many requests\. try again in 30 seconds/i)).toBeTruthy();
  });
});

describe('keyboard and layout (criteria 1 and 3)', () => {
  it('orders the controls unit, recipient, carrier, description, tracking, photo, submit', async () => {
    desk();
    await open();
    await chooseUnit();
    chooseCarrier('Other');
    await inForm().findByRole('option', { name: 'Robin Park' });

    const order = Array.from(form().querySelectorAll<HTMLElement>('input:not([type="file"]), select, button'))
      .map((element) => element.getAttribute('aria-label') ?? element.labels?.[0]?.textContent ?? element.textContent)
      .filter((name) => name !== 'A-101' && name !== '102' && !['Amazon', 'Canada Post', 'DHL', 'FedEx', 'Purolator', 'UPS'].includes(name ?? ''));
    expect(order).toEqual(['Unit', 'Recipient', 'Other', 'Other carrier', 'Description (optional)', 'Last 4 of tracking (optional)', 'Choose photo', 'Log package']);
  });
});

describe('another building (criterion 7)', () => {
  it('carries nothing of a half-filled form into the other building', async () => {
    sessionStorage.setItem('condo.buildingId', MAPLE.id);
    const birch: Sent[] = [];
    const { sent } = desk(undefined, {
      'GET /api/auth/me': () =>
        json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles: ['security'] }), membership(BIRCH, { roles: ['security'] })] }),
      [`GET ${base(BIRCH)}`]: () => json(buildingOut(BIRCH, ['security'])),
      [`GET ${base(BIRCH)}/notifications/summary`]: () => json({ unread_count: 0 }),
      [`GET ${base(BIRCH)}/packages`]: () => json({ items: [], next_cursor: null }),
      [`GET ${base(BIRCH)}/units`]: () => json({ items: [unit(9, '900')], next_cursor: null }),
      [`POST ${base(BIRCH)}/packages`]: async (request) => {
        birch.push({ key: request.headers.get('idempotency-key'), body: (await request.clone().json()) as Record<string, unknown> });
        return json(created(), 201);
      },
    });
    const app = renderApp([PAGE]);
    await screen.findByRole('form', { name: 'Log package' });
    await chooseUnit();
    chooseCarrier('UPS');
    fireEvent.change(inForm().getByLabelText('Description (optional)'), { target: { value: 'Maple box' } });
    submit();
    await waitFor(() => expect(status()).toBe('Logged ✓'));
    await chooseUnit();
    chooseCarrier('DHL');
    fireEvent.change(inForm().getByLabelText('Description (optional)'), { target: { value: 'Half filled' } });

    openAccountMenu();
    fireEvent.change(screen.getByLabelText('Building'), { target: { value: BIRCH.id } });
    await waitFor(() => expect(app.location().pathname).toBe('/'));
    act(() => app.navigate()(PAGE));
    await screen.findByRole('form', { name: 'Log package' });

    expect(inForm().getByLabelText<HTMLInputElement>('Description (optional)').value).toBe('');
    expect(inForm().queryAllByRole('radio', { checked: true })).toHaveLength(0);
    await chooseUnit(/^900$/);
    chooseCarrier('UPS');
    submit();
    await waitFor(() => expect(birch).toHaveLength(1));
    expect(birch[0].key).toMatch(UUID);
    expect(birch[0].key).not.toBe(sent[0].key);
  });
});
