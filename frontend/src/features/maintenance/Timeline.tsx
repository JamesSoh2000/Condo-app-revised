import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';

import { useBuildingId } from '@/app/BuildingProvider';
import { rateLimitMessage } from '@/features/auth/formErrors';
import { useFocusedRetry } from '@/features/lists/useFocusedRetry';
import { useLoadMore } from '@/features/lists/useLoadMore';
import {
  useMaintenanceComments,
  useMaintenanceStatusEvents,
  type MaintenanceComment,
  type MaintenanceRequest,
  type MaintenanceStatus,
  type MaintenanceStatusEvent,
} from '@/features/maintenance/api';
import { STATUS_LABEL } from '@/features/maintenance/labels';

type Pages<T> = UseInfiniteQueryResult<InfiniteData<{ items: T[]; next_cursor: string | null }>>;

interface Entry {
  id: string;
  at: string;
  /** 0 for a status change, 1 for a comment: at the same instant the change comes first (criterion 1a). */
  rank: 0 | 1;
  title: string;
  internal?: boolean;
  body?: string;
}

/** A move's name from where it came from: `in_progress` is a first start, a resume or a reopen (P6-03c D4). */
function moveName(from: MaintenanceStatus, to: MaintenanceStatus): string {
  if (to === 'in_progress') return from === 'on_hold' ? 'Work resumed' : from === 'resolved' ? 'Reopened' : 'Work started';
  if (to === 'on_hold') return 'Put on hold';
  return STATUS_LABEL[to];
}

/** The author as P6-03d returns them: a name only where the caller may see it. */
function author(comment: MaintenanceComment): string {
  return comment.author_name ?? (comment.author_is_staff ? 'Building management' : 'Resident');
}

/**
 * An instant to the microsecond, as a number (microseconds since 1970; exact below 2^53). `Date.parse` keeps
 * milliseconds only, and Postgres times have microseconds (review round 1 F3).
 */
function instant(at: string): number {
  const micros = /\.\d{3}(\d{0,3})/.exec(at)?.[1] ?? '';
  return Date.parse(at) * 1000 + Number(micros.padEnd(3, '0'));
}

function before(a: Entry, b: Entry): boolean {
  return (instant(a.at) - instant(b.at) || a.rank - b.rank || (a.id < b.id ? -1 : 1)) < 0;
}

/** One read's loaded entries, in its own order, and whether it has another page. */
export interface Read<T> {
  items: T[];
  more: boolean;
}

/**
 * The timeline (criteria 1a, 1b): the submit and cancel from the request's row, its status events and its comments,
 * merged in time order. Each read keeps the API's order (by id): a comment's time is its transaction's start, so one
 * that waited can be older than the comment before it (review round 1 F2). The merge stops where a read with another
 * page runs out, since that page may hold the next entry; so every "Load more" only adds entries at the end.
 */
export function buildTimeline(request: MaintenanceRequest, events: Read<MaintenanceStatusEvent>, comments: Read<MaintenanceComment>): Entry[] {
  const row: Entry[] = [{ id: `submitted-${request.id}`, at: request.submitted_at, rank: 0, title: 'Submitted' }];
  if (request.cancelled_at) row.push({ id: `cancelled-${request.id}`, at: request.cancelled_at, rank: 0, title: 'Cancelled' });
  const reads: Read<Entry>[] = [
    { items: row, more: false },
    { more: events.more, items: events.items.map((event) => ({ id: event.id, at: event.at, rank: 0, title: moveName(event.from_status, event.status) })) },
    {
      more: comments.more,
      items: comments.items.map((comment) => ({ id: comment.id, at: comment.created_at, rank: 1, title: author(comment), internal: comment.is_internal, body: comment.body })),
    },
  ];
  const next = reads.map(() => 0);
  const merged: Entry[] = [];
  for (;;) {
    let pick = -1;
    for (const [i, read] of reads.entries()) {
      if (next[i] === read.items.length) {
        if (read.more) return merged;
      } else if (pick === -1 || before(read.items[next[i]], reads[pick].items[next[pick]])) pick = i;
    }
    if (pick === -1) return merged;
    merged.push(reads[pick].items[next[pick]++]);
  }
}

