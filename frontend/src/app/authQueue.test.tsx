// @vitest-environment jsdom
/**
 * Login and logout run one at a time, in order, and a login whose form went away while it waited is
 * dropped (inbox B-3). Tests 1–3 come from Codex's review round 3 proofs. The first now asserts the
 * queued order (a second logout waits for the first) and the third the fixed outcome instead of the bug.
 */
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AUTH_TIMEOUT_MS, runAuthCall } from '@/app/authQueue';
import { RESIDENT_ME, calls, json, noContent, openAccountMenu, problem, renderApp, stubApi } from '@/test/renderApp';

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, ...actual.createApiClient({ baseUrl: 'http://app.test' }) };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'locks');
});

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));

function submit(email: string) {
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'DevPassword!2026' } });
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
}

describe('auth calls run one at a time (review round 3, Codex M2 and High)', () => {
  it('waits for every outstanding logout after Back/Forward remounts the shell', async () => {
    let signedIn = true;
    const finishes: ((response: Response) => void)[] = [];
    const fetchMock = stubApi({
      'GET /api/auth/me': () => (signedIn ? json(RESIDENT_ME) : problem(401, 'not_authenticated')),
      'POST /api/auth/logout': () => {
        signedIn = false;
        return new Promise<Response>((resolve) => finishes.push(resolve));
      },
      'POST /api/auth/login': () => {
        signedIn = true;
        return noContent();
      },
    });
    const app = renderApp(['/login', '/Packages']);
    await screen.findByText('Alex Chen');
    openAccountMenu();
    fireEvent.click(screen.getByRole('button', { name: /log out/i }));
    await waitFor(() => expect(finishes).toHaveLength(1));

    act(() => app.navigate()(-1));
    await screen.findByRole('heading', { name: /sign in/i });
    act(() => app.navigate()(1));
    await screen.findByText('Alex Chen');
    // The cached /me is fresh; remounting loses the pending button state, so a second logout is possible.
    openAccountMenu();
    fireEvent.click(screen.getByRole('button', { name: /log out/i }));
    await settle();
    // It waits for the first one instead of overtaking it.
    expect(finishes).toHaveLength(1);

    await act(() => Promise.resolve(finishes[0](noContent())));
    await waitFor(() => expect(finishes).toHaveLength(2));
    await screen.findByRole('heading', { name: /sign in/i });
    submit('resident1@example.test');
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: /sign in/i }).disabled).toBe(true));
    await settle();
    expect(calls(fetchMock)).not.toContain('POST /api/auth/login');

    await act(() => Promise.resolve(finishes[1](noContent())));
    // Once both logouts are done, the queued login goes out and signs the user in.
    expect(await screen.findByText('Alex Chen')).toBeTruthy();
    expect(calls(fetchMock).filter((c) => c === 'POST /api/auth/login')).toHaveLength(1);
  });

  it('does not submit credentials from an unmounted login form when logout settles', async () => {
    let signedIn = true;
    let finishLogout!: (response: Response) => void;
    const fetchMock = stubApi({
      'GET /api/auth/me': () => signedIn ? json(RESIDENT_ME) : problem(401, 'not_authenticated'),
      'POST /api/auth/logout': () => {
        signedIn = false;
        return new Promise<Response>((resolve) => { finishLogout = resolve; });
      },
      'POST /api/auth/login': () => {
        signedIn = true;
        return noContent();
      },
    });
    const app = renderApp(['/Packages']);
    await screen.findByText('Alex Chen');
    openAccountMenu();
    fireEvent.click(screen.getByRole('button', { name: /log out/i }));
    await waitFor(() => expect(signedIn).toBe(false));
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['me'] }));
    await screen.findByRole('heading', { name: /sign in/i });
    submit('resident1@example.test');
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: /sign in/i }).disabled).toBe(true));
    expect(calls(fetchMock)).not.toContain('POST /api/auth/login');
    // Abandon the pending sign-in, then come back to an empty form (a different user can now use it).
    act(() => app.navigate()('/no-such-page'));
    await screen.findByRole('heading', { name: /page not found/i });
    act(() => app.navigate()('/login'));
    await screen.findByRole('heading', { name: /sign in/i });
    expect(screen.getByLabelText<HTMLInputElement>(/email/i).value).toBe('');
    await act(() => Promise.resolve(finishLogout(noContent())));
    await settle();
    expect(calls(fetchMock)).not.toContain('POST /api/auth/login');
    expect(screen.getByRole('heading', { name: /sign in/i })).toBeTruthy();
  });

  it('keeps the latest account when a remounted login form replaces a waiting one', async () => {
    let current = RESIDENT_ME;
    let signedIn = true;
    let finishLogout!: (response: Response) => void;
    let finishOldLogin: (() => void) | undefined;
    const loginEmails: string[] = [];
    const nextUser = { ...RESIDENT_ME, user: { ...RESIDENT_ME.user, id: 'new-user', full_name: 'New User', email: 'new@example.test' } };
    stubApi({
      'GET /api/auth/me': () => signedIn ? json(current) : problem(401, 'not_authenticated'),
      'POST /api/auth/logout': () => {
        signedIn = false;
        return new Promise<Response>((resolve) => { finishLogout = resolve; });
      },
      'POST /api/auth/login': async (request) => {
        const body = await request.json() as { email: string };
        loginEmails.push(body.email);
        if (body.email === 'resident1@example.test') {
          return new Promise<Response>((resolve) => {
            finishOldLogin = () => { current = RESIDENT_ME; signedIn = true; resolve(noContent()); };
          });
        }
        current = nextUser;
        signedIn = true;
        return noContent();
      },
    });
    const app = renderApp(['/Packages']);
    await screen.findByText('Alex Chen');
    openAccountMenu();
    fireEvent.click(screen.getByRole('button', { name: /log out/i }));
    await waitFor(() => expect(signedIn).toBe(false));
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['me'] }));
    await screen.findByRole('heading', { name: /sign in/i });
    submit('resident1@example.test');
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: /sign in/i }).disabled).toBe(true));
    // Navigate away and return to replace the old, waiting form with a fresh one.
    act(() => app.navigate()('/no-such-page'));
    await screen.findByRole('heading', { name: /page not found/i });
    act(() => app.navigate()('/login'));
    await screen.findByRole('heading', { name: /sign in/i });
    submit('new@example.test');
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: /sign in/i }).disabled).toBe(true));
    await act(() => Promise.resolve(finishLogout(noContent())));
    await screen.findByText('New User');
    await settle();
    // The first form was gone before its turn came: its credentials were never sent.
    expect(loginEmails).toEqual(['new@example.test']);
    expect(finishOldLogin).toBeUndefined();
    expect(screen.getByRole('banner').textContent).toContain('New User');
  });
  it('does not pull the user back to next when the form went away while its login was in flight', async () => {
    let finishLogin!: (response: Response) => void;
    let signedIn = false;
    stubApi({
      'GET /api/auth/me': () => (signedIn ? json(RESIDENT_ME) : problem(401, 'not_authenticated')),
      'POST /api/auth/login': () =>
        new Promise<Response>((resolve) => {
          finishLogin = (response) => {
            signedIn = true;
            resolve(response);
          };
        }),
    });
    const app = renderApp(['/login?next=%2FPackages']);
    await screen.findByRole('heading', { name: /sign in/i });
    submit('resident1@example.test');
    await waitFor(() => expect(finishLogin).toBeDefined());

    act(() => app.navigate()('/no-such-page'));
    await screen.findByRole('heading', { name: /page not found/i });
    await act(() => Promise.resolve(finishLogin(noContent())));
    await settle();

    // The session exists (the server set the cookie), but the user stays where they went.
    expect(screen.getByTestId('location').textContent).toBe('/no-such-page');
  });
});

