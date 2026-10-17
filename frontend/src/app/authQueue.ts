let tail: Promise<unknown> = Promise.resolve();

/** A login or logout request that hasn't answered by then is aborted, so it can't hold the queue. */
export const AUTH_TIMEOUT_MS = 15_000;

/** The Web Lock every tab of this origin takes around an auth call (P2-06c). */
const LOCK = 'condo.auth';

/**
 * Runs login and logout calls one at a time, in the order they were queued, whatever the previous one's
 * outcome. A logout response deletes the session cookie and a login response sets one, so overlapping
 * calls could leave the browser signed in as the wrong account, or as nobody (inbox B-3). Tabs share the
 * cookie jar, so each call also holds the `condo.auth` Web Lock when the browser has `navigator.locks`;
 * without it, the order holds within this tab only.
 *
 * `call` gets a signal that aborts after `AUTH_TIMEOUT_MS`, counted from when its turn comes: pass it to
 * the request, so a hung request fails (and frees the queue and the lock) instead of waiting for the
 * browser's own timeout.
 */
export function runAuthCall<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timed = async () => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException('The auth call timed out', 'TimeoutError')),
      AUTH_TIMEOUT_MS,
    );
    try {
      return await call(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  };
  const locks = 'locks' in navigator ? navigator.locks : undefined;
  // The DOM typings give `request` the callback's return type unwrapped once too few (Promise<Promise<T>>);
  // the browser resolves it to T, as with any promise returned from a then callback.
  const result = tail.then(() => (locks ? (locks.request(LOCK, timed) as Promise<T>) : timed()));
  tail = result.catch(() => undefined);
  return result;
}
