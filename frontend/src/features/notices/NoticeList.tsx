import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { ApiError } from '@/api/errors';
import { useBuildingId } from '@/app/BuildingProvider';
import { rateLimitMessage } from '@/features/auth/formErrors';
import { useLoadMore } from '@/features/lists/useLoadMore';
import { useMarkReadOnce, useNoticeFeed, type Notice } from '@/features/notices/api';
import { NoticeBody } from '@/features/notices/NoticeBody';

interface Props {
  /** False until the page may ask for the feed (it waits for the unread count, criterion 5). */
  enabled: boolean;
  time: Intl.DateTimeFormat | undefined;
  /** Focus the feed's heading: a refresh removed the card that held focus, or Load more added no card (P6-02e). */
  onFocusLost: () => void;
}

/** The feed (P6-02a): one card per live notice, in the API's order (D5), paged with Load more. */
export function NoticeList({ enabled, time, onFocusLost }: Props) {
  const query = useNoticeFeed(useBuildingId(), enabled);
  const more = useLoadMore(query, onFocusLost);
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
      <ul ref={more.listRef} aria-label="Notices" className="flex flex-col gap-3">
        {items.map((item) => (
          <Card key={item.id} item={item} time={time} onGone={setGone} onFocusLost={onFocusLost} />
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
          ref={more.buttonRef}
          disabled={query.isFetching}
          onClick={more.onClick}
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
  onFocusLost: () => void;
}

function Card({ item, time, onGone, onFocusLost }: CardProps) {
  const { read, markRead } = useMarkReadOnce(useBuildingId());
  const unread = item.read_at === null;
  const gone = read.error instanceof ApiError && read.error.status === 404;
  // The button disables, then goes, on a press: focus waits on the card, which stays, and comes back to the button if
  // the read fails (P6-02c criterion 9), or a browser drops it to <body>.
  const cardRef = useRef<HTMLLIElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [refocus, setRefocus] = useState(false);
  useEffect(() => {
    if (refocus && read.isError) buttonRef.current?.focus();
  }, [refocus, read.isError]);
  // As `ManagerNoticeList.tsx::Row`: a removed node gets no blur, so a card that unmounts while this is true held
  // focus, and a refresh that drops it hands focus to the heading (P6-02e criterion 2).
  const focused = useRef(false);
  const lost = useRef(onFocusLost);
  lost.current = onFocusLost;
  useEffect(() => () => void (focused.current && lost.current()), []);
  return (
    <li
      ref={cardRef}
      tabIndex={-1}
      onFocus={() => (focused.current = true)}
      onBlur={() => (focused.current = false)}
      className="min-w-0 rounded border bg-white p-3 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 font-medium">{item.title}</h2>
        <NoticeLabels item={item} />
      </div>
      <NoticeTimes item={item} time={time} />
      <NoticeBody markdown={item.body} />
      <div className="mt-2 flex flex-wrap gap-2">
        {/* The notice on its own, with its attachment (P6-02b); Close comes back here. */}
        <Link
          to={`/notices/${item.id}`}
          state={{ fromList: true }}
          aria-label={`Open: ${item.title}`}
          className="inline-flex min-h-11 items-center rounded border px-4 text-sm"
        >
          Open
        </Link>
        {unread && (
          <button
            ref={buttonRef}
            type="button"
            disabled={read.isPending}
            aria-label={`Mark as read: ${item.title}`}
            onClick={(event) => {
              const focused = document.activeElement === event.currentTarget;
              if (focused) cardRef.current?.focus();
              setRefocus(focused);
              markRead(item.id, (error) => {
                if (error instanceof ApiError && error.status === 404) onGone(item.title);
              });
            }}
            className="min-h-11 rounded border px-4 text-sm disabled:opacity-50"
          >
            Mark as read
          </button>
        )}
      </div>
      {read.isError && !gone && (
        <p role="alert" className="mt-1 text-sm text-red-700">
          {rateLimitMessage(read.error) ?? 'Could not mark the notice read.'}
        </p>
      )}
    </li>
  );
}

const STATUS: Partial<Record<Notice['status'], string>> = { draft: 'Draft', archived: 'Archived' };

/** A notice's labels: its status when not published (a manager's view), "Urgent", "Unread". */
export function NoticeLabels({ item }: { item: Notice }) {
  const status = STATUS[item.status];
  return (
    <>
      {status && <span className="rounded bg-slate-200 px-1.5 text-xs font-semibold text-slate-800">{status}</span>}
      {item.priority === 'urgent' && <span className="rounded bg-red-100 px-1.5 text-xs font-semibold text-red-800">Urgent</span>}
      {item.read_at === null && <span className="rounded bg-blue-100 px-1.5 text-xs font-semibold text-blue-800">Unread</span>}
    </>
  );
}

/** "Published <time> · Until <time>", in the building's timezone. */
export function NoticeTimes({ item, time }: { item: Notice; time: Intl.DateTimeFormat | undefined }) {
  const at = (value: string) => <time dateTime={value}>{time?.format(new Date(value))}</time>;
  return (
    <p className="text-xs text-slate-600">
      {item.published_at && <>Published {at(item.published_at)}</>}
      {item.expires_at && <> · Until {at(item.expires_at)}</>}
    </p>
  );
}
