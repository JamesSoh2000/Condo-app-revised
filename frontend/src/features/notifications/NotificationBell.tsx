import { useEffect, useId, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { useMarkAllRead, useMarkRead, useNotificationSummary } from '@/features/notifications/api';
import { NotificationPanel } from '@/features/notifications/NotificationPanel';

/**
 * The header's bell (P3-05): a disclosure button, like the account menu, that shows the notification panel.
 * Its name carries the unread count, and a polite live region says it again when it changes. Escape and a
 * click or tap outside close the panel; Escape returns focus to the bell. It is open only at the location it was
 * opened at, so following a notification's link closes it, and forgotten then, so Back doesn't show it again
 * (P4-08f criterion 5). Rendered only for a loaded building, keyed by it.
 */
export function NotificationBell() {
  const summary = useNotificationSummary();
  // A failed refresh shows no count rather than the last one (review round 1, Codex F3).
  const unread = summary.isError ? undefined : summary.data?.unread_count;
  // Here, not in the panel: following a link closes the panel, and a failed mark-read must still show when it
  // is opened again (review round 1, Codex F4). Each new mutation replaces the previous one's error.
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();
  const { key } = useLocation();
  const [openAt, setOpenAt] = useState<string | null>(null);
  if (openAt !== null && openAt !== key) setOpenAt(null);
  const open = openAt === key;
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // `pointerdown`, as the account menu: iOS Safari may send no mouse event for a tap (P4-08f criterion 4).
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpenAt(null);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape' || !open) return;
    setOpenAt(null);
    button.current?.focus();
  };

  return (
    <div ref={root} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        aria-label={unread === undefined ? 'Notifications' : `Notifications, ${unread} unread`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpenAt(open ? null : key)}
        className="relative rounded border px-3 py-1 text-sm"
      >
        <span aria-hidden>🔔</span>
        {unread !== undefined && unread > 0 && (
          <span aria-hidden className="absolute -right-2 -top-2 rounded-full bg-red-600 px-1.5 text-xs text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      <span className="sr-only" aria-live="polite">
        {unread === undefined ? '' : `${unread} unread notification${unread === 1 ? '' : 's'}`}
      </span>
      {open && <NotificationPanel id={panelId} unread={unread ?? 0} markRead={markRead} markAllRead={markAllRead} />}
    </div>
  );
}
