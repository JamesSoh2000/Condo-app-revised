let tail: Promise<unknown> = Promise.resolve();

/**
 * Runs login and logout calls one at a time, in the order they were queued, whatever the previous one's
 * outcome. A logout response deletes the session cookie and a login response sets one, so overlapping
 * calls could leave the browser signed in as the wrong account, or as nobody (inbox B-3). Per tab only:
 * tabs share the cookie jar but not this queue.
 */
export function runAuthCall<T>(call: () => Promise<T>): Promise<T> {
  const result = tail.then(call);
  tail = result.catch(() => undefined);
  return result;
}
