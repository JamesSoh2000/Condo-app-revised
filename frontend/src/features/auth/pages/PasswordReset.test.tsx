// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readSelectedBuilding, writeSelectedBuilding, writeViewAs } from '@/app/buildingStorage';
import { MAPLE, calls, json, noContent, problem, renderApp, stubApi, type Handler } from '@/test/renderApp';

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, ...actual.createApiClient({ baseUrl: 'http://app.test' }) };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const REQUEST = 'POST /api/auth/password-reset/request';
const CONFIRM = 'POST /api/auth/password-reset/confirm';
const TOKEN = 'k3Jx_9q-0123456789abcdefghijklmnopqrstuvwxy';
const GOOD = 'correct horse battery';
const DETAIL = 'If an account exists for that email, a reset link is on its way.';

const location = () => screen.getByTestId('location').textContent;

/** A 422 `validation_error` with `errors[]`, as `app/core/errors.py` sends it. */
function invalid(errors: { loc: (string | number)[]; msg: string; type: string }[]): Response {
  return json(
    { type: 'about:blank', title: 'Validation error', status: 422, code: 'validation_error', request_id: 'req', errors },
    422,
  );
}

/** A response that answers only when `release` is called. */
function deferred(response: () => Response): { handler: Handler; release: () => void } {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { handler: () => gate.then(response), release };
}

async function bodyOf(fetchMock: ReturnType<typeof stubApi>, key: string): Promise<unknown> {
  const request = fetchMock.mock.calls.map(([r]) => r).find((r) => `${r.method} ${new URL(r.url).pathname}` === key);
  return request!.clone().json();
}

function requestLink(value: string) {
  fireEvent.change(screen.getByLabelText<HTMLInputElement>('Email'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));
}

function setPassword(password: string, confirm = password) {
  fireEvent.change(screen.getByLabelText<HTMLInputElement>('New password'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText<HTMLInputElement>('Confirm new password'), { target: { value: confirm } });
  fireEvent.click(screen.getByRole('button', { name: /set new password/i }));
}

describe('forgot password (P4-07a criteria 1, 2)', () => {
  it.each(['resident1@example.test', 'nobody@example.test'])(
    "shows the server's confirmation for any email (%s)",
    async (email) => {
      const fetchMock = stubApi({ [REQUEST]: () => json({ detail: DETAIL }, 202) });
      renderApp(['/forgot-password']);

      requestLink(`  ${email} `);

      const status = await screen.findByTestId('forgot-status');
      expect(status.getAttribute('role')).toBe('status');
      expect(status.textContent).toBe(DETAIL);
      expect(screen.queryByTestId('forgot-form')).toBeNull();
      expect(calls(fetchMock)).toEqual([REQUEST]);
      expect(await bodyOf(fetchMock, REQUEST)).toEqual({ email });
    },
  );

  it('asks for an email and sends nothing when empty', async () => {
    const fetchMock = stubApi({});
    renderApp(['/forgot-password']);

    requestLink('   ');

    expect(await screen.findByText('Enter your email.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Email'));
    expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBe('true');
    expect(calls(fetchMock)).toEqual([]);
  });

  it.each([
    ['30', 'Too many requests. Try again in 30 seconds.'],
    ['1', 'Too many requests. Try again in 1 second.'],
    ['600', 'Too many requests. Try again in 10 minutes.'],
    [null, 'Too many requests. Try again later.'],
  ])('shows the wait time on 429 (Retry-After %s)', async (retryAfter, message) => {
    stubApi({ [REQUEST]: () => problem(429, 'rate_limited', retryAfter ? { 'Retry-After': retryAfter } : {}) });
    renderApp(['/forgot-password']);

    requestLink('resident1@example.test');

    const alert = await screen.findByTestId('forgot-error');
    expect(alert.textContent).toBe(message);
    expect(alert.getAttribute('role')).toBe('alert');
    expect(document.activeElement).toBe(alert);
    expect(screen.getByTestId('forgot-form')).toBeTruthy();
  });

  it.each<[string, Handler]>([
    ['500', () => problem(500, 'internal_error')],
    ['422', () => invalid([{ loc: ['body', 'email'], msg: 'bad', type: 'value_error' }])],
    ['network', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['HTML 502', () => new Response('<html>Bad gateway</html>', { status: 502 })],
  ])('shows a generic message on other failures (%s)', async (_, handler) => {
    stubApi({ [REQUEST]: handler });
    renderApp(['/forgot-password']);

    requestLink('resident1@example.test');

    const alert = await screen.findByTestId('forgot-error');
    expect(alert.textContent).toBe('Could not send the link. Try again.');
    expect(document.body.textContent).not.toMatch(/internal_error|value_error|50\d|422|TypeError/);
  });

  it('focuses the heading on load and sends with Enter (criterion 11)', async () => {
    const fetchMock = stubApi({ [REQUEST]: () => json({ detail: DETAIL }, 202) });
    renderApp(['/forgot-password']);

    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: /forgot your password/i }));
    const input = screen.getByLabelText<HTMLInputElement>('Email');
    fireEvent.change(input, { target: { value: 'resident1@example.test' } });
    fireEvent.submit(input.form!);

    expect(await screen.findByTestId('forgot-status')).toBeTruthy();
    expect(calls(fetchMock)).toEqual([REQUEST]);
  });
});

