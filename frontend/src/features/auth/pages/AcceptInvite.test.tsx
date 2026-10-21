// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { components } from '@/api/schema';
import { readSelectedBuilding, writeSelectedBuilding } from '@/app/buildingStorage';
import {
  BIRCH,
  MAPLE,
  RESIDENT_ME,
  buildingOut,
  calls,
  json,
  membership,
  noContent,
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

const TOKEN = 'k3Jx_9q-0123456789abcdefghijklmnopqrstuvwxy';
const OTHER = 'Zz9_-0123456789abcdefghijklmnopqrstuvwxyzAB';
const GET = `GET /api/invitations/${TOKEN}`;
const ACCEPT = `POST /api/invitations/${TOKEN}/accept`;
const LOGIN = 'POST /api/auth/login';
const LOGOUT = 'POST /api/auth/logout';
const ME = 'GET /api/auth/me';
const GOOD = 'correct horse battery';

type Public = components['schemas']['InvitationPublicOut'];
const PUBLIC: Public = { building_name: 'Maple Tower', email_masked: 'n***@example.test', roles: ['security'] };
const ACCEPTED = { building_id: MAPLE.id, membership_id: '01929a4e-0000-7000-8000-00000000a0ff', roles: ['security'] };
/** The new security guard's `/me` once the accept has logged them in. */
const GUARD_ME: components['schemas']['MeOut'] = {
  user: { ...RESIDENT_ME.user, id: '01929a4e-0000-7000-8000-000000000009', email: 'new@example.test' },
  memberships: [membership(MAPLE, { roles: ['security'] })],
};

const location = () => screen.getByTestId('location').textContent;
const heading = () => screen.getByRole('heading', { level: 1 });

/** A 422 `validation_error` with `errors[]`, as `app/core/errors.py` sends it. */
function invalid(errors: { loc: (string | number)[]; msg: string; type: string }[]): Response {
  return json(
    { type: 'about:blank', title: 'Validation error', status: 422, code: 'validation_error', request_id: 'req', errors },
    422,
  );
}

/** The accept's answer to `{}` for an email with no account: both fields missing. */
const needsAccount = () =>
  invalid([
    { loc: ['body', 'full_name'], msg: 'Field required', type: 'missing' },
    { loc: ['body', 'password'], msg: 'Field required', type: 'missing' },
  ]);

/** A response that answers only when `release` is called. */
function deferred(response: () => Response): { handler: Handler; release: () => void } {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { handler: () => gate.then(response), release };
}

async function bodies(fetchMock: ReturnType<typeof stubApi>, key: string): Promise<unknown[]> {
  const requests = fetchMock.mock.calls.map(([r]) => r).filter((r) => `${r.method} ${new URL(r.url).pathname}` === key);
  return Promise.all(requests.map((r) => r.clone().json()));
}

function click(button: HTMLElement) {
  button.focus();
  fireEvent.click(button);
}

const acceptButton = () => screen.getByRole('button', { name: /accept invitation/i });

/** The new-account form, filled and submitted. */
function createAccount(name: string, password = GOOD, confirm = password) {
  fireEvent.change(screen.getByLabelText<HTMLInputElement>('Full name'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText<HTMLInputElement>('Password'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText<HTMLInputElement>('Confirm password'), { target: { value: confirm } });
  click(screen.getByRole('button', { name: /create account and accept/i }));
}

/** Lets pending effects and requests settle. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));

describe('details (criterion 1)', () => {
  it('shows the building, masked email and roles as words, without asking /me', async () => {
    const fetchMock = stubApi({ [GET]: () => json({ ...PUBLIC, roles: ['council', 'property_management', 'resident'] }) });
    renderApp([`/invite/${TOKEN}`]);

    expect(screen.getByTestId('invite-loading').getAttribute('role')).toBe('status');
    const details = await screen.findByTestId('invite-details');
    expect(within(details).getByTestId('invite-building').textContent).toBe('Maple Tower');
    expect(within(details).getByTestId('invite-email').textContent).toBe('n***@example.test');
    expect(within(details).getByTestId('invite-roles').textContent).toBe('Council, Property management, Resident');
    expect(document.body.textContent).not.toMatch(/property_management/);
    expect(acceptButton()).toBeTruthy();
    await settle();
    expect(calls(fetchMock)).toEqual([GET]);
  });
});

describe('new email (criterion 2)', () => {
  /** The server as it answers a new email: `{}` is 422 missing, the full body logs in. */
  function newEmailBackend(extra: Record<string, Handler> = {}) {
    let signedIn = false;
    return stubApi({
      [GET]: () => json(PUBLIC),
      [ACCEPT]: async (request) => {
        const body = (await request.clone().json()) as Record<string, unknown>;
        if (!('full_name' in body)) return needsAccount();
        signedIn = true;
        return json(ACCEPTED);
      },
      [ME]: () => (signedIn ? json(GUARD_ME) : problem(401, 'unauthorized')),
      [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, ['security'])),
      ...extra,
    });
  }

  it('asks for an account, creates it, and lands in the shell with the role navigation', async () => {
    const fetchMock = newEmailBackend();
    writeSelectedBuilding(BIRCH.id);
    const app = renderApp(['/forgot-password', `/invite/${TOKEN}`]);
    app.queryClient.setQueryData(['stale'], 'from before');

    click(await screen.findByRole('button', { name: /accept invitation/i }));

    expect(await screen.findByTestId('invite-form')).toBeTruthy();
    expect(document.activeElement).toBe(heading());
    createAccount('  Nadia Okafor ');

    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Package log' })).toBeTruthy();
    expect(within(nav).queryByRole('link', { name: 'My packages' })).toBeNull();
    expect(location()).toBe('/');
    expect(await bodies(fetchMock, ACCEPT)).toEqual([{}, { full_name: 'Nadia Okafor', password: GOOD }]);
    expect(app.queryClient.getQueryData(['stale'])).toBeUndefined();
    expect(readSelectedBuilding()).toBe(MAPLE.id);
    // The invite's entry was replaced: Back skips it.
    act(() => app.navigate()(-1));
    await waitFor(() => expect(location()).toBe('/forgot-password'));
  });

  it('sends a password with spaces as typed', async () => {
    const fetchMock = newEmailBackend();
    renderApp([`/invite/${TOKEN}`]);
    click(await screen.findByRole('button', { name: /accept invitation/i }));
    await screen.findByTestId('invite-form');

    createAccount('Nadia', `  ${GOOD}  `);

    await waitFor(() => expect(location()).toBe('/'));
    expect((await bodies(fetchMock, ACCEPT))[1]).toEqual({ full_name: 'Nadia', password: `  ${GOOD}  ` });
  });

  it('opens the form only for missing fields: any other 422 to {} is a generic error', async () => {
    stubApi({ [GET]: () => json(PUBLIC), [ACCEPT]: () => invalid([{ loc: ['body'], msg: 'x', type: 'model_type' }]) });
    renderApp([`/invite/${TOKEN}`]);

    click(await screen.findByRole('button', { name: /accept invitation/i }));

    const alert = await screen.findByTestId('invite-error');
    expect(alert.textContent).toBe('Could not accept the invitation. Try again.');
    expect(screen.queryByTestId('invite-form')).toBeNull();
  });
});

