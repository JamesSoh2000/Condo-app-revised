// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
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
} from '@/test/renderApp';

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, ...actual.createApiClient({ baseUrl: 'http://app.test' }) };
});

const { api } = await import('@/api/client');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const location = () => screen.getByTestId('location').textContent;

describe('RequireAuth (P2-06a criterion 7)', () => {
  it('shows only a loading state while /me is pending', async () => {
    let answer!: (response: Response) => void;
    stubApi({ 'GET /api/auth/me': () => new Promise<Response>((resolve) => (answer = resolve)) });

    renderApp(['/Packages']);

    expect((await screen.findByRole('status')).textContent).toMatch(/loading/i);
    expect(screen.queryByText('Alex Chen')).toBeNull();
    expect(screen.queryByRole('heading', { name: /packages/i })).toBeNull();

    act(() => answer(json(RESIDENT_ME)));
    expect(await screen.findByRole('heading', { name: /packages/i })).toBeTruthy();
    expect(screen.getByText('Alex Chen')).toBeTruthy();
  });

  it('redirects to /login with next when /me answers 401', async () => {
    stubApi({ 'GET /api/auth/me': () => problem(401, 'unauthorized') });

    renderApp(['/Packages?tab=2']);

    await waitFor(() => expect(location()).toBe('/login?next=%2FPackages%3Ftab%3D2'));
    expect(screen.getByRole('heading', { name: /sign in/i })).toBeTruthy();
  });

  it.each([
    ['a 500', () => problem(500, 'internal_error')],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('shows an error screen with Try again for %s, not the login page', async (_label, failure) => {
    let fail = true;
    const fetchMock = stubApi({ 'GET /api/auth/me': () => (fail ? failure() : json(RESIDENT_ME)) });

    renderApp(['/']);

    const retry = await screen.findByRole('button', { name: /try again/i });
    expect(location()).toBe('/');
    // The client retries a 5xx or network error twice before giving up.
    expect(calls(fetchMock)).toEqual(Array(3).fill('GET /api/auth/me'));

    fail = false;
    fireEvent.click(retry);
    expect(await screen.findByText('Alex Chen')).toBeTruthy();
  });

  it('passes React Query’s signal to the /me request (criterion 11)', async () => {
    const fetchMock = stubApi({ 'GET /api/auth/me': () => new Promise<Response>(() => {}) });

    const { queryClient } = renderApp(['/']);
    await screen.findByRole('status');

    const request = fetchMock.mock.calls[0][0];
    expect(request.signal.aborted).toBe(false);
    // Cancelling the in-flight query aborts the request it started.
    await act(() => queryClient.cancelQueries({ queryKey: ['me'] }));
    expect(request.signal.aborted).toBe(true);
  });
});

describe('home and placeholders (criterion 1)', () => {
  it('renders the home placeholder at / with the user name in the header', async () => {
    stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME) });

    renderApp(['/']);

    expect(await screen.findByRole('heading', { name: /home/i })).toBeTruthy();
    expect(screen.getByRole('banner').textContent).toContain('Alex Chen');
  });

  // P2-06b guards pages by role: /SecurityPackages is opened as a security user (a resident gets /403).
  it.each([
    ['/Packages', 'resident'],
    ['/packages', 'resident'],
    ['/SecurityPackages', 'security'],
    ['/Maintenance', 'resident'],
    ['/Dashboard', 'resident'],
    ['/Contacts', 'resident'],
  ] as const)(
    'renders a Being migrated placeholder at %s',
    async (path, role) => {
      stubApi({
        'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles: [role] })] }),
        [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, [role])),
      });

      renderApp([path]);

      expect(await screen.findByText(/being migrated/i)).toBeTruthy();
    },
  );

  it('renders the 404 page for an unknown path, without calling the API', async () => {
    const fetchMock = stubApi({});

    renderApp(['/no-such-page']);

    expect(await screen.findByRole('heading', { name: /page not found/i })).toBeTruthy();
    expect(calls(fetchMock)).toEqual([]);
  });

  it('renders the 404 page for a page outside the demo scope', async () => {
    stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME) });

    renderApp(['/Gameroom']);

    expect(await screen.findByRole('heading', { name: /page not found/i })).toBeTruthy();
  });
});

