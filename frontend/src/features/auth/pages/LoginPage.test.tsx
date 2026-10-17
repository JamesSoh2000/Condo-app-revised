// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RESIDENT_ME, calls, json, noContent, problem, renderApp, stubApi, type Handler } from '@/test/renderApp';

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, ...actual.createApiClient({ baseUrl: 'http://app.test' }) };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const location = () => screen.getByTestId('location').textContent;
const email = () => screen.getByLabelText<HTMLInputElement>(/email/i);
const password = () => screen.getByLabelText<HTMLInputElement>(/password/i);

/** A backend where `login` answers the login call and /me answers 200 only after a successful login. */
function backend(login: Handler) {
  let signedIn = false;
  return stubApi({
    'POST /api/auth/login': async (request) => {
      const response = await login(request);
      signedIn = response.status === 204;
      return response;
    },
    'GET /api/auth/me': () => (signedIn ? json(RESIDENT_ME) : problem(401, 'unauthorized')),
  });
}

function fillAndSubmit(emailValue: string, passwordValue: string) {
  fireEvent.change(email(), { target: { value: emailValue } });
  fireEvent.change(password(), { target: { value: passwordValue } });
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
}

describe('login (P2-06a criterion 1)', () => {
  it('logs in once and lands on the home placeholder with the user name', async () => {
    const fetchMock = backend(() => noContent());
    renderApp(['/login']);

    fillAndSubmit('resident1@example.test', 'DevPassword!2026');

    expect(await screen.findByRole('heading', { name: /home/i })).toBeTruthy();
    expect(location()).toBe('/');
    expect(screen.getByRole('banner').textContent).toContain('Alex Chen');
    expect(calls(fetchMock).filter((c) => c === 'POST /api/auth/login')).toHaveLength(1);
    const login = fetchMock.mock.calls.find(([r]) => r.method === 'POST')![0];
    expect(await login.json()).toEqual({ email: 'resident1@example.test', password: 'DevPassword!2026' });
    expect(login.headers.get('X-Requested-With')).toBe('fetch');
  });

  it('follows a safe next', async () => {
    backend(() => noContent());
    renderApp(['/login?next=%2FPackages']);

    fillAndSubmit('resident1@example.test', 'DevPassword!2026');

    expect(await screen.findByText(/being migrated/i)).toBeTruthy();
    expect(location()).toBe('/Packages');
  });

  it('ignores an unsafe next (criterion 8)', async () => {
    backend(() => noContent());
    renderApp(['/login?next=%2F%2Fevil.example']);

    fillAndSubmit('resident1@example.test', 'DevPassword!2026');

    await waitFor(() => expect(location()).toBe('/'));
  });

  it('trims the email but sends the password as typed', async () => {
    const fetchMock = backend(() => noContent());
    renderApp(['/login']);

    fillAndSubmit('  resident1@example.test ', ' pass word ');

    await waitFor(() => expect(location()).toBe('/'));
    const login = fetchMock.mock.calls.find(([r]) => r.method === 'POST')![0];
    expect(await login.json()).toEqual({ email: 'resident1@example.test', password: ' pass word ' });
  });

  it('drops data cached before the login', async () => {
    backend(() => noContent());
    const app = renderApp(['/login']);
    app.queryClient.setQueryData(['b', 'old-building', 'packages'], [{ id: 1 }]);

    fillAndSubmit('resident1@example.test', 'DevPassword!2026');

    await screen.findByRole('heading', { name: /home/i });
    expect(app.queryClient.getQueryData(['b', 'old-building', 'packages'])).toBeUndefined();
  });
});