/**
 * A stand-in for the browser's lock manager (`navigator.locks`): one FIFO queue per lock name, shared by
 * every caller, as all tabs of an origin share the real one.
 */
function fakeLocks() {
  const tails = new Map<string, Promise<unknown>>();
  const held: string[] = [];
  const request = vi.fn((name: string, callback: () => Promise<unknown>) => {
    const run = (tails.get(name) ?? Promise.resolve()).then(async () => {
      held.push(name);
      try {
        return await callback();
      } finally {
        held.splice(held.indexOf(name), 1);
      }
    });
    tails.set(name, run.catch(() => undefined));
    return run;
  });
  Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
  return { request, held };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('across tabs: the condo.auth Web Lock (P2-06c criterion 7a)', () => {
  it('runs each call inside the lock, waits for another tab holding it, and a failure releases it', async () => {
    const locks = fakeLocks();
    // Another tab is logging out: it holds the lock.
    const otherTab = deferred();
    void navigator.locks.request('condo.auth', () => otherTab.promise);
    const started: string[] = [];
    const first = deferred();

    const a = runAuthCall(async () => {
      started.push('a');
      expect(locks.held).toEqual(['condo.auth']);
      await first.promise;
    });
    const b = runAuthCall(() => {
      started.push('b');
      return Promise.resolve('b done');
    });
    await settle();
    expect(started).toEqual([]);

    otherTab.resolve();
    await settle();
    expect(started).toEqual(['a']);

    first.reject(new Error('logout failed'));
    await expect(a).rejects.toThrow('logout failed');
    await expect(b).resolves.toBe('b done');
    expect(started).toEqual(['a', 'b']);
    expect(locks.request.mock.calls.map(([name]) => name)).toEqual(['condo.auth', 'condo.auth', 'condo.auth']);
    expect(locks.held).toEqual([]);
  });

  it('keeps the per-tab order without navigator.locks (jsdom, old browsers)', async () => {
    expect('locks' in navigator).toBe(false);
    const order: string[] = [];
    const first = deferred();

    const a = runAuthCall(async () => {
      await first.promise;
      order.push('a');
    });
    const b = runAuthCall(() => {
      order.push('b');
      return Promise.resolve();
    });
    await settle();
    expect(order).toEqual([]);

    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a', 'b']);
  });
});

/** A handler that never answers, and fails like fetch does when its request is aborted. */
const hangUntilAborted = (request: Request) =>
  new Promise<Response>((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason as Error));
  });