describe('logout (criterion 5)', () => {
  it('calls the API, empties the cache and shows /login; Back renders no authenticated content', async () => {
    let signedIn = true;
    const fetchMock = stubApi({
      'GET /api/auth/me': () => (signedIn ? json(RESIDENT_ME) : problem(401, 'unauthorized')),
      'POST /api/auth/logout': () => {
        signedIn = false;
        return noContent();
      },
    });
    const app = renderApp(['/', '/Packages']);
    await screen.findByText('Alex Chen');

    fireEvent.click(screen.getByRole('button', { name: /log out/i }));

    await waitFor(() => expect(location()).toBe('/login'));
    expect(calls(fetchMock)).toContain('POST /api/auth/logout');
    expect(app.queryClient.getQueryCache().getAll()).toEqual([]);
    expect(screen.queryByText('Alex Chen')).toBeNull();

    act(() => app.navigate()(-1));

    // Back lands on a protected page: only the loading state, then the login page again.
    expect(screen.queryByText('Alex Chen')).toBeNull();
    expect(screen.queryByRole('heading', { name: /home|packages/i })).toBeNull();
    await waitFor(() => expect(location()).toMatch(/^\/login/));
    expect(screen.queryByText('Alex Chen')).toBeNull();
  });

  it.each([
    ['a 500', () => problem(500, 'internal_error')],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('keeps the user signed in with an error when the call fails with %s', async (_label, failure) => {
    stubApi({ 'GET /api/auth/me': () => json(RESIDENT_ME), 'POST /api/auth/logout': failure });
    const app = renderApp(['/']);
    await screen.findByText('Alex Chen');

    fireEvent.click(screen.getByRole('button', { name: /log out/i }));

    expect((await screen.findByRole('alert')).textContent).toContain('Could not log out, try again');
    expect(location()).toBe('/');
    expect(screen.getByText('Alex Chen')).toBeTruthy();
    expect(app.queryClient.getQueryData(['me'])).toEqual(RESIDENT_ME);
  });
});

describe('logout still in flight when the user logs in again (review round 2, Codex M1)', () => {
  it('sends the login only after the old logout settles, and the old logout does not undo it', async () => {
    let signedIn = true;
    let finishLogout!: (response: Response) => void;
    const fetchMock = stubApi({
      'GET /api/auth/me': () => (signedIn ? json(RESIDENT_ME) : problem(401, 'unauthorized')),
      'POST /api/auth/logout': () => {
        // The server revokes the session at once; its response (which deletes the cookie) is slow.
        signedIn = false;
        return new Promise<Response>((resolve) => (finishLogout = resolve));
      },
      'POST /api/auth/login': () => {
        signedIn = true;
        return noContent();
      },
    });
    const app = renderApp(['/Packages']);
    await screen.findByText('Alex Chen');
    fireEvent.click(screen.getByRole('button', { name: /log out/i }));
    await waitFor(() => expect(signedIn).toBe(false));
    // A refetch sees the revocation first and sends the user to the login page.
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['me'] }));
    await screen.findByRole('heading', { name: /sign in/i });
    expect(location()).toBe('/login?next=%2FPackages');

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'resident1@example.test' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'DevPassword!2026' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: /sign in/i }).disabled).toBe(true));
    // Its response would delete the new cookie, so the login waits for it.
    expect(calls(fetchMock)).not.toContain('POST /api/auth/login');

    await act(() => Promise.resolve(finishLogout(noContent())));

    expect(await screen.findByText('Alex Chen')).toBeTruthy();
    expect(calls(fetchMock).filter((c) => c === 'POST /api/auth/login')).toHaveLength(1);
    expect(location()).toBe('/Packages');
    expect(app.queryClient.getQueryData(['me'])).toEqual(RESIDENT_ME);
  });

  it('also waits for a logout that fails, then logs in', async () => {
    let finishLogout!: (response: Response) => void;
    let signedIn = false;
    const fetchMock = stubApi({
      'GET /api/auth/me': () => (signedIn ? json(RESIDENT_ME) : problem(401, 'unauthorized')),
      'POST /api/auth/logout': () => new Promise<Response>((resolve) => (finishLogout = resolve)),
      'POST /api/auth/login': () => {
        signedIn = true;
        return noContent();
      },
    });
    signedIn = true;
    const app = renderApp(['/']);
    await screen.findByText('Alex Chen');
    fireEvent.click(screen.getByRole('button', { name: /log out/i }));
    signedIn = false;
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['me'] }));
    await screen.findByRole('heading', { name: /sign in/i });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'resident1@example.test' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'DevPassword!2026' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(calls(fetchMock)).toContain('POST /api/auth/logout'));
    expect(calls(fetchMock)).not.toContain('POST /api/auth/login');

    await act(() => Promise.resolve(finishLogout(problem(500, 'internal_error'))));

    expect(await screen.findByText('Alex Chen')).toBeTruthy();
    expect(location()).toBe('/');
  });
});