describe('reset password (P4-07a criteria 3–8)', () => {
  it('sets the new password and lands on login with the banner', async () => {
    const fetchMock = stubApi({ [CONFIRM]: () => noContent() });
    const app = renderApp(['/forgot-password', `/reset-password/${TOKEN}`]);
    app.queryClient.setQueryData(['b', MAPLE.id, 'leftover'], 'cached');
    writeSelectedBuilding(MAPLE.id);
    writeViewAs('resident');

    setPassword(GOOD);

    const banner = await screen.findByTestId('login-banner');
    expect(banner.textContent).toBe('Your password was updated. Sign in with your new password.');
    expect(banner.getAttribute('role')).toBe('status');
    expect(location()).toBe('/login');
    expect(calls(fetchMock).filter((c) => c === CONFIRM)).toHaveLength(1);
    expect(await bodyOf(fetchMock, CONFIRM)).toEqual({ token: TOKEN, new_password: GOOD });
    expect(app.queryClient.getQueryData(['b', MAPLE.id, 'leftover'])).toBeUndefined();
    expect(readSelectedBuilding()).toBeNull();
    expect(sessionStorage.length).toBe(0);
    // The reset page's entry was replaced: Back goes to the page before it.
    app.navigate()(-1);
    await waitFor(() => expect(location()).toBe('/forgot-password'));
  });

  it('sends a password with leading and trailing spaces unchanged', async () => {
    const fetchMock = stubApi({ [CONFIRM]: () => noContent() });
    renderApp([`/reset-password/${TOKEN}`]);

    setPassword(`  ${GOOD}  `);

    await screen.findByTestId('login-banner');
    expect(await bodyOf(fetchMock, CONFIRM)).toEqual({ token: TOKEN, new_password: `  ${GOOD}  ` });
  });

  it.each(['short', `${TOKEN}x`])('shows the invalid-link screen for reset_token_invalid (token %s)', async (token) => {
    stubApi({ [CONFIRM]: () => problem(400, 'reset_token_invalid') });
    renderApp([`/reset-password/${token}`]);

    setPassword(GOOD);

    const screenEl = await screen.findByTestId('reset-invalid');
    const heading = screen.getByRole('heading', { level: 1, name: 'This reset link is no longer valid' });
    expect(document.activeElement).toBe(heading);
    expect(screen.queryByTestId('reset-form')).toBeNull();
    const link = screen.getByRole('link', { name: /request a new link/i });
    expect(link.getAttribute('href')).toBe('/forgot-password');
    expect(screenEl.textContent).not.toMatch(/reset_token_invalid|400/);
  });

  it.each([
    ['password_too_common', 'This password is too common. Choose another.'],
    ['password_too_short', 'Use at least 12 characters.'],
    ['string_too_short', 'Use at least 12 characters.'],
    ['password_too_long', 'Use at most 128 characters.'],
    ['string_too_long', 'Use at most 128 characters.'],
    ['password_invalid_characters', "This password contains characters that can't be used."],
  ])("puts the server's password error on the field and keeps the form (%s)", async (type, message) => {
    let answers = 0;
    const fetchMock = stubApi({
      [CONFIRM]: () => (++answers === 1 ? invalid([{ loc: ['body', 'new_password'], msg: 'x', type }]) : noContent()),
    });
    renderApp([`/reset-password/${TOKEN}`]);

    setPassword(GOOD);

    expect(await screen.findByText(message)).toBeTruthy();
    const field = screen.getByLabelText('New password');
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toContain('new_password-error');
    expect(document.body.textContent).not.toContain(type);

    // The same link works again with another password.
    setPassword('another long passphrase');
    expect(await screen.findByTestId('login-banner')).toBeTruthy();
    expect(calls(fetchMock).filter((c) => c === CONFIRM)).toHaveLength(2);
  });

  it.each([
    ['an unknown field', [{ loc: ['body', 'token'], msg: 'x', type: 'string_too_long' }]],
    ['no errors', []],
    ['an unknown type on the field', [{ loc: ['body', 'new_password'], msg: 'x', type: 'password_new_rule' }]],
    [
      'one placeable and one not',
      [
        { loc: ['body', 'new_password'], msg: 'x', type: 'password_too_common' },
        { loc: ['query', 'new_password'], msg: 'x', type: 'missing' },
      ],
    ],
  ])("shows a generic alert for an error it can't place (%s)", async (_, errors) => {
    stubApi({ [CONFIRM]: () => invalid(errors) });
    renderApp([`/reset-password/${TOKEN}`]);

    setPassword(GOOD);

    const alert = await screen.findByTestId('reset-error');
    expect(alert.textContent).toBe('Could not set the password. Try again.');
    expect(document.activeElement).toBe(alert);
    expect(screen.getByTestId('reset-form')).toBeTruthy();
  });

  it.each([
    ['11 characters', 'a'.repeat(11), 'a'.repeat(11), 'New password', 'Use at least 12 characters.'],
    ['6 emoji (12 UTF-16 units)', '😀'.repeat(6), '😀'.repeat(6), 'New password', 'Use at least 12 characters.'],
    ['129 characters', 'a'.repeat(129), 'a'.repeat(129), 'New password', 'Use at most 128 characters.'],
    ['a mismatch', GOOD, `${GOOD}!`, 'Confirm new password', "The passwords don't match."],
  ])('checks %s before sending', async (_, password, confirm, label, message) => {
    const fetchMock = stubApi({});
    renderApp([`/reset-password/${TOKEN}`]);

    setPassword(password, confirm);

    expect(await screen.findByText(message)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText(label));
    expect(calls(fetchMock)).toEqual([]);
  });

  it('accepts 12 emoji (12 code points, 24 UTF-16 units)', async () => {
    const fetchMock = stubApi({ [CONFIRM]: () => noContent() });
    renderApp([`/reset-password/${TOKEN}`]);

    setPassword('😀'.repeat(12));

    expect(await screen.findByTestId('login-banner')).toBeTruthy();
    expect(calls(fetchMock).filter((c) => c === CONFIRM)).toHaveLength(1);
  });

  it.each([
    [{ 'Retry-After': '45' }, 'Too many requests. Try again in 45 seconds.'],
    [{}, 'Too many requests. Try again later.'],
  ])('shows the wait time on 429', async (headers, message) => {
    stubApi({ [CONFIRM]: () => problem(429, 'rate_limited', headers) });
    renderApp([`/reset-password/${TOKEN}`]);

    setPassword(GOOD);

    const alert = await screen.findByTestId('reset-error');
    expect(alert.textContent).toBe(message);
    expect(document.activeElement).toBe(alert);
  });

  it.each<[string, Handler]>([
    ['500', () => problem(500, 'internal_error')],
    ['network', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('shows a generic message on other failures (%s)', async (_, handler) => {
    stubApi({ [CONFIRM]: handler });
    renderApp([`/reset-password/${TOKEN}`]);

    setPassword(GOOD);

    expect((await screen.findByTestId('reset-error')).textContent).toBe('Could not set the password. Try again.');
    expect(screen.getByTestId('reset-form')).toBeTruthy();
  });

  it('sends once on a double click', async () => {
    const slow = deferred(() => noContent());
    const fetchMock = stubApi({ [CONFIRM]: slow.handler });
    renderApp([`/reset-password/${TOKEN}`]);

    setPassword(GOOD);
    await waitFor(() => expect(calls(fetchMock)).toEqual([CONFIRM]));
    const button = screen.getByRole<HTMLButtonElement>('button', { name: /set new password/i });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    fireEvent.submit(button.form!);
    slow.release();

    expect(await screen.findByTestId('login-banner')).toBeTruthy();
    expect(calls(fetchMock).filter((c) => c === CONFIRM)).toHaveLength(1);
  });

  it('does not navigate when the reset answers after the page was left', async () => {
    const slow = deferred(() => noContent());
    const fetchMock = stubApi({ [CONFIRM]: slow.handler });
    const app = renderApp(['/forgot-password', `/reset-password/${TOKEN}`]);
    writeSelectedBuilding(MAPLE.id);

    setPassword(GOOD);
    await waitFor(() => expect(calls(fetchMock)).toEqual([CONFIRM]));
    app.navigate()(-1);
    await waitFor(() => expect(location()).toBe('/forgot-password'));
    slow.release();

    // The server logged every session out either way: the tab still forgets its choices.
    await waitFor(() => expect(readSelectedBuilding()).toBeNull());
    expect(location()).toBe('/forgot-password');
    expect(screen.queryByTestId('login-banner')).toBeNull();
  });

  it('focuses the heading on load and submits with Enter (criterion 11)', async () => {
    const fetchMock = stubApi({ [CONFIRM]: () => noContent() });
    renderApp([`/reset-password/${TOKEN}`]);

    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: /choose a new password/i }));
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: GOOD } });
    const confirm = screen.getByLabelText<HTMLInputElement>('Confirm new password');
    fireEvent.change(confirm, { target: { value: GOOD } });
    fireEvent.submit(confirm.form!);

    expect(await screen.findByTestId('login-banner')).toBeTruthy();
    expect(calls(fetchMock).filter((c) => c === CONFIRM)).toHaveLength(1);
  });
});

