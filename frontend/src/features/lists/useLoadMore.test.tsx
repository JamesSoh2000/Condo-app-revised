// @vitest-environment jsdom
/**
 * P6-02e: where focus goes after "Load more" (docs/tickets/P6-02e-list-focus-fixes.md), through a minimal list.
 * Each list's own test proves criterion 1 through the real component.
 */
import { QueryClient, QueryClientProvider, useInfiniteQuery } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { useLoadMore } from '@/features/lists/useLoadMore';

afterEach(cleanup);

interface Page {
  items: string[];
  next: number | null;
}

/** A pending page per request, answered by the test. */
function server() {
  const waiting: { cursor: number; resolve: (page: Page) => void; reject: (error: Error) => void }[] = [];
  return {
    fetch: (cursor: number) => new Promise<Page>((resolve, reject) => waiting.push({ cursor, resolve, reject })),
    answer: async (page: Page) => {
      await waitFor(() => expect(waiting.length).toBeGreaterThan(0));
      act(() => waiting.shift()!.resolve(page));
      await act(() => Promise.resolve());
    },
    fail: async () => {
      await waitFor(() => expect(waiting.length).toBeGreaterThan(0));
      act(() => waiting.shift()!.reject(new Error('down')));
      await act(() => Promise.resolve());
    },
  };
}

function List({ fetch }: { fetch: (cursor: number) => Promise<Page> }) {
  const query = useInfiniteQuery({
    queryKey: ['list'],
    queryFn: ({ pageParam }) => fetch(pageParam),
    initialPageParam: 0,
    getNextPageParam: (page: Page) => page.next,
    retry: false,
  });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const more = useLoadMore(query, () => headingRef.current?.focus());
  return (
    <div>
      <h2 ref={headingRef} tabIndex={-1}>
        Things
      </h2>
      <ul ref={more.listRef} aria-label="Things">
        {query.data?.pages
          .flatMap((page) => page.items)
          .map((item) => (
            <li key={item} tabIndex={-1}>
              {item}
            </li>
          ))}
      </ul>
      {query.isFetchNextPageError && <p role="alert">Could not load more.</p>}
      {query.hasNextPage && (
        <button ref={more.buttonRef} type="button" disabled={query.isFetching} onClick={more.onClick}>
          Load more
        </button>
      )}
      <button type="button">Elsewhere</button>
    </div>
  );
}

async function setup() {
  const api = server();
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <List fetch={api.fetch} />
    </QueryClientProvider>,
  );
  await api.answer({ items: ['a', 'b'], next: 1 });
  await screen.findByText('b');
  return api;
}

const row = (name: string) => screen.getByText(name, { selector: 'li' });
const button = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Load more' });
const press = () => {
  button().focus();
  fireEvent.click(button());
};

describe('Load more focus (P6-02e)', () => {
  it('criterion 1: parks on the last row while loading, then the first new row; the button goes after the last page', async () => {
    const api = await setup();
    press();
    expect(document.activeElement).toBe(row('b'));
    await waitFor(() => expect(button().disabled).toBe(true));

    await api.answer({ items: ['c', 'd'], next: null });
    await waitFor(() => expect(document.activeElement).toBe(row('c')));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('criterion 1: a last page with no rows sends focus to the heading', async () => {
    const api = await setup();
    press();
    await api.answer({ items: [], next: null });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Things' })));
  });

  it('criterion 4: a page that is not the last focuses its first row and the button comes back enabled', async () => {
    const api = await setup();
    press();
    await api.answer({ items: ['c'], next: 2 });
    await waitFor(() => expect(document.activeElement).toBe(row('c')));
    await waitFor(() => expect(button().disabled).toBe(false));
  });

  it('criterion 5: a failed page focuses the button again', async () => {
    const api = await setup();
    press();
    await api.fail();
    await screen.findByRole('alert');
    await waitFor(() => expect(document.activeElement).toBe(button()));
    expect(button().disabled).toBe(false);
  });

  it('criterion 6: a press that left focus elsewhere moves nothing', async () => {
    const api = await setup();
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    fireEvent.click(button());
    await api.answer({ items: ['c'], next: null });
    await screen.findByText('c');
    expect(document.activeElement).toBe(elsewhere);
  });

  it('criterion 6: focus moved on during the load stays where the user put it', async () => {
    const api = await setup();
    press();
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    await api.answer({ items: ['c'], next: null });
    await screen.findByText('c');
    expect(document.activeElement).toBe(elsewhere);
  });

  it('criterion 6 neighbour: a parked row removed during the load (focus on <body>) still gets the new row', async () => {
    const api = await setup();
    press();
    row('b').blur();
    expect(document.activeElement).toBe(document.body);
    await api.answer({ items: ['c'], next: null });
    await waitFor(() => expect(document.activeElement).toBe(row('c')));
  });
});
