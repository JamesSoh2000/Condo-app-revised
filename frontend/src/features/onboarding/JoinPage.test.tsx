// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { components } from '@/api/schema';
import { readSelectedBuilding, writeSelectedBuilding } from '@/app/buildingStorage';
import {
  BIRCH,
  MAPLE,
  RESIDENT_ME,
  calls,
  json,
  membership,
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

const CODE = 'MAPLE-2026';
const LOOKUP = `GET /api/join/${CODE}`;
const UNITS = `GET /api/join/${CODE}/units`;
const REQUEST = `POST /api/join/${CODE}/requests`;
const SIGNUP = 'POST /api/auth/signup';
const ME = 'GET /api/auth/me';
const MY_STATUS = `GET /api/buildings/${MAPLE.id}/onboarding/me`;
const GOOD = 'correct horse battery';

const BUILDING: Schemas['JoinBuildingOut'] = { building_id: MAPLE.id, building_name: 'Maple Tower' };
const UNIT_LIST: Schemas['UnitOption'][] = ['1001', '1002', '1003', '1004'].map((label, i) => ({
  id: `01929a4e-0000-7000-8000-0000000c000${i}`,
  tower: null,
  label,
}));
const U1003 = UNIT_LIST[2];
const NEW_USER: Schemas['MeUserOut'] = {
  id: '01929a4e-0000-7000-8000-000000000042',
  email: 'new@example.test',
  full_name: 'Robin Park',
  phone: null,
  locale: 'en',
};
const PENDING_ME: Schemas['MeOut'] = { user: NEW_USER, memberships: [membership(MAPLE, { status: 'pending' })] };
const CREATED: Schemas['OnboardingRequestOut'] = {
  id: '01929a4e-0000-7000-8000-0000000d0001',
  building_id: MAPLE.id,
  status: 'pending',
  unit_id: U1003.id,
  unit_label: '1003',
  tower: null,
  relationship: 'tenant',
  submitted_at: '2026-10-21T12:00:00Z',
};
const MY_PENDING: Schemas['OnboardingMeOut'] = {
  status: 'pending',
  unit_label: '1003',
  tower: null,
  relationship: 'tenant',
  decision_reason: null,
};

const location = () => screen.getByTestId('location').textContent;
const heading = () => screen.getByRole('heading', { level: 1 });
/** The text of the elements an input's `aria-describedby` names. */
const description = (element: HTMLElement) =>
  (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');

/** Units whose label starts with `search`, as the server filters them. */
const units: Handler = (request) => {
  const search = new URL(request.url).searchParams.get('search') ?? '';
  return json(UNIT_LIST.filter((unit) => unit.label.startsWith(search)));
};

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

function searches(fetchMock: ReturnType<typeof stubApi>): string[] {
  return fetchMock.mock.calls
    .map(([r]) => new URL(r.url))
    .filter((url) => url.pathname === `/api/join/${CODE}/units`)
    .map((url) => url.searchParams.get('search') ?? '');
}

async function bodies(fetchMock: ReturnType<typeof stubApi>, key: string): Promise<unknown[]> {
  const requests = fetchMock.mock.calls.map(([r]) => r).filter((r) => `${r.method} ${new URL(r.url).pathname}` === key);
  return Promise.all(requests.map((r) => r.clone().json()));
}

function signUp({ name = 'Robin Park', email = 'new@example.test', password = GOOD, confirm = undefined as string | undefined } = {}) {
  fireEvent.change(screen.getByLabelText('Full name'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: confirm ?? password } });
  fireEvent.submit(screen.getByTestId('join-signup-form'));
}

const search = (value: string) => fireEvent.change(screen.getByLabelText('Unit number'), { target: { value } });
const pickUnit = async (label: string) => fireEvent.click(await screen.findByRole('radio', { name: label }));
const pickRelationship = (name: RegExp) => fireEvent.click(screen.getByRole('radio', { name }));
const sendRequest = () => fireEvent.submit(screen.getByTestId('join-request-form'));

/** Signed in as `me` (cached by the shell), on the join page. */
async function openSignedIn(routes: Record<string, Handler>, me: Schemas['MeOut'] = { ...RESIDENT_ME, memberships: [] }) {
  const fetchMock = stubApi({ [LOOKUP]: () => json(BUILDING), [UNITS]: units, ...routes });
  const app = renderApp([{ pathname: `/join/${CODE}`, state: { signedIn: true } }]);
  app.queryClient.setQueryData(['me'], me);
  await screen.findByTestId('join-request');
  return { fetchMock, app };
}

describe('join page: looking up the code (4)', () => {
  it('shows the invalid-link screen for a 404, with no sign-up form', async () => {
    const fetchMock = stubApi({ 'GET /api/join/NOPE': () => problem(404, 'join_code_invalid') });
    renderApp(['/join/NOPE']);
    await screen.findByTestId('join-invalid');
    expect(heading().textContent).toContain("This join link isn't valid");
    expect(screen.queryByTestId('join-signup-form')).toBeNull();
    expect(calls(fetchMock)).toEqual(['GET /api/join/NOPE']);
  });

  it.each(['/join', '/join/', '/join/a/b'])('shows the invalid-link screen on %s without a request', async (path) => {
    const fetchMock = stubApi({});
    renderApp([path]);
    await screen.findByTestId('join-invalid');
    expect(calls(fetchMock)).toEqual([]);
  });

  it('offers a retry after a 429, with the wait', async () => {
    let answer = () => problem(429, 'rate_limited', { 'Retry-After': '30' });
    stubApi({ [LOOKUP]: () => answer() });
    renderApp([`/join/${CODE}`]);
    await screen.findByTestId('join-load-error');
    expect(screen.getByText(/try again in 30 seconds/i)).toBeTruthy();
    answer = () => json(BUILDING);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await screen.findByTestId('join-account');
  });
});

describe('join page: a visitor not known to be signed in', () => {
  it('signs up, picks 1003 as a tenant and lands on the pending screen (1)', async () => {
    let me: Schemas['MeOut'] | null = null;
    const fetchMock = stubApi({
      [LOOKUP]: () => json(BUILDING),
      [SIGNUP]: () => {
        me = PENDING_ME;
        return json(NEW_USER, 201);
      },
      [UNITS]: units,
      [REQUEST]: () => json(CREATED, 201),
      [ME]: () => (me ? json(me) : problem(401, 'not_authenticated')),
      [MY_STATUS]: () => json(MY_PENDING),
    });
    renderApp([`/join/${CODE}`]);
    await screen.findByTestId('join-account');
    expect(heading().textContent).toContain('Join Maple Tower');
    // Nothing session-bound before the visitor is known to be signed in (D1).
    expect(calls(fetchMock)).toEqual([LOOKUP]);

    signUp();
    await screen.findByTestId('join-request');
    search('100');
    await pickUnit('1003');
    pickRelationship(/^tenant/i);
    sendRequest();

    await waitFor(() => expect(location()).toBe('/'));
    const pending = await screen.findByTestId('pending-request');
    await waitFor(() => expect(within(pending).getByTestId('pending-unit').textContent).toContain('1003'));
    expect(pending.textContent).toContain('Maple Tower');
    expect(pending.textContent).toContain('Tenant');
    expect(pending.textContent).toContain('The building manager will review your request');
    expect(await bodies(fetchMock, SIGNUP)).toEqual([{ full_name: 'Robin Park', email: 'new@example.test', password: GOOD }]);
    expect(await bodies(fetchMock, REQUEST)).toEqual([{ unit_id: U1003.id, relationship: 'tenant' }]);
  });

  it('links to the login page with next', async () => {
    stubApi({ [LOOKUP]: () => json(BUILDING) });
    renderApp([`/join/${CODE}`]);
    const link = await screen.findByTestId('join-login-link');
    expect(link.getAttribute('href')).toBe(`/login?next=${encodeURIComponent(`/join/${CODE}`)}`);
  });

  it('skips the sign-up form when the login page sends the visitor back signed in', async () => {
    stubApi({ [LOOKUP]: () => json(BUILDING), [UNITS]: units });
    renderApp([{ pathname: `/join/${CODE}`, state: { signedIn: true } }]);
    await screen.findByTestId('join-request');
    expect(screen.queryByTestId('join-signup-form')).toBeNull();
  });

  it('says an account has the email, with a login link carrying next (5)', async () => {
    stubApi({ [LOOKUP]: () => json(BUILDING), [SIGNUP]: () => problem(409, 'email_in_use') });
    renderApp([`/join/${CODE}`]);
    await screen.findByTestId('join-account');
    signUp();
    const alert = await screen.findByTestId('join-error');
    expect(alert.textContent).toContain('An account already uses this email.');
    expect(within(alert).getByRole('link', { name: /log in/i }).getAttribute('href')).toBe(
      `/login?next=${encodeURIComponent(`/join/${CODE}`)}`,
    );
  });

  it("places the server's 422 under its fields (5)", async () => {
    stubApi({
      [LOOKUP]: () => json(BUILDING),
      [SIGNUP]: () =>
        invalid([
          { loc: ['body', 'email'], msg: 'x', type: 'email_address' },
          { loc: ['body', 'password'], msg: 'x', type: 'password_too_common' },
        ]),
    });
    renderApp([`/join/${CODE}`]);
    await screen.findByTestId('join-account');
    signUp();
    expect(await screen.findByText('Enter one email address.')).toBeTruthy();
    expect(screen.getByText('This password is too common. Choose another.')).toBeTruthy();
  });

  it('shows the wait after a 429 (5)', async () => {
    stubApi({ [LOOKUP]: () => json(BUILDING), [SIGNUP]: () => problem(429, 'rate_limited', { 'Retry-After': '60' }) });
    renderApp([`/join/${CODE}`]);
    await screen.findByTestId('join-account');
    signUp();
    expect((await screen.findByTestId('join-error')).textContent).toContain('Try again in 60 seconds.');
  });

  it('checks the form before sending: email, matching passwords', async () => {
    const fetchMock = stubApi({ [LOOKUP]: () => json(BUILDING) });
    renderApp([`/join/${CODE}`]);
    await screen.findByTestId('join-account');
    signUp({ email: 'not-an-email', confirm: 'something else entirely' });
    expect(await screen.findByText('Enter one email address.')).toBeTruthy();
    expect(screen.getByText("The passwords don't match.")).toBeTruthy();
    expect(calls(fetchMock)).toEqual([LOOKUP]);
  });

  it('sends one sign-up for a double submit (6)', async () => {
    const gate = deferred(() => json(NEW_USER, 201));
    const fetchMock = stubApi({ [LOOKUP]: () => json(BUILDING), [SIGNUP]: gate.handler, [UNITS]: units });
    renderApp([`/join/${CODE}`]);
    await screen.findByTestId('join-account');
    signUp();
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: /create account/i }).disabled).toBe(true));
    fireEvent.submit(screen.getByTestId('join-signup-form'));
    gate.release();
    await screen.findByTestId('join-request');
    expect(calls(fetchMock).filter((c) => c === SIGNUP)).toHaveLength(1);
  });

  it("removes another user's cached data and the tab's choices (15)", async () => {
    stubApi({ [LOOKUP]: () => json(BUILDING), [SIGNUP]: () => json(NEW_USER, 201), [UNITS]: units });
    const app = renderApp([`/join/${CODE}`]);
    // Left by the previous user of the tab, whose session is gone (no /me cached).
    app.queryClient.setQueryData(['b', MAPLE.id, 'building'], { name: 'old' });
    writeSelectedBuilding(MAPLE.id);
    await screen.findByTestId('join-account');

    signUp();
    await screen.findByTestId('join-request');
    expect(app.queryClient.getQueryData(['b', MAPLE.id, 'building'])).toBeUndefined();
    expect(app.queryClient.getQueryData(['join', CODE])).toEqual(BUILDING);
    expect(readSelectedBuilding()).toBeNull();
  });
  it('a sign-up that lands after the user went back to the shell rebuilds it for the new user (15)', async () => {
    const gate = deferred(() => json(NEW_USER, 201));
    let created = false;
    stubApi({
      [LOOKUP]: () => json(BUILDING),
      [SIGNUP]: async (request) => {
        const answer = await gate.handler(request);
        created = true;
        return answer;
      },
      [ME]: () => json(created ? { user: NEW_USER, memberships: [] } : RESIDENT_ME),
    });
    const app = renderApp([`/join/${CODE}`]);
    await screen.findByTestId('join-account');
    signUp();
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: /create account/i }).disabled).toBe(true));
    act(() => app.navigate()('/'));
    await screen.findByRole('navigation', { name: 'Main' });
    expect(document.body.textContent).toContain(RESIDENT_ME.user.full_name);

    gate.release();
    await screen.findByRole('heading', { name: /not a member of a building yet/i });
    expect(document.body.textContent).not.toContain(RESIDENT_ME.user.full_name);
  });
});

