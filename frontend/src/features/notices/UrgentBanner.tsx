import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Link } from 'react-router-dom';

import { ApiError } from '@/api/errors';
import { rateLimitMessage } from '@/features/auth/formErrors';
import { urgentNoticesKey, useMarkReadOnce, useNoticeSummary, useUrgentNotices, type Notice } from '@/features/notices/api';

export const DISCLAIMER = 'This app is not an emergency alert system: in an emergency, call 911.';

/**
 * The urgent banner (P6-02b), on every page of a building with notices on, while the member has unread urgent notices
 * by the polled summary (ADR-0012: within one 30 s poll while the tab is visible). It names the newest three, each
 * acknowledged by marking it read (D3), and says it is not emergency alerting (D1).
 */
interface Props {
  buildingId: string;
  /** The shell's live region around the banner, which stays mounted: focus goes there when a row leaves (R2 F1). */
  slotRef: RefObject<HTMLDivElement>;
}

export function UrgentBanner({ buildingId, slotRef }: Props) {
  const queryClient = useQueryClient();
  // A failed refresh keeps the last count: an urgent banner shouldn't blink away on one lost poll.
  const count = useNoticeSummary(buildingId).data?.urgent_unread ?? 0;
  const list = useUrgentNotices(buildingId, count > 0);

  // The list doesn't poll (D4): when the count moves it is asked again, cancelled first, as a request already out may
  // have been read before the change. Until an answer newer than the change arrives, its old rows aren't shown: the
  // change is marked while rendering, so not even one commit shows them.
  const [change, setChange] = useState({ count, at: 0 });
  if (change.count !== count) setChange({ count, at: Date.now() });
  const seen = useRef(count);
  useEffect(() => {
    if (seen.current === count) return;
    seen.current = count;
    const filters = { queryKey: urgentNoticesKey(buildingId) };
    void queryClient.cancelQueries(filters).then(() => queryClient.invalidateQueries(filters));
  }, [count, buildingId, queryClient]);

  if (count === 0) return null;
  const rows = list.data && list.dataUpdatedAt >= change.at ? list.data.items : undefined;
  const more = rows ? count - rows.length : 0;
  return (
    <section aria-label="Urgent notices" className="border-b border-red-300 bg-red-50 px-4 py-3 text-red-900">
      <div className="mx-auto flex max-w-5xl min-w-0 flex-col gap-2 [overflow-wrap:anywhere]">
        <p className="font-semibold">{count === 1 ? 'Urgent building notice' : `${count} urgent notices`}</p>
        {rows ? (
          <ul className="flex flex-col gap-2">
            {rows.map((item) => (
              <Row key={item.id} item={item} buildingId={buildingId} slotRef={slotRef} />
            ))}
          </ul>
        ) : (
          <Link to="/notices" className="underline">
            See the notices
          </Link>
        )}
        {more > 0 && (
          <Link to="/notices" className="self-start underline">
            and {more} more
          </Link>
        )}
        <p className="text-sm">{DISCLAIMER}</p>
      </div>
    </section>
  );
}

function Row({ item, buildingId, slotRef }: { item: Notice } & Props) {
  const { read, markRead } = useMarkReadOnce(buildingId);
  // A 404: the notice left (archived, expired) before the press; the refresh drops its row (criterion 9).
  const failed = read.isError && !(read.error instanceof ApiError && read.error.status === 404);
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <Link to={`/notices/${item.id}`} className="min-w-0 font-medium underline">
        {item.title}
      </Link>
      <button
        type="button"
        disabled={read.isPending}
        aria-label={`Acknowledge: ${item.title}`}
        onClick={() => {
          // The row (or the whole banner) leaves once read: focus would drop to <body>.
          slotRef.current?.focus();
          markRead(item.id);
        }}
        className="min-h-11 rounded border border-red-300 bg-white px-3 text-sm disabled:opacity-50"
      >
        Acknowledge
      </button>
      {failed && (
        <span role="alert" className="text-sm text-red-700">
          {rateLimitMessage(read.error) ?? 'Could not acknowledge the notice, try again.'}
        </span>
      )}
    </li>
  );
}