const loaded = <T,>(query: Pages<T>): Read<T> => ({ items: query.data?.pages.flatMap((page) => page.items) ?? [], more: query.hasNextPage });

interface Props {
  request: MaintenanceRequest;
  /** The caller reads as staff here: the queries' key (criterion 2a). */
  staff: boolean;
  time: Intl.DateTimeFormat | undefined;
  /** Where focus goes when a press leaves nothing to hold it (the dialog). */
  focusDialog: () => void;
}

/**
 * Mounted once the request has loaded. It reads the two queries itself, as the dialog does (the same keys, so no other
 * request): "Load more" moves focus once its page has landed, and only a component that reads the queries renders the
 * new entries in that same update (as the lists do with `useLoadMore`).
 */
export function Timeline({ request, staff, time, focusDialog }: Props) {
  const buildingId = useBuildingId();
  const events = useMaintenanceStatusEvents(buildingId, request.id, staff, true);
  const comments = useMaintenanceComments(buildingId, request.id, staff, true);
  const reads = [events, comments];
  // Each read with another page is asked for it; the button counts as failed if either failed.
  const more = useLoadMore(
    {
      fetchNextPage: async (options) => {
        const results = await Promise.all(reads.filter((read) => read.hasNextPage).map((read) => read.fetchNextPage(options)));
        return { isFetchNextPageError: results.some((result) => result.isFetchNextPageError) };
      },
    },
    focusDialog,
  );
  const { retryRef, retry } = useFocusedRetry(
    {
      refetch: async () => {
        const results = await Promise.all(reads.filter((read) => read.isError).map((read) => read.refetch()));
        return { isError: results.some((result) => result.isError) };
      },
    },
    focusDialog,
  );

  const failed = reads.find((read) => read.isError && !read.isFetchNextPageError);
  if (failed) {
    return (
      <div role="alert" className="mt-2 text-sm text-red-700">
        {rateLimitMessage(failed.error) ?? 'Could not load the timeline.'}{' '}
        <button type="button" ref={retryRef} className="underline" onClick={retry}>
          Try again
        </button>
      </div>
    );
  }
  if (!events.data || !comments.data) return <p role="status" className="mt-2">Loading the timeline…</p>;

  const pageFailed = reads.find((read) => read.isFetchNextPageError);
  return (
    <div className="mt-2 flex min-w-0 flex-col gap-2">
      <ul ref={more.listRef} aria-label="Timeline" className="flex flex-col gap-2">
        {buildTimeline(request, loaded(events), loaded(comments)).map((entry) => (
          <li key={entry.id} tabIndex={-1} className="min-w-0 rounded border p-2 text-sm [overflow-wrap:anywhere]">
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{entry.title}</span>
              {entry.internal && <span className="rounded bg-amber-100 px-1 text-xs font-semibold text-amber-900">Internal</span>}
              <time dateTime={entry.at} className="text-slate-700">
                {time?.format(new Date(entry.at))}
              </time>
            </p>
            {entry.body !== undefined && <p className="mt-1 whitespace-pre-wrap">{entry.body}</p>}
          </li>
        ))}
      </ul>
      {pageFailed && (
        <p role="alert" className="text-sm text-red-700">
          {rateLimitMessage(pageFailed.error) ?? 'Could not load more of the timeline.'}
        </p>
      )}
      {reads.some((read) => read.hasNextPage) && !reads.some((read) => read.isRefetchError) && (
        <button
          type="button"
          ref={more.buttonRef}
          disabled={reads.some((read) => read.isFetching)}
          onClick={more.onClick}
          className="min-h-11 self-start rounded border px-4 text-sm disabled:opacity-50"
        >
          Load more
        </button>
      )}
    </div>
  );
}