describe('password field (P4-07a criterion 9)', () => {
  it('shows and hides the password without submitting', () => {
    const fetchMock = stubApi({});
    renderApp([`/reset-password/${TOKEN}`]);
    const input = screen.getByLabelText<HTMLInputElement>('New password');
    const toggle = screen.getByTestId('reset-password-toggle');

    expect(input.type).toBe('password');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.getAttribute('type')).toBe('button');
    expect(toggle.textContent).toBe('Show password');
    fireEvent.click(toggle);
    expect(input.type).toBe('text');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe(input.id);
    fireEvent.click(toggle);
    expect(input.type).toBe('password');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    // The confirmation has its own toggle.
    expect(screen.getByLabelText<HTMLInputElement>('Confirm new password').type).toBe('password');

    expect(screen.queryByText('Use at least 12 characters.')).toBeNull();
    expect(calls(fetchMock)).toEqual([]);
  });

  it('counts code points in a hint tied to the input, outside any live region', () => {
    stubApi({});
    renderApp([`/reset-password/${TOKEN}`]);
    const input = screen.getByLabelText<HTMLInputElement>('New password');
    const hint = () => document.getElementById(input.getAttribute('aria-describedby')!.split(' ')[0])!;

    expect(hint().textContent).toBe('At least 12 characters');
    fireEvent.change(input, { target: { value: 'abc😀efg' } });
    expect(hint().textContent).toBe('7 of at least 12 characters');
    fireEvent.change(input, { target: { value: 'a'.repeat(15) } });
    expect(hint().textContent).toBe('15 characters (at least 12)');
    expect(hint().closest('[aria-live], [role="status"], [role="alert"]')).toBeNull();
  });
});
