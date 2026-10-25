import { useRef, useState } from 'react';

import { ApiError } from '@/api/errors';
import { useBuildingId } from '@/app/BuildingProvider';
import { rateLimitMessage } from '@/features/auth/formErrors';
import { useMarkNoticeRead, useNoticeFeed, type Notice } from '@/features/notices/api';
import { NoticeBody } from '@/features/notices/NoticeBody';

interface Props {
  /** False until the page may ask for the feed (it waits for the unread count, criterion 5). */
  enabled: boolean;
  time: Intl.DateTimeFormat | undefined;
}

/** The feed (P6-02a): one card per live notice, in the API's order (D5), paged with Load more. */
export function NoticeList({ enabled, time }: Props) {
  const query = useNoticeFeed(useBuildingId(), enabled);
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  // A notice that left the feed while being marked read (404) takes its card with it on the refresh, so the list says
  // so, not the card (criterion 2).
  const [gone, setGone] = useState<string | null>(null);

  let body;
  if (query.isPending) body = <p role="status">Loading notices…</p>;
  else if (query.isError && !query.isFetchNextPageError) {
    body = (
      <div role="alert" className="text-sm text-red-700">
        {rateLimitMessage(query.error) ?? 'Could not load the notices.'}{' '}
        <button type="button" className="underline" onClick={() => void query.refetch()}>
          Try again
        </button>
      </div>
    );
  }
  const shown =
    query.data &&
    (items.length === 0 ? (
      <p>No notices right now.</p>
    ) : (
      <ul aria-label="Notices" className="flex flex-col gap-3">
        {items.map((item) => (
          <Card key={item.id} item={item} time={time} onGone={setGone} />
        ))}
      </ul>
    ));

  return (
    <div className="mt-4 flex min-w-0 flex-col gap-3">
      {gone !== null && (
        <p role="alert" className="text-sm text-red-700 [overflow-wrap:anywhere]">
          “{gone}” is no longer available.
        </p>
      )}
      {body}
      {shown}
      {query.isFetchNextPageError && (
        <p role="alert" className="text-sm text-red-700">
          {rateLimitMessage(query.error) ?? 'Could not load more notices.'}
        </p>
      )}
      {query.hasNextPage && !query.isRefetchError && (
        // As the packages lists: not while any fetch is out, nor after a failed refresh.
        <button
          type="button"
          disabled={query.isFetching}
          onClick={() => void query.fetchNextPage({ cancelRefetch: false })}
          className="min-h-11 self-start rounded border px-4 text-sm disabled:opacity-50"
        >
          Load more
        </button>
      )}
    </div>
  );
}

interface CardProps {
  item: Notice;
  time: Intl.DateTimeFormat | undefined;
  onGone: (title: string) => void;
}

function Card({ item, time, onGone }: CardProps) {
  const read = useMarkNoticeRead(useBuildingId());
  // Set before the request, so a second press in the same tick, before `isPending` renders, sends nothing.
  const sending = useRef(false);
  const at = (value: string) => <time dateTime={value}>{time?.format(new Date(value))}</time>;
  const unread = item.read_at === null;
  const gone = read.error instanceof ApiError && read.error.status === 404;
  const markRead = () => {
    if (sending.current) return;
    sending.current = true;
    read.mutate(item.id, {
      onError: (error) => {
        if (error instanceof ApiError && error.status === 404) onGone(item.title);
      },
      onSettled: () => {
        sending.current = false;
      },
    });
  };
  return (
    <li className="min-w-0 rounded border bg-white p-3 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 font-medium">{item.title}</h2>
        {item.priority === 'urgent' && <span className="rounded bg-red-100 px-1.5 text-xs font-semibold text-red-800">Urgent</span>}
        {unread && <span className="rounded bg-blue-100 px-1.5 text-xs font-semibold text-blue-800">Unread</span>}
      </div>
      <p className="text-xs text-slate-600">
        {item.published_at && <>Published {at(item.published_at)}</>}
        {item.expires_at && <> · Until {at(item.expires_at)}</>}
      </p>
      <NoticeBody markdown={item.body} />
      {unread && (
        <button
          type="button"
          disabled={read.isPending}
          aria-label={`Mark as read: ${item.title}`}
          onClick={markRead}
          className="mt-2 min-h-11 rounded border px-4 text-sm disabled:opacity-50"
        >
          Mark as read
        </button>
      )}
      {read.isError && !gone && (
        <p role="alert" className="mt-1 text-sm text-red-700">
          {rateLimitMessage(read.error) ?? 'Could not mark the notice read.'}
        </p>
      )}
    </li>
  );
}
