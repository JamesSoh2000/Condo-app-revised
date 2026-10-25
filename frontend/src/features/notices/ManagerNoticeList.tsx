import { useEffect, useRef } from 'react';

import { useBuildingId } from '@/app/BuildingProvider';
import { rateLimitMessage } from '@/features/auth/formErrors';
import { useLoadMore } from '@/features/lists/useLoadMore';
import { useManagedNotices, type ManagedStatus, type Notice, type NoticeAction } from '@/features/notices/api';
import { NoticeBody } from '@/features/notices/NoticeBody';
import { NoticeTimes } from '@/features/notices/NoticeList';

/** The actions each list's rows have (criteria 2, 3): an archived notice is final. */
const ACTIONS: Record<ManagedStatus, NoticeAction[]> = { draft: ['publish', 'archive'], published: ['archive'], archived: [] };

interface Props {
  status: ManagedStatus;
  label: string;
  empty: string;
  time: Intl.DateTimeFormat | undefined;
  /** The device's clock, for the "Expired" label (D4). */
  now: number;
  onAction: (action: NoticeAction, item: Notice, opener: HTMLButtonElement) => void;
  /** Open the editor on a draft (P6-02d). */
  onEdit: (item: Notice, opener: HTMLButtonElement) => void;
  /**
   * Focus the list's heading: a refresh removed the row that held focus, which a browser would drop to <body>, or Load
   * more added no row (P6-02e).
   */
  onFocusLost: () => void;
}

/** One of the manager's lists (P6-02c criterion 1): its notices in the API's order, 25 a page with Load more. */
export function ManagerNoticeList({ status, label, empty, time, now, onAction, onEdit, onFocusLost }: Props) {
  const query = useManagedNotices(useBuildingId(), status);
  const more = useLoadMore(query, onFocusLost);
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  let body;
  if (query.isPending) body = <p role="status">Loading notices…</p>;
  else if (query.isError && !query.isFetchNextPageError) {
    body = (
      <div role="alert" className="text-sm text-red-700">
        {rateLimitMessage(query.error) ?? (query.data ? 'Could not refresh the notices.' : 'Could not load the notices.')}{' '}
        <button type="button" className="underline" onClick={() => void query.refetch()}>
          Try again
        </button>
      </div>
    );
  }
  const shown =
    query.data &&
    (items.length === 0 ? (
      <p>{empty}</p>
    ) : (
      <ul ref={more.listRef} aria-label={label} className="flex flex-col gap-3">
        {items.map((item) => (
          <Row key={item.id} item={item} time={time} now={now} onAction={onAction} onEdit={onEdit} onFocusLost={onFocusLost} />
        ))}
      </ul>
    ));

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {body}
      {shown}
      {query.isFetchNextPageError && (
        <p role="alert" className="text-sm text-red-700">
          {rateLimitMessage(query.error) ?? 'Could not load more notices.'}
        </p>
      )}
      {query.hasNextPage && !query.isRefetchError && (
        // As the feed: not while any fetch is out, nor after a failed refresh.
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

interface RowProps {
  item: Notice;
  time: Intl.DateTimeFormat | undefined;
  now: number;
  onAction: Props['onAction'];
  onEdit: Props['onEdit'];
  onFocusLost: Props['onFocusLost'];
}

function Row({ item, time, now, onAction, onEdit, onFocusLost }: RowProps) {
  // Whether focus is inside the row. A removed node gets no blur, so a row that unmounts while this is true held focus:
  // any refresh that drops it (a 409's late refetch after Cancel, a focus refetch) hands focus on (review round 1 F1).
  // The flag outlives a focused child that a refresh removed (no blur either), so focus is handed on only if it is on
  // <body> now, not taken from where the user has moved it since (P6-02e review round 1 F1).
  const focused = useRef(false);
  const lost = useRef(onFocusLost);
  lost.current = onFocusLost;
  useEffect(() => () => void (focused.current && document.activeElement === document.body && lost.current()), []);
  const expired = item.status === 'published' && item.expires_at !== null && Date.parse(item.expires_at) <= now;
  return (
    <li
      tabIndex={-1}
      onFocus={() => (focused.current = true)}
      onBlur={() => (focused.current = false)}
      className="min-w-0 rounded border bg-white p-3 [overflow-wrap:anywhere]"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 font-medium">{item.title}</h3>
        {item.priority === 'urgent' && <span className="rounded bg-red-100 px-1.5 text-xs font-semibold text-red-800">Urgent</span>}
        {expired && <span className="rounded bg-amber-100 px-1.5 text-xs font-semibold text-amber-900">Expired</span>}
      </div>
      <NoticeTimes item={item} time={time} />
      <NoticeBody markdown={item.body} />
      {ACTIONS[item.status].length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {item.status === 'draft' && (
            <button
              type="button"
              aria-label={`Edit: ${item.title}`}
              onClick={(event) => onEdit(item, event.currentTarget)}
              className="min-h-11 rounded border px-4 text-sm font-medium"
            >
              Edit
            </button>
          )}
          {ACTIONS[item.status].map((action) => {
            const label = action === 'publish' ? 'Publish' : 'Archive';
            return (
              <button
                key={action}
                type="button"
                aria-label={`${label}: ${item.title}`}
                onClick={(event) => onAction(action, item, event.currentTarget)}
                className={`min-h-11 rounded px-4 text-sm font-medium ${action === 'publish' ? 'bg-slate-900 text-white' : 'border'}`}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
    </li>
  );
}