describe('join page: signed in', () => {
  it('lists units for an empty search and says when nothing matches (11)', async () => {
    await openSignedIn({});
    for (const label of ['1001', '1002', '1003', '1004']) expect(await screen.findByRole('radio', { name: label })).toBeTruthy();
    search('99');
    expect(await screen.findByText('No unit starts with “99”.')).toBeTruthy();
  });

  it('requests only the last search, after the pause (12)', async () => {
    const { fetchMock } = await openSignedIn({});
    await screen.findByRole('radio', { name: '1001' });
    search('1');
    search('10');
    search('100');
    await screen.findByRole('radio', { name: '1003' });
    await waitFor(() => expect(searches(fetchMock)).toEqual(['', '100']));
  });

  it('says what is missing and sends nothing (10)', async () => {
    const { fetchMock } = await openSignedIn({});
    sendRequest();
    expect(await screen.findByText('Choose your unit.')).toBeTruthy();
    expect(screen.getByText('Choose how you relate to the unit.')).toBeTruthy();
    expect(calls(fetchMock)).not.toContain(REQUEST);
  });

  it('drops a unit picked from the previous results once the new ones leave it out', async () => {
    const { fetchMock } = await openSignedIn({});
    await screen.findByRole('radio', { name: '1001' });
    search('1003');
    // Still the empty search's list for 300 ms: 1001 can be clicked, then the new results don't have it.
    fireEvent.click(screen.getByRole('radio', { name: '1001' }));
    await waitFor(() => expect(screen.queryByRole('radio', { name: '1001' })).toBeNull());
    pickRelationship(/^owner/i);
    sendRequest();
    expect(await screen.findByText('Choose your unit.')).toBeTruthy();
    expect(calls(fetchMock)).not.toContain(REQUEST);
  });

  it('explains each relationship in plain words', async () => {
    await openSignedIn({});
    expect(description(screen.getByRole('radio', { name: /^owner/i }))).toMatch(/you own this unit/i);
    expect(description(screen.getByRole('radio', { name: /^tenant/i }))).toMatch(/you rent this unit/i);
    expect(description(screen.getByRole('radio', { name: /^household member/i }))).toMatch(/you live in this unit with/i);
  });

  it('sends one request for a double submit (6)', async () => {
    const gate = deferred(() => json(CREATED, 201));
    const { fetchMock } = await openSignedIn({ [REQUEST]: gate.handler, [ME]: () => json(PENDING_ME), [MY_STATUS]: () => json(MY_PENDING) });
    await pickUnit('1003');
    pickRelationship(/^tenant/i);
    sendRequest();
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: /send request/i }).disabled).toBe(true));
    sendRequest();
    gate.release();
    await waitFor(() => expect(location()).toBe('/'));
    expect(calls(fetchMock).filter((c) => c === REQUEST)).toHaveLength(1);
  });

  it('shows "Request sent" when the user has an active building elsewhere (13)', async () => {
    const birch = { ...RESIDENT_ME, memberships: [membership(BIRCH)] };
    await openSignedIn({ [REQUEST]: () => json(CREATED, 201), [ME]: () => json(birch) }, birch);
    await pickUnit('1003');
    pickRelationship(/^tenant/i);
    sendRequest();
    const sent = await screen.findByTestId('join-sent');
    expect(location()).toBe(`/join/${CODE}`);
    expect(sent.textContent).toContain('1003');
    expect(sent.textContent).toContain('Tenant');
    expect(within(sent).getByRole('link', { name: /go to the app/i }).getAttribute('href')).toBe('/');
  });

  it('treats the 200 for an existing pending request like a new one', async () => {
    await openSignedIn({ [REQUEST]: () => json(CREATED, 200), [ME]: () => json(PENDING_ME), [MY_STATUS]: () => json(MY_PENDING) });
    await pickUnit('1003');
    pickRelationship(/^tenant/i);
    sendRequest();
    await screen.findByTestId('pending-request');
  });

  it.each([
    ['already_member', 409, 'join-member', /already a member of Maple Tower/i],
    ['membership_not_eligible', 409, 'join-not-eligible', /suspended or has ended/i],
    ['join_code_invalid', 404, 'join-invalid', /isn't valid/i],
  ] as const)('maps %s to its screen (9)', async (code, status, testId, text) => {
    await openSignedIn({ [REQUEST]: () => problem(status, code) });
    await pickUnit('1003');
    pickRelationship(/^owner/i);
    sendRequest();
    expect((await screen.findByTestId(testId)).textContent).toMatch(text);
  });

  it('says a unit is gone and refreshes the list (9)', async () => {
    let gone = false;
    const { fetchMock } = await openSignedIn({
      [REQUEST]: () => {
        gone = true;
        return problem(404, 'unit_not_found');
      },
      [UNITS]: (request) => (gone ? json(UNIT_LIST.filter((u) => u.label !== '1003')) : units(request)),
    });
    await pickUnit('1003');
    pickRelationship(/^owner/i);
    sendRequest();
    expect(await screen.findByText('That unit is no longer available. Choose another.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('radio', { name: '1003' })).toBeNull());
    expect(searches(fetchMock)).toEqual(['', '']);
  });

  it('sends a lost session to the login page and back here (14)', async () => {
    stubApi({ [LOOKUP]: () => json(BUILDING), [UNITS]: () => problem(401, 'not_authenticated'), [ME]: () => problem(401, 'x') });
    renderApp([{ pathname: `/join/${CODE}`, state: { signedIn: true } }]);
    await waitFor(() => expect(location()).toBe(`/login?next=${encodeURIComponent(`/join/${CODE}`)}`));
  });

  it('keys the screen per history entry: an answer for the entry left behind changes nothing (16)', async () => {
    const gate = deferred(() => json(CREATED, 201));
    const { app, fetchMock } = await openSignedIn({ [REQUEST]: gate.handler, 'GET /api/join/BIRCH-0001': () => json({ building_id: BIRCH.id, building_name: 'Birch Court' }) });
    await pickUnit('1003');
    pickRelationship(/^tenant/i);
    sendRequest();
    await waitFor(() => expect(calls(fetchMock)).toContain(REQUEST));

    act(() => app.navigate()('/join/BIRCH-0001', { state: { signedIn: true } }));
    await waitFor(() => expect(heading().textContent).toContain('Join Birch Court'));
    gate.release();
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(location()).toBe('/join/BIRCH-0001');
    expect(screen.queryByTestId('join-sent')).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /send request/i }).disabled).toBe(false);
  });
});
