import { useEffect, useRef, useState, type MouseEvent } from 'react';

interface Refetch {
  refetch: () => Promise<{ isError: boolean }>;
}

/**
 * A failed first page's "Try again" (P6-04a review round 1 F1; shared in P6-04b). A failed first page has no data, so
 * its refetch goes back to pending and the button goes while it runs; then the rows, the empty message or a new button
 * replace it. A press that leaves focus on it parks focus on the heading, which stays, and puts it on the new button if
 * the retry failed. Focus the user moved meanwhile stays.
 */
export function useFocusedRetry(query: Refetch, focusHeading: () => void) {
  const retryRef = useRef<HTMLButtonElement>(null);
  // Set when a pressed "Try again" failed again; its own object each time, so the effect runs after the commit that
  // shows the new button (as `useLoadMore`).
  const [failedRetry, setFailedRetry] = useState<{ parked: Element | null } | null>(null);

  useEffect(() => {
    if (!failedRetry) return;
    const active = document.activeElement;
    if (active === failedRetry.parked || active === document.body || active === null) retryRef.current?.focus();
  }, [failedRetry]);

  const retry = (event: MouseEvent<HTMLButtonElement>) => {
    const pressed = document.activeElement === event.currentTarget;
    if (pressed) focusHeading();
    const parked = document.activeElement;
    void query.refetch().then((result) => {
      if (pressed && result.isError) setFailedRetry({ parked });
    });
  };
  return { retryRef, retry };
}
