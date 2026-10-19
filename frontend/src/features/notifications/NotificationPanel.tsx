import { useNavigate } from 'react-router-dom';

import type { components } from '@/api/schema';
import { isAppPath, type useMarkAllRead, type useMarkRead, useNotifications } from '@/features/notifications/api';

type Notification = components['schemas']['NotificationOut'];

interface Props {
  id: string;
  unread: number;
  /** Owned by the bell, which outlives the panel (see NotificationBell). */
  markRead: ReturnType<typeof useMarkRead>;
  markAllRead: ReturnType<typeof useMarkAllRead>;
}

/**
 * The bell's panel: the notifications, newest first, with "Load more" and "Mark all read". Clicking one marks it
 * read (when it is unread) and opens its link when that is an app path; the mark-read request carries on after
 * the navigation closes the panel.
 */
export function NotificationPanel({ id, unread, markRead, markAllRead }: Props) {
  const list = useNotifications({ enabled: true });
  const navigate = useNavigate();
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];

  const onOpen = (notification: Notification) => {
    if (notification.read_at === null) {
      markAllRead.reset();
      markRead.mutate(notification.id);
    }
    if (isAppPath(notification.link)) navigate(notification.link);
  };

  return (
    <section
      id={id}
      aria-label="Notifications"
      className="absolute right-0 z-10 mt-2 flex max-h-[28rem] w-80 flex-col gap-2 overflow-y-auto rounded border bg-white p-3 shadow"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Notifications</h2>
        <button
          type="button"
          className="rounded border px-2 py-0.5 text-xs disabled:opacity-50"
          disabled={unread === 0 || markAllRead.isPending}
          onClick={() => {
            markRead.reset();
            markAllRead.mutate();
          }}
        >
          Mark all read
        </button>
      </div>
      {(markRead.isError || markAllRead.isError) && (
        <p role="alert" className="text-sm text-red-800">
          Could not mark notifications read. Try again.
        </p>
      )}
      {list.isPending ? (
        <p className="text-sm text-slate-600">Loading…</p>
      ) : list.isError && items.length === 0 ? (
        <p className="text-sm text-red-800">Could not load notifications.</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-slate-600">No notifications</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((notification) => (
            <li key={notification.id}>
              <button
                type="button"
                onClick={() => onOpen(notification)}
                className={`w-full rounded px-2 py-1 text-left text-sm hover:bg-slate-100 ${notification.read_at === null ? 'font-medium' : 'text-slate-600'}`}
              >
                {notification.read_at === null && (
                  <>
                    <span aria-hidden className="mr-1 inline-block h-2 w-2 rounded-full bg-blue-600" />
                    <span className="sr-only">Unread</span>
                  </>
                )}
                <span className="block">{notification.title}</span>
                <span className="block text-xs text-slate-600">{notification.body}</span>
                <time dateTime={notification.created_at} className="block text-xs text-slate-500">
                  {new Date(notification.created_at).toLocaleString()}
                </time>
              </button>
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <button
          type="button"
          className="rounded border px-2 py-1 text-sm disabled:opacity-50"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          Load more
        </button>
      )}
    </section>
  );
}