describe('session lost (criterion 6)', () => {
  it('clears the cache and goes to /login with next when another call answers 401', async () => {
    stubApi({
      'GET /api/auth/me': () => json(RESIDENT_ME),
      'GET /api/auth/sessions': () => problem(401, 'unauthorized'),
    });
    const app = renderApp(['/Packages?tab=2']);
    await screen.findByText('Alex Chen');
    app.queryClient.setQueryData(['b', 'some-building', 'packages'], [{ id: 1 }]);

    await act(() => api.get('/api/auth/sessions').catch(() => undefined));

    await waitFor(() => expect(location()).toBe('/login?next=%2FPackages%3Ftab%3D2'));
    expect(app.queryClient.getQueryData(['b', 'some-building', 'packages'])).toBeUndefined();
    expect(app.queryClient.getQueryData(['me'])).toBeUndefined();
    expect(screen.queryByText('Alex Chen')).toBeNull();
  });

  it('keeps the home page query in next (review round 1)', async () => {
    stubApi({
      'GET /api/auth/me': () => json(RESIDENT_ME),
      'GET /api/auth/sessions': () => problem(401, 'unauthorized'),
    });
    renderApp(['/?tab=2']);
    await screen.findByText('Alex Chen');

    await act(() => api.get('/api/auth/sessions').catch(() => undefined));

    await waitFor(() => expect(location()).toBe('/login?next=%2F%3Ftab%3D2'));
  });

  it('does not navigate on a login-page alias such as /login/', async () => {
    stubApi({ 'GET /api/auth/sessions': () => problem(401, 'unauthorized') });
    renderApp(['/login/?next=%2FPackages']);
    await screen.findByRole('heading', { name: /sign in/i });

    await act(() => api.get('/api/auth/sessions').catch(() => undefined));

    expect(location()).toBe('/login/?next=%2FPackages');
  });

  it('ignores the 401 of the login call itself (criterion 2)', async () => {
    stubApi({
      'GET /api/auth/me': () => json(RESIDENT_ME),
      'POST /api/auth/login': () => problem(401, 'invalid_credentials'),
    });
    const app = renderApp(['/Packages']);
    await screen.findByText('Alex Chen');

    await act(() =>
      api.post('/api/auth/login', { body: { email: 'x@example.test', password: 'nope' } }).catch(() => undefined),
    );

    expect(location()).toBe('/Packages');
    expect(app.queryClient.getQueryData(['me'])).toEqual(RESIDENT_ME);
  });

  it('does not replace /login?next=… when a 401 arrives on the login page', async () => {
    stubApi({ 'GET /api/auth/sessions': () => problem(401, 'unauthorized') });
    renderApp(['/login?next=%2FPackages']);
    await screen.findByRole('heading', { name: /sign in/i });

    await act(() => api.get('/api/auth/sessions').catch(() => undefined));

    expect(location()).toBe('/login?next=%2FPackages');
  });
});