describe('login and logout time out (P2-06c criterion 7b)', () => {
  it('gives up a hung logout after the timeout, shows the error, and frees the queue', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let hang = true;
    const fetchMock = stubApi({
      'GET /api/auth/me': () => json(RESIDENT_ME),
      'POST /api/auth/logout': (request) => (hang ? hangUntilAborted(request) : noContent()),
    });
    renderApp(['/']);
    await screen.findByText('Alex Chen');
    openAccountMenu();
    fireEvent.click(screen.getByRole('button', { name: /log out/i }));
    await waitFor(() => expect(calls(fetchMock)).toContain('POST /api/auth/logout'));

    // shouldAdvanceTime lets real time move the clock too, hence the margin.
    await act(() => vi.advanceTimersByTimeAsync(AUTH_TIMEOUT_MS - 1_000));
    expect(screen.queryByRole('alert')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1_000));

    expect((await screen.findByRole('alert')).textContent).toContain('Could not log out, try again');
    expect(screen.getByTestId('location').textContent).toBe('/');

    hang = false;
    openAccountMenu();
    fireEvent.click(screen.getByRole('button', { name: /log out/i }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/login'));
    expect(calls(fetchMock).filter((c) => c === 'POST /api/auth/logout')).toHaveLength(2);
  });

  it('gives up a hung login after the timeout with the generic message, then sends the next one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let hang = true;
    let signedIn = false;
    const fetchMock = stubApi({
      'GET /api/auth/me': () => (signedIn ? json(RESIDENT_ME) : problem(401, 'not_authenticated')),
      'POST /api/auth/login': (request) => {
        if (hang) return hangUntilAborted(request);
        signedIn = true;
        return noContent();
      },
    });
    renderApp(['/login']);
    await screen.findByRole('heading', { name: /sign in/i });
    submit('resident1@example.test');
    await waitFor(() => expect(calls(fetchMock)).toContain('POST /api/auth/login'));

    await act(() => vi.advanceTimersByTimeAsync(AUTH_TIMEOUT_MS));

    expect((await screen.findByRole('alert')).textContent).toBe('Could not sign in. Try again.');
    hang = false;
    submit('resident1@example.test');
    expect(await screen.findByText('Alex Chen')).toBeTruthy();
    expect(calls(fetchMock).filter((c) => c === 'POST /api/auth/login')).toHaveLength(2);
  });

  it('passes an unaborted signal to a call that answers in time', async () => {
    let seen: AbortSignal | undefined;
    await runAuthCall((signal) => {
      seen = signal;
      return Promise.resolve();
    });
    expect(seen?.aborted).toBe(false);
  });
});
