import { useEffect, useId, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { useNotificationSummary } from '@/features/notifications/api';
import { NotificationPanel } from '@/features/notifications/NotificationPanel';

/**
 * The header's bell (P3-05): a disclosure button, like the account menu, that shows the notification panel.
 * Its name carries the unread count, and a polite live region says it again when it changes. Escape and a
 * click outside close the panel; Escape returns focus to the bell. It is open only at the location it was
 * opened at, so following a notification's link closes it. Rendered only for a selected building.
 */
export function NotificationBell() {
  const { data } = useNotificationSummary();
  const unread = data?.unread_count;
  const { key } = useLocation();
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === key;
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpenAt(null);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
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
      {open && <NotificationPanel id={panelId} unread={unread ?? 0} />}
    </div>
  );
}