describe('failed login (criteria 2, 3 and 4)', () => {
  it('shows the generic message for a wrong password, focuses it, empties the password and stays', async () => {
    backend(() => problem(401, 'invalid_credentials'));
    const app = renderApp(['/login?next=%2FPackages']);
    app.queryClient.setQueryData(['version'], { git_sha: 'x' });

    fillAndSubmit('resident1@example.test', 'wrong-password');

    const summary = await screen.findByRole('alert');
    expect(summary.textContent).toBe('Email or password is incorrect.');
    await waitFor(() => expect(document.activeElement).toBe(summary));
    expect(password().value).toBe('');
    expect(email().value).toBe('resident1@example.test');
    expect(location()).toBe('/login?next=%2FPackages');
    // The login call's own 401 is not a lost session: the cache is not cleared.
    expect(app.queryClient.getQueryData(['version'])).toEqual({ git_sha: 'x' });
  });

  it('moves focus to the summary again on a second failure', async () => {
    backend(() => problem(401, 'invalid_credentials'));
    renderApp(['/login']);
    fillAndSubmit('resident1@example.test', 'wrong-1');
    const summary = await screen.findByRole('alert');
    await waitFor(() => expect(document.activeElement).toBe(summary));
    password().focus();

    fillAndSubmit('resident1@example.test', 'wrong-2');

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('alert')));
  });

  it.each([
    ['1', 'Too many sign-in attempts. Try again in 1 second.'],
    ['42', 'Too many sign-in attempts. Try again in 42 seconds.'],
    ['119', 'Too many sign-in attempts. Try again in 119 seconds.'],
    ['120', 'Too many sign-in attempts. Try again in 2 minutes.'],
    ['121', 'Too many sign-in attempts. Try again in 3 minutes.'],
    ['900', 'Too many sign-in attempts. Try again in 15 minutes.'],
    [undefined, 'Too many sign-in attempts. Try again later.'],
    ['soon', 'Too many sign-in attempts. Try again later.'],
    ['0', 'Too many sign-in attempts. Try again later.'],
  ])('says when to retry for a 429 with Retry-After %j', async (retryAfter, message) => {
    backend(() => problem(429, 'rate_limited', retryAfter === undefined ? {} : { 'Retry-After': retryAfter }));
    renderApp(['/login']);

    fillAndSubmit('resident1@example.test', 'whatever-password');

    const summary = await screen.findByRole('alert');
    expect(summary.textContent).toBe(message);
    await waitFor(() => expect(document.activeElement).toBe(summary));
    expect(location()).toBe('/login');
  });

  it.each([
    ['a 500', () => problem(500, 'internal_error')],
    ['a 403 csrf_failed', () => problem(403, 'csrf_failed')],
    ['a 422', () => problem(422, 'validation_error')],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('shows a generic retry message for %s', async (_label, failure) => {
    backend(failure);
    renderApp(['/login']);

    fillAndSubmit('resident1@example.test', 'whatever-password');

    expect((await screen.findByRole('alert')).textContent).toBe('Could not sign in. Try again.');
  });

  it.each([
    ['', '', 'email'],
    ['   ', 'secret-password', 'email'],
    ['resident1@example.test', '', 'password'],
  ])('sends nothing and focuses the first invalid field for email %j / password %j', async (e, p, first) => {
    const fetchMock = backend(() => noContent());
    renderApp(['/login']);

    fillAndSubmit(e, p);

    const field = first === 'email' ? email() : password();
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(field.getAttribute('aria-invalid')).toBe('true');
    const describedBy = field.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)?.textContent).toMatch(/enter your/i);
    expect(calls(fetchMock)).toEqual([]);
  });

  it('marks both fields when both are empty', async () => {
    backend(() => noContent());
    renderApp(['/login']);

    fillAndSubmit('', '');

    await waitFor(() => expect(password().getAttribute('aria-invalid')).toBe('true'));
    expect(email().getAttribute('aria-invalid')).toBe('true');
  });

  it('refuses a password longer than the backend accepts, without a request', async () => {
    const fetchMock = backend(() => noContent());
    renderApp(['/login']);

    fillAndSubmit('resident1@example.test', 'x'.repeat(129));

    await waitFor(() => expect(password().getAttribute('aria-invalid')).toBe('true'));
    expect(calls(fetchMock)).toEqual([]);
  });

  it('labels both fields', () => {
    stubApi({});
    renderApp(['/login']);

    expect(email().type).toBe('email');
    expect(email().autocomplete).toBe('username');
    expect(password().type).toBe('password');
    expect(password().autocomplete).toBe('current-password');
  });
});
