import { useEffect, useRef, useState, type MouseEvent } from 'react';

interface NextPage {
  fetchNextPage: (options: { cancelRefetch: boolean }) => Promise<{ isFetchNextPageError: boolean }>;
}

/**
 * A list's "Load more" (P6-02e): where focus goes. The button disables while the page loads and removes itself after
 * the last one, and either drops focus to <body> in a browser. So a press that leaves focus on the button parks it on
 * the last row (rows have `tabIndex={-1}`), and once the page has landed moves it to the first new row, to the button
 * again if the page failed, or to the list's heading if the page added no row. Focus the user moved meanwhile stays.
 */
export function useLoadMore(query: NextPage, focusHeading: () => void) {
  const listRef = useRef<HTMLUListElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Set when the page has landed; its own object each time. State, so the effect runs after the commit that shows the
  // new rows: the fetch's promise settles before React renders them.
  const [landed, setLanded] = useState<{ rows: number; parked: Element | null; failed: boolean } | null>(null);
  const heading = useRef(focusHeading);
  heading.current = focusHeading;

  useEffect(() => {
    if (!landed) return;
    const active = document.activeElement;
    if (active !== landed.parked && active !== document.body && active !== null) return;
    const target = landed.failed ? buttonRef.current : listRef.current?.children[landed.rows];
    if (target instanceof HTMLElement && target.isConnected) target.focus();
    else heading.current();
  }, [landed]);

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    const pressed = document.activeElement === event.currentTarget;
    const rows = listRef.current?.children.length ?? 0;
    let parked: Element | null = null;
    if (pressed) {
      const last = listRef.current?.children[rows - 1];
      if (last instanceof HTMLElement) last.focus();
      else heading.current();
      parked = document.activeElement;
    }
    void query.fetchNextPage({ cancelRefetch: false }).then((result) => {
      if (pressed) setLanded({ rows, parked, failed: result.isFetchNextPageError });
    });
  };

  return { listRef, buttonRef, onClick };
}