describe('existing account, logged out (criterion 3)', () => {
  /** An existing account: the accept needs a session, which the login gives. */
  function existingBackend(meBefore: 'none' | 'signed-in' = 'none') {
    let signedIn = meBefore === 'signed-in';
    return stubApi({
      [GET]: () => json(PUBLIC),
      [ACCEPT]: () => (signedIn ? json(ACCEPTED) : problem(409, 'login_required')),
      [LOGIN]: () => {
        signedIn = true;
        return noContent();
      },
      [ME]: () => (signedIn ? json(GUARD_ME) : problem(401, 'unauthorized')),
      [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, ['security'])),
    });
  }

  it('goes through login and accepts once on return', async () => {
    const fetchMock = existingBackend();
    renderApp([`/invite/${TOKEN}`]);

    click(await screen.findByRole('button', { name: /accept invitation/i }));
    const link = await screen.findByTestId('invite-login-link');
    expect(screen.getByTestId('invite-login').textContent).toContain('n***@example.test');
    expect(document.activeElement).toBe(heading());
    expect(heading().textContent).toBe('Log in to accept');
    expect(link.getAttribute('href')).toBe(`/login?next=%2Finvite%2F${TOKEN}`);

    fireEvent.click(link);
    await waitFor(() => expect(location()).toBe(`/login?next=%2Finvite%2F${TOKEN}`));
    fireEvent.change(screen.getByLabelText<HTMLInputElement>('Email'), { target: { value: 'guard@example.test' } });
    fireEvent.change(screen.getByLabelText<HTMLInputElement>('Password'), { target: { value: 'DevPassword!2026' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Package log' })).toBeTruthy();
    expect(location()).toBe('/');
    expect(calls(fetchMock).filter((c) => c === ACCEPT)).toHaveLength(2);
  });

  it('accepts by itself when the login page found a session already', async () => {
    const fetchMock = existingBackend('signed-in');
    renderApp([`/login?next=%2Finvite%2F${TOKEN}`]);

    await waitFor(() => expect(location()).toBe('/'));
    expect(calls(fetchMock).filter((c) => c === ACCEPT)).toHaveLength(1);
  });

  it('drops the state after the automatic accept fails, so a reload does not accept again', async () => {
    const fetchMock = stubApi({ [GET]: () => json(PUBLIC), [ACCEPT]: () => problem(500, 'internal_error') });
    const app = renderApp([{ pathname: `/invite/${TOKEN}`, state: { signedIn: true } }]);

    expect((await screen.findByTestId('invite-error')).textContent).toBe('Could not accept the invitation. Try again.');
    await waitFor(() => expect(app.location().state).not.toHaveProperty('signedIn'));
    expect(calls(fetchMock).filter((c) => c === ACCEPT)).toHaveLength(1);
    expect(screen.getByTestId('invite-error')).toBeTruthy();

    const { pathname, search } = app.location();
    const state: unknown = app.location().state;
    cleanup();
    const reloaded = stubApi({ [GET]: () => json(PUBLIC) });
    renderApp([{ pathname, search, state }]);
    await screen.findByTestId('invite-details');
    await settle();
    expect(calls(reloaded)).toEqual([GET]);
  });

  it.each([`/invite/${TOKEN}?signedIn=true`, `/invite/${TOKEN}?state=signedIn&accept=1`])(
    'a link cannot trigger the automatic accept (%s)',
    async (entry) => {
      const fetchMock = stubApi({ [GET]: () => json(PUBLIC) });
      renderApp([entry]);

      await screen.findByTestId('invite-details');
      await settle();
      expect(calls(fetchMock)).toEqual([GET]);
    },
  );

  it('sends the automatic accept once even if the details load again', async () => {
    const slow = deferred(() => json(ACCEPTED));
    const fetchMock = stubApi({ [GET]: () => json(PUBLIC), [ACCEPT]: slow.handler, [ME]: () => json(GUARD_ME) });
    const app = renderApp([{ pathname: `/invite/${TOKEN}`, state: { signedIn: true } }]);

    await waitFor(() => expect(calls(fetchMock)).toContain(ACCEPT));
    expect(screen.getByTestId('invite-accepting').getAttribute('role')).toBe('status');
    await act(() => app.queryClient.refetchQueries({ queryKey: ['invitation', TOKEN] }));
    slow.release();

    await waitFor(() => expect(location()).toBe('/'));
    expect(calls(fetchMock).filter((c) => c === ACCEPT)).toHaveLength(1);
  });
});

describe('existing account, logged in (criterion 4)', () => {
  it('accepts with one click and opens the accepted building, not the one the tab had', async () => {
    const fetchMock = stubApi({
      [GET]: () => json(PUBLIC),
      [ACCEPT]: () => json(ACCEPTED),
      [ME]: () => json({ ...GUARD_ME, memberships: [membership(BIRCH), membership(MAPLE, { roles: ['security'] })] }),
      [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, ['security'])),
    });
    writeSelectedBuilding(BIRCH.id);
    renderApp([`/invite/${TOKEN}`]);

    click(await screen.findByRole('button', { name: /accept invitation/i }));

    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Package log' })).toBeTruthy();
    expect(readSelectedBuilding()).toBe(MAPLE.id);
    expect(await bodies(fetchMock, ACCEPT)).toEqual([{}]);
  });
});

describe('another account signed in (criterion 5)', () => {
  it('logs out in place and shows the details again', async () => {
    let signedIn = true;
    const fetchMock = stubApi({
      [GET]: () => json(PUBLIC),
      [ACCEPT]: () => (signedIn ? problem(403, 'invitation_email_mismatch') : needsAccount()),
      [LOGOUT]: () => {
        signedIn = false;
        return noContent();
      },
    });
    writeSelectedBuilding(BIRCH.id);
    const app = renderApp([`/invite/${TOKEN}`]);
    app.queryClient.setQueryData(['me'], RESIDENT_ME);

    click(await screen.findByRole('button', { name: /accept invitation/i }));
    const screenEl = await screen.findByTestId('invite-mismatch');
    expect(heading().textContent).toBe("You're signed in with another account");
    expect(document.activeElement).toBe(heading());
    expect(screenEl.textContent).toContain('n***@example.test');

    click(screen.getByRole('button', { name: /log out/i }));

    expect(await screen.findByTestId('invite-details')).toBeTruthy();
    expect(document.activeElement).toBe(heading());
    expect(location()).toBe(`/invite/${TOKEN}`);
    expect(app.queryClient.getQueryData(['me'])).toBeUndefined();
    expect(readSelectedBuilding()).toBeNull();

    click(acceptButton());
    expect(await screen.findByTestId('invite-form')).toBeTruthy();
    expect(calls(fetchMock)).toEqual([GET, ACCEPT, LOGOUT, ACCEPT]);
  });

  it.each<[string, Handler]>([
    ['500', () => problem(500, 'internal_error')],
    ['network', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('a failed logout (%s) keeps the screen and says so', async (_, handler) => {
    stubApi({ [GET]: () => json(PUBLIC), [ACCEPT]: () => problem(403, 'invitation_email_mismatch'), [LOGOUT]: handler });
    renderApp([`/invite/${TOKEN}`]);

    click(await screen.findByRole('button', { name: /accept invitation/i }));
    click(await screen.findByRole('button', { name: /log out/i }));

    const alert = await screen.findByTestId('invite-error');
    expect(alert.textContent).toBe('Could not log out. Try again.');
    expect(document.activeElement).toBe(alert);
    expect(screen.getByTestId('invite-mismatch')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /log out/i }).disabled).toBe(false);
  });
});

describe('invalid link (criterion 6)', () => {
  const INVALID_TEXT = 'This invitation is no longer validAsk your building manager to resend it.';

  it('shows the friendly screen for a 404 from the details', async () => {
    stubApi({ [GET]: () => problem(404, 'invitation_invalid') });
    renderApp([`/invite/${TOKEN}`]);

    const invalidScreen = await screen.findByTestId('invite-invalid');
    expect(invalidScreen.textContent).toBe(INVALID_TEXT);
    expect(document.activeElement).toBe(heading());
    expect(document.body.textContent).not.toMatch(/invitation_invalid|404/);
  });

  it.each(['form', 'button'])('shows it for a 404 from the accept (%s)', async (from) => {
    let accepts = 0;
    stubApi({
      [GET]: () => json(PUBLIC),
      [ACCEPT]: () => (++accepts === 1 && from === 'form' ? needsAccount() : problem(404, 'invitation_invalid')),
    });
    renderApp([`/invite/${TOKEN}`]);

    click(await screen.findByRole('button', { name: /accept invitation/i }));
    if (from === 'form') {
      await screen.findByTestId('invite-form');
      createAccount('Nadia');
    }

    expect((await screen.findByTestId('invite-invalid')).textContent).toBe(INVALID_TEXT);
    expect(document.activeElement).toBe(heading());
  });

  it.each(['/invite', '/invite/', '/invite/a/b'])('shows it for the path %s, without a request', async (path) => {
    const fetchMock = stubApi({});
    renderApp([path]);

    expect(screen.getByTestId('invite-invalid').textContent).toBe(INVALID_TEXT);
    expect(document.activeElement).toBe(heading());
    await settle();
    expect(calls(fetchMock)).toEqual([]);
  });
});

describe('other refusals (criterion 7)', () => {
  it('membership_exists says so and links to the app', async () => {
    stubApi({ [GET]: () => json(PUBLIC), [ACCEPT]: () => problem(409, 'membership_exists') });
    renderApp([`/invite/${TOKEN}`]);

    click(await screen.findByRole('button', { name: /accept invitation/i }));

    const member = await screen.findByTestId('invite-member');
    expect(heading().textContent).toBe("You're already a member of Maple Tower");
    expect(document.activeElement).toBe(heading());
    expect(within(member).getByRole('link', { name: /go to the app/i }).getAttribute('href')).toBe('/');
  });

  it('unit_inactive says the unit is no longer active', async () => {
    stubApi({ [GET]: () => json(PUBLIC), [ACCEPT]: () => problem(409, 'unit_inactive') });
    renderApp([`/invite/${TOKEN}`]);

    click(await screen.findByRole('button', { name: /accept invitation/i }));

    const unit = await screen.findByTestId('invite-unit');
    expect(unit.textContent).toContain('no longer active');
    expect(document.activeElement).toBe(heading());
    expect(document.body.textContent).not.toMatch(/unit_inactive|409/);
  });

  it.each([
    ['30', 'Too many requests. Try again in 30 seconds.'],
    [null, 'Too many requests. Try again later.'],
  ])('a 429 from the accept shows the wait (Retry-After %s)', async (retryAfter, message) => {
    stubApi({
      [GET]: () => json(PUBLIC),
      [ACCEPT]: () => problem(429, 'rate_limited', retryAfter ? { 'Retry-After': retryAfter } : {}),
    });
    renderApp([`/invite/${TOKEN}`]);

    click(await screen.findByRole('button', { name: /accept invitation/i }));

    const alert = await screen.findByTestId('invite-error');
    expect(alert.textContent).toBe(message);
    expect(alert.getAttribute('role')).toBe('alert');
    expect(document.activeElement).toBe(alert);
    expect(acceptButton()).toBeTruthy();
  });

  it.each<[string, Handler]>([
    ['500', () => problem(500, 'internal_error')],
    ['network', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['HTML 502', () => new Response('<html>Bad gateway</html>', { status: 502 })],
    ['unplaceable 422', () => invalid([{ loc: ['body', 'roles'], msg: 'x', type: 'extra_forbidden' }])],
  ])('other accept failures from the form (%s) show a generic message and keep it', async (_, handler) => {
    let accepts = 0;
    stubApi({ [GET]: () => json(PUBLIC), [ACCEPT]: (r) => (++accepts === 1 ? needsAccount() : handler(r)) });
    renderApp([`/invite/${TOKEN}`]);
    click(await screen.findByRole('button', { name: /accept invitation/i }));
    await screen.findByTestId('invite-form');

    createAccount('Nadia');

    const alert = await screen.findByTestId('invite-error');
    expect(alert.textContent).toBe('Could not accept the invitation. Try again.');
    expect(document.activeElement).toBe(alert);
    expect(screen.getByTestId('invite-form')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/internal_error|extra_forbidden|50\d|422|TypeError/);
  });

  it.each<[string, Handler, string]>([
    ['429', () => problem(429, 'rate_limited', { 'Retry-After': '600' }), 'Too many requests. Try again in 10 minutes.'],
    ['500', () => problem(500, 'internal_error'), 'Check your connection and try again.'],
    ['network', () => Promise.reject(new TypeError('Failed to fetch')), 'Check your connection and try again.'],
  ])('a details failure (%s) offers to try again', async (_, handler, message) => {
    let gets = 0;
    const fetchMock = stubApi({ [GET]: (r) => (++gets <= 3 ? handler(r) : json(PUBLIC)) });
    renderApp([`/invite/${TOKEN}`]);

    const failed = await screen.findByTestId('invite-load-error');
    expect(failed.textContent).toContain(message);
    expect(document.activeElement).toBe(heading());
    expect(document.body.textContent).not.toMatch(/rate_limited|internal_error|TypeError/);
    const tries = calls(fetchMock).length;

    gets = 3;
    click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByTestId('invite-details')).toBeTruthy();
    expect(calls(fetchMock).length).toBe(tries + 1);
  });
});

describe('form checks (criterion 8)', () => {
  async function openForm(accept: Handler = () => needsAccount()) {
    const fetchMock = stubApi({ [GET]: () => json(PUBLIC), [ACCEPT]: accept });
    renderApp([`/invite/${TOKEN}`]);
    click(await screen.findByRole('button', { name: /accept invitation/i }));
    await screen.findByTestId('invite-form');
    return fetchMock;
  }

  it.each([
    ['an empty name', '   ', GOOD, GOOD, 'Full name', 'Enter your full name.'],
    ['a name over 200 code points', '𝒶'.repeat(201), GOOD, GOOD, 'Full name', 'Use at most 200 characters.'],
    ['a name with a tab', 'Nadia\tOkafor', GOOD, GOOD, 'Full name', "The name can't contain line breaks or other control characters."],
    ['a short password', 'Nadia', 'short', 'short', 'Password', 'Use at least 12 characters.'],
    ['a long password', 'Nadia', 'x'.repeat(129), 'x'.repeat(129), 'Password', 'Use at most 128 characters.'],
    ['a different confirmation', 'Nadia', GOOD, `${GOOD}!`, 'Confirm password', "The passwords don't match."],
  ])('%s is refused on its field without a request', async (_, name, password, confirm, label, message) => {
    const fetchMock = await openForm();

    createAccount(name, password, confirm);

    expect(await screen.findByText(message)).toBeTruthy();
    const field = screen.getByLabelText(label);
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toContain(`${field.id}-error`);
    expect(calls(fetchMock).filter((c) => c === ACCEPT)).toHaveLength(1);
  });

  it('accepts a name of 200 emoji (200 code points, 400 UTF-16 units)', async () => {
    let accepts = 0;
    const fetchMock = await openForm(() => (++accepts === 1 ? needsAccount() : problem(500, 'internal_error')));

    createAccount('𝒶'.repeat(200));

    await screen.findByTestId('invite-error');
    expect(calls(fetchMock).filter((c) => c === ACCEPT)).toHaveLength(2);
  });

  it.each([
    [['body', 'password'], 'password_too_common', 'Password', 'This password is too common. Choose another.'],
    [['body', 'password'], 'string_too_short', 'Password', 'Use at least 12 characters.'],
    [['body', 'full_name'], 'string_too_short', 'Full name', 'Enter your full name.'],
    [['body', 'full_name'], 'string_too_long', 'Full name', 'Use at most 200 characters.'],
    [['body', 'full_name'], 'control_characters', 'Full name', "The name can't contain line breaks or other control characters."],
    [['body', 'full_name'], 'missing', 'Full name', 'Enter your full name.'],
  ])('a server 422 on %j (%s) shows the page message on the field', async (loc, type, label, message) => {
    let accepts = 0;
    await openForm(() => (++accepts === 1 ? needsAccount() : invalid([{ loc, msg: 'server words', type }])));

    createAccount('Nadia');

    expect(await screen.findByText(message)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText(label));
    expect(document.body.textContent).not.toContain('server words');
    expect(screen.getByTestId('invite-form')).toBeTruthy();
  });
});

describe('keyboard (criterion 9)', () => {
  it('focuses the heading on load and on the form, and submits with Enter', async () => {
    let accepts = 0;
    const fetchMock = stubApi({
      [GET]: () => json(PUBLIC),
      [ACCEPT]: () => (++accepts === 1 ? needsAccount() : json(ACCEPTED)),
      [ME]: () => json(GUARD_ME),
      [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, ['security'])),
    });
    renderApp([`/invite/${TOKEN}`]);

    await screen.findByTestId('invite-details');
    expect(document.activeElement).toBe(heading());
    fireEvent.submit(screen.getByTestId('invite-accept-form'));

    await screen.findByTestId('invite-form');
    expect(document.activeElement).toBe(heading());
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Nadia' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: GOOD } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: GOOD } });
    fireEvent.submit(screen.getByTestId('invite-form'));

    await waitFor(() => expect(location()).toBe('/'));
    expect(calls(fetchMock).filter((c) => c === ACCEPT)).toHaveLength(2);
  });

  it('labels every input', async () => {
    stubApi({ [GET]: () => json(PUBLIC), [ACCEPT]: () => needsAccount() });
    renderApp([`/invite/${TOKEN}`]);
    click(await screen.findByRole('button', { name: /accept invitation/i }));
    await screen.findByTestId('invite-form');

    for (const input of screen.getByTestId('invite-form').querySelectorAll('input')) {
      expect(input.labels?.length).toBe(1);
    }
    expect(screen.getByLabelText('Full name').getAttribute('autocomplete')).toBe('name');
  });
});

describe('no double accept, no late navigation (criterion 10)', () => {
  it('sends once on a double click of the accept button', async () => {
    const slow = deferred(() => needsAccount());
    const fetchMock = stubApi({ [GET]: () => json(PUBLIC), [ACCEPT]: slow.handler });
    renderApp([`/invite/${TOKEN}`]);

    const button = await screen.findByRole<HTMLButtonElement>('button', { name: /accept invitation/i });
    click(button);
    fireEvent.submit(button.form!);
    await waitFor(() => expect(button.disabled).toBe(true));
    fireEvent.submit(button.form!);
    slow.release();

    await screen.findByTestId('invite-form');
    expect(calls(fetchMock).filter((c) => c === ACCEPT)).toHaveLength(1);
  });

  it('sends once on a double submit of the form, and keeps the button disabled', async () => {
    let accepts = 0;
    const slow = deferred(() => json(ACCEPTED));
    const fetchMock = stubApi({
      [GET]: () => json(PUBLIC),
      [ACCEPT]: (r) => (++accepts === 1 ? needsAccount() : slow.handler(r)),
      [ME]: () => json(GUARD_ME),
      [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, ['security'])),
    });
    renderApp([`/invite/${TOKEN}`]);
    click(await screen.findByRole('button', { name: /accept invitation/i }));
    await screen.findByTestId('invite-form');

    createAccount('Nadia');
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: /create account and accept/i });
    await waitFor(() => expect(calls(fetchMock).filter((c) => c === ACCEPT)).toHaveLength(2));
    fireEvent.submit(screen.getByTestId('invite-form'));
    await settle();
    expect(submit.disabled).toBe(true);
    slow.release();

    await waitFor(() => expect(location()).toBe('/'));
    expect(calls(fetchMock).filter((c) => c === ACCEPT)).toHaveLength(2);
  });

  it.each([
    ['another invite link', OTHER],
    ['the same link in another history entry', TOKEN],
  ])('Back to %s: the abandoned accept neither navigates nor changes that screen', async (_, previous) => {
    const slow = deferred(() => json(ACCEPTED));
    const fetchMock = stubApi({
      [GET]: () => json(PUBLIC),
      [`GET /api/invitations/${OTHER}`]: () => json({ ...PUBLIC, building_name: 'Birch Court' }),
      [ACCEPT]: slow.handler,
    });
    const app = renderApp([`/invite/${previous}`, `/invite/${TOKEN}`]);

    click(await screen.findByRole('button', { name: /accept invitation/i }));
    await waitFor(() => expect(calls(fetchMock)).toContain(ACCEPT));
    app.navigate()(-1);
    await waitFor(() => expect(app.location().key).not.toBe('default'));
    await screen.findByTestId('invite-details');
    slow.release();

    // The accept may have logged a new account in: the tab still forgets what it cached.
    await waitFor(() => expect(readSelectedBuilding()).toBe(MAPLE.id));
    await settle();
    expect(location()).toBe(`/invite/${previous}`);
    expect(screen.getByTestId('invite-details')).toBeTruthy();
    expect(acceptButton().hasAttribute('disabled')).toBe(false);
    expect(screen.queryByTestId('invite-accepting')).toBeNull();
  });

  it('a form error does not follow the user to another invite link', async () => {
    stubApi({
      [GET]: () => json(PUBLIC),
      [`GET /api/invitations/${OTHER}`]: () => json(PUBLIC),
      [ACCEPT]: () => problem(409, 'login_required'),
    });
    const app = renderApp([`/invite/${TOKEN}`]);
    click(await screen.findByRole('button', { name: /accept invitation/i }));
    await screen.findByTestId('invite-login');

    app.navigate()(`/invite/${OTHER}`);

    expect(await screen.findByTestId('invite-details')).toBeTruthy();
    expect(screen.queryByTestId('invite-login')).toBeNull();
    expect(document.activeElement).toBe(heading());
  });
});

describe('next stays safe (criterion 11)', () => {
  it.each(['//evil.example', '/\\evil.example', 'https://evil.example/invite/x'])(
    'an unsafe next (%s) still goes home after login, with no accept',
    async (next) => {
      let signedIn = false;
      const fetchMock = stubApi({
        [LOGIN]: () => {
          signedIn = true;
          return noContent();
        },
        [ME]: () => (signedIn ? json(RESIDENT_ME) : problem(401, 'unauthorized')),
      });
      renderApp([`/login?next=${encodeURIComponent(next)}`]);
      await waitFor(() => expect(calls(fetchMock)).toContain(ME));

      fireEvent.change(screen.getByLabelText<HTMLInputElement>('Email'), { target: { value: 'a@example.test' } });
      fireEvent.change(screen.getByLabelText<HTMLInputElement>('Password'), { target: { value: 'DevPassword!2026' } });
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

      await waitFor(() => expect(location()).toBe('/'));
      expect(calls(fetchMock).some((c) => c.startsWith('POST /api/invitations'))).toBe(false);
    },
  );
});
